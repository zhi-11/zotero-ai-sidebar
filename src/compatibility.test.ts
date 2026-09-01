import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Zotero compatibility manifest", () => {
  it("allows Zotero 10 while retaining Zotero 7 support", () => {
    const manifest = JSON.parse(
      readFileSync(resolve(process.cwd(), "addon/manifest.json"), "utf8"),
    ) as {
      applications: {
        zotero: {
          strict_min_version: string;
          strict_max_version: string;
        };
      };
    };

    expect(manifest.applications.zotero.strict_min_version).toBe("7.0");
    expect(manifest.applications.zotero.strict_max_version).toBe("10.0.*");
  });
});
