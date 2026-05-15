import OpenAI from 'openai';
import type {
  AgentTool,
  Message,
  Provider,
  ProviderStreamOptions,
  StreamChunk,
  ToolExecutionResult,
} from './types';
import type {
  ModelPreset,
  ReasoningEffort,
  ReasoningSummary,
} from '../settings/types';
import type { ToolSettings } from '../settings/tool-settings';
import { DEFAULT_CONTEXT_POLICY } from '../context/policy';

const OPENAI_REQUEST_TIMEOUT_MS = 120_000;
const OPENAI_FIRST_EVENT_TIMEOUT_MS = 60_000;

// OpenAI Responses-API tool loop. Three load-bearing decisions, all aligned
// with OpenAI Codex's harness model:
//
// 1. INVARIANT: `store: false`. We do NOT rely on server-persisted response
//    item IDs. Every iteration re-sends the full conversation `input` —
//    user/assistant turns, function calls, function-call outputs.
//    GOTCHA: previously we tried to chain via `previous_response_id`; that
//    broke the moment a turn had `store:false` (no persisted ID).
//    REF: CLAUDE.md "Development Lessons", Codex `responses/streaming.rs`.
//
// 2. INVARIANT: `parallel_tool_calls: false`. Tools run strictly sequentially
//    so each tool's output is in the input list before the next call is
//    issued. WHY: lets later calls see earlier passages/ranges in the same
//    turn (the typical Codex "search → read range" pattern).
//
// 3. `maxToolIterations` is a SAFETY FUSE, not routing logic. We do not
//    branch behavior on iteration count; we only stop the loop when the
//    fuse blows. Default comes from policy (single source of truth).

interface ResponseUsage {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
}

type ResponseEvent = {
  type?: string;
  delta?: string;
  item_id?: string;
  message?: string;
  item?: ResponseOutputItemLike;
  response?: {
    error?: { message?: string } | null;
    usage?: ResponseUsage;
  };
};

type ResponseOutputItemLike =
  | ResponseFunctionCallLike
  | ResponseMessageLike
  | ResponseReasoningLike
  | ResponseMcpCallLike
  | ResponseMcpListToolsLike
  | ResponseMcpApprovalRequestLike;

export interface ResponseFunctionCallLike {
  type: 'function_call';
  call_id: string;
  name: string;
  arguments: string;
}

interface ResponseMessageLike {
  type: 'message';
  role?: 'assistant';
  content?: Array<{ type?: string; text?: string; refusal?: string }>;
}

interface ResponseReasoningLike {
  type: 'reasoning';
  summary?: Array<{ text?: string }>;
}

interface ResponseMcpCallLike {
  type: 'mcp_call';
  id: string;
  server_label: string;
  name: string;
  status?: 'in_progress' | 'completed' | 'incomplete' | 'calling' | 'failed';
  error?: string | null;
}

interface ResponseMcpListToolsLike {
  type: 'mcp_list_tools';
  id: string;
  server_label: string;
  tools?: Array<{ name?: string }>;
  error?: string | null;
}

interface ResponseMcpApprovalRequestLike {
  type: 'mcp_approval_request';
  id: string;
  server_label: string;
  name: string;
}

interface FunctionCallOutputItem {
  type: 'function_call_output';
  call_id: string;
  output: string;
}

export class OpenAIProvider implements Provider {
  async *stream(
    messages: Message[],
    systemPrompt: string,
    preset: ModelPreset,
    signal: AbortSignal,
    options: ProviderStreamOptions = {},
  ): AsyncIterable<StreamChunk> {
    const client = new OpenAI({
      apiKey: preset.apiKey,
      ...(preset.baseUrl ? { baseURL: preset.baseUrl } : {}),
      timeout: OPENAI_REQUEST_TIMEOUT_MS,
      maxRetries: 0,
      dangerouslyAllowBrowser: true,
    });

    if (preset.extras?.openaiUseChatCompletions) {
      yield* this.streamChatCompletions(client, messages, systemPrompt, preset, signal, options);
      return;
    }

    const hostedTools = openAIHostedToolSpecs(options.toolSettings);
    if (options.tools?.length || hostedTools.length) {
      yield* this.streamWithTools(
        client,
        messages,
        systemPrompt,
        preset,
        signal,
        options,
      );
      return;
    }

    let stream: AsyncIterable<unknown>;
    try {
      stream = (await client.responses.create(
        {
          model: preset.model,
          instructions: systemPrompt,
          input: toOpenAIInput(messages) as never,
          ...maxOutputTokensParam(preset),
          ...promptCacheParams(preset, options),
          reasoning: reasoningOptions(preset),
          stream: true,
          store: false,
        },
        { signal },
      )) as unknown as AsyncIterable<unknown>;
    } catch (err) {
      yield { type: 'error', message: errMsg(err) };
      return;
    }

    try {
      for await (const event of streamEventsWithFirstEventTimeout(
        stream,
        signal,
      )) {
        const chunk = responseEventToChunk(event as ResponseEvent);
        if (chunk) yield chunk;
      }
    } catch (err) {
      yield { type: 'error', message: errMsg(err) };
    }
  }

  private async *streamChatCompletions(
    client: OpenAI,
    messages: Message[],
    systemPrompt: string,
    preset: ModelPreset,
    signal: AbortSignal,
    options: ProviderStreamOptions = {},
  ): AsyncIterable<StreamChunk> {
    const tools = options.tools ?? [];
    const toolMap = new Map(tools.map((t) => [t.name, t]));
    const chatTools = tools.length ? tools.map(chatCompletionToolSpec) : undefined;
    const maxIterations = options.maxToolIterations ?? DEFAULT_CONTEXT_POLICY.maxToolIterations;

    // Accumulate the full conversation including tool turns across iterations.
    const chatMessages: ChatMessage[] = toChatMessages(messages, systemPrompt);
    let frontBlock: string | undefined = options.pinnedFullText;

    for (let iteration = 0; iteration <= maxIterations; iteration++) {
      let stream: AsyncIterable<unknown>;
      try {
        stream = (await client.chat.completions.create(
          {
            model: preset.model,
            messages: withFrontBlock(
              chatMessages as Array<{ role?: string; content?: unknown }>,
              frontBlock,
            ) as ChatMessage[],
            max_tokens: preset.maxTokens,
            stream: true,
            stream_options: { include_usage: true },
            ...promptCacheParams(preset, options),
            ...(chatTools ? { tools: chatTools, tool_choice: 'auto', parallel_tool_calls: false } : {}),
            ...chatCompletionReasoningParam(preset),
          } as never,
          { signal },
        )) as unknown as AsyncIterable<unknown>;
      } catch (err) {
        yield { type: 'error', message: errMsg(err) };
        return;
      }

      // Accumulate streaming deltas into a complete assistant message.
      let textContent = '';
      // DeepSeek (and some relays) stream reasoning_content separately. It must
      // be passed back verbatim in the assistant message for the next turn or
      // the API returns 400 "reasoning_content must be passed back".
      let reasoningContent = '';
      const toolCallsAcc: Map<number, { id: string; name: string; arguments: string }> = new Map();
      let finishReason: string | null = null;
      let usage: ChatCompletionUsage | undefined;

      try {
        for await (const event of stream) {
          const e = event as ChatCompletionEvent;
          const choice = e.choices?.[0];
          if (choice) {
            const delta = choice.delta;
            if (delta?.reasoning_content) {
              reasoningContent += delta.reasoning_content;
              yield { type: 'thinking_delta', text: delta.reasoning_content };
            }
            if (delta?.content) {
              textContent += delta.content;
              yield { type: 'text_delta', text: delta.content };
            }
            // Accumulate tool call fragments by index.
            // GOTCHA: initialize name/arguments to '' then only use +=.
            // Initializing from the first delta AND then doing += doubles the name.
            for (const tc of delta?.tool_calls ?? []) {
              const idx = tc.index ?? 0;
              if (!toolCallsAcc.has(idx)) {
                toolCallsAcc.set(idx, { id: tc.id ?? '', name: '', arguments: '' });
              }
              const acc = toolCallsAcc.get(idx)!;
              if (tc.id) acc.id = tc.id;
              if (tc.function?.name) acc.name += tc.function.name;
              if (tc.function?.arguments) acc.arguments += tc.function.arguments;
            }
            if (choice.finish_reason) finishReason = choice.finish_reason;
          }
          if (e.usage) usage = e.usage;
        }
      } catch (err) {
        yield { type: 'error', message: errMsg(err) };
        return;
      }

      if (usage) yield chatUsageChunk(usage);

      // No tool calls — natural exit.
      if (finishReason !== 'tool_calls' || toolCallsAcc.size === 0) {
        return;
      }

      // Build the assistant message with tool_calls and append to history.
      const toolCallItems = Array.from(toolCallsAcc.entries())
        .sort(([a], [b]) => a - b)
        .map(([, tc]) => ({ id: tc.id, type: 'function' as const, function: { name: tc.name, arguments: tc.arguments } }));

      chatMessages.push({
        role: 'assistant',
        content: textContent || null,
        ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
        tool_calls: toolCallItems,
      } as ChatMessage);

      // Execute each tool and append role:tool messages.
      for (const tc of toolCallItems) {
        yield { type: 'tool_call', name: tc.function.name, status: 'started', summary: `调用 Zotero 工具: ${tc.function.name}` };
        const callLike: ResponseFunctionCallLike = {
          type: 'function_call',
          call_id: tc.id,
          name: tc.function.name,
          arguments: tc.function.arguments,
        };
        const result = await executeToolCall(callLike, toolMap, signal, options.permissionMode ?? 'default');
        if (result.result.frontBlock) frontBlock = result.result.frontBlock;
        yield { type: 'tool_call', name: tc.function.name, status: result.status, summary: result.result.summary, context: result.result.context };
        chatMessages.push({ role: 'tool', tool_call_id: tc.id, content: result.result.output } as ChatMessage);
      }
    }

    yield { type: 'error', message: 'Tool loop stopped because the model exceeded the local tool iteration limit.' };
  }

  private async *streamWithTools(
    client: OpenAI,
    messages: Message[],
    systemPrompt: string,
    preset: ModelPreset,
    signal: AbortSignal,
    options: ProviderStreamOptions,
  ): AsyncIterable<StreamChunk> {
    const tools = options.tools ?? [];
    const openAITools = [
      ...tools.map(openAIToolSpec),
      ...openAIHostedToolSpecs(options.toolSettings),
    ];
    const toolMap = new Map(tools.map((tool) => [tool.name, tool]));
    // `input` accumulates across iterations: original messages, then each
    // function_call we replay, then each function_call_output we synthesize
    // from local tool execution. The model sees the same shape every turn.
    const input: unknown[] = toOpenAIInput(messages);
    let frontBlock: string | undefined = options.pinnedFullText;
    const maxIterations =
      options.maxToolIterations ?? DEFAULT_CONTEXT_POLICY.maxToolIterations;

    for (let iteration = 0; iteration <= maxIterations; iteration++) {
      let stream: AsyncIterable<unknown>;
      try {
        stream = (await client.responses.create(
          {
            model: preset.model,
            instructions: systemPrompt,
            input: withFrontBlock(
              input as Array<{ role?: string; content?: unknown }>,
              frontBlock,
            ),
            ...maxOutputTokensParam(preset),
            ...promptCacheParams(preset, options),
            reasoning: reasoningOptions(preset),
            tools: openAITools,
            tool_choice: 'auto',
            parallel_tool_calls: false,
            stream: true,
            store: false,
          } as never,
          { signal },
        )) as unknown as AsyncIterable<unknown>;
      } catch (err) {
        yield { type: 'error', message: errMsg(err) };
        return;
      }

      const output: ResponseOutputItemLike[] = [];
      const calls: ResponseFunctionCallLike[] = [];
      let usage: ResponseUsage | undefined;
      let failed = false;

      try {
        for await (const event of streamEventsWithFirstEventTimeout(
          stream,
          signal,
        )) {
          const e = event as ResponseEvent;
          switch (e.type) {
            case 'response.created':
              yield {
                type: 'status',
                message: 'OpenAI 已接收请求，等待模型开始处理',
              };
              break;
            case 'response.in_progress':
              yield {
                type: 'status',
                message: hostedToolsStatus(options.toolSettings),
              };
              break;
            case 'response.output_text.delta':
              if (e.delta) yield { type: 'text_delta', text: e.delta };
              break;
            case 'response.reasoning_text.delta':
            case 'response.reasoning_summary_text.delta':
              if (e.delta) yield { type: 'thinking_delta', text: e.delta };
              break;
            case 'response.output_item.done':
              if (e.item) {
                output.push(e.item);
                if (isFunctionCall(e.item)) calls.push(e.item);
                const hostedChunk = hostedOutputItemToChunk(e.item);
                if (hostedChunk) yield hostedChunk;
              }
              break;
            case 'response.web_search_call.in_progress':
              yield {
                type: 'tool_call',
                name: 'web_search',
                status: 'started',
                summary: '正在使用内置联网搜索',
              };
              break;
            case 'response.web_search_call.searching':
              break;
            case 'response.web_search_call.completed':
              yield {
                type: 'tool_call',
                name: 'web_search',
                status: 'completed',
                summary: '内置联网搜索完成',
              };
              break;
            case 'response.completed':
              usage = e.response?.usage;
              break;
            case 'response.failed':
              yield {
                type: 'error',
                message: e.response?.error?.message || 'OpenAI response failed',
              };
              failed = true;
              break;
            case 'error':
              yield {
                type: 'error',
                message: e.message || 'OpenAI stream error',
              };
              failed = true;
              break;
            default:
              break;
          }
          if (failed) break;
        }
      } catch (err) {
        yield { type: 'error', message: errMsg(err) };
        return;
      }

      if (failed) return;

      if (usage) yield usageChunk(usage);

      // Natural exit: model produced text-only output. No tool calls ⇒ done.
      if (calls.length === 0) {
        return;
      }

      // Replay function_call items into `input` BEFORE running them. The
      // Responses API requires the call to appear in the request that also
      // contains its function_call_output, otherwise the next turn errors.
      input.push(...calls.map(functionCallReplayItem));

      for (const call of calls) {
        yield {
          type: 'tool_call',
          name: call.name,
          status: 'started',
          summary: `调用 Zotero 工具: ${call.name}`,
        };
        const result = await executeToolCall(
          call,
          toolMap,
          signal,
          options.permissionMode ?? 'default',
        );
        if (result.result.frontBlock) frontBlock = result.result.frontBlock;
        yield {
          type: 'tool_call',
          name: call.name,
          status: result.status,
          summary: result.result.summary,
          context: result.result.context,
        };
        input.push({
          type: 'function_call_output',
          call_id: call.call_id,
          output: result.result.output,
        } satisfies FunctionCallOutputItem);
      }
    }

    // Safety-fuse blew. INVARIANT: never silently truncate; surface as error
    // so the user can see the loop bound was the limiter, not the model.
    yield {
      type: 'error',
      message:
        'Tool loop stopped because the model exceeded the local tool iteration limit.',
    };
  }
}

export function functionCallReplayItem(
  call: ResponseFunctionCallLike,
): ResponseFunctionCallLike {
  return {
    type: 'function_call',
    call_id: call.call_id,
    name: call.name,
    arguments: call.arguments,
  };
}

async function executeToolCall(
  call: ResponseFunctionCallLike,
  toolMap: Map<string, AgentTool>,
  signal: AbortSignal,
  permissionMode: 'default' | 'yolo',
): Promise<{ status: 'completed' | 'error'; result: ToolExecutionResult }> {
  if (signal.aborted) {
    return {
      status: 'error',
      result: { output: 'Tool call aborted.', summary: '工具调用已停止' },
    };
  }

  const tool = toolMap.get(call.name);
  if (!tool) {
    return {
      status: 'error',
      result: {
        output: `Unknown local tool: ${call.name}`,
        summary: `未知工具 ${call.name}`,
      },
    };
  }

  // INVARIANT: write tools (annotations, future Zotero mutations) MUST gate
  // through requiresApproval. In default mode they refuse; only YOLO mode
  // bypasses. There is no UI approval prompt yet — that is the planned
  // path mirroring Codex's `AskForApproval::OnRequest`.
  // REF: CLAUDE.md non-negotiable "No hidden Zotero writes".
  if (tool.requiresApproval && permissionMode !== 'yolo') {
    return {
      status: 'error',
      result: {
        output: `Local tool ${call.name} requires approval. Enable YOLO mode to run it without approval.`,
        summary: `需要审批: ${call.name}`,
      },
    };
  }

  let args: unknown;
  try {
    args = call.arguments ? JSON.parse(call.arguments) : {};
  } catch {
    return {
      status: 'error',
      result: {
        output: `Invalid JSON arguments for local tool: ${call.name}`,
        summary: `工具参数 JSON 无效: ${call.name}`,
      },
    };
  }

  try {
    return { status: 'completed', result: await tool.execute(args) };
  } catch (err) {
    return {
      status: 'error',
      result: {
        output: errMsg(err),
        summary: `工具执行失败: ${call.name}`,
      },
    };
  }
}

function openAIToolSpec(tool: AgentTool): Record<string, unknown> {
  return {
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    strict: false,
  };
}

export function openAIHostedToolSpecs(
  settings: ToolSettings | undefined,
): Record<string, unknown>[] {
  if (!settings) return [];
  const specs: Record<string, unknown>[] = [];
  if (settings.webSearchMode !== 'disabled') {
    specs.push({
      type: 'web_search',
      search_context_size:
        settings.webSearchMode === 'live' ? 'high' : 'medium',
    });
  }
  for (const server of settings.mcpServers ?? []) {
    if (!server.enabled || !server.serverUrl) continue;
    specs.push({
      type: 'mcp',
      server_label: server.serverLabel,
      server_url: server.serverUrl,
      ...(server.allowedTools.length
        ? { allowed_tools: server.allowedTools }
        : {}),
      require_approval: server.requireApproval,
      server_description:
        `User-configured MCP server "${server.serverLabel}". Let the model decide when to call its allowed tools.`,
    });
  }
  const arxiv = settings.arxivMcp;
  if (arxiv.enabled && arxiv.serverUrl) {
    specs.push({
      type: 'mcp',
      server_label: arxiv.serverLabel,
      server_url: arxiv.serverUrl,
      allowed_tools: arxiv.allowedTools,
      require_approval: arxiv.requireApproval,
      server_description:
        'Configurable arXiv MCP search server. Let the model decide when to search or fetch paper metadata.',
    });
  }
  return specs;
}

function hostedOutputItemToChunk(
  item: ResponseOutputItemLike,
): StreamChunk | null {
  if (isMcpCall(item)) {
    return {
      type: 'tool_call',
      name: `mcp:${item.server_label}/${item.name}`,
      status: item.error || item.status === 'failed' ? 'error' : 'completed',
      summary: item.error
        ? `MCP 调用失败: ${item.error}`
        : `MCP 调用完成: ${item.server_label}/${item.name}`,
    };
  }
  if (isMcpListTools(item)) {
    return {
      type: 'tool_call',
      name: `mcp:${item.server_label}/list_tools`,
      status: item.error ? 'error' : 'completed',
      summary: item.error
        ? `MCP 工具列表获取失败: ${item.error}`
        : `MCP 工具列表已获取: ${item.tools?.length ?? 0} 个工具`,
    };
  }
  if (isMcpApprovalRequest(item)) {
    return {
      type: 'tool_call',
      name: `mcp:${item.server_label}/${item.name}`,
      status: 'error',
      summary:
        'MCP 请求人工审批；当前插件暂不支持审批回传，请在设置中改为 never 后重试。',
    };
  }
  return null;
}

// Prepends the paper full text as a front block immediately after the system
// prompt and before conversation history. Used by both OpenAI tool loops.
// Returns the SAME array reference when no front block is set (no behavior
// change). The Responses `input` has no leading system item (the system
// prompt is the separate `instructions` field), so for it the block goes at
// index 0; Chat Completions keeps the system message at index 0, so the block
// goes at index 1.
export function withFrontBlock(
  items: Array<{ role?: string; content?: unknown }>,
  frontBlock: string | undefined,
): Array<{ role?: string; content?: unknown }> {
  if (!frontBlock) return items;
  const block = { role: 'user', content: `[Paper full text]\n${frontBlock}` };
  if (items[0]?.role === 'system') {
    return [items[0], block, ...items.slice(1)];
  }
  return [block, ...items];
}

export function toOpenAIInput(messages: Message[]): unknown[] {
  return messages.map((message) => {
    if (!message.images?.length) {
      return { role: message.role, content: message.content };
    }

    const content: Array<Record<string, string>> = [];
    if (message.content) {
      content.push({
        type: 'input_text',
        text: message.content,
      });
    }
    message.images.forEach((image, index) => {
      const label = image.marker ?? `[Image #${index + 1}]`;
      content.push({
        type: 'input_text',
        text: `<image name=${label}>`,
      });
      content.push({
        type: 'input_image',
        image_url: image.dataUrl,
        detail: 'high',
      });
      content.push({
        type: 'input_text',
        text: '</image>',
      });
    });
    return { role: message.role, content };
  });
}

function isFunctionCall(
  item: ResponseOutputItemLike,
): item is ResponseFunctionCallLike {
  return (
    item.type === 'function_call' &&
    typeof item.call_id === 'string' &&
    typeof item.name === 'string' &&
    typeof item.arguments === 'string'
  );
}

function isMcpCall(item: ResponseOutputItemLike): item is ResponseMcpCallLike {
  return (
    item.type === 'mcp_call' &&
    typeof item.server_label === 'string' &&
    typeof item.name === 'string'
  );
}

function isMcpListTools(
  item: ResponseOutputItemLike,
): item is ResponseMcpListToolsLike {
  return (
    item.type === 'mcp_list_tools' && typeof item.server_label === 'string'
  );
}

function isMcpApprovalRequest(
  item: ResponseOutputItemLike,
): item is ResponseMcpApprovalRequestLike {
  return (
    item.type === 'mcp_approval_request' &&
    typeof item.server_label === 'string' &&
    typeof item.name === 'string'
  );
}

function reasoningOptions(preset: ModelPreset): {
  effort: ReasoningEffort;
  summary?: Exclude<ReasoningSummary, 'none'>;
} {
  // GOTCHA: 'none' must omit the `summary` key entirely — the API rejects
  // an explicit `summary: 'none'` value. Default to 'concise' so the
  // sidebar's collapsible thinking block has something to render.
  const summary = preset.extras?.reasoningSummary ?? 'concise';
  return {
    effort: preset.extras?.reasoningEffort ?? 'xhigh',
    ...(summary === 'none' ? {} : { summary }),
  };
}

function maxOutputTokensParam(preset: ModelPreset): {
  max_output_tokens?: number;
} {
  return preset.extras?.omitMaxOutputTokens === true
    ? {}
    : { max_output_tokens: preset.maxTokens };
}

function promptCacheParams(
  preset: ModelPreset,
  options: ProviderStreamOptions,
): { prompt_cache_key?: string } {
  if (!isOfficialOpenAIEndpoint(preset)) return {};
  const key = stablePromptCacheKey(options.promptCacheKey);
  return key ? { prompt_cache_key: key } : {};
}

function isOfficialOpenAIEndpoint(preset: ModelPreset): boolean {
  const baseUrl = preset.baseUrl.trim();
  if (!baseUrl) return true;
  try {
    return new URL(baseUrl).hostname === 'api.openai.com';
  } catch {
    return false;
  }
}

function stablePromptCacheKey(value: string | undefined): string {
  const cleaned = (value ?? '')
    .trim()
    .replace(/[^A-Za-z0-9:_-]+/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 96);
  return cleaned || 'zai:openai';
}

function responseEventToChunk(event: ResponseEvent): StreamChunk | null {
  switch (event.type) {
    case 'response.created':
      return {
        type: 'status',
        message: 'OpenAI 已接收请求，等待模型开始处理',
      };
    case 'response.in_progress':
      return { type: 'status', message: '模型正在处理请求' };
    case 'response.output_text.delta':
      return event.delta ? { type: 'text_delta', text: event.delta } : null;
    case 'response.reasoning_text.delta':
    case 'response.reasoning_summary_text.delta':
      return event.delta ? { type: 'thinking_delta', text: event.delta } : null;
    case 'response.completed': {
      const usage = event.response?.usage;
      return usage ? usageChunk(usage) : null;
    }
    case 'response.failed':
      return {
        type: 'error',
        message: event.response?.error?.message || 'OpenAI response failed',
      };
    case 'error':
      return { type: 'error', message: event.message || 'OpenAI stream error' };
    default:
      return null;
  }
}

function usageChunk(usage: ResponseUsage): StreamChunk {
  return {
    type: 'usage',
    input: usage.input_tokens ?? 0,
    output: usage.output_tokens ?? 0,
    ...(typeof usage.input_tokens_details?.cached_tokens === 'number'
      ? { cacheRead: usage.input_tokens_details.cached_tokens }
      : {}),
  };
}

// Chat Completions wire types. Kept minimal — only fields we read or write.
type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | Array<unknown> }
  | { role: 'assistant'; content: string | null; tool_calls?: ChatToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

interface ChatToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface ChatCompletionEvent {
  choices?: Array<{
    delta?: {
      content?: string | null;
      // DeepSeek-R1 streams chain-of-thought here; must be replayed in the
      // next assistant message or the API returns 400.
      reasoning_content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: ChatCompletionUsage;
}

interface ChatCompletionUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
}

function toChatMessages(messages: Message[], systemPrompt: string): ChatMessage[] {
  const result: ChatMessage[] = [];
  if (systemPrompt) result.push({ role: 'system', content: systemPrompt });
  for (const msg of messages) {
    const text = Array.isArray(msg.content)
      ? msg.content.filter((b) => b.type === 'text').map((b) => (b as { type: 'text'; text: string }).text).join('\n')
      : msg.content;
    if (msg.images?.length) {
      // Multimodal: build content array with image_url parts.
      const parts: Array<unknown> = [];
      if (text) parts.push({ type: 'text', text });
      for (const img of msg.images) {
        parts.push({ type: 'image_url', image_url: { url: img.dataUrl, detail: 'high' } });
      }
      result.push({ role: msg.role as 'user', content: parts });
    } else {
      result.push({ role: msg.role as 'user' | 'assistant', content: text });
    }
  }
  return result;
}

function chatCompletionToolSpec(tool: AgentTool): Record<string, unknown> {
  return {
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  };
}

function chatCompletionReasoningParam(preset: ModelPreset): Record<string, unknown> {
  const effort = preset.extras?.reasoningEffort;
  if (!effort || effort === 'none') return {};
  // Chat Completions uses top-level reasoning_effort (not nested reasoning.effort).
  return { reasoning_effort: effort === 'xhigh' ? 'high' : effort };
}

function chatUsageChunk(usage: ChatCompletionUsage): StreamChunk {
  const deepSeekInput =
    (usage.prompt_cache_hit_tokens ?? 0) +
    (usage.prompt_cache_miss_tokens ?? 0);
  const cacheRead =
    typeof usage.prompt_cache_hit_tokens === 'number'
      ? usage.prompt_cache_hit_tokens
      : typeof usage.prompt_tokens_details?.cached_tokens === 'number'
        ? usage.prompt_tokens_details.cached_tokens
        : undefined;
  return {
    type: 'usage',
    input: usage.prompt_tokens ?? deepSeekInput,
    output: usage.completion_tokens ?? 0,
    ...(cacheRead != null ? { cacheRead } : {}),
  };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function* streamEventsWithFirstEventTimeout<T>(
  stream: AsyncIterable<T>,
  signal: AbortSignal,
): AsyncIterable<T> {
  const iterator = stream[Symbol.asyncIterator]();
  let first = true;
  try {
    while (true) {
      const next = first
        ? await nextWithFirstEventTimeout(iterator, signal)
        : await iterator.next();
      first = false;
      if (next.done) return;
      yield next.value;
    }
  } finally {
    await iterator.return?.();
  }
}

function nextWithFirstEventTimeout<T>(
  iterator: AsyncIterator<T>,
  signal: AbortSignal,
): Promise<IteratorResult<T>> {
  if (signal.aborted) return Promise.reject(new Error('Request was aborted.'));
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
    };
    const settleResolve = (
      value: IteratorResult<T> | PromiseLike<IteratorResult<T>>,
    ) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const settleReject = (err: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    const onAbort = () => {
      settleReject(new Error('Request was aborted.'));
    };
    const timeout = setTimeout(() => {
      settleReject(
        new Error(
          `OpenAI 流式响应在 ${Math.round(
            OPENAI_FIRST_EVENT_TIMEOUT_MS / 1000,
          )} 秒内没有返回任何事件。通常是当前 Base URL 不支持 hosted web_search/MCP 流式事件，或上游联网检索被卡住。`,
        ),
      );
    }, OPENAI_FIRST_EVENT_TIMEOUT_MS);
    signal.addEventListener('abort', onAbort, { once: true });
    iterator.next().then(
      (value) => settleResolve(value),
      (err) => settleReject(err),
    );
  });
}

function hostedToolsStatus(settings: ToolSettings | undefined): string {
  if (!settings) return '模型正在处理请求';
  if (settings.webSearchMode === 'live') {
    return '模型正在处理请求；Live 联网会搜索网页，但不保证下载/解析 PDF 全文';
  }
  if (settings.webSearchMode === 'cached') {
    return '模型正在处理请求；联网搜索已启用，但不保证下载/解析 PDF 全文';
  }
  if (settings.mcpServers?.some((server) => server.enabled && server.serverUrl)) {
    return '模型正在处理请求；MCP 工具已作为可用工具提供';
  }
  if (settings.arxivMcp.enabled && settings.arxivMcp.serverUrl) {
    return '模型正在处理请求；arXiv MCP 已作为可用工具提供';
  }
  return '模型正在处理请求';
}
