import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AnthropicProvider, toAnthropicTools } from '../../src/providers/anthropic';
import type { ModelPreset } from '../../src/settings/types';
import type { AgentTool, StreamChunk } from '../../src/providers/types';

// Configurable SDK mock: each call to client.messages.stream() pops the next
// queued event generator and records the request body it was given. Tests set
// `h.streamQueue` (one generator per expected request) and inspect
// `h.streamCalls` afterwards. vi.hoisted lets the mock factory see these.
const h = vi.hoisted(() => ({
  streamCalls: [] as any[],
  streamQueue: [] as Array<() => AsyncIterable<any>>,
}));

vi.mock('@anthropic-ai/sdk', () => {
  class FakeAnthropic {
    messages = {
      stream: async (body: any) => {
        h.streamCalls.push(body);
        const next = h.streamQueue.shift();
        if (!next) throw new Error('test queued no stream for this request');
        return next();
      },
    };
  }
  return { default: FakeAnthropic };
});

const preset: ModelPreset = {
  id: 'a',
  label: 'Opus',
  provider: 'anthropic',
  apiKey: 'sk',
  baseUrl: 'https://api.anthropic.com',
  model: 'claude-opus-4-7-20251101',
  maxTokens: 4000,
  extras: { vendor: 'claude', reasoningEffort: 'high' },
};

async function collect(tool: AgentTool, permissionMode: 'default' | 'yolo') {
  const provider = new AnthropicProvider();
  const got: StreamChunk[] = [];
  for await (const c of provider.stream(
    [{ role: 'user', content: '帮我分析一下 figure3' }],
    'be helpful',
    preset,
    new AbortController().signal,
    { tools: [tool], maxToolIterations: 4, permissionMode },
  )) {
    got.push(c);
  }
  return got;
}

// Iteration 0: model thinks (with a signature), narrates, then calls
// arxiv_get_figure(number=3).
async function* toolUseRound(): AsyncIterable<any> {
  yield { type: 'message_start', message: { usage: { input_tokens: 100, cache_read_input_tokens: 0 } } };
  yield { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } };
  yield { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Need the figure.' } };
  yield { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'SIG123' } };
  yield { type: 'content_block_stop', index: 0 };
  yield { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } };
  yield { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: "I'll fetch Figure 3." } };
  yield { type: 'content_block_stop', index: 1 };
  yield { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'tu_1', name: 'arxiv_get_figure', input: {} } };
  yield { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"number":3}' } };
  yield { type: 'content_block_stop', index: 2 };
  yield { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 30 } };
  yield { type: 'message_stop' };
}

// Iteration 1: model answers using the image it now sees.
async function* finalRound(text: string): AsyncIterable<any> {
  yield { type: 'message_start', message: { usage: { input_tokens: 200, cache_read_input_tokens: 100 } } };
  yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
  yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } };
  yield { type: 'content_block_stop', index: 0 };
  yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 50 } };
  yield { type: 'message_stop' };
}

// Approval-gated tool: model calls it with no arguments.
async function* approvalToolRound(): AsyncIterable<any> {
  yield { type: 'message_start', message: { usage: { input_tokens: 80 } } };
  yield { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_w', name: 'zotero_write_note', input: {} } };
  yield { type: 'content_block_stop', index: 0 };
  yield { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 10 } };
  yield { type: 'message_stop' };
}

beforeEach(() => {
  h.streamCalls.length = 0;
  h.streamQueue = [];
});

describe('toAnthropicTools', () => {
  it('maps AgentTools onto Anthropic name/description/input_schema', () => {
    const schema = { type: 'object', properties: { number: { type: 'number' } }, required: ['number'] };
    expect(
      toAnthropicTools([
        {
          name: 'arxiv_get_figure',
          description: 'Fetch a figure.',
          parameters: schema,
          execute: async () => ({ output: '' }),
        },
      ]),
    ).toEqual([
      { name: 'arxiv_get_figure', description: 'Fetch a figure.', input_schema: schema },
    ]);
  });
});

describe('AnthropicProvider tool loop', () => {
  it('runs the loop, executes the tool, and feeds the figure back as a native tool_result image', async () => {
    const figureImage = {
      id: 'fig-3',
      name: 'figure-3.png',
      mediaType: 'image/png',
      dataUrl: 'data:image/png;base64,FIGDATA',
      size: 7,
    };
    let executedWith: unknown;
    const tool: AgentTool = {
      name: 'arxiv_get_figure',
      description: 'Fetch an arXiv figure as an image.',
      parameters: { type: 'object', properties: { number: { type: 'number' } }, required: ['number'] },
      execute: async (args) => {
        executedWith = args;
        return { output: 'Figure 3 fetched.', summary: '读取 arXiv Figure 3（含图像）', images: [figureImage] };
      },
    };
    h.streamQueue = [toolUseRound, () => finalRound('Figure 3 shows it clearly.')];

    const got = await collect(tool, 'default');

    // The model's parsed arguments reached the tool.
    expect(executedWith).toEqual({ number: 3 });

    // The visible stream: thinking, narration, tool trace, image, final answer.
    expect(got).toContainEqual({ type: 'thinking_delta', text: 'Need the figure.' });
    expect(got).toContainEqual({ type: 'text_delta', text: "I'll fetch Figure 3." });
    expect(got).toContainEqual({
      type: 'tool_call',
      name: 'arxiv_get_figure',
      status: 'started',
      summary: '调用 Zotero 工具: arxiv_get_figure',
    });
    expect(got).toContainEqual({
      type: 'tool_call',
      name: 'arxiv_get_figure',
      status: 'completed',
      summary: '读取 arXiv Figure 3（含图像）',
      context: undefined,
    });
    expect(got).toContainEqual({ type: 'tool_images', images: [figureImage] });
    expect(got).toContainEqual({ type: 'text_delta', text: 'Figure 3 shows it clearly.' });

    // Two requests: the original turn, then the continuation with tool results.
    expect(h.streamCalls).toHaveLength(2);

    // First request forwards the mapped tool.
    expect(h.streamCalls[0].tools).toEqual([
      {
        name: 'arxiv_get_figure',
        description: 'Fetch an arXiv figure as an image.',
        input_schema: { type: 'object', properties: { number: { type: 'number' } }, required: ['number'] },
      },
    ]);

    // Second request replays the assistant turn (thinking WITH signature must
    // precede tool_use, or Anthropic 400s with extended thinking on) and the
    // tool_result carrying the image as a native image block.
    const msgs = h.streamCalls[1].messages;
    const assistantTurn = msgs[msgs.length - 2];
    const userTurn = msgs[msgs.length - 1];
    expect(assistantTurn.role).toBe('assistant');
    expect(assistantTurn.content).toContainEqual({ type: 'thinking', thinking: 'Need the figure.', signature: 'SIG123' });
    expect(assistantTurn.content).toContainEqual({ type: 'tool_use', id: 'tu_1', name: 'arxiv_get_figure', input: { number: 3 } });
    expect(userTurn.role).toBe('user');
    expect(userTurn.content).toEqual([
      {
        type: 'tool_result',
        tool_use_id: 'tu_1',
        content: [
          { type: 'text', text: 'Figure 3 fetched.' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'FIGDATA' } },
        ],
      },
    ]);
  });

  it('blocks approval-required tools in default mode and reports the refusal back to the model', async () => {
    const execute = vi.fn(async () => ({ output: 'should not run' }));
    const tool: AgentTool = {
      name: 'zotero_write_note',
      description: 'Pretend write tool.',
      parameters: { type: 'object', properties: {} },
      requiresApproval: true,
      execute,
    };
    h.streamQueue = [approvalToolRound, () => finalRound('I could not write the note.')];

    const got = await collect(tool, 'default');

    expect(execute).not.toHaveBeenCalled();
    expect(got).toContainEqual({
      type: 'tool_call',
      name: 'zotero_write_note',
      status: 'error',
      summary: '需要审批: zotero_write_note',
      context: undefined,
    });

    // The refusal is fed back as an is_error tool_result so the model can react.
    const userTurn = h.streamCalls[1].messages.at(-1);
    expect(userTurn.content[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'tu_w',
      is_error: true,
    });
    expect(userTurn.content[0].content[0].text).toContain('requires approval');
  });
});
