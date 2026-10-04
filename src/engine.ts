// One monitoring pass: who is signed in, what is new in the activity feed,
// which new comments landed under the account's posts, which posts the
// account was tagged in, what the watched profiles posted, which comments
// under their posts name a keyword, how urgent each one is, and whether a
// follower count moved.
//
// The pass is a state machine over an explicit MonitorState, like the X and
// Reddit monitors: state in, next state and events out, nothing mutated. The
// caller persists the state and schedules the next pass.
//
// Everything is read, nothing is done: no like, no comment, no reply, no
// follow. Answering is the reply agent's job, with the person's approval.
//
// Comment threads are the expensive read, so the pass reads one only when the
// post's comment count grew since it last looked. A pass reads at most
// maxCommentReads threads; a post past that waits for the next pass with its
// old count, so nothing is skipped, only delayed.

import type { MonitorBrowser } from "./browser.js";
import type { ItemSource, Match, MonitorEvent } from "./events.js";
import { activityItem, commentItem, isOwn, matchText, postContext, postItem, type InstagramItem } from "./items.js";
import { keywordMatcher, signature, type Matcher } from "./keywords.js";
import { errorText, makeLogger, type LogSink, type Logger } from "./log.js";
import {
  LANDING_URL,
  SIGN_IN_URL,
  activityScript,
  commentsScript,
  meScript,
  originScript,
  profileScript,
  tagsScript,
  type ActivitySnapshot,
  type CommentsSnapshot,
  type FetchMeta,
  type MeSnapshot,
  type OriginSnapshot,
  type ProfileSnapshot,
  type RawPost,
  type TagsSnapshot,
} from "./scripts.js";
import {
  MAX_HISTORY,
  MAX_PASS_NOTES,
  MAX_POSTS_WATCHED,
  MAX_SEEN,
  normalizeHandle,
  normalizeState,
  type FollowerStats,
  type MonitorState,
  type PostWatch,
  type SourceState,
} from "./state.js";
import { byUrgency, triage } from "./triage.js";

const BLANK_PAGE = "about:blank";
const LOAD_WAIT_SECONDS = 15;

export type Sleep = (ms: number) => Promise<void>;

export const defaultSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export interface PassDeps {
  browser: MonitorBrowser;
  state: MonitorState;
  now?: () => number;
  sleep?: Sleep;
  /** A source of numbers in [0, 1), for the pauses a person would take. */
  random?: () => number;
  log?: LogSink;
  /** Called for every event as it happens, before the pass returns. */
  onEvent?: (event: MonitorEvent) => void;
  /** Called with what the pass is doing, for a status line. */
  onStep?: (step: string) => void;
  /** Checked between requests, so Stop ends the pass instead of waiting it
   *  out. */
  shouldStop?: () => boolean;
}

export interface PassSummary {
  signedIn: boolean;
  handle?: string;
  /** The profile is not signed in to Instagram, so nothing could be read. */
  loginRequired: boolean;
  /** Instagram wants the account to pass a security check before it answers
   *  again. Someone has to open instagram.com in the profile and do it. */
  securityCheck: boolean;
  /** Instagram is limiting the account, and the pass stopped early. */
  rateLimited: boolean;
  /** Why the pass stopped reading, when it did: a refusal, a security check,
   *  a site that could not be reached. The next pass should back off. */
  blocked?: string;
  /** Requests made to instagram.com. */
  requests: number;
  sourcesRead: number;
  /** Sources read for the first time, or with a new keyword set: what they
   *  hold is the starting line, and nothing in them is announced. */
  baselines: number;
  itemsRead: number;
  /** Items that matched, new or not, inside the age window. */
  matches: number;
  newItems: number;
  /** New items triaged as high urgency. */
  urgent: number;
  /** Comment threads read, and threads that grew but wait for the next pass
   *  because this one had read its share. */
  commentReads: number;
  commentReadsDeferred: number;
  followerChecks: number;
  followerChanges: number;
  stopped: boolean;
  notes: string[];
}

export interface PassResult {
  state: MonitorState;
  events: MonitorEvent[];
  summary: PassSummary;
  /** Every item the pass found that matched, new or not, inside the age
   *  window, most urgent first: what a dashboard shows. */
  matches: Match[];
}

export interface AccountCheck {
  signedIn: boolean;
  handle?: string;
  /** Instagram wants a security check before anything else. */
  securityCheck?: boolean;
  /** Why instagram.com could not be read at all. */
  blocked?: string;
}

class StopRequested extends Error {}
class SignedOut extends Error {}
class Blocked extends Error {}
class SecurityCheck extends Error {}
class RateLimited extends Error {}

const SECURITY_NOTE = "Instagram wants this account to pass a security check before it answers again. Open instagram.com in the profile and complete it; monitoring picks up on the next pass.";

/** checkAccount opens instagram.com and reads who is signed in, and stops
 *  there: nothing else is read, and the page is left open for a person who is
 *  about to sign in. It is what a panel calls before any monitoring has run. */
export async function checkAccount(deps: { browser: MonitorBrowser; now?: () => number; log?: LogSink }): Promise<AccountCheck> {
  const log = makeLogger(deps.log, deps.now ?? Date.now);
  await deps.browser.open(SIGN_IN_URL);
  await deps.browser.waitForLoad(LOAD_WAIT_SECONDS).catch(() => undefined);
  const where = await deps.browser.evaluate<OriginSnapshot>(originScript(), "origin");
  if (where.checkpoint_page) return { signedIn: false, securityCheck: true };
  const me = await deps.browser.evaluate<MeSnapshot>(meScript(), "me");
  log("identity", { status: me.status, signed_in: me.signed_in, user: me.user?.username, reason: me.reason, refused: me.refused, error: me.error });
  if (me.checkpoint) return { signedIn: false, securityCheck: true };
  if (me.signed_in && me.user) return { signedIn: true, handle: me.user.username };
  if (me.login_required) return { signedIn: false };
  if (me.status === 0 && me.error) return { signedIn: false, blocked: `instagram.com could not be reached (${me.error}).` };
  if (me.throttled) return { signedIn: false, blocked: `Instagram is limiting this account${me.reason ? ` ("${me.reason}")` : ""}.` };
  return { signedIn: false, ...(me.refused ? { blocked: `instagram.com answered with a page instead of data: ${me.refused}` } : {}) };
}

/** runPass runs one monitoring pass. It does not throw for anything Instagram
 *  or the browser does; failures end up in the summary's notes and the log. */
export async function runPass(deps: PassDeps): Promise<PassResult> {
  return new Pass(deps).run();
}

interface SourceRead {
  key: string;
  source: ItemSource;
  /** What the source is filtered by, for SourceState.filter. */
  filter: string;
  /** Whether an item must name a keyword to count. */
  filtered: boolean;
  items: InstagramItem[];
}

class Pass {
  private readonly browser: MonitorBrowser;
  private readonly now: () => number;
  private readonly sleep: Sleep;
  private readonly random: () => number;
  private readonly log: Logger;
  private readonly deps: PassDeps;
  private readonly at: number;
  private state: MonitorState;
  private readonly events: MonitorEvent[] = [];
  private readonly matches = new Map<string, Match>();
  private readonly seen: Set<string>;
  private readonly seenOrder: string[];
  private readonly sources: Record<string, SourceState> = {};
  private readonly posts: Record<string, PostWatch>;
  private readonly planned = new Set<string>();
  private readonly keywords: Matcher;
  private readonly excluded: Matcher;
  private readonly urgent: Matcher;
  private handle = "";
  private ownPostIds = new Set<string>();
  private readonly summary: PassSummary = {
    signedIn: false,
    loginRequired: false,
    securityCheck: false,
    rateLimited: false,
    requests: 0,
    sourcesRead: 0,
    baselines: 0,
    itemsRead: 0,
    matches: 0,
    newItems: 0,
    urgent: 0,
    commentReads: 0,
    commentReadsDeferred: 0,
    followerChecks: 0,
    followerChanges: 0,
    stopped: false,
    notes: [],
  };

  constructor(deps: PassDeps) {
    this.deps = deps;
    this.browser = deps.browser;
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? defaultSleep;
    this.random = deps.random ?? Math.random;
    this.log = makeLogger(deps.log, this.now);
    this.at = this.now();
    this.state = normalizeState(deps.state);
    this.seenOrder = [...this.state.seen];
    this.seen = new Set(this.seenOrder);
    this.posts = { ...this.state.posts };
    const settings = this.state.settings;
    this.keywords = keywordMatcher(settings.keywords);
    this.excluded = keywordMatcher(settings.excludeKeywords);
    this.urgent = keywordMatcher(settings.urgentTerms);
  }

  async run(): Promise<PassResult> {
    this.log("pass_start", { settings: this.state.settings, account: this.state.account?.handle });
    const settings = this.state.settings;
    try {
      await this.land();
      await this.readAccount();
      const own = await this.readOwnProfile();
      if (settings.watchActivity) await this.readActivity();
      if (settings.watchOwnComments && own) await this.readOwnComments(own.posts);
      if (settings.watchTags && this.state.account?.pk) await this.readTags(this.state.account.pk);
      for (const handle of settings.profiles) {
        if (handle.toLowerCase() === this.handle.toLowerCase()) continue;
        await this.readProfile(handle);
      }
    } catch (error) {
      if (error instanceof StopRequested) {
        this.summary.stopped = true;
      } else if (error instanceof SignedOut) {
        this.signOut();
      } else if (error instanceof SecurityCheck) {
        this.securityCheck();
      } else if (error instanceof Blocked) {
        this.summary.blocked = error.message;
        this.note(error.message);
      } else if (error instanceof RateLimited) {
        this.summary.rateLimited = true;
        this.summary.blocked = error.message;
        this.note(error.message);
      } else {
        this.note(`The pass failed: ${errorText(error)}`);
        this.log("pass_error", { error: errorText(error) });
      }
    } finally {
      await this.park();
    }
    this.finish();
    const matches = [...this.matches.values()].sort(byUrgency);
    this.summary.matches = matches.length;
    this.log("pass_end", { ...this.summary });
    return { state: this.state, events: this.events, summary: this.summary, matches };
  }

  // --- landing and account ---------------------------------------------------

  /** land puts the tab on instagram.com, which every read is fetched from. */
  private async land(): Promise<void> {
    this.step("Opening instagram.com");
    const current = await this.browser.evaluate<OriginSnapshot>(originScript(), "origin").catch(() => undefined);
    if (current?.on_instagram && !current.login_page && !current.checkpoint_page) return;
    await this.browser.open(LANDING_URL);
    await this.browser.waitForLoad(LOAD_WAIT_SECONDS).catch(() => undefined);
    const landed = await this.browser.evaluate<OriginSnapshot>(originScript(), "origin");
    this.log("landed", { ...landed });
    if (landed.checkpoint_page) throw new SecurityCheck();
    if (!landed.on_instagram) throw new Blocked(`The tab did not reach instagram.com (it shows ${landed.url}).`);
  }

  /** readAccount asks Instagram who is signed in. Nothing on Instagram can be
   *  read signed out, so a signed-out profile ends the pass here. */
  private async readAccount(): Promise<void> {
    this.step("Reading the signed-in account");
    const me = await this.fetch<MeSnapshot>(meScript(), "me");
    if (!me.signed_in || !me.user) {
      throw new Blocked(`Instagram did not say who is signed in (HTTP ${me.status}${me.reason ? `, "${me.reason}"` : ""}).`);
    }
    const previous = this.state.account;
    const handle = normalizeHandle(me.user.username) || previous?.handle || "";
    if (!previous?.signedIn) this.emit({ type: "signed_in", at: this.at, ...(handle ? { handle } : {}) });
    if (previous?.handle && handle && previous.handle.toLowerCase() !== handle.toLowerCase()) {
      this.emit({ type: "account_changed", at: this.at, previous: previous.handle, current: handle });
      // Another account has its own activity, tags and posts: they start over.
      const own = new Set(["activity", "tags", "comments:own"]);
      this.state = {
        ...this.state,
        sources: Object.fromEntries(Object.entries(this.state.sources).filter(([key]) => !own.has(key))),
      };
      for (const [id, watch] of Object.entries(this.posts)) {
        if (watch.owner.toLowerCase() === previous.handle.toLowerCase()) delete this.posts[id];
      }
    }
    this.handle = handle;
    this.state = { ...this.state, account: { ...(handle ? { handle } : {}), ...(me.user.pk ? { pk: me.user.pk } : {}), signedIn: true, checkedAt: this.at } };
    this.summary.signedIn = true;
    if (handle) this.summary.handle = handle;
  }

  private signOut(): void {
    const previous = this.state.account;
    if (previous?.signedIn !== false) this.emit({ type: "signed_out", at: this.at, ...(previous?.handle ? { handle: previous.handle } : {}) });
    this.state = {
      ...this.state,
      account: { ...(previous?.handle ? { handle: previous.handle } : {}), ...(previous?.pk ? { pk: previous.pk } : {}), signedIn: false, checkedAt: this.at },
    };
    this.summary.signedIn = false;
    this.summary.loginRequired = true;
    this.note("The profile is not signed in to Instagram. Sign it in, and monitoring picks up on the next pass.");
  }

  private securityCheck(): void {
    const handle = this.handle || this.state.account?.handle;
    this.emit({ type: "security_check", at: this.at, ...(handle ? { handle } : {}) });
    this.summary.securityCheck = true;
    this.summary.blocked = SECURITY_NOTE;
    this.note(SECURITY_NOTE);
  }

  // --- the account's own profile ---------------------------------------------

  /** readOwnProfile reads the account's profile: its follower count and its
   *  newest posts, whose comments are watched. */
  private async readOwnProfile(): Promise<ProfileSnapshot | undefined> {
    if (!this.handle) return undefined;
    this.step("Reading your profile");
    const profile = await this.fetch<ProfileSnapshot>(profileScript(this.handle), `profile @${this.handle.toLowerCase()}`);
    if (!profile.ok || !profile.found) {
      this.note(`Your own profile could not be read (HTTP ${profile.status}${profile.reason ? `, "${profile.reason}"` : ""}); comments on your posts wait for the next pass.`);
      return undefined;
    }
    this.ownPostIds = new Set(profile.posts.map((post) => post.pk));
    this.recordFollowers(this.handle, true, profile);
    return profile;
  }

  // --- sources ---------------------------------------------------------------

  private async readActivity(): Promise<void> {
    this.step("Reading your activity");
    this.planned.add("activity");
    const activity = await this.fetch<ActivitySnapshot>(activityScript(), "activity");
    if (!activity.ok) {
      this.sourceFailed("activity", "Your activity", activity);
      return;
    }
    const items = activity.stories
      .map((story) => activityItem(story, this.handle, this.ownPostIds))
      .filter((item): item is InstagramItem => !!item);
    this.consider({ key: "activity", source: { kind: "activity", name: "activity" }, filter: "", filtered: false, items });
  }

  private async readTags(userPk: string): Promise<void> {
    this.step("Reading posts you are tagged in");
    this.planned.add("tags");
    const tags = await this.fetch<TagsSnapshot>(tagsScript(userPk), "tags");
    if (!tags.ok) {
      this.sourceFailed("tags", "Posts you are tagged in", tags);
      return;
    }
    const items = tags.posts.map((post) => postItem(post, "tag")).filter((item): item is InstagramItem => !!item);
    this.consider({ key: "tags", source: { kind: "tags", name: "tags" }, filter: "", filtered: false, items });
  }

  private async readOwnComments(posts: RawPost[]): Promise<void> {
    this.step("Reading comments on your posts");
    const key = "comments:own";
    this.planned.add(key);
    const items = await this.readThreads(key, newest(posts, this.state.settings.ownPosts), "comment_on_post");
    this.consider({ key, source: { kind: "own_comments", name: "your posts" }, filter: "", filtered: false, items });
  }

  /** readProfile reads one watched profile: its new posts, its follower count,
   *  and, with keywords, the comments under its newest posts that name one. */
  private async readProfile(handle: string): Promise<void> {
    this.step(`Reading @${handle}`);
    const lower = handle.toLowerCase();
    const postsKey = `profile:${lower}:posts`;
    const commentsKey = `profile:${lower}:comments`;
    this.planned.add(postsKey);
    const profile = await this.fetch<ProfileSnapshot>(profileScript(handle), `profile @${lower}`);
    if (!profile.found) {
      const why = profile.status === 404 || (profile.ok && !profile.found)
        ? `@${handle} was not found: check the spelling.`
        : `@${handle} could not be read (HTTP ${profile.status}${profile.reason ? `, "${profile.reason}"` : ""}).`;
      this.sourceFailed(postsKey, `@${handle}`, profile, why);
      return;
    }
    this.recordFollowers(handle, false, profile);
    if (profile.private && profile.posts.length === 0) {
      this.sourceFailed(postsKey, `@${handle}`, profile, `@${handle} is private: follow it from this account to see its posts.`);
      return;
    }
    const posts = profile.posts.map((post) => ({ ...post, owner: post.owner || profile.user?.username || handle }));
    const items = posts.map((post) => postItem(post)).filter((item): item is InstagramItem => !!item);
    const settings = this.state.settings;
    this.consider({ key: postsKey, source: { kind: "profile_posts", name: `@${handle}` }, filter: "all", filtered: false, items });
    if (settings.keywords.length > 0 && settings.watchProfileComments && settings.postsPerProfile > 0) {
      this.planned.add(commentsKey);
      const comments = await this.readThreads(commentsKey, newest(posts, settings.postsPerProfile));
      this.consider({ key: commentsKey, source: { kind: "profile_comments", name: `@${handle}` }, filter: signature(settings.keywords), filtered: true, items: comments });
    }
  }

  /** readThreads reads the comments under the posts whose comment count grew.
   *  A post seen for the first time is only recorded, unless it was posted
   *  after the source started: then its comments are all new. */
  private async readThreads(key: string, posts: RawPost[], addressed?: "comment_on_post"): Promise<InstagramItem[]> {
    const source = this.state.sources[key];
    const since = source?.since ?? this.at;
    const items: InstagramItem[] = [];
    for (const post of posts) {
      const count = post.comments ?? 0;
      const previous = this.posts[post.pk];
      const postedSince = post.taken_at !== null && post.taken_at * 1000 >= since;
      const grew = previous ? count > previous.comments : !!source && postedSince && count > 0;
      if (!grew) {
        this.watch(post, previous ? Math.min(previous.comments, count) : count);
        continue;
      }
      if (this.summary.commentReads >= this.state.settings.maxCommentReads) {
        // Keep the old count: the next pass sees the growth and reads it.
        this.summary.commentReadsDeferred += 1;
        continue;
      }
      const thread = await this.fetch<CommentsSnapshot>(commentsScript(post.pk), `comments ${post.pk}`);
      this.summary.commentReads += 1;
      if (!thread.ok) {
        this.log("thread_failed", { post: post.pk, status: thread.status, reason: thread.reason });
        continue;
      }
      const context = postContext(post);
      for (const comment of thread.comments) {
        const item = commentItem(comment, context, addressed);
        if (item) items.push(item);
      }
      this.watch(post, Math.max(count, thread.count ?? 0));
    }
    return items;
  }

  private watch(post: RawPost, comments: number): void {
    this.posts[post.pk] = {
      owner: post.owner,
      shortcode: post.shortcode,
      comments,
      ...(post.taken_at !== null ? { takenAt: post.taken_at * 1000 } : {}),
      checkedAt: this.at,
    };
  }

  /** consider decides what in one source's items is new, ranks it, and
   *  records the source. The first read of a source is its starting line. */
  private consider(read: SourceRead): void {
    const previous = this.state.sources[read.key];
    const baseline = !previous || previous.filter !== read.filter;
    const since = baseline ? this.at : previous.since;
    const maxAge = this.state.settings.maxItemAgeMs;
    const floor = maxAge > 0 ? Math.max(since, this.at - maxAge) : since;
    const fresh: Match[] = [];
    this.summary.sourcesRead += 1;
    this.summary.itemsRead += read.items.length;

    for (const item of read.items) {
      if (isOwn(item, this.handle)) continue;
      const text = matchText(item);
      const keywords = this.keywords(text);
      if (read.filtered && keywords.length === 0) continue;
      if (!item.addressed && this.excluded(text).length > 0) continue;
      const match: Match = { item, source: read.source, keywords, triage: triage(item, { at: this.at, keywords, urgent: this.urgent }) };
      const inWindow = maxAge === 0 || (item.createdAt !== undefined && item.createdAt >= this.at - maxAge);
      if (inWindow && !this.matches.has(item.key)) this.matches.set(item.key, match);
      const isNew = !baseline && !this.seen.has(item.key) && item.createdAt !== undefined && item.createdAt >= floor;
      this.remember(item.key);
      if (isNew) fresh.push(match);
    }

    fresh.sort((left, right) => (left.item.createdAt ?? 0) - (right.item.createdAt ?? 0));
    for (const match of fresh) {
      this.emit({ type: "new_item", at: this.at, ...(this.handle ? { account: this.handle } : {}), ...match });
      if (match.triage.urgency === "high") this.summary.urgent += 1;
    }
    this.summary.newItems += fresh.length;
    if (baseline) this.summary.baselines += 1;
    this.log("source", { source: read.key, baseline, read: read.items.length, fresh: fresh.length });
    this.sources[read.key] = {
      since,
      filter: read.filter,
      lastReadAt: this.at,
      ...(fresh.length > 0 ? { lastNewAt: this.at } : previous?.lastNewAt !== undefined && !baseline ? { lastNewAt: previous.lastNewAt } : {}),
    };
  }

  private sourceFailed(key: string, name: string, meta: FetchMeta, why?: string): void {
    const note = why ?? `${name} could not be read (HTTP ${meta.status}${meta.reason ? `, "${meta.reason}"` : meta.refused ? `: ${meta.refused}` : ""}).`;
    this.note(note);
    const previous = this.state.sources[key];
    if (previous) this.sources[key] = { ...previous, note };
  }

  private remember(key: string): void {
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.seenOrder.push(key);
  }

  // --- followers -------------------------------------------------------------

  private recordFollowers(handle: string, own: boolean, profile: ProfileSnapshot): void {
    if (!this.state.settings.trackFollowers || profile.followers === null) return;
    this.summary.followerChecks += 1;
    const key = handle.toLowerCase();
    const previous: FollowerStats = this.state.followers[key] ?? { handle, history: [] };
    const followers = profile.followers;
    const next: FollowerStats = {
      handle: profile.user?.username || previous.handle || handle,
      followers,
      ...(profile.following !== null ? { following: profile.following } : {}),
      ...(profile.posts_count !== null ? { posts: profile.posts_count } : {}),
      checkedAt: this.at,
      ...(previous.changedAt !== undefined ? { changedAt: previous.changedAt } : {}),
      history: previous.history,
    };
    if (previous.followers === undefined) {
      next.history = [...previous.history, { at: this.at, value: followers }].slice(-MAX_HISTORY);
    } else if (previous.followers !== followers) {
      this.emit({ type: "followers_changed", at: this.at, handle: next.handle, own, previous: previous.followers, current: followers, delta: followers - previous.followers });
      this.summary.followerChanges += 1;
      next.changedAt = this.at;
      next.history = [...previous.history, { at: this.at, value: followers }].slice(-MAX_HISTORY);
    }
    this.state = { ...this.state, followers: { ...this.state.followers, [key]: next } };
  }

  // --- plumbing --------------------------------------------------------------

  /** fetch runs one request script, paced like a person moving between pages,
   *  and turns what would end the pass — a sign-in wall, a security check, a
   *  rate limit, a refusal, an unreachable site — into the matching error. */
  private async fetch<T extends FetchMeta>(script: string, label: string): Promise<T> {
    this.checkStop();
    // Instagram is quicker than most sites to restrict an account that reads
    // fast, so the pauses are longer than the other monitors'.
    if (this.summary.requests > 0) await this.sleep(this.pause(1500, 4000));
    this.checkStop();
    const started = this.now();
    const result = await this.browser.evaluate<T>(script, label);
    this.summary.requests += 1;
    this.log("request", {
      label,
      path: result.path,
      status: result.status,
      ok: result.ok,
      ms: this.now() - started,
      ...(result.reason ? { reason: result.reason } : {}),
      ...(result.refused ? { refused: result.refused } : {}),
      ...(result.error ? { error: result.error } : {}),
      ...(result.login_required ? { login_required: true } : {}),
      ...(result.checkpoint ? { checkpoint: true } : {}),
      ...(result.throttled ? { throttled: true } : {}),
    });
    if (result.login_required) throw new SignedOut();
    if (result.checkpoint) throw new SecurityCheck();
    if (result.throttled) {
      throw new RateLimited(`Instagram is limiting this account${result.reason ? ` ("${result.reason}")` : ""}. The pass stopped; the next one waits longer.`);
    }
    if (result.status === 0 && result.error) throw new Blocked(`instagram.com could not be reached (${result.error}).`);
    // A page instead of data from an endpoint that answers data means
    // Instagram changed or closed it; a 404 page is about the one profile.
    if (result.refused && result.status !== 404) throw new Blocked(`instagram.com answered with a page instead of data (HTTP ${result.status}: ${result.refused}).`);
    return result;
  }

  /** finish settles the sources, the watched posts and the seen list. A
   *  source that is no longer configured is forgotten, so adding it back
   *  starts a fresh baseline. */
  private finish(): void {
    const deferred = this.summary.commentReadsDeferred;
    if (deferred > 0) this.note(`${deferred} post${deferred === 1 ? "" : "s"} with new comments wait${deferred === 1 ? "s" : ""} for the next pass (maxCommentReads).`);
    const sources: Record<string, SourceState> = {};
    for (const [key, value] of Object.entries(this.state.sources)) {
      if (this.planned.has(key) || this.stillConfigured(key)) sources[key] = value;
    }
    Object.assign(sources, this.sources);
    const watched = new Set(this.state.settings.profiles.map((handle) => handle.toLowerCase()));
    const own = (this.handle || this.state.account?.handle || "").toLowerCase();
    const followers = Object.fromEntries(Object.entries(this.state.followers).filter(([key]) => watched.has(key) || key === own));
    const posts = Object.fromEntries(
      Object.entries(this.posts)
        .filter(([, watch]) => !watch.owner || watch.owner.toLowerCase() === own || watched.has(watch.owner.toLowerCase()))
        .sort(([, left], [, right]) => left.checkedAt - right.checkedAt)
        .slice(-MAX_POSTS_WATCHED),
    );
    this.state = {
      ...this.state,
      sources,
      posts,
      followers,
      seen: this.seenOrder.slice(-MAX_SEEN),
      lastPass: {
        at: this.at,
        finishedAt: this.now(),
        newItems: this.summary.newItems,
        urgent: this.summary.urgent,
        followerChanges: this.summary.followerChanges,
        notes: this.summary.notes,
      },
    };
  }

  /** stillConfigured tells a source the settings still ask for, for a pass
   *  that ended before it reached it. */
  private stillConfigured(key: string): boolean {
    const settings = this.state.settings;
    if (key === "activity") return settings.watchActivity;
    if (key === "tags") return settings.watchTags;
    if (key === "comments:own") return settings.watchOwnComments;
    const profile = /^profile:([^:]+):(posts|comments)$/.exec(key);
    if (!profile) return false;
    return settings.profiles.some((handle) => handle.toLowerCase() === profile[1]);
  }

  /** park leaves the tab on a blank page. It is best effort. */
  private async park(): Promise<void> {
    if (!this.state.settings.parkTab) return;
    try {
      await this.browser.open(BLANK_PAGE);
    } catch (error) {
      this.log("park_failed", { error: errorText(error) });
    }
  }

  private pause(min: number, max: number): number {
    return Math.round(min + (max - min) * this.random());
  }

  private emit(event: MonitorEvent): void {
    this.events.push(event);
    this.log("event", { event });
    try {
      this.deps.onEvent?.(event);
    } catch (error) {
      this.log("on_event_failed", { error: errorText(error) });
    }
  }

  private step(step: string): void {
    this.log("step", { step });
    try {
      this.deps.onStep?.(step);
    } catch {
      /* a status line is not worth a pass */
    }
  }

  private note(note: string): void {
    if (this.summary.notes.includes(note)) return;
    this.summary.notes = [...this.summary.notes, note].slice(-MAX_PASS_NOTES);
  }

  private checkStop(): void {
    if (this.deps.shouldStop?.()) throw new StopRequested("stopped");
  }
}

/** newest takes a profile's newest posts by when they were posted. The
 *  profile lists pinned posts first, and a post pinned a year ago is not
 *  where new comments are. */
function newest(posts: RawPost[], count: number): RawPost[] {
  return [...posts].sort((left, right) => (right.taken_at ?? 0) - (left.taken_at ?? 0)).slice(0, count);
}
