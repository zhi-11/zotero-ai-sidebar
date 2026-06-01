import OpenAI from "openai";
import type { Message, Provider, StreamChunk } from "./types";
import type { ModelPreset } from "../settings/types";

interface ResponseUsage {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
}

interface ResponseEvent {
  type?: string;
  delta?: string;
  message?: string;
  response?: {
    error?: { message?: string } | null;
    usage?: ResponseUsage;
  };
}

const REQUEST_TIMEOUT_MS = 120_000;

export class OpenAIProvider implements Provider {
  async *stream(
    messages: Message[],
    systemPrompt: string,
    preset: ModelPreset,
    signal: AbortSignal,
  ): AsyncIterable<StreamChunk> {
    const client = new OpenAI({
      apiKey: preset.apiKey,
      ...(preset.baseUrl ? { baseURL: preset.baseUrl } : {}),
      timeout: REQUEST_TIMEOUT_MS,
      maxRetries: 0,
      dangerouslyAllowBrowser: true,
    });

    let stream: AsyncIterable<unknown>;
    try {
      if (shouldUseChatCompletions(preset)) {
        yield* this.streamChatCompletions(
          client,
          messages,
          systemPrompt,
          preset,
          signal,
        );
        return;
      }
      stream = (await client.responses.create(
        {
          model: preset.model,
          instructions: systemPrompt,
          input: messages.map((message) => ({
            role: message.role,
            content: message.content,
          })) as never,
          max_output_tokens: preset.maxTokens,
          stream: true,
          store: false,
          ...responsesReasoningParam(preset),
        },
        { signal },
      )) as unknown as AsyncIterable<unknown>;
    } catch (err) {
      yield { type: "error", message: errorMessage(err) };
      return;
    }

    try {
      for await (const event of stream) {
        const chunk = responseEventToChunk(event as ResponseEvent);
        if (chunk) yield chunk;
      }
    } catch (err) {
      yield { type: "error", message: errorMessage(err) };
    }
  }

  private async *streamChatCompletions(
    client: OpenAI,
    messages: Message[],
    systemPrompt: string,
    preset: ModelPreset,
    signal: AbortSignal,
  ): AsyncIterable<StreamChunk> {
    let stream: AsyncIterable<unknown>;
    try {
      stream = (await client.chat.completions.create(
        {
          model: preset.model,
          messages: [
            { role: "system", content: systemPrompt },
            ...messages.map((message) => ({
              role: message.role,
              content: message.content,
            })),
          ],
          max_tokens: preset.maxTokens,
          stream: true,
          stream_options: { include_usage: true },
          ...chatReasoningParam(preset),
        } as never,
        { signal },
      )) as unknown as AsyncIterable<unknown>;
    } catch (err) {
      yield { type: "error", message: errorMessage(err) };
      return;
    }

    try {
      for await (const event of stream) {
        const e = event as {
          choices?: Array<{
            delta?: { content?: string | null; reasoning_content?: string | null };
          }>;
          usage?: {
            prompt_tokens?: number;
            completion_tokens?: number;
            prompt_tokens_details?: { cached_tokens?: number };
            prompt_cache_hit_tokens?: number;
          };
        };
        const delta = e.choices?.[0]?.delta;
        if (delta?.reasoning_content) {
          yield { type: "thinking_delta", text: delta.reasoning_content };
        }
        if (delta?.content) yield { type: "text_delta", text: delta.content };
        if (e.usage) {
          yield {
            type: "usage",
            input: e.usage.prompt_tokens ?? 0,
            output: e.usage.completion_tokens ?? 0,
            cacheRead:
              e.usage.prompt_cache_hit_tokens ??
              e.usage.prompt_tokens_details?.cached_tokens,
          };
        }
      }
    } catch (err) {
      yield { type: "error", message: errorMessage(err) };
    }
  }
}

function responseEventToChunk(event: ResponseEvent): StreamChunk | null {
  switch (event.type) {
    case "response.output_text.delta":
      return event.delta ? { type: "text_delta", text: event.delta } : null;
    case "response.reasoning_text.delta":
    case "response.reasoning_summary_text.delta":
      return event.delta ? { type: "thinking_delta", text: event.delta } : null;
    case "response.completed": {
      const usage = event.response?.usage;
      return usage
        ? {
            type: "usage",
            input: usage.input_tokens ?? 0,
            output: usage.output_tokens ?? 0,
            cacheRead: usage.input_tokens_details?.cached_tokens,
          }
        : null;
    }
    case "response.failed":
      return {
        type: "error",
        message: event.response?.error?.message || "OpenAI response failed",
      };
    case "error":
      return { type: "error", message: event.message || "OpenAI stream error" };
    default:
      return null;
  }
}

function responsesReasoningParam(preset: ModelPreset): Record<string, unknown> {
  const effort = preset.extras?.reasoningEffort;
  if (!effort || effort === "none") return {};
  const summary = preset.extras?.reasoningSummary;
  return {
    reasoning: {
      effort,
      ...(summary && summary !== "none" ? { summary } : {}),
    },
  };
}

function chatReasoningParam(preset: ModelPreset): Record<string, unknown> {
  const effort = preset.extras?.reasoningEffort;
  if (isDeepSeekPreset(preset)) {
    if (!effort || effort === "none") {
      return { thinking: { type: "disabled" } };
    }
    return {
      thinking: { type: "enabled" },
      reasoning_effort: effort === "xhigh" ? "high" : effort,
    };
  }
  if (!effort || effort === "none") return {};
  return { reasoning_effort: effort === "xhigh" ? "high" : effort };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function shouldUseChatCompletions(preset: ModelPreset): boolean {
  return preset.extras?.openaiUseChatCompletions === true || isDeepSeekPreset(preset);
}

function isDeepSeekPreset(preset: ModelPreset): boolean {
  const baseUrl = preset.baseUrl.toLowerCase();
  const model = preset.model.toLowerCase();
  return baseUrl.includes("deepseek") || model.startsWith("deepseek-");
}
