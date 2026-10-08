import { beforeEach, describe, expect, it } from "vitest";
import { checkAccount, runPass, type PassDeps, type PassResult } from "./engine.js";
import type { MonitorEvent, NewItemEvent } from "./events.js";
import { DEFAULT_QUERIES, LANDING_URL, SIGN_IN_URL, queriesPage, type RawPost } from "./scripts.js";
import { emptyState, withSettings, type MonitorSettings, type MonitorState } from "./state.js";
import { FakeInstagram, NOON, comment, post, story } from "./testing/fakeBrowser.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

let clock = NOON + 60 * MINUTE;
let ig: FakeInstagram;
let mine: RawPost;
let theirs: RawPost;

beforeEach(() => {
  clock = NOON + 60 * MINUTE;
  ig = new FakeInstagram();
  mine = post("acme_shop", 10, "New drop is live", { comments: 2 });
  theirs = post("rival_store", 20, "Our summer sale", { comments: 4 });
  ig.profiles.acme_shop = { followers: 500, posts: [mine] };
  ig.profiles.rival_store = { followers: 9000, posts: [theirs] };
});

function pass(state: MonitorState, extra: Partial<PassDeps> = {}): Promise<PassResult> {
  return runPass({
    browser: ig,
    state,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    random: () => 0.5,
    ...extra,
  });
}

function watching(patch: Partial<MonitorSettings> = {}): MonitorState {
  return emptyState({ profiles: ["rival_store"], keywords: ["acme"], ...patch });
}

const types = (events: MonitorEvent[]) => events.map((event) => event.type);
const fresh = (events: MonitorEvent[]) => events.filter((event): event is NewItemEvent => event.type === "new_item");
const texts = (events: MonitorEvent[]) => fresh(events).map((event) => event.item.text);

/** later moves the clock to the next pass and returns a minute offset from
 *  NOON that lies between the two passes. */
function later(minutes = 15): number {
  const between = (clock - NOON) / MINUTE + 1;
  clock += minutes * MINUTE;
  return between;
}

/** grow adds comments under a post and raises its count, as Instagram shows. */
function grow(target: RawPost, ...added: ReturnType<typeof comment>[]): void {
  ig.comments[target.pk] = [...added, ...(ig.comments[target.pk] ?? [])];
  target.comments = (target.comments ?? 0) + added.length;
}

describe("the first pass", () => {
  it("signs in, records every source as its starting line, and lists what the threads hold without announcing it", async () => {
    ig.stories = [story("fan", 30, "fan mentioned you in a comment: @acme_shop love it", { comment_id: "1800000000000000001", media_id: theirs.pk })];
    ig.comments[mine.pk] = [comment("buyer", 15, "Does it ship to Canada?"), comment("visitor", 12, "nice")];
    ig.comments[theirs.pk] = [comment("shopper", 25, "acme does this cheaper"), comment("x", 24, "love it")];
    const { state, events, summary, matches } = await pass(watching());

    expect(types(events)).toEqual(["signed_in"]);
    expect(summary).toMatchObject({ signedIn: true, handle: "acme_shop", newItems: 0, commentReads: 2 });
    expect(summary.baselines).toBe(summary.sourcesRead);
    expect(Object.keys(state.sources).sort()).toEqual(["activity", "comments:own", "profile:rival_store:comments", "profile:rival_store:posts", "tags"]);
    // The posts are watched from here on, at the counts they have now.
    expect(state.posts[mine.pk]).toMatchObject({ owner: "acme_shop", comments: 2 });
    expect(state.posts[theirs.pk]).toMatchObject({ owner: "rival_store", comments: 4 });
    expect(state.followers).toMatchObject({ acme_shop: { followers: 500 }, rival_store: { followers: 9000 } });
    // The dashboard gets what is there now: the comments on the account's
    // posts, and the keyword comments under the watched profile's.
    expect(matches.map((match) => match.item.text).sort()).toEqual(
      ["@acme_shop love it", "Does it ship to Canada?", "Our summer sale", "acme does this cheaper", "nice"].sort(),
    );
    expect(ig.opened).toEqual([LANDING_URL, "about:blank"]);
  });

  it("reads no more threads than allowed on the first pass, and the rest when they grow", async () => {
    const second = post("acme_shop", 5, "Older drop", { comments: 1 });
    ig.profiles.acme_shop!.posts = [mine, second];
    const first = await pass(watching({ maxCommentReads: 1, profiles: [] }));
    expect(first.summary).toMatchObject({ commentReads: 1, commentReadsDeferred: 1 });
    expect(first.state.posts[second.pk]).toMatchObject({ comments: 0 });
    later();
    const next = await pass(first.state);
    expect(ig.threadsRead).toEqual([mine.pk, second.pk]);
    expect(next.summary).toMatchObject({ commentReads: 1, commentReadsDeferred: 0, newItems: 0 });
  });

  it("never mutates the state it was given", async () => {
    const given = watching();
    const copy = structuredClone(given);
    await pass(Object.freeze(given));
    expect(given).toEqual(copy);
  });
});

describe("comments on the account's posts", () => {
  it("reads a thread only when its count grew, and announces what is new", async () => {
    const first = await pass(watching());
    const before = ig.threadsRead.length;
    const minute = later();
    grow(mine, comment("buyer", minute, "Does it ship to Canada?"), comment("acme_shop", minute + 1, "thanks all!"));
    const { events, summary } = await pass(first.state);

    expect(ig.threadsRead.slice(before)).toEqual([mine.pk]);
    expect(summary.commentReads).toBe(1);
    const [question] = fresh(events);
    expect(fresh(events)).toHaveLength(1);
    expect(question).toMatchObject({
      source: { kind: "own_comments" },
      item: { author: "buyer", kind: "comment", addressed: "comment_on_post", post: { id: mine.pk, url: `https://www.instagram.com/p/${mine.shortcode}/` } },
      triage: { urgency: "high", reasons: ["Comments on your post", "Asks a question", "No reply yet"] },
    });
    expect(question!.item.url).toBe(`https://www.instagram.com/p/${mine.shortcode}/c/${question!.item.id}/`);
  });

  it("reads the comments of a post published after monitoring started", async () => {
    const first = await pass(watching());
    const minute = later();
    const fresh_ = post("acme_shop", minute, "Restock!", { comments: 0 });
    ig.profiles.acme_shop!.posts = [fresh_, mine];
    grow(fresh_, comment("buyer", minute + 2, "finally"));
    const { events } = await pass(first.state);
    expect(texts(events)).toEqual(["finally"]);
  });

  it("reads no more threads than allowed, and catches up on the next pass", async () => {
    const second = post("acme_shop", 5, "Older drop", { comments: 1 });
    ig.profiles.acme_shop!.posts = [mine, second];
    const first = await pass(watching({ maxCommentReads: 1, profiles: [] }));
    let minute = later();
    grow(mine, comment("a", minute, "one"));
    grow(second, comment("b", minute, "two"));
    const middle = await pass(first.state);
    expect(texts(middle.events)).toEqual(["one"]);
    expect(middle.summary).toMatchObject({ commentReads: 1, commentReadsDeferred: 1 });
    expect(middle.summary.notes).toContain("1 post with new comments waits for the next pass (maxCommentReads).");
    minute = later();
    const last = await pass(middle.state);
    expect(texts(last.events)).toEqual(["two"]);
  });
});

describe("a pass that stops halfway through the threads", () => {
  it("keeps the threads it read due, so their comments are announced next time", async () => {
    const second = post("acme_shop", 5, "Older drop", { comments: 1 });
    ig.profiles.acme_shop!.posts = [mine, second];
    const first = await pass(watching({ profiles: [] }));
    const minute = later();
    grow(mine, comment("a", minute, "one"));
    grow(second, comment("b", minute, "two"));
    ig.throttle = `comments ${second.pk}`;
    const stopped = await pass(first.state);
    expect(stopped.summary.rateLimited).toBe(true);
    expect(fresh(stopped.events)).toHaveLength(0);
    expect(stopped.state.posts[mine.pk]!.comments).toBe(2);
    ig.throttle = "";
    later();
    const next = await pass(stopped.state);
    expect(texts(next.events).sort()).toEqual(["one", "two"]);
  });
});

describe("the activity feed", () => {
  it("announces a mention as high, and the same comment found under a post only once", async () => {
    const first = await pass(watching());
    const minute = later();
    const mention = comment("fan", minute, "@acme_shop is this legit?");
    ig.stories = [story("fan", minute, "fan mentioned you in a comment: @acme_shop is this legit?", { comment_id: mention.pk, media_id: mine.pk })];
    grow(mine, mention);
    const { events } = await pass(first.state);

    expect(fresh(events)).toHaveLength(1);
    expect(fresh(events)[0]).toMatchObject({
      source: { kind: "activity" },
      item: { key: `comment:${mention.pk}`, addressed: "mention", text: "@acme_shop is this legit?" },
      triage: { urgency: "high", reasons: ["Mentions you", "Asks a question"] },
    });
  });

  it("leaves out likes and follows: there is nothing to answer in them", async () => {
    const first = await pass(watching());
    const minute = later();
    ig.stories = [story("fan", minute, "fan liked your post."), story("fan2", minute, "fan2 started following you.")];
    const { events } = await pass(first.state);
    expect(fresh(events)).toHaveLength(0);
  });

  it("calls a comment under someone else's post a reply", async () => {
    const first = await pass(watching());
    const minute = later();
    ig.stories = [story("fan", minute, "fan replied to your comment: agreed", { comment_id: "1800000000000000777", media_id: "3254998171211400001" })];
    const { events } = await pass(first.state);
    expect(fresh(events)[0]!.item).toMatchObject({ addressed: "reply", text: "agreed" });
  });
});

describe("tags", () => {
  it("announces a post the account is tagged in as high", async () => {
    const first = await pass(watching());
    const minute = later();
    ig.tagged = [post("blogger", minute, "Unboxing my new kit")];
    const { events } = await pass(first.state);
    expect(fresh(events)[0]).toMatchObject({ source: { kind: "tags" }, item: { addressed: "tag", author: "blogger" }, triage: { urgency: "high" } });
  });
});

describe("watched profiles", () => {
  it("announces a watched profile's new post, and the comments under it that name a keyword", async () => {
    const first = await pass(watching({ excludeKeywords: ["giveaway"] }));
    const minute = later();
    const launch = post("rival_store", minute, "Big launch today", { comments: 0 });
    ig.profiles.rival_store!.posts = [launch, theirs];
    grow(theirs,
      comment("shopper", minute, "acme does this cheaper, anyone tried?"),
      comment("shopper2", minute, "love it"),
      comment("bot", minute, "acme giveaway click here"));
    const { events } = await pass(first.state);

    expect(texts(events).sort()).toEqual(["Big launch today", "acme does this cheaper, anyone tried?"]);
    const competitor = fresh(events).find((event) => event.source.kind === "profile_comments")!;
    expect(competitor).toMatchObject({ source: { name: "@rival_store" }, keywords: ["acme"], triage: { urgency: "low", reasons: ["Asks a question"] } });
  });

  it("reads no comments under a watched profile's posts without keywords", async () => {
    const first = await pass(watching({ keywords: [] }));
    later();
    grow(theirs, comment("x", 0, "acme"));
    await pass(first.state);
    expect(ig.threadsRead).not.toContain(theirs.pk);
  });

  it("says when a profile is private or does not exist", async () => {
    ig.profiles.locked = { followers: 1, posts: [post("locked", 1, "hidden")], private: true };
    const { summary } = await pass(watching({ profiles: ["locked", "nobody_here"] }));
    expect(summary.notes).toEqual(expect.arrayContaining([
      "@locked is private: follow it from this account to see its posts.",
      "@nobody_here was not found: check the spelling.",
    ]));
  });

  it("reports a follower count that moved", async () => {
    const first = await pass(watching());
    ig.profiles.rival_store!.followers = 9100;
    later();
    const { events } = await pass(first.state);
    expect(events).toContainEqual(expect.objectContaining({ type: "followers_changed", handle: "rival_store", own: false, previous: 9000, current: 9100, delta: 100 }));
  });
});

describe("GraphQL queries Instagram no longer knows", () => {
  const fresh_ = { posts: { docId: "11111111111111111", providers: { __relay_internal__pv__NewFlagrelayprovider: true } }, content: { docId: "22222222222222222", providers: {} }, tagged: { docId: "33333333333333333", providers: {} } };

  it("reads the current ids off the tagged tab once, keeps them, and reads on", async () => {
    ig.staleDocs = [DEFAULT_QUERIES.posts.docId];
    ig.liveQueries = { ok: true, queries: fresh_, missing: [] };
    const { state, summary } = await pass(watching());

    expect(ig.opened).toEqual([LANDING_URL, queriesPage("acme_shop"), LANDING_URL, "about:blank"]);
    expect(ig.labels.filter((label) => label === "queries")).toHaveLength(1);
    expect(state.queries).toMatchObject({ posts: { docId: "11111111111111111" }, resolvedAt: expect.any(Number) });
    expect(summary.notes).toEqual([]);
    expect(state.followers).toMatchObject({ acme_shop: { followers: 500 }, rival_store: { followers: 9000 } });
    // The retried read and every later one carry the new id and flags.
    const profileScripts = ig.scripts.filter((_, index) => ig.labels[index]!.startsWith("profile @"));
    expect(profileScripts.slice(1).every((script) => script.includes("11111111111111111") && script.includes("NewFlag"))).toBe(true);

    // The next pass starts from the kept ids and needs no refresh.
    ig.labels.length = 0;
    later();
    await pass(state);
    expect(ig.labels).not.toContain("queries");
  });

  it("notes a query it could not repair, and still reads activity and comments", async () => {
    ig.staleDocs = [DEFAULT_QUERIES.posts.docId];
    ig.stories = [story("fan", 30, "fan mentioned you in a comment: @acme_shop hi", { comment_id: "1800000000000000002", media_id: theirs.pk })];
    const { state, summary, matches } = await pass(watching());

    expect(ig.labels.filter((label) => label === "queries")).toHaveLength(6);
    expect(state.queries).toBeUndefined();
    expect(summary.notes).toContain("Instagram changed how its profile pages ask for data and the monitor could not catch up: profiles and tagged posts were not read. Update the monitor; activity and comments still work.");
    expect(matches.map((match) => match.item.text)).toContain("@acme_shop hi");
    expect(summary.blocked).toBeUndefined();
  });
});

describe("degraded states", () => {
  it("stops at a signed-out profile, says so once, and picks up after a sign-in", async () => {
    const first = await pass(watching());
    ig.signedIn = false;
    later();
    const out = await pass(first.state);
    expect(types(out.events)).toEqual(["signed_out"]);
    expect(out.summary).toMatchObject({ signedIn: false, loginRequired: true, requests: 1 });
    expect(out.state.sources).toEqual(first.state.sources);
    later();
    const still = await pass(out.state);
    expect(types(still.events)).toEqual([]);
    ig.signedIn = true;
    later();
    const back = await pass(still.state);
    expect(types(back.events)).toEqual(["signed_in"]);
  });

  it("stops at a security check and asks for it to be done by hand", async () => {
    const first = await pass(watching());
    ig.checkpoint = true;
    later();
    const { events, summary } = await pass(first.state);
    expect(types(events)).toEqual(["security_check"]);
    expect(summary).toMatchObject({ securityCheck: true, requests: 1 });
    expect(summary.blocked).toContain("security check");
    expect(ig.opened.at(-1)).toBe("about:blank");
  });

  it("stops when Instagram limits the account, keeping what was read before", async () => {
    const first = await pass(watching());
    const minute = later();
    ig.stories = [story("fan", minute, "fan mentioned you: @acme_shop hi", { comment_id: "1800000000000000999" })];
    ig.throttle = "profile @rival_store";
    const { events, summary, state } = await pass(first.state);
    expect(summary.rateLimited).toBe(true);
    expect(summary.blocked).toContain("feedback_required");
    expect(fresh(events)).toHaveLength(1);
    expect(state.sources["profile:rival_store:posts"]).toEqual(first.state.sources["profile:rival_store:posts"]);
  });

  it("starts activity over when another account signs in", async () => {
    const first = await pass(watching());
    ig.handle = "other_brand";
    ig.profiles.other_brand = { followers: 3, posts: [] };
    const minute = later();
    ig.stories = [story("fan", minute, "fan mentioned you: @other_brand hey", { comment_id: "1800000000000000555" })];
    const { events } = await pass(first.state);
    expect(types(events)).toEqual(["account_changed"]);
  });
});

describe("settings", () => {
  it("forgets a profile that was removed, so adding it back starts over", async () => {
    const first = await pass(watching());
    later();
    const without = await pass(withSettings(first.state, { profiles: [] }));
    expect(Object.keys(without.state.sources)).not.toContain("profile:rival_store:posts");
    expect(without.state.followers.rival_store).toBeUndefined();
  });

  it("does not announce what is older than the age window after a long absence", async () => {
    const first = await pass(watching({ maxItemAgeMs: 6 * HOUR }));
    const minute = later(20 * 60);
    grow(mine, comment("early", minute + 60, "old news?"), comment("late", minute + 19 * 60, "fresh?"));
    const { events } = await pass(first.state);
    expect(texts(events)).toEqual(["fresh?"]);
  });
});

describe("checkAccount", () => {
  it("opens instagram.com, says who is signed in, and leaves the page open", async () => {
    expect(await checkAccount({ browser: ig })).toEqual({ signedIn: true, handle: "acme_shop" });
    expect(ig.opened).toEqual([SIGN_IN_URL]);
    ig.signedIn = false;
    expect(await checkAccount({ browser: ig })).toEqual({ signedIn: false });
    ig.signedIn = true;
    ig.checkpoint = true;
    expect(await checkAccount({ browser: ig })).toEqual({ signedIn: false, securityCheck: true });
  });
});
