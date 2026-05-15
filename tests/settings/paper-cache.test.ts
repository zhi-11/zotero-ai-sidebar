import { beforeEach, describe, expect, it } from 'vitest';
import {
  freezeFullText,
  getFrozenFullText,
  isPaperPinned,
  setPaperPinned,
} from '../../src/settings/paper-cache';

let stored = '{}';

beforeEach(() => {
  stored = '{}';
  Object.defineProperty(globalThis, 'Zotero', {
    configurable: true,
    value: {
      Profile: { dir: '/tmp/zotero-profile' },
      DataDirectory: { dir: '/tmp/zotero-data' },
      File: {
        getContentsAsync: async () => stored,
        putContentsAsync: async (_path: string, contents: string) => {
          stored = contents;
        },
      },
    },
  });
});

describe('paper cache', () => {
  it('freezes full text and reads it back byte-identical', async () => {
    await freezeFullText(7, 'PAPER BODY');
    expect(await getFrozenFullText(7)).toBe('PAPER BODY');
  });

  it('returns null when no usable cache exists', async () => {
    expect(await getFrozenFullText(7)).toBeNull();
  });

  it('treats an empty fullText as no usable cache', async () => {
    await freezeFullText(7, '');
    expect(await getFrozenFullText(7)).toBeNull();
  });

  it('persists the pinned flag independently of the frozen text', async () => {
    await freezeFullText(7, 'PAPER BODY');
    expect(await isPaperPinned(7)).toBe(false);
    await setPaperPinned(7, true);
    expect(await isPaperPinned(7)).toBe(true);
    expect(await getFrozenFullText(7)).toBe('PAPER BODY');
  });

  it('keeps the frozen text when the toggle is turned off', async () => {
    await freezeFullText(7, 'PAPER BODY');
    await setPaperPinned(7, true);
    await setPaperPinned(7, false);
    expect(await getFrozenFullText(7)).toBe('PAPER BODY');
  });

  it('discards a malformed cache file', async () => {
    stored = 'not json';
    expect(await getFrozenFullText(7)).toBeNull();
    expect(await isPaperPinned(7)).toBe(false);
  });

  it('serializes concurrent writes without losing either mutation', async () => {
    const a = freezeFullText(7, 'TEXT A');
    const b = setPaperPinned(7, true);
    await Promise.all([a, b]);
    expect(await getFrozenFullText(7)).toBe('TEXT A');
    expect(await isPaperPinned(7)).toBe(true);
  });
});
