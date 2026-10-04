// The pure rules: ids and links, items, keyword matching, urgency triage, and
// the state document.

import { describe, expect, it } from "vitest";
import { commentUrl, idFromShortcode, mediaPk, postUrl, shortcodeFromId } from "./ids.js";
import { activityItem, commentItem, postContext, postItem } from "./items.js";
import { keywordMatcher } from "./keywords.js";
import { scheduleDelay } from "./schedule.js";
import { emptyState, normalizeHandle, normalizeSettings, normalizeState } from "./state.js";
import { DEFAULT_URGENT_TERMS, byUrgency, triage } from "./triage.js";
import { NOON, comment, post, story } from "./testing/fakeBrowser.js";

describe("ids", () => {
  it("write a media id as its shortcode and back, without losing digits", () => {
    const id = "3254998171211465227";
    const code = shortcodeFromId(id);
    expect(code).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(idFromShortcode(code)).toBe(id);
    expect(shortcodeFromId(`${id}_25025320`)).toBe(code);
    expect(shortcodeFromId("not an id")).toBe("");
    expect(mediaPk("00123_4")).toBe("123");
  });

  it("make the links a person opens", () => {
    expect(postUrl("C0dEx1")).toBe("https://www.instagram.com/p/C0dEx1/");
    expect(commentUrl("C0dEx1", "18012345678901234")).toBe("https://www.instagram.com/p/C0dEx1/c/18012345678901234/");
  });
});

describe("items", () => {
  it("carry the post they are under, for context", () => {
    const raw = post("rival_store", 0, "Our   summer\nsale", { shortcode: "C0dEx1" });
    const item = commentItem(comment("buyer", 1, "nice"), postContext(raw));
    expect(item).toMatchObject({ kind: "comment", author: "buyer", post: { owner: "rival_store", caption: "Our summer sale", url: "https://www.instagram.com/p/C0dEx1/" } });
    expect(postItem(raw)).toMatchObject({ key: `post:${raw.pk}`, kind: "post", createdAt: NOON });
  });

  it("read an activity line down to what was written, in any language", () => {
    const own = new Set(["3254998171211465227"]);
    const swedish = activityItem(story("fan", 0, "fan kommenterade: snyggt!", { comment_id: "1", media_id: "3254998171211465227" }), "acme_shop", own);
    expect(swedish).toMatchObject({ key: "comment:1", text: "snyggt!", addressed: "comment_on_post" });
    expect(swedish!.url).toBe(commentUrl(shortcodeFromId("3254998171211465227"), "1"));
    const caption = activityItem(story("blogger", 0, "blogger mentioned you in their post: thanks @acme_shop!"), "acme_shop", own);
    expect(caption).toMatchObject({ kind: "activity", addressed: "mention", url: "https://www.instagram.com/accounts/activity/" });
    expect(activityItem(story("fan", 0, "fan liked your photo."), "acme_shop", own)).toBeUndefined();
    expect(activityItem(story("x", 0, "x mentioned you: thanks @acme_shop."), "acme_shop", own)?.addressed).toBe("mention");
    expect(activityItem(story("x", 0, "x: hi @acme_shop.eu"), "acme_shop", own)).toBeUndefined();
    // "@acme_shopping" is someone else.
    expect(activityItem(story("x", 0, "x: hi @acme_shopping"), "acme_shop", own)).toBeUndefined();
  });
});

describe("keywords", () => {
  it("count a hashtag or a handle as a word", () => {
    const match = keywordMatcher(["acme"]);
    expect(match("loving #acme today")).toEqual(["acme"]);
    expect(match("thanks @acme")).toEqual(["acme"]);
    expect(match("acmeshop")).toEqual([]);
  });
});

const at = NOON + 60 * 60_000;
const urgent = keywordMatcher([...DEFAULT_URGENT_TERMS]);
const context = postContext(post("acme_shop", 0, "drop"));

describe("triage", () => {
  it("ranks a question on your post high", () => {
    const item = commentItem(comment("buyer", 50, "Does it ship to Canada?"), context, "comment_on_post")!;
    expect(triage(item, { at, keywords: [], urgent })).toEqual({ urgency: "high", score: 4, reasons: ["Comments on your post", "Asks a question", "No reply yet"] });
  });

  it("ranks a plain comment on your post medium, and one already answered lower", () => {
    const plain = commentItem(comment("fan", 50, "love it"), context, "comment_on_post")!;
    expect(triage(plain, { at, keywords: [], urgent }).urgency).toBe("medium");
    const answered = commentItem(comment("fan", 50, "love it", { replies: 2 }), context, "comment_on_post")!;
    expect(triage(answered, { at, keywords: [], urgent })).toMatchObject({ urgency: "medium", score: 2 });
  });

  it("counts an urgent term only in an item about you", () => {
    const stranger = commentItem(comment("x", 50, "my order never arrived"), context)!;
    expect(triage(stranger, { at, keywords: [], urgent })).toEqual({ urgency: "low", score: 0, reasons: [] });
    expect(triage(stranger, { at, keywords: ["acme"], urgent }).reasons).toEqual(['Says "never arrived"']);
  });

  it("ignores the handles a reply starts with when it looks for a question", () => {
    const reply = commentItem(comment("x", 50, "@acme_shop @friend how much?"), context)!;
    expect(triage(reply, { at, keywords: [], urgent }).reasons).toEqual(["Asks a question"]);
  });

  it("notices a watched profile's post picking up fast", () => {
    const busy = postItem(post("rival_store", 0, "launch", { comments: 120 }))!;
    expect(triage(busy, { at, keywords: [], urgent }).reasons).toEqual(["120 comments in 1 hour"]);
  });

  it("sorts most urgent first, then newest", () => {
    const entry = (minute: number, urgency: "high" | "low", score: number) => ({
      item: postItem(post("a", minute, String(minute)))!,
      triage: { urgency, score, reasons: [] },
    });
    expect([entry(1, "low", 0), entry(2, "high", 4), entry(3, "low", 0)].sort(byUrgency).map((e) => e.item.text)).toEqual(["2", "3", "1"]);
  });
});

describe("state", () => {
  it("reads handles in every form a person pastes them", () => {
    for (const value of ["rival_store", "@rival_store", "https://www.instagram.com/rival_store/", "instagram.com/rival_store?hl=en".replace(/^/, "https://")]) {
      expect(normalizeHandle(value), value).toBe("rival_store");
    }
    expect(normalizeHandle("bad..name")).toBe("");
    expect(normalizeHandle("not a handle")).toBe("");
  });

  it("clamps settings to safe ranges", () => {
    const settings = normalizeSettings({ maxCommentReads: 500, ownPosts: -1, profiles: ["a b", "rival_store", "RIVAL_STORE"] });
    expect(settings).toMatchObject({ maxCommentReads: 30, ownPosts: 0, profiles: ["rival_store"] });
    expect(normalizeSettings({ urgentTerms: [] }).urgentTerms).toEqual([]);
    expect(normalizeSettings({}).urgentTerms).toEqual(DEFAULT_URGENT_TERMS);
  });

  it("accepts whatever was on disk", () => {
    expect(normalizeState(null)).toEqual(emptyState());
    const state = normalizeState({
      account: { handle: "@acme_shop", pk: "100", signedIn: true, checkedAt: 5 },
      sources: { activity: { since: 1, filter: "" }, broken: {} },
      posts: { "3254998171211465227": { owner: "acme_shop", shortcode: "C", comments: 2, checkedAt: 1 }, junk: { comments: 1 } },
      seen: ["comment:1", 2],
    });
    expect(state.account).toEqual({ handle: "acme_shop", pk: "100", signedIn: true, checkedAt: 5 });
    expect(Object.keys(state.sources)).toEqual(["activity"]);
    expect(Object.keys(state.posts)).toEqual(["3254998171211465227"]);
    expect(state.seen).toEqual(["comment:1"]);
  });
});

describe("scheduleDelay", () => {
  it("spreads the interval, never goes under five minutes, and backs off after a refusal", () => {
    expect(scheduleDelay(15 * 60_000, { random: () => 0.5 })).toBe(15 * 60_000);
    expect(scheduleDelay(60_000, { random: () => 0.5 })).toBe(5 * 60_000);
    expect(scheduleDelay(15 * 60_000, { random: () => 0.5, backOff: true })).toBe(45 * 60_000);
  });
});
