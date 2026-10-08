// Monitor state and settings: one JSON document the caller owns and persists.
//
// A pass takes the state in and hands the next one back without mutating what
// it was given, so a pass cut short leaves the last saved state intact and
// everything a finished pass learned is in what it returned.

import { MAX_KEYWORDS, normalizeKeywords } from "./keywords.js";
import { mediaPk } from "./ids.js";
import { DEFAULT_URGENT_TERMS } from "./triage.js";
import type { ProviderValue, QueryKey, ResolvedQuery } from "./scripts.js";

export interface MonitorSettings {
  /** Words and phrases to find: a brand, a product, a competitor. */
  keywords: string[];
  /** Words that drop an item even when a keyword matched. */
  excludeKeywords: string[];
  /** Profiles to watch, without the @: competitors, partners, the accounts
   *  your customers follow. Each one's new posts are reported; with keywords,
   *  so are the comments under them that name a keyword. */
  profiles: string[];
  /** Read the activity feed: mentions, replies, and comments on your posts. */
  watchActivity: boolean;
  /** Read the comment threads under the account's own newest posts. */
  watchOwnComments: boolean;
  /** Read the posts the account is tagged in. */
  watchTags: boolean;
  /** Read the comments under watched profiles' newest posts, for keyword
   *  matches. Only with keywords. */
  watchProfileComments: boolean;
  /** Terms that make an item urgent; see triage.ts. */
  urgentTerms: string[];
  /** How many of the account's newest posts have their comments watched. */
  ownPosts: number;
  /** How many of each watched profile's newest posts have their comments
   *  read for keywords. */
  postsPerProfile: number;
  /** How many comment threads one pass may read. A post whose comment count
   *  grew past this is read on the next pass instead. */
  maxCommentReads: number;
  /** How old an item may be and still be announced. 0 turns the limit off. */
  maxItemAgeMs: number;
  /** Track follower counts of the account and the watched profiles. They come
   *  with the profile reads, so they cost no request of their own. */
  trackFollowers: boolean;
  /** Leave the tab on about:blank after a pass. */
  parkTab: boolean;
}

export interface AccountState {
  handle?: string;
  pk?: string;
  signedIn: boolean;
  checkedAt: number;
}

/** One thing the monitor reads: the activity feed, the tagged posts, the
 *  comments on the account's posts, a profile's posts, or the comments under
 *  a profile's posts. */
export interface SourceState {
  /** When the source was first read with its current filter: nothing created
   *  before it is announced. */
  since: number;
  /** The keyword set it filtered by when `since` was set. */
  filter: string;
  lastReadAt?: number;
  lastNewAt?: number;
  note?: string;
}

/** What the monitor last knew about one post, to tell when its comments are
 *  worth reading again: only a post whose comment count grew is read. */
export interface PostWatch {
  owner: string;
  shortcode: string;
  /** Its comment count when its comments were last read, or when it was
   *  first seen. */
  comments: number;
  takenAt?: number;
  checkedAt: number;
}

export interface CountSample {
  at: number;
  value: number;
}

export interface FollowerStats {
  handle: string;
  followers?: number;
  following?: number;
  posts?: number;
  checkedAt?: number;
  changedAt?: number;
  history: CountSample[];
  note?: string;
}

export interface PassRecord {
  at: number;
  finishedAt: number;
  newItems: number;
  urgent: number;
  followerChanges: number;
  notes: string[];
}

export interface MonitorState {
  version: 1;
  settings: MonitorSettings;
  account?: AccountState;
  /** Keyed by source: "activity", "tags", "comments:own",
   *  "profile:<handle>:posts", "profile:<handle>:comments". */
  sources: Record<string, SourceState>;
  /** Item keys already seen or announced, newest last, bounded, across every
   *  source. */
  seen: string[];
  /** Keyed by media id. */
  posts: Record<string, PostWatch>;
  /** Keyed by lowercased handle; the account itself included. */
  followers: Record<string, FollowerStats>;
  lastPass?: PassRecord;
  /** The GraphQL doc ids and provider flags read off instagram.com after the
   *  built-in ones stopped working; absent while those still work. */
  queries?: StoredQueries;
}

export type StoredQueries = Partial<Record<QueryKey, ResolvedQuery>> & { resolvedAt: number };

export const MAX_PROFILES = 10;
export const MAX_URGENT_TERMS = 50;
export const DEFAULT_OWN_POSTS = 6;
export const DEFAULT_POSTS_PER_PROFILE = 3;
export const DEFAULT_MAX_COMMENT_READS = 10;
export const DEFAULT_MAX_ITEM_AGE_MS = 48 * 60 * 60 * 1000;
export const MAX_SEEN = 5000;
export const MAX_POSTS_WATCHED = 300;
export const MAX_HISTORY = 200;
export const MAX_PASS_NOTES = 5;

/** Instagram usernames: letters, digits, periods and underscores, up to 30. */
const HANDLE = /^[A-Za-z0-9._]{1,30}$/;

export function defaultSettings(): MonitorSettings {
  return {
    keywords: [],
    excludeKeywords: [],
    profiles: [],
    watchActivity: true,
    watchOwnComments: true,
    watchTags: true,
    watchProfileComments: true,
    urgentTerms: [...DEFAULT_URGENT_TERMS],
    ownPosts: DEFAULT_OWN_POSTS,
    postsPerProfile: DEFAULT_POSTS_PER_PROFILE,
    maxCommentReads: DEFAULT_MAX_COMMENT_READS,
    maxItemAgeMs: DEFAULT_MAX_ITEM_AGE_MS,
    trackFollowers: true,
    parkTab: true,
  };
}

export function emptyState(settings: Partial<MonitorSettings> = {}): MonitorState {
  return { version: 1, settings: normalizeSettings(settings), sources: {}, seen: [], posts: {}, followers: {} };
}

/** normalizeHandle accepts "@name", a profile URL or a bare name, and returns
 *  the name, or "" for anything that cannot be an Instagram username. */
export function normalizeHandle(value: unknown): string {
  let text = String(value ?? "").trim();
  text = text.replace(/^https?:\/\/(?:www\.)?instagram\.com\//i, "").replace(/[/?#].*$/, "").replace(/^@+/, "");
  if (text.startsWith(".") || text.endsWith(".") || text.includes("..")) return "";
  return HANDLE.test(text) ? text : "";
}

function integer(value: unknown, fallback: number, min: number, max = Number.MAX_SAFE_INTEGER): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(number)));
}

function flag(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function normalizeSettings(raw: unknown): MonitorSettings {
  const base = defaultSettings();
  const record = raw && typeof raw === "object" ? (raw as Partial<MonitorSettings>) : {};
  const profiles: string[] = [];
  for (const value of Array.isArray(record.profiles) ? record.profiles : []) {
    const handle = normalizeHandle(value);
    if (handle && !profiles.some((known) => known.toLowerCase() === handle.toLowerCase())) profiles.push(handle);
  }
  return {
    keywords: normalizeKeywords(record.keywords, MAX_KEYWORDS),
    excludeKeywords: normalizeKeywords(record.excludeKeywords, MAX_KEYWORDS),
    profiles: profiles.slice(0, MAX_PROFILES),
    watchActivity: flag(record.watchActivity, base.watchActivity),
    watchOwnComments: flag(record.watchOwnComments, base.watchOwnComments),
    watchTags: flag(record.watchTags, base.watchTags),
    watchProfileComments: flag(record.watchProfileComments, base.watchProfileComments),
    urgentTerms: Array.isArray(record.urgentTerms) ? normalizeKeywords(record.urgentTerms, MAX_URGENT_TERMS) : base.urgentTerms,
    ownPosts: integer(record.ownPosts, base.ownPosts, 0, 12),
    postsPerProfile: integer(record.postsPerProfile, base.postsPerProfile, 0, 12),
    maxCommentReads: integer(record.maxCommentReads, base.maxCommentReads, 0, 30),
    maxItemAgeMs: integer(record.maxItemAgeMs, base.maxItemAgeMs, 0),
    trackFollowers: flag(record.trackFollowers, base.trackFollowers),
    parkTab: flag(record.parkTab, base.parkTab),
  };
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}

function history(raw: unknown): CountSample[] {
  return Array.isArray(raw)
    ? raw
      .filter((sample) => sample && finite(sample.at) !== undefined && finite(sample.value) !== undefined)
      .map((sample) => ({ at: sample.at as number, value: sample.value as number }))
      .slice(-MAX_HISTORY)
    : [];
}

/** normalizeState accepts whatever was on disk, including a file from an
 *  older version or a hand edit, and returns something a pass can run on. */
export function normalizeState(raw: unknown): MonitorState {
  const record = raw && typeof raw === "object" ? (raw as Partial<MonitorState>) : {};
  const state = emptyState(record.settings ?? {});

  const account = record.account;
  if (account && typeof account === "object") {
    const handle = normalizeHandle(account.handle);
    const pk = mediaPk(account.pk);
    state.account = { ...(handle ? { handle } : {}), ...(pk ? { pk } : {}), signedIn: account.signedIn === true, checkedAt: finite(account.checkedAt) ?? 0 };
  }

  for (const [key, value] of Object.entries(record.sources ?? {})) {
    if (!value || typeof value !== "object" || finite(value.since) === undefined) continue;
    state.sources[key] = {
      since: value.since,
      filter: typeof value.filter === "string" ? value.filter : "",
      ...optional("lastReadAt", finite(value.lastReadAt)),
      ...optional("lastNewAt", finite(value.lastNewAt)),
      ...optional("note", text(value.note)),
    };
  }

  state.seen = Array.isArray(record.seen)
    ? record.seen.filter((key): key is string => typeof key === "string" && !!key).slice(-MAX_SEEN)
    : [];

  const posts = Object.entries(record.posts ?? {})
    .filter(([id, value]) => mediaPk(id) && value && typeof value === "object" && finite(value.comments) !== undefined)
    .sort(([, left], [, right]) => (finite(left.checkedAt) ?? 0) - (finite(right.checkedAt) ?? 0))
    .slice(-MAX_POSTS_WATCHED);
  for (const [id, value] of posts) {
    state.posts[mediaPk(id)] = {
      owner: text(value.owner) ?? "",
      shortcode: text(value.shortcode) ?? "",
      comments: value.comments,
      ...optional("takenAt", finite(value.takenAt)),
      checkedAt: finite(value.checkedAt) ?? 0,
    };
  }

  for (const [key, value] of Object.entries(record.followers ?? {})) {
    if (!value || typeof value !== "object") continue;
    const handle = normalizeHandle(value.handle ?? key);
    if (!handle) continue;
    state.followers[handle.toLowerCase()] = {
      handle,
      ...optional("followers", finite(value.followers)),
      ...optional("following", finite(value.following)),
      ...optional("posts", finite(value.posts)),
      ...optional("checkedAt", finite(value.checkedAt)),
      ...optional("changedAt", finite(value.changedAt)),
      history: history(value.history),
      ...optional("note", text(value.note)),
    };
  }

  const pass = record.lastPass;
  if (pass && typeof pass === "object" && finite(pass.at) !== undefined) {
    state.lastPass = {
      at: pass.at,
      finishedAt: finite(pass.finishedAt) ?? pass.at,
      newItems: finite(pass.newItems) ?? 0,
      urgent: finite(pass.urgent) ?? 0,
      followerChanges: finite(pass.followerChanges) ?? 0,
      notes: Array.isArray(pass.notes) ? pass.notes.filter((note): note is string => typeof note === "string").slice(-MAX_PASS_NOTES) : [],
    };
  }
  const queries = normalizeQueries(record.queries);
  if (queries) state.queries = queries;
  return state;
}

const QUERY_KEYS: QueryKey[] = ["posts", "content", "tagged"];

function normalizeQueries(raw: unknown): StoredQueries | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  const resolvedAt = finite(record.resolvedAt);
  if (resolvedAt === undefined) return undefined;
  const out: StoredQueries = { resolvedAt };
  for (const key of QUERY_KEYS) {
    const query = record[key] as Partial<ResolvedQuery> | undefined;
    if (!query || typeof query !== "object" || typeof query.docId !== "string" || !/^\d{5,30}$/.test(query.docId)) continue;
    const providers: Record<string, ProviderValue> = {};
    for (const [flag, value] of Object.entries(query.providers ?? {}).slice(0, 40)) {
      if (!/^__relay_internal__pv__\w{1,120}$/.test(flag)) continue;
      providers[flag] = typeof value === "boolean" || typeof value === "number" || typeof value === "string" ? value : null;
    }
    out[key] = { docId: query.docId, providers };
  }
  return QUERY_KEYS.some((key) => out[key]) ? out : undefined;
}

/** withSettings applies a settings patch, normalized. */
export function withSettings(state: MonitorState, patch: Partial<MonitorSettings>): MonitorState {
  return { ...state, settings: normalizeSettings({ ...state.settings, ...patch }) };
}
