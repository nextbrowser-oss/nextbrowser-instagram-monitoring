// The core is what the app imports into its renderer, where there is no Node.
// Anything under src/ outside src/node that reaches for a Node module breaks
// the app's build, so it is checked here rather than found there.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as core from "./index.js";

const SRC = new URL(".", import.meta.url).pathname;

describe("the core", () => {
  it("imports nothing from Node", async () => {
    const files = (await readdir(SRC)).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"));
    expect(files.length).toBeGreaterThan(5);
    for (const name of files) {
      const text = await readFile(join(SRC, name), "utf8");
      expect(text, name).not.toMatch(/from\s+["'](node:|fs|path|os|child_process)/);
      expect(text, name).not.toMatch(/\bprocess\./);
      expect(text, name).not.toMatch(/from\s+["']\.\/node\//);
    }
  });

  it("exports the pass, the rules and the state helpers", () => {
    expect(typeof core.runPass).toBe("function");
    expect(typeof core.triage).toBe("function");
    expect(core.emptyState().settings).toEqual(core.defaultSettings());
  });

  it("never acts on instagram.com: every request is a GET, and nothing is clicked", async () => {
    const text = await readFile(join(SRC, "scripts.ts"), "utf8");
    expect(text).not.toMatch(/method:\s*["'](POST|PUT|PATCH|DELETE)/i);
    expect(text).not.toMatch(/\/(like|unlike|follow|unfollow|create|add|delete|seen|mark_seen)\//);
    expect(text).not.toMatch(/\.click\(/);
  });
});
