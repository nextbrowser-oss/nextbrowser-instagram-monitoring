// A stand-in instagram.com for engine tests. The engine labels every evaluate
// with what it reads ("me", "profile @acme", "comments 3254…", "activity"), so
// the fake answers by label instead of running the scripts; the scripts
// themselves are tested against stand-in answers in scripts.test.ts.

import type { MonitorBrowser } from "../browser.js";
import type {
  ActivitySnapshot,
  CommentsSnapshot,
  FetchMeta,
  MeSnapshot,
  OriginSnapshot,
  ProfileSnapshot,
  QueriesSnapshot,
  RawComment,
  RawPost,
  RawStory,
  TagsSnapshot,
} from "../scripts.js";

export interface FakeProfile {
  followers: number;
  posts: RawPost[];
  private?: boolean;
}

export class FakeInstagram implements MonitorBrowser {
  url = "about:blank";
  signedIn = true;
  handle = "acme_shop";
  pk = "100";
  /** Answer every request with a security check. */
  checkpoint = false;
  /** Answer the request with this label with feedback_required. */
  throttle = "";
  profiles: Record<string, FakeProfile> = {};
  /** Comments by media id, newest first. */
  comments: Record<string, RawComment[]> = {};
  stories: RawStory[] = [];
  tagged: RawPost[] = [];
  /** Doc ids Instagram no longer knows: a profile or tags read whose script
   *  carries one answers query_broken. */
  staleDocs: string[] = [];
  /** What the queries page defines, for the engine's refresh. */
  liveQueries: QueriesSnapshot = { ok: false, queries: {}, missing: ["PolarisProfilePostsQuery", "PolarisProfilePageContentQuery", "PolarisProfileTaggedTabContentQuery"] };
  readonly opened: string[] = [];
  readonly labels: string[] = [];
  readonly scripts: string[] = [];

  async open(url: string): Promise<void> {
    this.url = url;
    this.opened.push(url);
  }

  async waitForLoad(): Promise<void> {}

  async evaluate<T>(script: string, label = ""): Promise<T> {
    this.labels.push(label);
    this.scripts.push(script);
    if ((label.startsWith("profile @") || label === "tags") && this.staleDocs.some((doc) => script.includes(doc))) {
      const base = this.meta(label);
      const broken = { ...base, ok: false, reason: "execution error", query_broken: true };
      return (label === "tags"
        ? { ...broken, posts: [] }
        : { ...broken, found: false, private: false, user: null, followers: null, following: null, posts_count: null, posts: [] }) as T;
    }
    return this.answer(label) as T;
  }

  /** The comment threads read, by media id, in order. */
  get threadsRead(): string[] {
    return this.labels.filter((label) => label.startsWith("comments ")).map((label) => label.slice("comments ".length));
  }

  private meta(label: string, status = 200): FetchMeta {
    const base: FetchMeta = { path: "", status, ok: status >= 200 && status < 300, refused: "", error: "", reason: "", login_required: false, checkpoint: false, throttled: false };
    if (!this.signedIn) return { ...base, status: 401, ok: false, reason: "Please wait a few minutes before you try again.", login_required: true };
    if (this.checkpoint) return { ...base, status: 400, ok: false, reason: "checkpoint_required", checkpoint: true };
    if (label === this.throttle) return { ...base, status: 400, ok: false, reason: "feedback_required", throttled: true };
    return base;
  }

  private answer(label: string): unknown {
    if (label === "origin") {
      return { url: this.url, on_instagram: this.url.startsWith("https://www.instagram.com/"), login_page: false, checkpoint_page: false } satisfies OriginSnapshot;
    }
    if (label === "me") {
      const meta = this.meta(label);
      return { ...meta, signed_in: meta.ok, user: meta.ok ? { pk: this.pk, username: this.handle, full_name: "Acme" } : null } satisfies MeSnapshot;
    }
    if (label.startsWith("profile @")) {
      const handle = label.slice("profile @".length);
      const profile = this.profiles[handle];
      const meta = this.meta(label, profile ? 200 : 404);
      if (!profile || !meta.ok) return { ...meta, found: false, private: false, user: null, followers: null, following: null, posts_count: null, posts: [] } satisfies ProfileSnapshot;
      return {
        ...meta, found: true, private: profile.private === true, user: { pk: handle === this.handle.toLowerCase() ? this.pk : `9${handle.length}`, username: handle, full_name: handle },
        followers: profile.followers, following: 10, posts_count: profile.posts.length, posts: profile.private ? [] : profile.posts,
      } satisfies ProfileSnapshot;
    }
    if (label.startsWith("comments ")) {
      const id = label.slice("comments ".length);
      const meta = this.meta(label);
      const comments = meta.ok ? this.comments[id] ?? [] : [];
      return { ...meta, comments, count: comments.length } satisfies CommentsSnapshot;
    }
    if (label === "activity") {
      const meta = this.meta(label);
      return { ...meta, stories: meta.ok ? this.stories : [] } satisfies ActivitySnapshot;
    }
    if (label === "queries") return this.liveQueries;
    if (label === "tags") {
      const meta = this.meta(label);
      return { ...meta, posts: meta.ok ? this.tagged : [] } satisfies TagsSnapshot;
    }
    throw new Error(`the fake has no answer for "${label}"`);
  }
}

/** NOON is the time minute 0 of the helpers below stands for. */
export const NOON = Date.UTC(2026, 9, 2, 12, 0, 0);

let serial = 0;

const seconds = (minute: number) => (NOON + minute * 60_000) / 1000;

/** post builds a post by `owner`, posted `minute` minutes after NOON, with a
 *  media id too wide for a Number, as Instagram's are. */
export function post(owner: string, minute: number, caption: string, patch: Partial<RawPost> = {}): RawPost {
  const pk = `32549981712114${String(65000 + serial++).padStart(5, "0")}`;
  return { pk, shortcode: `SC${serial}`, taken_at: seconds(minute), caption, comments: 0, likes: 5, video: false, pinned: false, owner, ...patch };
}

/** comment builds a comment by `user`, written `minute` minutes after NOON. */
export function comment(user: string, minute: number, text: string, patch: Partial<RawComment> = {}): RawComment {
  return { pk: `1801234567890${String(10000 + serial++)}`, text, created_at: seconds(minute), user, replies: 0, likes: 0, ...patch };
}

/** story builds an activity-feed entry. */
export function story(profile: string, minute: number, text: string, patch: Partial<RawStory> = {}): RawStory {
  return { pk: `s${serial++}`, story_type: 12, text, profile, timestamp: seconds(minute), comment_id: "", media_id: "", ...patch };
}
