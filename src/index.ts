// @nextbrowser-oss/instagram-monitoring — the browser-agnostic core.
//
// Nothing exported from here touches Node: the Nextbrowser app runs it in the
// renderer with its own nextctl-backed browser. The Node adapter (nbc CLI,
// state file, command line) is "@nextbrowser-oss/instagram-monitoring/node".

export type { MonitorBrowser } from "./browser.js";
export {
  checkAccount,
  runPass,
  type AccountCheck,
  type PassDeps,
  type PassResult,
  type PassSummary,
} from "./engine.js";
export type {
  AccountChangedEvent,
  FollowersChangedEvent,
  ItemSource,
  Match,
  MonitorEvent,
  NewItemEvent,
  SecurityCheckEvent,
  SignedInEvent,
  SignedOutEvent,
} from "./events.js";
export {
  defaultSettings,
  emptyState,
  normalizeHandle,
  normalizeSettings,
  normalizeState,
  withSettings,
  MAX_PROFILES,
  type AccountState,
  type CountSample,
  type FollowerStats,
  type MonitorSettings,
  type MonitorState,
  type PassRecord,
  type PostWatch,
  type SourceState,
} from "./state.js";
export { activityItem, commentItem, postItem, type Addressed, type InstagramItem, type ItemKind, type PostContext } from "./items.js";
export { keywordMatcher, normalizeKeyword, normalizeKeywords, splitKeywords, MAX_KEYWORDS } from "./keywords.js";
export { byUrgency, triage, DEFAULT_URGENT_TERMS, type Triage, type Urgency } from "./triage.js";
export { commentUrl, idFromShortcode, postUrl, shortcodeFromId } from "./ids.js";
export { LANDING_URL, SIGN_IN_URL } from "./scripts.js";
export type { LogEntry, LogSink } from "./log.js";
export { scheduleDelay, DEFAULT_INTERVAL_MS, MIN_INTERVAL_MS } from "./schedule.js";
