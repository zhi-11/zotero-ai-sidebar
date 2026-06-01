import Anthropic from "@anthropic-ai/sdk";
import type { Message, Provider, StreamChunk } from "./types";
import {
  findClaudeDescriptor,
  type ModelPreset,
  type TranslateThinking,
} from "../settings/types";

export class AnthropicProvider implements Provider {
  async *stream(
    messages: Message[],
    systemPrompt: string,
    preset: ModelPreset,
    signal: AbortSignal,
  ): AsyncIterable<StreamChunk> {
    const client = new Anthropic({
      apiKey: preset.apiKey,
      ...(preset.baseUrl ? { baseURL: preset.baseUrl } : {}),
      dangerouslyAllowBrowser: true,
    });

    const requestBody: Record<string, unknown> = {
      model: preset.model,
      max_tokens: preset.maxTokens,
      system: [{ type: "text", text: systemPrompt }],
      messages: messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
    };
    const thinkingExtras = buildAnthropicThinking(preset);
    if (thinkingExtras) Object.assign(requestBody, thinkingExtras);

    let stream: AsyncIterable<unknown>;
    try {
      stream = (await client.messages.stream(
        requestBody as Parameters<typeof client.messages.stream>[0],
        { signal },
      )) as AsyncIterable<unknown>;
    } catch (err) {
      yield { type: "error", message: errorMessage(err) };
      return;
    }

    let latestUsage:
      | {
          input_tokens?: number;
          output_tokens?: number;
          cache_read_input_tokens?: number;
        }
      | undefined;
    try {
      for await (const event of stream) {
        const e = event as {
          type: string;
          delta?: { type: string; text?: string; thinking?: string };
          usage?: {
            input_tokens?: number;
            output_tokens?: number;
            cache_read_input_tokens?: number;
          };
        };
        if (e.type === "content_block_delta") {
          if (e.delta?.type === "text_delta" && e.delta.text != null) {
            yield { type: "text_delta", text: e.delta.text };
          } else if (
            e.delta?.type === "thinking_delta" &&
            e.delta.thinking != null
          ) {
            yield { type: "thinking_delta", text: e.delta.thinking };
          }
        } else if (e.type === "message_delta" && e.usage) {
          latestUsage = e.usage;
        }
      }
      if (latestUsage) {
        yield {
          type: "usage",
          input: latestUsage.input_tokens ?? 0,
          output: latestUsage.output_tokens ?? 0,
          cacheRead: latestUsage.cache_read_input_tokens,
        };
      }
    } catch (err) {
      yield { type: "error", message: errorMessage(err) };
    }
  }
}

function buildAnthropicThinking(preset: ModelPreset): Record<string, unknown> | null {
  const level = preset.extras?.translateThinking as TranslateThinking | undefined;
  if (!level || level === "off") return null;
  const vendor = preset.extras?.vendor ?? "compat";
  if (vendor === "compat") return null;
  if (vendor === "deepseek") {
    return {
      thinking: { type: "enabled" },
      output_config: { effort: deepSeekEffort(level) },
    };
  }

  const descriptor = findClaudeDescriptor(preset.model);
  if (descriptor.thinkingDialect === "adaptive") {
    return {
      thinking: { type: "adaptive" },
      output_config: {
        effort: level === "xhigh" && !descriptor.acceptsXhigh ? "max" : level,
      },
    };
  }
  return {
    thinking: {
      type: "enabled",
      budget_tokens: thinkingBudget(level),
    },
  };
}

function deepSeekEffort(level: Exclude<TranslateThinking, "off">): string {
  if (level === "xhigh") return "high";
  return level;
}

function thinkingBudget(level: Exclude<TranslateThinking, "off">): number {
  if (level === "low") return 1024;
  if (level === "medium") return 2048;
  if (level === "high") return 4096;
  return 8192;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
