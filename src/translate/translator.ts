import { getProvider } from '../providers/factory';
import type { Message, StreamChunk } from '../providers/types';
import type { ModelPreset, ReasoningEffort, TranslateThinking } from '../settings/types';

const SYSTEM_PROMPT =
  '英译中。只输出简体中文译文；术语、缩写、公式、模型名可保留原文。';

const STRICT_SYSTEM_PROMPT =
  '英译中，只输出含中文的译文；不要英文改写、解释或引号。';
const TRANSLATE_CONTEXT_CHAR_LIMIT = 600;
const TRANSLATE_MAX_OUTPUT_TOKENS = 384;

export interface TranslateRequest {
  sentence: string;
  contextLabel?: string;
  contextText?: string;
  preset: ModelPreset;
  model: string;
  thinking: TranslateThinking;
  signal: AbortSignal;
}

export interface TranslateChunk {
  type: 'text' | 'usage' | 'error' | 'done';
  text?: string;
  message?: string;
  input?: number;
  output?: number;
  cacheRead?: number;
}

type TranslationResult =
  | { type: 'ok'; text: string; usage?: TranslationUsage }
  | { type: 'error'; message?: string };

interface TranslationUsage {
  input: number;
  output: number;
  cacheRead?: number;
}

const THINKING_TO_EFFORT: Record<TranslateThinking, ReasoningEffort> = {
  off: 'none',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
};

// Per-provider preset adjustments for the translate flow. OpenAI path is
// kept identical to the previous behavior; the Anthropic path adds a
// translate-only thinking signal and bumps maxTokens because Anthropic's
// max_tokens covers thinking + visible output (the OpenAI 384 cap would
// starve any thinking budget).
export function buildTranslatePreset(req: TranslateRequest): ModelPreset {
  const model = req.model || req.preset.model;
  if (req.preset.provider === 'openai') {
    return {
      ...req.preset,
      model,
      maxTokens: Math.min(
        req.preset.maxTokens || TRANSLATE_MAX_OUTPUT_TOKENS,
        TRANSLATE_MAX_OUTPUT_TOKENS,
      ),
      extras: {
        ...req.preset.extras,
        reasoningEffort: THINKING_TO_EFFORT[req.thinking],
        reasoningSummary: 'none',
      },
    };
  }
  // Anthropic path. Thinking shape is decided in the provider based on
  // (vendor, model, level). We only signal level + bump maxTokens here.
  return {
    ...req.preset,
    model,
    maxTokens: anthropicTranslateMaxTokens(req.preset, req.thinking),
    extras: {
      ...req.preset.extras,
      translateThinking: req.thinking,
    },
  };
}

// Anthropic max_tokens covers (thinking + visible output). Visible output for
// translation is short — TRANSLATE_MAX_OUTPUT_TOKENS — so we just need enough
// headroom for the thinking budget plus that. For adaptive/deepseek paths the
// model decides how much to think; 4096 is generous without being wasteful.
function anthropicTranslateMaxTokens(
  preset: ModelPreset,
  level: TranslateThinking,
): number {
  const vendor = preset.extras?.vendor ?? 'compat';
  // No thinking → no need to grow the cap; keep it at the OpenAI-equivalent
  // tight ceiling. Same for compat vendor (already non-thinking).
  if (vendor === 'compat' || level === 'off') {
    return Math.min(
      preset.maxTokens || TRANSLATE_MAX_OUTPUT_TOKENS,
      TRANSLATE_MAX_OUTPUT_TOKENS,
    );
  }
  // For Claude old-mode (enabled+budget_tokens), the budget must be < max_tokens.
  // Pad max_tokens above the budget to leave room for the visible reply.
  const budgetCeiling: Record<Exclude<TranslateThinking, 'off'>, number> = {
    low: 1024 + TRANSLATE_MAX_OUTPUT_TOKENS,
    medium: 2048 + TRANSLATE_MAX_OUTPUT_TOKENS,
    high: 4096 + TRANSLATE_MAX_OUTPUT_TOKENS,
    xhigh: 8192 + TRANSLATE_MAX_OUTPUT_TOKENS,
  };
  return Math.max(budgetCeiling[level], 4096);
}

function buildUserMessage(req: TranslateRequest): string {
  const sentence = req.sentence.trim();
  if (!req.contextText) return `原文：${sentence}`;
  const label = req.contextLabel || '参考';
  return `${label}：${trimContext(req.contextText)}\n原文：${sentence}`;
}

export async function* translateSentence(req: TranslateRequest): AsyncIterable<TranslateChunk> {
  const overriddenPreset = buildTranslatePreset(req);

  const messages: Message[] = [{ role: 'user', content: buildUserMessage(req) }];

  const first = await collectTranslation(
    messages,
    SYSTEM_PROMPT,
    overriddenPreset,
    req.signal,
  );
  if (first.type === 'error') {
    yield first;
    return;
  }

  const retried = translationNeedsRetry(req.sentence, first.text);
  const result = retried
    ? await retryStrictTranslation(messages, overriddenPreset, req.signal)
    : { type: 'ok' as const, text: first.text };

  if (result.type === 'error') {
    yield result;
    return;
  }
  yield { type: 'text', text: cleanTranslationOutput(result.text) };
  const usage = retried ? addUsage(first.usage, result.usage) : first.usage;
  if (usage) yield { type: 'usage', ...usage };
  yield { type: 'done' };
}

async function retryStrictTranslation(
  messages: Message[],
  preset: ModelPreset,
  signal: AbortSignal,
): Promise<TranslationResult> {
  const second = await collectTranslation(
    messages,
    STRICT_SYSTEM_PROMPT,
    preset,
    signal,
  );
  if (second.type === 'error') return second;
  return { type: 'ok', text: second.text, usage: second.usage };
}

async function collectTranslation(
  messages: Message[],
  systemPrompt: string,
  preset: ModelPreset,
  signal: AbortSignal,
): Promise<TranslationResult> {
  const provider = getProvider(preset);
  let text = '';
  let usage: TranslationUsage | undefined;
  try {
    for await (const chunk of provider.stream(messages, systemPrompt, preset, signal)) {
      const mapped = mapChunk(chunk);
      if (!mapped) continue;
      if (mapped.type === 'error') {
        return { type: 'error', message: mapped.message };
      }
      if (mapped.type === 'text' && mapped.text) text += mapped.text;
      if (mapped.type === 'usage') usage = usageFromChunk(mapped);
    }
    return { type: 'ok', text, usage };
  } catch (err) {
    return {
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

function trimContext(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= TRANSLATE_CONTEXT_CHAR_LIMIT) return normalized;
  return `${normalized.slice(0, TRANSLATE_CONTEXT_CHAR_LIMIT)}…`;
}

function usageFromChunk(chunk: TranslateChunk): TranslationUsage {
  return {
    input: chunk.input ?? 0,
    output: chunk.output ?? 0,
    cacheRead: chunk.cacheRead,
  };
}

function addUsage(
  a: TranslationUsage | undefined,
  b: TranslationUsage | undefined,
): TranslationUsage | undefined {
  if (!a) return b;
  if (!b) return a;
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: (a.cacheRead ?? 0) + (b.cacheRead ?? 0),
  };
}

export function translationNeedsRetry(source: string, output: string): boolean {
  const trimmed = output.trim();
  if (!trimmed) return false;
  if (hasCjk(trimmed)) return false;
  return asciiWordCount(source) >= 4 && asciiWordCount(trimmed) >= 4;
}

export function cleanTranslationOutput(output: string): string {
  return output
    .trim()
    .replace(/^(?:译文|翻译|Translation|Translated text)\s*[:：]\s*/i, '')
    .trim();
}

function hasCjk(text: string): boolean {
  return /[\u3400-\u9fff]/.test(text);
}

function asciiWordCount(text: string): number {
  return text.match(/[A-Za-z][A-Za-z-]*/g)?.length ?? 0;
}

function mapChunk(chunk: StreamChunk): TranslateChunk | null {
  switch (chunk.type) {
    case 'text_delta':
      return { type: 'text', text: chunk.text };
    case 'error':
      return { type: 'error', message: chunk.message };
    case 'usage':
      return {
        type: 'usage',
        input: chunk.input,
        output: chunk.output,
        cacheRead: chunk.cacheRead,
      };
    default:
      return null;
  }
}
