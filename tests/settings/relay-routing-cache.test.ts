import { beforeEach, describe, expect, it } from "vitest";
import {
  loadRelaySalt,
  persistRelaySalt,
  routingEntryKey,
} from "../../src/settings/relay-routing-cache";

let stored = "{}";

beforeEach(() => {
  stored = "{}";
  Object.defineProperty(globalThis, "Zotero", {
    configurable: true,
    value: {
      Profile: { dir: "/tmp/zotero-profile" },
      DataDirectory: { dir: "/tmp/zotero-data" },
      File: {
        getContentsAsync: async () => stored,
        putContentsAsync: async (_path: string, contents: string) => {
          stored = contents;
        },
      },
    },
  });
});

describe("relay routing cache", () => {
  it("defaults the salt to 0 when no entry exists", async () => {
    expect(await loadRelaySalt("preset-a", "gpt-5_5", "FQRVCCJN")).toBe(0);
  });

  it("persists and reads back a salt", async () => {
    await persistRelaySalt("preset-a", "gpt-5_5", "FQRVCCJN", 2);
    expect(await loadRelaySalt("preset-a", "gpt-5_5", "FQRVCCJN")).toBe(2);
  });

  it("keeps per-paper salts independent", async () => {
    await persistRelaySalt("preset-a", "gpt-5_5", "FQRVCCJN", 1);
    await persistRelaySalt("preset-a", "gpt-5_5", "M59PVULT", 3);
    expect(await loadRelaySalt("preset-a", "gpt-5_5", "FQRVCCJN")).toBe(1);
    expect(await loadRelaySalt("preset-a", "gpt-5_5", "M59PVULT")).toBe(3);
  });

  it("keeps per-model salts independent for the same paper", async () => {
    await persistRelaySalt("preset-a", "gpt-5_5", "FQRVCCJN", 1);
    await persistRelaySalt("preset-a", "gpt-4o", "FQRVCCJN", 4);
    expect(await loadRelaySalt("preset-a", "gpt-5_5", "FQRVCCJN")).toBe(1);
    expect(await loadRelaySalt("preset-a", "gpt-4o", "FQRVCCJN")).toBe(4);
  });

  it("treats null itemKey as a 'global' entry distinct from per-paper", async () => {
    await persistRelaySalt("preset-a", "gpt-5_5", null, 5);
    await persistRelaySalt("preset-a", "gpt-5_5", "FQRVCCJN", 2);
    expect(await loadRelaySalt("preset-a", "gpt-5_5", null)).toBe(5);
    expect(await loadRelaySalt("preset-a", "gpt-5_5", "FQRVCCJN")).toBe(2);
  });

  it("clamps non-integer or negative persisted salts to 0", async () => {
    // Simulate a hand-edited file with garbage.
    stored = JSON.stringify({
      [routingEntryKey("preset-a", "gpt-5_5", "FQRVCCJN")]: {
        salt: -3,
        lastSuccessAt: "2026-05-28T00:00:00.000Z",
      },
      [routingEntryKey("preset-a", "gpt-5_5", "M59PVULT")]: {
        salt: "huh",
        lastSuccessAt: "",
      },
    });
    expect(await loadRelaySalt("preset-a", "gpt-5_5", "FQRVCCJN")).toBe(0);
    expect(await loadRelaySalt("preset-a", "gpt-5_5", "M59PVULT")).toBe(0);
  });

  it("returns 0 from a malformed JSON file rather than throwing", async () => {
    stored = "not json at all";
    expect(await loadRelaySalt("preset-a", "gpt-5_5", "FQRVCCJN")).toBe(0);
  });

  it("returns 0 when the root JSON is an array instead of an object", async () => {
    stored = "[1, 2, 3]";
    expect(await loadRelaySalt("preset-a", "gpt-5_5", "FQRVCCJN")).toBe(0);
  });

  it("serializes concurrent persists without losing either write", async () => {
    const a = persistRelaySalt("preset-a", "gpt-5_5", "FQRVCCJN", 1);
    const b = persistRelaySalt("preset-a", "gpt-5_5", "M59PVULT", 7);
    await Promise.all([a, b]);
    expect(await loadRelaySalt("preset-a", "gpt-5_5", "FQRVCCJN")).toBe(1);
    expect(await loadRelaySalt("preset-a", "gpt-5_5", "M59PVULT")).toBe(7);
  });

  it("writes a lastSuccessAt timestamp on each persist", async () => {
    await persistRelaySalt("preset-a", "gpt-5_5", "FQRVCCJN", 2);
    const parsed = JSON.parse(stored) as Record<
      string,
      { salt: number; lastSuccessAt: string }
    >;
    const entry = parsed[routingEntryKey("preset-a", "gpt-5_5", "FQRVCCJN")];
    expect(entry.salt).toBe(2);
    // ISO 8601 — Z suffix is the giveaway.
    expect(entry.lastSuccessAt).toMatch(/T.*Z$/);
  });
});
