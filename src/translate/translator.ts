import { getProvider } from "../providers/factory";
import type { Message, StreamChunk } from "../providers/types";
import type {
  ModelPreset,
  ReasoningEffort,
  TranslateThinking,
} from "../settings/types";

const SYSTEM_PROMPT =
  "英译中。只输出简体中文译文；术语、缩写、公式、模型名可保留原文。";

const STRICT_SYSTEM_PROMPT =
  "英译中，只输出含中文的译文；不要英文改写、解释或引号。";
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
  type: "text" | "usage" | "error" | "done";
  text?: string;
  message?: string;
  input?: number;
  output?: number;
  cacheRead?: number;
}

type TranslationResult =
  | { type: "ok"; text: string; usage?: TranslationUsage }
  | { type: "error"; message?: string };

interface TranslationUsage {
  input: number;
  output: number;
  cacheRead?: number;
}

const THINKING_TO_EFFORT: Record<TranslateThinking, ReasoningEffort> = {
  off: "none",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
};

// Per-provider preset adjustments for the translate flow. OpenAI path is
// kept identical to the previous behavior; the Anthropic path adds a
// translate-only thinking signal and bumps maxTokens because Anthropic's
// max_tokens covers thinking + visible output (the OpenAI 384 cap would
// starve any thinking budget).
export function buildTranslatePreset(req: TranslateRequest): ModelPreset {
  const model = req.model || req.preset.model;
  if (req.preset.provider === "openai") {
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
        reasoningSummary: "none",
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
  const vendor = preset.extras?.vendor ?? "compat";
  // No thinking → no need to grow the cap; keep it at the OpenAI-equivalent
  // tight ceiling. Same for compat vendor (already non-thinking).
  if (vendor === "compat" || level === "off") {
    return Math.min(
      preset.maxTokens || TRANSLATE_MAX_OUTPUT_TOKENS,
      TRANSLATE_MAX_OUTPUT_TOKENS,
    );
  }
  // For Claude old-mode (enabled+budget_tokens), the budget must be < max_tokens.
  // Pad max_tokens above the budget to leave room for the visible reply.
  const budgetCeiling: Record<Exclude<TranslateThinking, "off">, number> = {
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
  const label = req.contextLabel || "参考";
  return `${label}：${trimContext(req.contextText)}\n原文：${sentence}`;
}

export async function* translateSentence(
  req: TranslateRequest,
): AsyncIterable<TranslateChunk> {
  const overriddenPreset = buildTranslatePreset(req);

  const messages: Message[] = [
    { role: "user", content: buildUserMessage(req) },
  ];

  const first = await collectTranslation(
    messages,
    SYSTEM_PROMPT,
    overriddenPreset,
    req.signal,
  );
  if (first.type === "error") {
    yield first;
    return;
  }

  const retried = translationNeedsRetry(req.sentence, first.text);
  const result = retried
    ? await retryStrictTranslation(messages, overriddenPreset, req.signal)
    : { type: "ok" as const, text: first.text };

  if (result.type === "error") {
    yield result;
    return;
  }
  yield { type: "text", text: cleanTranslationOutput(result.text) };
  const usage = retried ? addUsage(first.usage, result.usage) : first.usage;
  if (usage) yield { type: "usage", ...usage };
  yield { type: "done" };
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
  if (second.type === "error") return second;
  return { type: "ok", text: second.text, usage: second.usage };
}

async function collectTranslation(
  messages: Message[],
  systemPrompt: string,
  preset: ModelPreset,
  signal: AbortSignal,
): Promise<TranslationResult> {
  const provider = getProvider(preset);
  let text = "";
  let usage: TranslationUsage | undefined;
  try {
    for await (const chunk of provider.stream(
      messages,
      systemPrompt,
      preset,
      signal,
    )) {
      const mapped = mapChunk(chunk);
      if (!mapped) continue;
      if (mapped.type === "error") {
        return { type: "error", message: mapped.message };
      }
      if (mapped.type === "text" && mapped.text) text += mapped.text;
      if (mapped.type === "usage") usage = usageFromChunk(mapped);
    }
    return { type: "ok", text, usage };
  } catch (err) {
    return {
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

function trimContext(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
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
    .replace(/^(?:译文|翻译|Translation|Translated text)\s*[:：]\s*/i, "")
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
    case "text_delta":
      return { type: "text", text: chunk.text };
    case "error":
      return { type: "error", message: chunk.message };
    case "usage":
      return {
        type: "usage",
        input: chunk.input,
        output: chunk.output,
        cacheRead: chunk.cacheRead,
      };
    default:
      return null;
  }
}

export interface AnalysisBlock {
  text: string;
  role: string;
  meaning: string;
  isClause?: boolean;
  children?: AnalysisBlock[];
}

export interface AnalysisResult {
  blocks: AnalysisBlock[];
}

const ANALYSIS_SYSTEM_PROMPT = `你是英语语法分析专家。分析句子结构，输出嵌套 JSON。

句子成分 role 只能用这 9 种：
主语、谓语、宾语、表语、定语、状语、补语、同位语、连接词

每个条目包含：
- "text": 原文片段
- "role": 上述 9 种成分之一，或从句类型（定语从句/状语从句/宾语从句/主语从句/表语从句/同位语从句）
- "meaning": 中文释义
- "isClause": true 表示该条目是一个从句
- "children": 从句内部成分数组（仅 isClause=true 时有此字段）

规则：
1. 介词 (of/in/on/at/to/for/from/by/with) 与宾语合并为状语或定语，不单独列出
2. 冠词 (a/an/the) 与名词合并
3. 连接词 (and/or/but) 独立条目，meaning=""
4. isClause=true 只用于完整主谓结构从句。不算从句：to do不定式、动名词短语、分词短语、介词短语、仅有连接词但无完整主谓的短语不是从句
5. 从句通常由连接词开头（that/which/who/when/where/why/how/if/whether/because/although/while/since/unless）
6. 括号内引用 (Author, 2020)/(Fig. 1A) 保持原文，meaning=""
7. 标点符号独立条目，role="标点"，meaning=""
8. 术语、学名给出准确中文译名
9. 只输出 JSON 数组
10. 先标主干，再标从句和修饰语，保持原文顺序

原文：{sentence}`;

export async function analyzeSentence(
  sentence: string,
  preset: ModelPreset,
  model: string,
  signal: AbortSignal,
): Promise<AnalysisResult> {
  const provider = getProvider(preset);
  const overriddenPreset = buildTranslatePreset({
    sentence,
    preset,
    model: model || preset.model,
    thinking: "off",
    signal,
  });
  overriddenPreset.maxTokens = Math.max(overriddenPreset.maxTokens, 2048);
  const prompt = ANALYSIS_SYSTEM_PROMPT.replace("{sentence}", sentence.trim());
  const messages: Message[] = [{ role: "user", content: prompt }];
  let text = "";
  try {
    for await (const chunk of provider.stream(
      messages,
      "",
      overriddenPreset,
      signal,
    )) {
      if (chunk.type === "text_delta" && chunk.text) text += chunk.text;
      if (chunk.type === "error") throw new Error(chunk.message);
    }
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : String(err));
  }
  const json = text.replace(/```(?:json)?\s*([\s\S]*?)\s*```/g, "$1").trim();
  try {
    return { blocks: JSON.parse(json) as AnalysisBlock[] };
  } catch {
    const match = /\[[\s\S]*\]/.exec(json);
    if (match) return { blocks: JSON.parse(match[0]) as AnalysisBlock[] };
    throw new Error("无法解析分析结果");
  }
}

export interface ExplainRequest extends TranslateRequest {
  prompt: string;
}

export interface ExplainResult {
  text: string;
}

export interface QuestionAnswerEntry {
  question: string;
  answer: string;
}

export interface QuestionRequest extends TranslateRequest {
  question: string;
  translation?: string;
  history?: QuestionAnswerEntry[];
}

const QUESTION_SYSTEM_PROMPT =
  "你是学术论文阅读助手。请依据目标句、译文和上下文，用简体中文直接回答问题。答案应准确、简短，通常不超过三句话；信息不足时明确说明，不要编造。只输出答案。";
const QUESTION_MAX_OUTPUT_TOKENS = 320;

export async function answerSentenceQuestion(
  req: QuestionRequest,
): Promise<QuestionAnswerEntry> {
  const provider = getProvider(req.preset);
  // Q&A is deliberately non-thinking and tightly capped: it is an on-demand
  // reading aid, not a second long-form explanation mode.
  const preset = buildTranslatePreset({ ...req, thinking: "off" });
  preset.maxTokens = Math.min(
    req.preset.maxTokens || QUESTION_MAX_OUTPUT_TOKENS,
    QUESTION_MAX_OUTPUT_TOKENS,
  );
  const messages: Message[] = [
    { role: "user", content: buildQuestionUserMessage(req) },
  ];
  let text = "";
  try {
    for await (const chunk of provider.stream(
      messages,
      QUESTION_SYSTEM_PROMPT,
      preset,
      req.signal,
    )) {
      if (chunk.type === "text_delta" && chunk.text) text += chunk.text;
      if (chunk.type === "error") throw new Error(chunk.message);
    }
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : String(err));
  }
  const answer = text.trim();
  if (!answer) throw new Error("模型没有返回答案");
  return { question: req.question.trim(), answer };
}

function buildQuestionUserMessage(req: QuestionRequest): string {
  const parts = [`目标句：${req.sentence.trim()}`];
  if (req.translation?.trim()) parts.push(`译文：${req.translation.trim()}`);
  if (req.contextText?.trim()) {
    parts.push(
      `${req.contextLabel || "论文上下文"}：${trimExplainContext(req.contextText)}`,
    );
  }
  const history = (req.history ?? []).slice(-4);
  if (history.length) {
    parts.push(
      `此前问答：\n${history
        .map((entry) => `Q：${entry.question}\nA：${entry.answer}`)
        .join("\n")}`,
    );
  }
  parts.push(`当前问题：${req.question.trim()}`);
  return parts.join("\n");
}

const EXPLAIN_CONTEXT_CHAR_LIMIT = 4000;
const EXPLAIN_MAX_OUTPUT_TOKENS = 1600;

export async function explainSentence(
  req: ExplainRequest,
): Promise<ExplainResult> {
  const provider = getProvider(req.preset);
  const overriddenPreset = buildLongFormPreset(req);
  const messages: Message[] = [
    {
      role: "user",
      content: buildExplainUserMessage(req),
    },
  ];
  let text = "";
  try {
    for await (const chunk of provider.stream(
      messages,
      req.prompt,
      overriddenPreset,
      req.signal,
    )) {
      if (chunk.type === "text_delta" && chunk.text) text += chunk.text;
      if (chunk.type === "error") throw new Error(chunk.message);
    }
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : String(err));
  }
  const result = text.trim();
  if (!result) throw new Error("模型没有返回详解内容");
  return { text: result };
}

function buildLongFormPreset(req: ExplainRequest): ModelPreset {
  const preset = buildTranslatePreset(req);
  if (preset.provider === "openai") {
    return {
      ...preset,
      maxTokens: Math.min(
        req.preset.maxTokens || EXPLAIN_MAX_OUTPUT_TOKENS,
        EXPLAIN_MAX_OUTPUT_TOKENS,
      ),
    };
  }
  return {
    ...preset,
    maxTokens: Math.max(preset.maxTokens, EXPLAIN_MAX_OUTPUT_TOKENS),
  };
}

function buildExplainUserMessage(req: ExplainRequest): string {
  const sentence = req.sentence.trim();
  if (!req.contextText) return `待详解句子：${sentence}`;
  const label = req.contextLabel || "论文上下文";
  return `${label}（仅用于理解目标句）：${trimExplainContext(req.contextText)}
待详解句子：${sentence}`;
}

function trimExplainContext(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= EXPLAIN_CONTEXT_CHAR_LIMIT) return normalized;
  return `${normalized.slice(0, EXPLAIN_CONTEXT_CHAR_LIMIT)}…`;
}
