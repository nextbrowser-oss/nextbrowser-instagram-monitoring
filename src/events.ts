// What a pass reports. Events are plain JSON, so a caller can store them, send
// them over IPC, or print them one per line.

import type { InstagramItem } from "./items.js";
import type { Triage } from "./triage.js";

/** Where an item was found. */
export interface ItemSource {
  kind: "activity" | "tags" | "own_comments" | "profile_posts" | "profile_comments";
  /** "activity", "tags", "your posts", or "@handle". */
  name: string;
}

/** An item that matched, ranked, with where it came from. It is what a
 *  new_item event carries, and what a pass hands back for a dashboard. */
export interface Match {
  item: InstagramItem;
  source: ItemSource;
  /** The keywords it names. */
  keywords: string[];
  triage: Triage;
}

/** Something new that needs a look: a mention, a tag, a reply, a comment on
 *  the account's post, a watched profile's new post, or a comment there that
 *  names a keyword. */
export interface NewItemEvent extends Match {
  type: "new_item";
  at: number;
  /** The monitored account. */
  account?: string;
}

/** A follower count moved: the account's own, or a watched profile's. */
export interface FollowersChangedEvent {
  type: "followers_changed";
  at: number;
  handle: string;
  own: boolean;
  previous: number;
  current: number;
  delta: number;
}

/** The profile is signed in to instagram.com, for the first time or again. */
export interface SignedInEvent {
  type: "signed_in";
  at: number;
  handle?: string;
}

/** The profile is signed out. Nothing on Instagram can be read until someone
 *  signs it in again. */
export interface SignedOutEvent {
  type: "signed_out";
  at: number;
  handle?: string;
}

/** A different account is signed in than before. Its activity and its posts
 *  start over. */
export interface AccountChangedEvent {
  type: "account_changed";
  at: number;
  previous: string;
  current: string;
}

/** Instagram stopped answering until the account passes a security check. */
export interface SecurityCheckEvent {
  type: "security_check";
  at: number;
  handle?: string;
}

export type MonitorEvent =
  | NewItemEvent
  | FollowersChangedEvent
  | SignedInEvent
  | SignedOutEvent
  | AccountChangedEvent
  | SecurityCheckEvent;
