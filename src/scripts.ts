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

/** The GraphQL queries instagram.com's own profile page sends. The REST
 *  endpoints the monitor read before (users/web_profile_info, usertags/feed)
 *  answer a signed-in web session with a 429 "Page Not Found" page since
 *  October 2026. Instagram rotates doc ids now and then: when a read starts
 *  failing with an execution error, open a profile in a browser, watch the
 *  POSTs to /graphql/query and /api/graphql, and copy the new doc_id of the
 *  query with the same friendly name. */
export const PROFILE_POSTS_QUERY = { path: "/graphql/query", name: "PolarisProfilePostsQuery", docId: "28542612348729311" } as const;
// The page sends the content query to /api/graphql, which wants the page's
// lsd token; /graphql/query answers the same doc id without it.
export const PROFILE_CONTENT_QUERY = { path: "/graphql/query", name: "PolarisProfilePageContentQuery", docId: "28036671149327607" } as const;
export const PROFILE_TAGGED_QUERY = { path: "/graphql/query", name: "PolarisProfileTaggedTabContentQuery", docId: "28463910693308962" } as const;

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
  const request = async (path, init) => {
    const meta = { path: path, status: 0, ok: false, refused: "", error: "", reason: "", login_required: false, checkpoint: false, throttled: false };
    const csrf = (document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/) || [])[1] || "";
    const headers = Object.assign({ accept: "application/json", "x-ig-app-id": ${jsLiteral(WEB_APP_ID)}, "x-requested-with": "XMLHttpRequest" }, (init && init.headers) || {});
    if (csrf) headers["x-csrftoken"] = csrf;
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), ${FETCH_TIMEOUT_MS}) : null;
    let response;
    try {
      const options = { credentials: "include", headers: headers, signal: controller ? controller.signal : undefined };
      if (init && init.body) { options.method = "POST"; options.body = init.body; }
      response = await fetch(path, options);
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
  };
  const graphql = async (query, variables) => {
    const body = new URLSearchParams({ doc_id: query.docId, variables: JSON.stringify(variables), fb_api_req_friendly_name: query.name, server_timestamps: "true" }).toString();
    // Not the web app's x-asbd-id or x-fb-friendly-name: without the page's
    // lsd and fb_dtsg tokens, which robots.txt does not have, either header
    // makes the server answer with its home page instead of data.
    const got = await request(query.path, { body: body, headers: { "content-type": "application/x-www-form-urlencoded" } });
    got.meta.path = query.path + "#" + query.name;
    const data = got.body && got.body.data && typeof got.body.data === "object" ? got.body.data : null;
    // GraphQL answers 200 with errors beside partial data; only no data at all
    // is a failed read.
    if (got.body && !data) {
      const errors = Array.isArray(got.body.errors) ? got.body.errors : [];
      got.meta.ok = false;
      if (!got.meta.reason) got.meta.reason = String((errors[0] && (errors[0].summary || errors[0].message)) || "no data").slice(0, 160);
    }
    return { meta: got.meta, data: got.meta.ok ? data : null };
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

/** meScript reads who is signed in from the profile edit form's data, the
 *  endpoint instagram.com's own settings page uses. accounts/current_user, read
 *  before, now redirects a signed-in web session to the home page (HTML, HTTP
 *  200), so a signed-in account read as "no account". The form carries no id;
 *  the ds_user_id cookie, readable from the page, is the account's pk. */
export function meScript(): string {
  return String.raw`(async () => {${REQUEST_HELPER}${READ_HELPER}
  const got = await request("/api/v1/accounts/edit/web_form_data/");
  const out = Object.assign({ signed_in: false, user: null }, got.meta);
  const form = got.meta.ok && got.body && got.body.form_data && typeof got.body.form_data === "object" ? got.body.form_data : null;
  const username = form ? str(form.username, 40) : "";
  if (username) {
    const pk = (document.cookie.match(/(?:^|;\s*)ds_user_id=(\d+)/) || [])[1] || "";
    out.signed_in = true;
    out.user = { pk: pk, username: username, full_name: [str(form.first_name, 80), str(form.last_name, 80)].filter(Boolean).join(" ").slice(0, 80) };
  }
  return out;
})()`;
}

/** The variables instagram.com's profile page sends with each query; the
 *  relay provider flags are copied as they are, since the server checks them. */
export function profilePostsVariables(username: string): Record<string, unknown> {
  return {
    data: { count: 12, include_reel_media_seen_timestamp: true, include_relationship_info: true, latest_besties_reel_media: true, latest_reel_media: true },
    username,
    __relay_internal__pv__PolarisMultiCaptionCarouselEnabledrelayprovider: true,
    __relay_internal__pv__PolarisShortDramaEnabledrelayprovider: true,
    __relay_internal__pv__PolarisReelsRecoDebugOverlayEnabledrelayprovider: false,
  };
}

export function profileContentVariables(userPk: string): Record<string, unknown> {
  return {
    enable_integrity_filters: true,
    id: userPk,
    __relay_internal__pv__PolarisCannesGuardianExperienceEnabledrelayprovider: true,
    __relay_internal__pv__PolarisCASB976ProfileEnabledrelayprovider: false,
    __relay_internal__pv__PolarisWebSchoolsEnabledrelayprovider: false,
    __relay_internal__pv__PolarisRepostsConsumptionEnabledrelayprovider: true,
    __relay_internal__pv__PolarisShortDramaEnabledrelayprovider: true,
  };
}

export function profileTaggedVariables(userPk: string): Record<string, unknown> {
  return { count: 12, user_id: userPk, __relay_internal__pv__PolarisShortDramaEnabledrelayprovider: true };
}

/** profileScript reads a profile: who it is, its counts, and its newest posts
 *  (twelve, pinned ones first, as the profile page shows them). The posts come
 *  by username and carry the owner's pk, which the counts need; a profile
 *  without posts is found by search. No match anywhere means no such profile. */
export function profileScript(username: string): string {
  return String.raw`(async () => {${REQUEST_HELPER}${READ_HELPER}
  const username = ${jsLiteral(username)};
  const out = { found: false, private: false, user: null, followers: null, following: null, posts_count: null, posts: [] };
  const timeline = await graphql(${jsLiteral(PROFILE_POSTS_QUERY)}, ${jsLiteral(profilePostsVariables(username))});
  Object.assign(out, timeline.meta);
  // An unknown name answers 200 with errors and no data; search tells it
  // from a query that broke. Anything else that failed ends the read here.
  const queryError = !timeline.meta.ok && timeline.meta.status === 200 && !!timeline.meta.reason && !timeline.meta.refused &&
    !timeline.meta.login_required && !timeline.meta.checkpoint && !timeline.meta.throttled;
  if (!timeline.meta.ok && !queryError) return out;
  const conn = timeline.data && timeline.data.xdt_api__v1__feed__user_timeline_graphql_connection;
  const nodes = conn && Array.isArray(conn.edges) ? conn.edges.map((edge) => edge && edge.node).filter((node) => node && typeof node === "object") : [];
  let pk = "";
  for (const node of nodes) {
    pk = idOf(node.user && (node.user.pk || node.user.id));
    if (pk) break;
  }
  if (!pk) {
    const search = await request("/web/search/topsearch/?context=blended&include_reel=false&query=" + encodeURIComponent(username));
    if (!search.meta.ok) return Object.assign(out, search.meta);
    const users = search.body && Array.isArray(search.body.users) ? search.body.users : [];
    const hit = users.map((entry) => entry && entry.user).find((u) => u && String(u.username || "").toLowerCase() === username.toLowerCase());
    pk = hit ? idOf(hit.pk || hit.pk_id || hit.id) : "";
    if (!pk) return Object.assign(out, search.meta);
  }
  const content = await graphql(${jsLiteral(PROFILE_CONTENT_QUERY)}, Object.assign(${jsLiteral(profileContentVariables(""))}, { id: pk }));
  if (!content.meta.ok) return Object.assign(out, content.meta);
  const u = content.data.user;
  if (!u || typeof u !== "object") return out;
  out.found = true;
  out.private = u.is_private === true;
  out.user = user(u);
  out.followers = num(u.follower_count);
  out.following = num(u.following_count);
  out.posts_count = num(u.media_count);
  out.posts = nodes.map((node) => {
    const post = apiPost(node);
    if (!post) return null;
    post.pinned = Array.isArray(node.timeline_pinned_user_ids) && node.timeline_pinned_user_ids.length > 0;
    if (!post.owner) post.owner = out.user.username;
    return post;
  }).filter((post) => post && post.pk);
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
  const got = await graphql(${jsLiteral(PROFILE_TAGGED_QUERY)}, ${jsLiteral(profileTaggedVariables(userPk))});
  const out = Object.assign({ posts: [] }, got.meta);
  if (!got.meta.ok) return out;
  const conn = got.data.xdt_api__v1__usertags__user_id__feed_connection;
  out.posts = (conn && Array.isArray(conn.edges) ? conn.edges : []).map((edge) => apiPost(edge && edge.node)).filter((post) => post && post.pk);
  return out;
})()`;
}

// --- paths ------------------------------------------------------------------

export const ACTIVITY_PATH = "/api/v1/news/inbox/";

export function commentsPath(mediaId: string): string {
  return `/api/v1/media/${mediaPk(mediaId)}/comments/?can_support_threading=true&permalink_enabled=false`;
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
