import Anthropic from '@anthropic-ai/sdk';
import type { Provider, Message, ProviderStreamOptions, StreamChunk } from './types';
import {
  findClaudeDescriptor,
  type AnthropicVendor,
  type ModelPreset,
  type ReasoningEffort,
  type TranslateThinking,
} from '../settings/types';

// Anthropic Messages-streaming adapter.
// GOTCHA: this adapter does NOT yet implement the agent tool loop. The
// Codex-style harness/tools flow currently runs only on the OpenAI Responses
// path. `_options.tools` is intentionally ignored — switching providers in
// the sidebar disables Zotero tools for that turn.
// REF: providers/openai.ts for the tool-loop reference implementation.
export class AnthropicProvider implements Provider {
  async *stream(
    messages: Message[],
    systemPrompt: string,
    preset: ModelPreset,
    signal: AbortSignal,
    _options: ProviderStreamOptions = {},
  ): AsyncIterable<StreamChunk> {
    const client = new Anthropic({
      apiKey: preset.apiKey,
      ...(preset.baseUrl ? { baseURL: preset.baseUrl } : {}),
      dangerouslyAllowBrowser: true,
    });

    const baseRequest = {
      model: preset.model,
      max_tokens: preset.maxTokens,
      // WHY: mark the system prompt as `ephemeral` so Anthropic prompt
      // caching kicks in across turns — the prompt is large (paper
      // metadata + context plan) and stable for the duration of the
      // current Zotero item's chat thread.
      // REF: Anthropic prompt-caching docs; cache_control TTL is short.
      system: [
        { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
      ],
      messages: toAnthropicMessages(messages),
    };
    // Thinking config is opt-in: the translator writes `extras.translateThinking`
    // before calling stream(); the chat path never sets it, so chat behavior is
    // unchanged. SDK 0.91 doesn't type `output_config`/adaptive thinking yet,
    // so we cast to a permissive shape and let the SDK forward it as JSON.
    const requestBody: Record<string, unknown> = { ...baseRequest };
    const thinkingExtras = buildAnthropicThinking(preset);
    if (thinkingExtras) Object.assign(requestBody, thinkingExtras);

    let stream: AsyncIterable<unknown>;
    try {
      stream = (await client.messages.stream(
        requestBody as Parameters<typeof client.messages.stream>[0],
        { signal },
      )) as AsyncIterable<unknown>;
    } catch (err) {
      yield { type: 'error', message: errMsg(err) };
      return;
    }

    try {
      for await (const event of stream) {
        const e = event as {
          type: string;
          delta?: { type: string; text?: string; thinking?: string };
          usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
        };
        if (e.type === 'content_block_delta') {
          if (e.delta?.type === 'text_delta' && e.delta.text != null) {
            yield { type: 'text_delta', text: e.delta.text };
          } else if (e.delta?.type === 'thinking_delta' && e.delta.thinking != null) {
            yield { type: 'thinking_delta', text: e.delta.thinking };
          }
        } else if (e.type === 'message_delta' && e.usage) {
          yield {
            type: 'usage',
            input: e.usage.input_tokens ?? 0,
            output: e.usage.output_tokens ?? 0,
            cacheRead: e.usage.cache_read_input_tokens,
          };
        }
      }
    } catch (err) {
      yield { type: 'error', message: errMsg(err) };
    }
  }
}

type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | {
      type: 'image';
      source: {
        type: 'base64';
        media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
        data: string;
      };
    };

export function toAnthropicMessages(
  messages: Message[],
): Array<{ role: Message['role']; content: string | AnthropicContentBlock[] }> {
  return messages.map((message) => {
    if (!message.images?.length) {
      return { role: message.role, content: message.content };
    }

    const content: AnthropicContentBlock[] = [];
    if (message.content) {
      content.push({ type: 'text', text: message.content });
    }
    message.images.forEach((image, index) => {
      const label = image.marker ?? `[Image #${index + 1}]`;
      content.push({ type: 'text', text: `<image name=${label}>` });
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: anthropicImageMediaType(image.mediaType),
          data: dataUrlPayload(image.dataUrl),
        },
      });
      content.push({ type: 'text', text: '</image>' });
    });
    return { role: message.role, content };
  });
}

function anthropicImageMediaType(
  mediaType: string,
): 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' {
  switch (mediaType) {
    case 'image/jpeg':
    case 'image/png':
    case 'image/gif':
    case 'image/webp':
      return mediaType;
    default:
      return 'image/png';
  }
}

// GOTCHA: Anthropic's image source expects raw base64, NOT a `data:` URL.
// We strip the `data:image/png;base64,` prefix here. OpenAI takes the full
// data-URL via `input_image.image_url`, so the providers diverge on this.
function dataUrlPayload(dataUrl: string): string {
  const comma = dataUrl.indexOf(',');
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Anthropic's thinking configuration has three dialects we have to dispatch
// between (see settings/types.ts AnthropicVendor for the rationale):
//
//   - Claude (modern: Opus 4.7 / 4.6, Sonnet 4.6, Mythos):
//       thinking: { type: "adaptive" } + output_config: { effort }
//     Opus 4.7 REJECTS the legacy `enabled` mode with a 400.
//
//   - Claude (older: Sonnet 4.5/Haiku 4.5/etc.):
//       thinking: { type: "enabled", budget_tokens: N }
//     `output_config.effort` is unsupported on these models.
//
//   - DeepSeek (Anthropic-format endpoint):
//       thinking: { type: "enabled" } + output_config: { effort }
//     Per DeepSeek docs they accept low/medium/high/xhigh/max and collapse
//     low|medium → high and xhigh → max internally.
//
// Returning `null` means the chat/connectivity path: send no thinking field
// and the existing AnthropicProvider behavior holds. The translator opts in
// by writing `extras.translateThinking`; nothing else writes that field.
export function buildAnthropicThinking(
  preset: ModelPreset,
): Record<string, unknown> | null {
  // Translate flow writes a transient `extras.translateThinking` (with an
  // explicit "off" choice). Chat flow doesn't — instead we read the
  // persisted reasoningEffort the user picked in the composer footer / the
  // preset card. Compat vendor is never given a thinking field regardless.
  const level: TranslateThinking | null =
    preset.extras?.translateThinking ?? reasoningEffortToThinking(preset.extras?.reasoningEffort);
  if (!level) return null;
  const vendor: AnthropicVendor = preset.extras?.vendor ?? 'compat';
  if (vendor === 'compat') return null;
  // Explicit "off". Claude defaults to no-thinking when the field is omitted,
  // so for vendor=claude we just return null. DeepSeek is the opposite —
  // its `thinking` default is `enabled`, so we MUST send `disabled` to
  // actually turn thinking off; otherwise the API still thinks.
  if (level === 'off') {
    return vendor === 'deepseek' ? { thinking: { type: 'disabled' } } : null;
  }
  if (vendor === 'deepseek') {
    return {
      thinking: { type: 'enabled' },
      // DeepSeek only exposes 'high' and 'max' effectively (per their
      // Anthropic-format docs note 3: low/medium → high, xhigh → max).
      // Pre-collapse so the wire body matches what actually takes effect
      // — UI also restricts to these two for new selections.
      output_config: { effort: deepseekEffort(level) },
    };
  }
  const descriptor = findClaudeDescriptor(preset.model);
  if (descriptor.thinkingDialect === 'adaptive') {
    return {
      thinking: { type: 'adaptive' },
      output_config: { effort: claudeAdaptiveEffort(descriptor, level) },
    };
  }
  return {
    thinking: { type: 'enabled', budget_tokens: claudeBudgetTokens(level) },
  };
}

// Helpers below only ever run for non-'off' levels — buildAnthropicThinking
// short-circuits the 'off' case before reaching either of them.
type ActiveThinking = Exclude<TranslateThinking, 'off'>;

function deepseekEffort(level: ActiveThinking): 'high' | 'max' {
  return level === 'xhigh' ? 'max' : 'high';
}

// Map the preset's reasoningEffort (OpenAI-shaped enum) onto our internal
// TranslateThinking levels for the chat flow. The 'none' / 'minimal' values
// — which OpenAI exposes for "no/very-light reasoning" — get folded into
// 'off' so the UX stays "thinking on" by default; setting effort to 'low'
// or above is what actually triggers Anthropic thinking on chat.
function reasoningEffortToThinking(
  effort: ReasoningEffort | undefined,
): TranslateThinking | null {
  if (!effort) return null;
  if (effort === 'none' || effort === 'minimal') return 'off';
  return effort;
}

function claudeAdaptiveEffort(
  descriptor: { acceptsXhigh?: boolean },
  level: ActiveThinking,
): string {
  // xhigh is Opus-4.7-only per Anthropic's effort-availability matrix; on
  // Sonnet 4.6 / Opus 4.6 we promote it to `max` (the next strongest level
  // they actually accept) so xhigh users still get heavy thinking.
  if (level === 'xhigh' && !descriptor.acceptsXhigh) return 'max';
  return level;
}

function claudeBudgetTokens(level: ActiveThinking): number {
  switch (level) {
    case 'low':
      return 1024;
    case 'medium':
      return 2048;
    case 'high':
      return 4096;
    case 'xhigh':
      return 8192;
  }
}
