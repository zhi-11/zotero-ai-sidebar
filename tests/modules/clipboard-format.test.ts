import { beforeEach, describe, expect, it } from 'vitest';
import {
  formatConversationMarkdown,
  messageToClipboard,
} from '../../src/modules/clipboard-format';

beforeEach(() => {
  Object.defineProperty(globalThis, 'Zotero', {
    configurable: true,
    value: {
      Items: {
        get: () => ({
          getField: (field: string) =>
            field === 'title' ? 'Pinned Paper' : '',
          getCreators: () => [],
          getTags: () => [],
        }),
      },
    },
  });
});

describe('formatConversationMarkdown', () => {
  it('renders the paper front block after the system prompt and before history', () => {
    const markdown = formatConversationMarkdown(
      {
        itemID: 1,
        messages: [{ role: 'user', content: 'Summarize this paper' }],
      },
      true,
      'SYS',
      'PAPER BODY',
    );

    expect(markdown).toContain('## System Prompt');
    expect(markdown).toContain('## Front Block');
    expect(markdown).toContain('[Paper full text]\nPAPER BODY');
    expect(markdown.indexOf('## System Prompt')).toBeLessThan(
      markdown.indexOf('## Front Block'),
    );
    expect(markdown.indexOf('## Front Block')).toBeLessThan(
      markdown.indexOf('## You'),
    );
  });

  it('explains the per-turn model input order for cache debugging', () => {
    const markdown = messageToClipboard(
      {
        role: 'user',
        content: 'Summarize this paper',
        context: {
          planMode: 'full_pdf',
          fullTextChars: 44522,
          toolCalls: [
            {
              name: 'zotero_get_full_pdf',
              status: 'completed',
              summary: '读取 PDF 全文 44522/44522 字',
            },
          ],
          promptCacheDebug: {
            provider: 'openai',
            requestPath: 'openai.responses',
            endpoint: 'https://api.openai.com/v1',
            model: 'gpt-5.2',
            presetID: 'preset-1',
            promptCacheKey: 'zai:openai:preset-1:gpt-5.2:item-3',
            promptCacheKeySent: true,
            promptCacheRetention: '24h',
            promptCacheMechanism: 'OpenAI prompt_cache_key',
            reasoningSent: true,
            reasoningDetail: 'responses reasoning.effort=xhigh, summary=concise',
            toolsSent: ['zotero_search_pdf'],
            toolsHash: 'toolhash1',
            systemPromptHash: 'syshash1',
            frontBlockHash: 'fronthash',
            frontBlockChars: 44522,
            stablePrefixHash: 'prefixhash',
            replayContentHash: 'wirehash',
            replayContentChars: 123,
          },
        },
      },
      true,
    );

    expect(markdown).toContain('### 发送给模型的信息顺序');
    expect(markdown).toContain('1. System Prompt');
    expect(markdown).toContain(
      '2. Front Block：[Paper full text]，44522 字',
    );
    expect(markdown).toContain('3. Conversation History');
    expect(markdown).toContain('4. Current User Message：User question');
    expect(markdown).toContain('zotero_get_full_pdf');
    expect(markdown).toContain('System Prompt + Front Block');
    expect(markdown).toContain('### Cache Debug');
    expect(markdown).toContain('- Provider path: openai.responses');
    expect(markdown).toContain(
      '- prompt_cache_key: zai:openai:preset-1:gpt-5.2:item-3',
    );
    expect(markdown).toContain('- prompt_cache_retention: 24h');
    expect(markdown).toContain(
      '- Reasoning sent: yes (responses reasoning.effort=xhigh, summary=concise)',
    );
    expect(markdown).toContain('stable_prefix=prefixhash');
    expect(markdown).toContain('Codex-style replay: enabled');
  });

  it('appends token usage at the end of a debug-copied message', () => {
    const markdown = messageToClipboard(
      {
        role: 'assistant',
        content: 'Done.',
        usage: { input: 18049, cacheRead: 4864, output: 3910 },
      },
      true,
    );

    expect(markdown).toContain('Done.\n\n### Token 使用');
    expect(markdown).toContain('- Input raw: 18,049');
    expect(markdown).toContain('- Input cache hit: 4,864');
    expect(markdown).toContain('- Input cache miss: 13,185');
    expect(markdown).toContain('- Output: 3,910');
    expect(markdown).toContain('- Cache hit rate: 27%');
    expect(markdown).toContain('- Token total: 21,959');
    expect(markdown).toContain('官方口径');
  });
});
