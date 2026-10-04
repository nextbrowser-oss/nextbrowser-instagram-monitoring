// What the monitor reports about one comment, post or activity entry, with
// enough context to review it without opening Instagram: who, what, on which
// post, and a direct link.

import { commentUrl, postUrl, shortcodeFromId } from "./ids.js";
import type { RawComment, RawPost, RawStory } from "./scripts.js";

export type ItemKind = "comment" | "post" | "activity";

/** How an item concerns the monitored account. */
export type Addressed = "mention" | "tag" | "reply" | "comment_on_post";

/** The post an item belongs to, for context. */
export interface PostContext {
  id: string;
  shortcode: string;
  owner?: string;
  /** The caption's opening, cut to 200 characters. */
  caption?: string;
  url: string;
}

export interface InstagramItem {
  /** "comment:<id>", "post:<id>" or "activity:<id>": unique across sources,
   *  so a comment found both in the activity feed and under a post is one
   *  item. */
  key: string;
  id: string;
  kind: ItemKind;
  author: string;
  /** A comment's text, a post's caption, an activity line. Cut to 2,000
   *  characters. */
  text: string;
  /** A direct link: the comment itself, the post, or the activity page. */
  url: string;
  /** The post a comment is under, or a post itself. */
  post?: PostContext;
  /** Milliseconds since the epoch. */
  createdAt?: number;
  likes?: number;
  /** Replies in a comment's thread, or a post's comment count. */
  replies?: number;
  video?: boolean;
  /** How it concerns the monitored account, when it does. */
  addressed?: Addressed;
}

const ACTIVITY_URL = "https://www.instagram.com/accounts/activity/";
const CONTEXT_CAPTION = 200;

function seconds(value: number | null | undefined): number | undefined {
  return value !== null && value !== undefined && Number.isFinite(value) ? Math.round(value * 1000) : undefined;
}

/** postContext describes a post for the items under it. */
export function postContext(post: Pick<RawPost, "pk" | "shortcode" | "caption" | "owner">): PostContext {
  const shortcode = post.shortcode || shortcodeFromId(post.pk);
  return {
    id: post.pk,
    shortcode,
    ...(post.owner ? { owner: post.owner } : {}),
    ...(post.caption ? { caption: post.caption.replace(/\s+/g, " ").trim().slice(0, CONTEXT_CAPTION) } : {}),
    url: postUrl(shortcode),
  };
}

/** postItem reports a post itself: a watched profile's new post, or a post the
 *  account is tagged in. */
export function postItem(raw: RawPost, addressed?: Addressed): InstagramItem | undefined {
  if (!raw.pk) return undefined;
  const post = postContext(raw);
  return {
    key: `post:${raw.pk}`,
    id: raw.pk,
    kind: "post",
    author: raw.owner || "",
    text: raw.caption.trim(),
    url: post.url,
    post,
    ...optional("createdAt", seconds(raw.taken_at)),
    ...optional("likes", raw.likes ?? undefined),
    ...optional("replies", raw.comments ?? undefined),
    ...(raw.video ? { video: true } : {}),
    ...(addressed ? { addressed } : {}),
  };
}

/** commentItem reports a comment under a post. */
export function commentItem(raw: RawComment, post: PostContext, addressed?: Addressed): InstagramItem | undefined {
  if (!raw.pk || !raw.user) return undefined;
  return {
    key: `comment:${raw.pk}`,
    id: raw.pk,
    kind: "comment",
    author: raw.user,
    text: raw.text.trim(),
    url: post.shortcode ? commentUrl(post.shortcode, raw.pk) : post.url,
    post,
    ...optional("createdAt", seconds(raw.created_at)),
    ...optional("likes", raw.likes ?? undefined),
    ...optional("replies", raw.replies ?? undefined),
    ...(addressed ? { addressed } : {}),
  };
}

/** activityItem reports an activity-feed entry that has something to answer:
 *  a comment (on the account's post, mentioning it, or replying to it) or a
 *  caption that mentions it. Likes and follows carry nothing to answer and
 *  return undefined. A comment entry takes the comment's key, so the same
 *  comment read under its post later is not reported twice. */
export function activityItem(raw: RawStory, handle: string, ownPosts: ReadonlySet<string>): InstagramItem | undefined {
  // A handle can hold periods but never ends with one: "@acme_shop." ends a
  // sentence, "@acme_shop.eu" is somebody else.
  const mentions = !!handle && new RegExp(`@${escape(handle)}(?!\\w|\\.\\w)`, "i").test(raw.text);
  if (!raw.comment_id && !mentions) return undefined;
  const shortcode = raw.media_id ? shortcodeFromId(raw.media_id) : "";
  const post: PostContext | undefined = shortcode ? { id: raw.media_id, shortcode, url: postUrl(shortcode) } : undefined;
  const addressed: Addressed = mentions ? "mention" : raw.media_id && ownPosts.has(raw.media_id) ? "comment_on_post" : "reply";
  const id = raw.comment_id || raw.pk || `${raw.profile}:${raw.timestamp ?? ""}`;
  return {
    key: raw.comment_id ? `comment:${raw.comment_id}` : `activity:${id}`,
    id,
    kind: raw.comment_id ? "comment" : "activity",
    author: raw.profile,
    text: stripActor(raw.text, raw.profile),
    url: post ? (raw.comment_id ? commentUrl(shortcode, raw.comment_id) : post.url) : ACTIVITY_URL,
    ...(post ? { post } : {}),
    ...optional("createdAt", seconds(raw.timestamp)),
    addressed,
  };
}

/** stripActor drops the activity line's opening "alice commented:" so what is
 *  left is what alice wrote. The opening is in the account's language, so only
 *  the shape is relied on: the actor's name, some words, a colon. */
function stripActor(text: string, actor: string): string {
  const trimmed = text.trim();
  if (!actor || !trimmed.toLowerCase().startsWith(actor.toLowerCase())) return trimmed;
  const colon = trimmed.indexOf(":", actor.length);
  return colon > 0 && colon < actor.length + 60 ? trimmed.slice(colon + 1).trim() : trimmed;
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}

/** isOwn says whether the monitored account wrote the item. */
export function isOwn(item: InstagramItem, handle: string | undefined): boolean {
  return !!handle && item.author.toLowerCase() === handle.toLowerCase();
}

/** matchText is what a keyword may be found in: the item's own text, and for
 *  a comment the caption of the post it is under is context, not a match. */
export function matchText(item: InstagramItem): string {
  return item.text;
}
