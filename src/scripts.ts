// Page scripts: every read the monitor makes on instagram.com.
//
// Instagram's web app draws every page from JSON it fetches from its own
// /api/v1 endpoints. The monitor asks the same endpoints from an
// instagram.com tab, with fetch, the profile's cookies and the headers the web
// app sends, so it reads exactly what the signed-in account would see, one
// small request per read instead of a page of scripts and pictures over the
// proxy.
//
// None of these endpoints is a public API. They are what instagram.com itself
// uses, they answer only a signed-in session, and they change without notice.
// Every script therefore reports what came back — data, a sign-in wall, a
// security check, a rate limit, a page instead of data — rather than assume.
//
// Each script is one expression returning a JSON-serializable value, run
// through CDP Runtime.evaluate with returnByValue and awaitPromise. Values from
// outside the page are inserted as JSON literals. Answers are cut down in the
// page to the fields the monitor uses.

import { mediaPk } from "./ids.js";

/** jsLiteral renders a value as a JavaScript literal safe to inline. */
export function jsLiteral(value: unknown): string {
  return JSON.stringify(value ?? "");
}

/** Where the tab lands before it reads anything: the lightest page on the
 *  same origin as every endpoint. */
export const LANDING_URL = "https://www.instagram.com/robots.txt";
/** Where a person signs in. It is a real page, because that is what someone
 *  about to sign in wants in front of them. */
export const SIGN_IN_URL = "https://www.instagram.com/";
/** The id instagram.com's own web app sends with every API call. Without it
 *  the endpoints answer with an error. */
export const WEB_APP_ID = "936619743392459";

const FETCH_TIMEOUT_MS = 20_000;
/** How much of a caption or a comment is kept. */
export const TEXT_MAX = 2_000;

/** What one request came back with, whatever it was. */
export interface FetchMeta {
  path: string;
  /** The HTTP status; 0 when the request never got an answer. */
  status: number;
  /** A JSON answer with a 2xx status and no failure in it. */
  ok: boolean;
  /** Set when instagram.com answered with a page instead of data: its title
   *  or the start of its text. */
  refused: string;
  /** The request failed before an answer: a network error or the timeout. */
  error: string;
  /** Instagram's own message on a failure, as it wrote it (often translated
   *  into the account's language). */
  reason: string;
  /** The session is not signed in. */
  login_required: boolean;
  /** Instagram wants the account to pass a security check (a checkpoint or a
   *  challenge) before it answers again. */
  checkpoint: boolean;
  /** Instagram is limiting the account: HTTP 429, feedback_required, or a
   *  spam flag on the answer. */
  throttled: boolean;
}

export interface RawUser {
  pk: string;
  username: string;
  full_name: string;
}

export interface RawPost {
  pk: string;
  shortcode: string;
  /** Seconds since the epoch. */
  taken_at: number | null;
  caption: string;
  comments: number | null;
  likes: number | null;
  video: boolean;
  pinned: boolean;
  /** The account that posted it, when the answer says. */
  owner: string;
}

export interface RawComment {
  pk: string;
  text: string;
  created_at: number | null;
  user: string;
  /** Replies in its thread. */
  replies: number | null;
  likes: number | null;
}

export interface RawStory {
  /** The story's own id, when it has one. */
  pk: string;
  story_type: number | null;
  /** The line as the activity feed draws it, e.g. "alice mentioned you in a
   *  comment: @you hi". */
  text: string;
  /** Who did it. */
  profile: string;
  timestamp: number | null;
  comment_id: string;
  media_id: string;
}

export interface MeSnapshot extends FetchMeta {
  signed_in: boolean;
  user: RawUser | null;
}

export interface ProfileSnapshot extends FetchMeta {
  found: boolean;
  private: boolean;
  user: RawUser | null;
  followers: number | null;
  following: number | null;
  posts_count: number | null;
  posts: RawPost[];
}

export interface CommentsSnapshot extends FetchMeta {
  comments: RawComment[];
  count: number | null;
}

export interface ActivitySnapshot extends FetchMeta {
  stories: RawStory[];
}

export interface TagsSnapshot extends FetchMeta {
  posts: RawPost[];
}

/** Where the tab is, and whether instagram.com is showing its sign-in or
 *  security-check page instead. */
export interface OriginSnapshot {
  url: string;
  on_instagram: boolean;
  login_page: boolean;
  checkpoint_page: boolean;
}

/** request() fetches one path from the current origin and never throws: every
 *  outcome is a value the engine can reason about. Ids of 16 digits or more
 *  are quoted before JSON.parse, which would otherwise round them: a media id
 *  like 3254998171211465227 does not survive a trip through a Number. */
const REQUEST_HELPER = String.raw`
  const request = async (path) => {
    const meta = { path: path, status: 0, ok: false, refused: "", error: "", reason: "", login_required: false, checkpoint: false, throttled: false };
    const csrf = (document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/) || [])[1] || "";
    const headers = { accept: "application/json", "x-ig-app-id": ${jsLiteral(WEB_APP_ID)}, "x-requested-with": "XMLHttpRequest" };
    if (csrf) headers["x-csrftoken"] = csrf;
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), ${FETCH_TIMEOUT_MS}) : null;
    let response;
    try {
      response = await fetch(path, { credentials: "include", headers: headers, signal: controller ? controller.signal : undefined });
    } catch (error) {
      meta.error = String((error && (error.name === "AbortError" ? "timed out" : error.message)) || error).slice(0, 200);
      return { meta: meta, body: null };
    } finally {
      if (timer) clearTimeout(timer);
    }
    meta.status = Number(response.status) || 0;
    const finalUrl = String(response.url || "");
    let text = "";
    try { text = await response.text(); } catch (error) { meta.error = "the answer could not be read"; return { meta: meta, body: null }; }
    let body = null;
    if (/^\s*[\[{]/.test(text)) {
      try { body = JSON.parse(text.replace(/("(?:pk|id|pk_id|media_id|comment_id|user_id|strong_id__)"\s*:\s*)(\d{16,})/g, '$1"$2"')); } catch (error) { body = null; }
    }
    if (body === null) {
      if (/\/accounts\/login|\/challenge\//.test(finalUrl)) {
        meta.login_required = /\/accounts\/login/.test(finalUrl);
        meta.checkpoint = /\/challenge\//.test(finalUrl);
        return { meta: meta, body: null };
      }
      const title = (/<title[^>]*>([^<]*)<\/title>/i.exec(text) || [])[1] || "";
      const plain = text.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      meta.refused = (title.trim() || plain || ("HTTP " + meta.status)).slice(0, 160);
      if (meta.status === 429) meta.throttled = true;
      return { meta: meta, body: null };
    }
    const message = typeof body.message === "string" ? body.message : "";
    const failed = !response.ok || body.status === "fail";
    meta.reason = failed ? message.slice(0, 160) : "";
    meta.login_required = body.require_login === true || message === "login_required";
    meta.checkpoint = !meta.login_required && (!!body.checkpoint_url || !!body.challenge || /^(checkpoint_required|challenge_required)$/.test(message));
    meta.throttled = !meta.login_required && !meta.checkpoint && (meta.status === 429 || body.spam === true || message === "feedback_required" || /please wait a few minutes/i.test(message));
    meta.ok = !failed && !meta.login_required && !meta.checkpoint && !meta.throttled;
    return { meta: meta, body: body };
  };`;

/** Helpers that read Instagram's two answer shapes: the web app's GraphQL
 *  style (edges, nodes, counts under edge_*) and the API style (items,
 *  plain fields). */
const READ_HELPER = String.raw`
  const str = (value, max) => (typeof value === "string" ? value.slice(0, max || 200) : typeof value === "number" ? String(value) : "");
  const num = (value) => (typeof value === "number" && isFinite(value) ? value : null);
  const idOf = (value) => { const text = str(value, 64).split("_")[0]; return /^\d+$/.test(text) ? text : ""; };
  const user = (u) => (u && typeof u === "object" ? { pk: idOf(u.pk || u.id || u.pk_id), username: str(u.username, 40), full_name: str(u.full_name, 80) } : null);
  const graphPost = (node, owner) => {
    if (!node || typeof node !== "object") return null;
    const captions = node.edge_media_to_caption && Array.isArray(node.edge_media_to_caption.edges) ? node.edge_media_to_caption.edges : [];
    const likes = node.edge_liked_by || node.edge_media_preview_like || {};
    return {
      pk: idOf(node.id || node.pk),
      shortcode: str(node.shortcode || node.code, 40),
      taken_at: num(node.taken_at_timestamp || node.taken_at),
      caption: str(captions[0] && captions[0].node && captions[0].node.text, ${TEXT_MAX}),
      comments: num(node.edge_media_to_comment && node.edge_media_to_comment.count),
      likes: num(likes.count),
      video: node.is_video === true,
      pinned: Array.isArray(node.pinned_for_users) && node.pinned_for_users.length > 0,
      owner: str((node.owner && node.owner.username) || owner, 40)
    };
  };
  const apiPost = (item) => {
    if (!item || typeof item !== "object") return null;
    return {
      pk: idOf(item.pk || item.id),
      shortcode: str(item.code || item.shortcode, 40),
      taken_at: num(item.taken_at),
      caption: str(item.caption && item.caption.text, ${TEXT_MAX}),
      comments: num(item.comment_count),
      likes: num(item.like_count),
      video: item.media_type === 2,
      pinned: false,
      owner: str(item.user && item.user.username, 40)
    };
  };`;

/** originScript says whether the tab is on instagram.com, and whether it shows
 *  the sign-in or security-check page instead of what was asked for. */
export function originScript(): string {
  return String.raw`(() => {
  const host = String(location.hostname || "").toLowerCase();
  const path = String(location.pathname || "");
  return {
    url: location.href,
    on_instagram: host === "instagram.com" || host.endsWith(".instagram.com"),
    login_page: path.indexOf("/accounts/login") === 0,
    checkpoint_page: path.indexOf("/challenge") === 0 || path.indexOf("/accounts/suspended") === 0
  };
})()`;
}

/** meScript reads who is signed in. */
export function meScript(): string {
  return String.raw`(async () => {${REQUEST_HELPER}${READ_HELPER}
  const got = await request("/api/v1/accounts/current_user/?edit=true");
  const out = Object.assign({ signed_in: false, user: null }, got.meta);
  const found = got.meta.ok && got.body && got.body.user ? user(got.body.user) : null;
  if (found && found.username) { out.signed_in = true; out.user = found; }
  return out;
})()`;
}

/** profileScript reads a profile: who it is, its counts, and its newest posts
 *  (twelve, pinned ones first, as the profile page shows them). */
export function profileScript(username: string): string {
  return String.raw`(async () => {${REQUEST_HELPER}${READ_HELPER}
  const got = await request(${jsLiteral(profilePath(username))});
  const out = Object.assign({ found: false, private: false, user: null, followers: null, following: null, posts_count: null, posts: [] }, got.meta);
  const u = got.body && got.body.data && got.body.data.user;
  if (!got.meta.ok || !u || typeof u !== "object") return out;
  out.found = true;
  out.private = u.is_private === true;
  out.user = user(u);
  out.followers = num(u.edge_followed_by && u.edge_followed_by.count);
  out.following = num(u.edge_follow && u.edge_follow.count);
  const media = u.edge_owner_to_timeline_media || {};
  out.posts_count = num(media.count);
  out.posts = (Array.isArray(media.edges) ? media.edges : []).map((edge) => graphPost(edge && edge.node, u.username)).filter((post) => post && post.pk);
  return out;
})()`;
}

/** commentsScript reads the newest comments under one post. */
export function commentsScript(mediaId: string): string {
  return String.raw`(async () => {${REQUEST_HELPER}${READ_HELPER}
  const got = await request(${jsLiteral(commentsPath(mediaId))});
  const out = Object.assign({ comments: [], count: null }, got.meta);
  const body = got.meta.ok && got.body ? got.body : null;
  if (!body) return out;
  out.count = num(body.comment_count);
  out.comments = (Array.isArray(body.comments) ? body.comments : []).map((c) => (c && typeof c === "object" ? {
    pk: idOf(c.pk || c.id),
    text: str(c.text, ${TEXT_MAX}),
    created_at: num(c.created_at_utc || c.created_at),
    user: str(c.user && c.user.username, 40),
    replies: num(c.child_comment_count),
    likes: num(c.comment_like_count)
  } : null)).filter((c) => c && c.pk);
  return out;
})()`;
}

/** activityScript reads the account's activity feed: comments, mentions,
 *  tags and replies, together with likes and follows the monitor ignores. */
export function activityScript(): string {
  return String.raw`(async () => {${REQUEST_HELPER}${READ_HELPER}
  const got = await request(${jsLiteral(ACTIVITY_PATH)});
  const out = Object.assign({ stories: [] }, got.meta);
  const body = got.meta.ok && got.body ? got.body : null;
  if (!body) return out;
  const all = [].concat(Array.isArray(body.new_stories) ? body.new_stories : [], Array.isArray(body.old_stories) ? body.old_stories : []);
  out.stories = all.map((story) => {
    if (!story || typeof story !== "object") return null;
    const args = story.args && typeof story.args === "object" ? story.args : {};
    const media = Array.isArray(args.media) && args.media[0] ? args.media[0] : {};
    const commentIds = Array.isArray(args.comment_ids) ? args.comment_ids : [];
    return {
      pk: str(story.pk || args.tuuid, 64),
      story_type: num(story.story_type) !== null ? num(story.story_type) : num(story.type),
      text: str(args.text || args.rich_text, ${TEXT_MAX}),
      profile: str(args.profile_name, 40),
      timestamp: num(args.timestamp),
      comment_id: idOf(args.comment_id || commentIds[0]),
      media_id: idOf(media.id)
    };
  }).filter(Boolean);
  return out;
})()`;
}

/** tagsScript reads the posts the account is tagged in. */
export function tagsScript(userPk: string): string {
  return String.raw`(async () => {${REQUEST_HELPER}${READ_HELPER}
  const got = await request(${jsLiteral(tagsPath(userPk))});
  const out = Object.assign({ posts: [] }, got.meta);
  const body = got.meta.ok && got.body ? got.body : null;
  if (!body) return out;
  out.posts = (Array.isArray(body.items) ? body.items : []).map(apiPost).filter((post) => post && post.pk);
  return out;
})()`;
}

// --- paths ------------------------------------------------------------------

export const ACTIVITY_PATH = "/api/v1/news/inbox/";

export function profilePath(username: string): string {
  return `/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`;
}

export function commentsPath(mediaId: string): string {
  return `/api/v1/media/${mediaPk(mediaId)}/comments/?can_support_threading=true&permalink_enabled=false`;
}

export function tagsPath(userPk: string): string {
  return `/api/v1/usertags/${encodeURIComponent(userPk)}/feed/?count=12`;
}

/** Every script with a label, for the tests that make sure each one is at
 *  least a valid expression. */
export function allScripts(): Record<string, string> {
  return {
    origin: originScript(),
    me: meScript(),
    profile: profileScript("instagram"),
    comments: commentsScript("3254998171211465227"),
    activity: activityScript(),
    tags: tagsScript("25025320"),
  };
}
