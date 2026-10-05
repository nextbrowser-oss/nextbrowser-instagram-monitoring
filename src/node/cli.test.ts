import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PassSummary } from "../engine.js";
import { emptyState } from "../state.js";
import { describeEvent, describePass, parseDuration, settingsFromFlags } from "./cli.js";
import { loadState, saveState } from "./store.js";

describe("parseDuration", () => {
  it("reads the durations the flags take", () => {
    expect(parseDuration("15m", "--x")).toBe(900_000);
    expect(parseDuration("48h", "--x")).toBe(172_800_000);
    expect(() => parseDuration("soon", "--interval")).toThrow("--interval");
  });
});

describe("settingsFromFlags", () => {
  it("patches only what was given, and the negative flag wins", () => {
    expect(settingsFromFlags({})).toEqual({});
    expect(settingsFromFlags({ "no-tags": true, tags: true, "no-activity": true, "keep-tab": true })).toEqual({ watchTags: false, watchActivity: false, parkTab: false });
    expect(settingsFromFlags({ profiles: "@rival_store, https://www.instagram.com/other.brand/", keywords: "acme, acme shop", "max-comment-reads": "4" })).toEqual({
      profiles: ["rival_store", "other.brand"],
      keywords: ["acme", "acme shop"],
      maxCommentReads: 4,
    });
  });

  it("refuses a username Instagram would not have", () => {
    expect(() => settingsFromFlags({ profiles: "ok, bad..name" })).toThrow("not an Instagram username");
  });
});

describe("describeEvent", () => {
  const at = new Date(2026, 9, 2, 9, 5).getTime();

  it("writes a match on two lines: who and how urgent, then why and the link", () => {
    const line = describeEvent({
      type: "new_item",
      at,
      source: { kind: "own_comments", name: "your posts" },
      keywords: [],
      triage: { urgency: "high", score: 4, reasons: ["Comments on your post", "Asks a question"] },
      item: { key: "comment:1", id: "1", kind: "comment", author: "buyer", text: "Does it ship to Canada?", url: "https://www.instagram.com/p/C0dEx1/c/1/", addressed: "comment_on_post" },
    });
    expect(line).toBe("09:05  HIGH    @buyer commented on your post: Does it ship to Canada?\n        [Comments on your post · Asks a question]  https://www.instagram.com/p/C0dEx1/c/1/");
  });

  it("names the competitor a keyword comment was found under", () => {
    const line = describeEvent({
      type: "new_item",
      at,
      source: { kind: "profile_comments", name: "@rival_store" },
      keywords: ["acme"],
      triage: { urgency: "low", score: 0, reasons: [] },
      item: { key: "comment:2", id: "2", kind: "comment", author: "shopper", text: "acme is cheaper", url: "https://www.instagram.com/p/X/c/2/" },
    });
    expect(line).toContain("@shopper commented on @rival_store's post: acme is cheaper");
    expect(describeEvent({ type: "security_check", at, handle: "acme_shop" })).toContain("open instagram.com in the profile");
  });
});

describe("describePass", () => {
  const summary: PassSummary = {
    signedIn: true, handle: "acme_shop", loginRequired: false, securityCheck: false, rateLimited: false, requests: 8, sourcesRead: 5,
    baselines: 0, itemsRead: 40, matches: 6, newItems: 2, urgent: 1, commentReads: 2, commentReadsDeferred: 0, followerChecks: 2,
    followerChanges: 1, stopped: false, failed: false, notes: [],
  };

  it("sums a pass up in one line", () => {
    expect(describePass(summary, new Date(2026, 9, 2, 21, 5).getTime()))
      .toBe("21:05  pass @acme_shop: 5 sources: 2 new (1 urgent) of 6 matches; 2 threads read; followers: 2 read, 1 changed");
  });

  it("says what stopped it", () => {
    const line = describePass({ ...summary, sourcesRead: 0, commentReads: 0, followerChecks: 0, securityCheck: true, notes: ["Do the check."] }, new Date(2026, 9, 2, 9, 0).getTime());
    expect(line).toBe("09:00  pass @acme_shop: security check\n        Do the check.");
  });
});

describe("the state file", () => {
  let dir = "";
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("round-trips, and refuses a file it cannot read", async () => {
    dir = await mkdtemp(join(tmpdir(), "instagram-monitor-"));
    const path = join(dir, "nested", "state.json");
    expect(await loadState(path)).toEqual(emptyState());
    const state = { ...emptyState({ profiles: ["rival_store"] }), seen: ["comment:1"] };
    await saveState(path, state);
    expect(await loadState(path)).toEqual(state);
    await writeFile(path, "{ not json");
    await expect(loadState(path)).rejects.toThrow();
  });
});
