// instagram-monitor: run the monitor against one Nextbrowser profile from a
// terminal.
//
// Events go to stdout, one JSON object per line (or readable lines with
// --format text), so another process can follow them; the log goes to stderr
// with --verbose. The state lives in a file between runs.

import { parseArgs } from "node:util";
import { runPass, type PassSummary } from "../engine.js";
import type { MonitorEvent } from "../events.js";
import { splitKeywords } from "../keywords.js";
import type { LogEntry } from "../log.js";
import { DEFAULT_INTERVAL_MS, scheduleDelay } from "../schedule.js";
import { normalizeHandle, withSettings, type MonitorSettings, type MonitorState } from "../state.js";
import { nbcBrowser } from "./nbc.js";
import { defaultStatePath, loadState, saveState } from "./store.js";

const USAGE = `instagram-monitor — watch Instagram for comments, mentions and competitor posts through a Nextbrowser profile

Usage:
  instagram-monitor run   --profile NAME [options]   pass after pass until stopped
  instagram-monitor once  --profile NAME [options]   one pass
  instagram-monitor state --profile NAME [--state FILE]   print the saved state

The profile must be signed in to instagram.com.

What is watched:
  --profiles a,b           profiles to watch (competitors, partners), without @
  --keywords "a,b c"       words and phrases to find in captions and comments
  --exclude "a,b"          words that drop an item even when a keyword matched
  --urgent-terms "a,b"     terms that make an item urgent (default: a built-in list)
  --no-activity / --activity           mentions, replies and comments (default: yes)
  --no-own-comments / --own-comments   comments under your newest posts (default: yes)
  --no-tags / --tags                   posts you are tagged in (default: yes)
  --no-profile-comments / --profile-comments   keyword comments under watched profiles' posts (default: yes)
  --no-followers / --followers         follower counts (default: yes)

How much:
  --interval 15m           between passes (min 5m, spread ±20%)
  --own-posts 6            your newest posts whose comments are watched (0-12)
  --posts-per-profile 3    each watched profile's newest posts read for keyword comments (0-12)
  --max-comment-reads 10   comment threads one pass may read (0-30)
  --max-age 48h            older items are not announced

Browser:
  --nbc PATH               nbc or nextctl binary (default: the app's, then PATH)
  --runtime-root DIR       the app's runtime root (default: the app's)
  --runtime NAME           nbc --runtime for the profile
  --no-start               do not start the profile; fail if it is not running
  --keep-tab               leave the last page open instead of about:blank

Output:
  --state FILE             state file (default ~/.nextbrowser/instagram-monitoring/<profile>.json)
  --format json|text       stdout format (default: text on a terminal, json otherwise)
  --verbose                write the monitor's log to stderr as JSON lines

Settings given as flags are saved in the state file and kept for later runs.
`;

const DURATION = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/;
const UNIT_MS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

export function parseDuration(value: string, flag: string): number {
  const match = DURATION.exec(value.trim());
  if (!match) throw new Error(`${flag}: "${value}" is not a duration like 90s, 15m or 2h`);
  return Math.round(Number(match[1]) * UNIT_MS[match[2] ?? "s"]!);
}

function positiveInteger(value: string, flag: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw new Error(`${flag}: "${value}" is not a whole number`);
  return number;
}

const OPTIONS = {
  profile: { type: "string" },
  state: { type: "string" },
  interval: { type: "string" },
  profiles: { type: "string" },
  keywords: { type: "string" },
  exclude: { type: "string" },
  "urgent-terms": { type: "string" },
  "own-posts": { type: "string" },
  "posts-per-profile": { type: "string" },
  "max-comment-reads": { type: "string" },
  "max-age": { type: "string" },
  activity: { type: "boolean" },
  "no-activity": { type: "boolean" },
  "own-comments": { type: "boolean" },
  "no-own-comments": { type: "boolean" },
  tags: { type: "boolean" },
  "no-tags": { type: "boolean" },
  "profile-comments": { type: "boolean" },
  "no-profile-comments": { type: "boolean" },
  followers: { type: "boolean" },
  "no-followers": { type: "boolean" },
  nbc: { type: "string" },
  "runtime-root": { type: "string" },
  runtime: { type: "string" },
  "no-start": { type: "boolean" },
  "keep-tab": { type: "boolean" },
  format: { type: "string" },
  verbose: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

type Values = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>["values"];

/** toggle reads a --x / --no-x pair; the negative wins when both are given. */
function toggle(values: Values, name: string): boolean | undefined {
  const record = values as Record<string, unknown>;
  if (record[`no-${name}`]) return false;
  if (record[name]) return true;
  return undefined;
}

/** settingsFromFlags is the settings patch the flags ask for. */
export function settingsFromFlags(values: Values): Partial<MonitorSettings> {
  const patch: Partial<MonitorSettings> = {};
  const toggles: [string, keyof MonitorSettings][] = [
    ["activity", "watchActivity"],
    ["own-comments", "watchOwnComments"],
    ["tags", "watchTags"],
    ["profile-comments", "watchProfileComments"],
    ["followers", "trackFollowers"],
  ];
  for (const [flag, setting] of toggles) {
    const value = toggle(values, flag);
    if (value !== undefined) (patch as Record<string, unknown>)[setting] = value;
  }
  if (values.profiles !== undefined) {
    const handles = values.profiles.split(/[\s,]+/).filter(Boolean);
    const invalid = handles.filter((handle) => !normalizeHandle(handle));
    if (invalid.length) throw new Error(`--profiles: not an Instagram username: ${invalid.join(", ")}`);
    patch.profiles = handles.map(normalizeHandle);
  }
  if (values.keywords !== undefined) patch.keywords = splitKeywords(values.keywords);
  if (values.exclude !== undefined) patch.excludeKeywords = splitKeywords(values.exclude);
  if (values["urgent-terms"] !== undefined) patch.urgentTerms = splitKeywords(values["urgent-terms"]);
  if (values["own-posts"] !== undefined) patch.ownPosts = positiveInteger(values["own-posts"], "--own-posts");
  if (values["posts-per-profile"] !== undefined) patch.postsPerProfile = positiveInteger(values["posts-per-profile"], "--posts-per-profile");
  if (values["max-comment-reads"] !== undefined) patch.maxCommentReads = positiveInteger(values["max-comment-reads"], "--max-comment-reads");
  if (values["max-age"] !== undefined) patch.maxItemAgeMs = parseDuration(values["max-age"], "--max-age");
  if (values["keep-tab"]) patch.parkTab = false;
  return patch;
}

function time(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
}

function plural(count: number, noun: string): string {
  return `${count} ${count === 1 ? noun : /(s|sh|ch|x)$/.test(noun) ? `${noun}es` : `${noun}s`}`;
}

function oneLine(text: string, max = 90): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function signed(delta: number): string {
  return `${delta > 0 ? "+" : ""}${delta.toLocaleString()}`;
}

const LEVEL = { high: "HIGH", medium: "MEDIUM", low: "low" } as const;

/** describeEvent is the readable text for an event. A new item takes two
 *  lines: what and how urgent, then why and where to open it. */
export function describeEvent(event: MonitorEvent): string {
  switch (event.type) {
    case "new_item": {
      const { item, source, triage } = event;
      const who = item.addressed === "mention"
        ? `@${item.author} mentioned you`
        : item.addressed === "tag"
          ? `@${item.author} tagged you`
          : item.addressed === "reply"
            ? `@${item.author} replied`
            : item.addressed === "comment_on_post"
              ? `@${item.author} commented on your post`
              : item.kind === "post"
                ? `@${item.author} posted`
                : `@${item.author} commented`;
      const where = source.kind === "profile_comments" ? ` on ${source.name}'s post` : "";
      const body = oneLine(item.text) || (item.video ? "[video]" : "[no text]");
      const why = triage.reasons.length ? `[${triage.reasons.join(" · ")}]  ` : "";
      return `${time(event.at)}  ${LEVEL[triage.urgency].padEnd(6)}  ${who}${where}: ${body}\n        ${why}${item.url}`;
    }
    case "followers_changed":
      return `${time(event.at)}  followers @${event.handle}${event.own ? " (you)" : ""}: ${event.previous.toLocaleString()} → ${event.current.toLocaleString()} (${signed(event.delta)})`;
    case "signed_in":
      return `${time(event.at)}  signed in${event.handle ? ` as @${event.handle}` : ""}`;
    case "signed_out":
      return `${time(event.at)}  signed out${event.handle ? ` (was @${event.handle})` : ""}: sign the profile in to instagram.com`;
    case "account_changed":
      return `${time(event.at)}  account changed: @${event.previous} → @${event.current}; activity and posts start over`;
    case "security_check":
      return `${time(event.at)}  security check${event.handle ? ` for @${event.handle}` : ""}: open instagram.com in the profile and complete it`;
  }
}

/** describePass is the readable line for a finished pass. */
export function describePass(summary: PassSummary, at: number): string {
  const parts: string[] = [];
  if (summary.loginRequired) parts.push("not signed in");
  if (summary.sourcesRead) {
    const baseline = summary.baselines === summary.sourcesRead;
    parts.push(baseline
      ? `starting line: ${plural(summary.sourcesRead, "source")}, ${plural(summary.matches, "match")}`
      : `${plural(summary.sourcesRead, "source")}: ${summary.newItems} new${summary.urgent ? ` (${summary.urgent} urgent)` : ""} of ${plural(summary.matches, "match")}`);
  }
  if (summary.commentReads) parts.push(`${plural(summary.commentReads, "thread")} read`);
  if (summary.followerChecks) parts.push(`followers: ${summary.followerChecks} read, ${summary.followerChanges} changed`);
  if (summary.securityCheck) parts.push("security check");
  else if (summary.rateLimited) parts.push("rate-limited");
  else if (summary.blocked) parts.push("refused");
  if (summary.stopped) parts.push("stopped");
  const who = summary.handle ? ` @${summary.handle}` : "";
  return `${time(at)}  pass${who}: ${parts.join("; ") || "nothing read"}${summary.notes.length ? `\n        ${summary.notes.join("\n        ")}` : ""}`;
}

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  const command = positionals[0] ?? "";
  if (values.help || !["run", "once", "state"].includes(command)) {
    process.stdout.write(USAGE);
    return values.help ? 0 : 2;
  }
  const profile = values.profile?.trim();
  if (!profile && !(command === "state" && values.state)) throw new Error("--profile is required");
  const statePath = values.state ?? defaultStatePath(profile ?? "");
  let state: MonitorState = withSettings(await loadState(statePath), settingsFromFlags(values));
  if (command === "state") {
    process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
    return 0;
  }

  const format = values.format ?? (process.stdout.isTTY ? "text" : "json");
  if (format !== "json" && format !== "text") throw new Error(`--format: "${format}" is neither json nor text`);
  const intervalMs = values.interval !== undefined ? parseDuration(values.interval, "--interval") : DEFAULT_INTERVAL_MS;
  const print = (line: string) => process.stdout.write(`${line}\n`);
  const log = values.verbose ? (entry: LogEntry) => process.stderr.write(`${JSON.stringify(entry)}\n`) : undefined;
  const browser = nbcBrowser({
    profile: profile!,
    ...(values.nbc ? { binary: values.nbc } : {}),
    ...(values["runtime-root"] ? { runtimeRoot: values["runtime-root"] } : {}),
    ...(values.runtime ? { runtime: values.runtime } : {}),
    ...(values.verbose ? { trace: (entry) => process.stderr.write(`${JSON.stringify({ t: new Date().toISOString(), ev: "nbc", ...entry })}\n`) } : {}),
  });

  let stopping = false;
  let wake: (() => void) | undefined;
  const stop = () => {
    if (stopping) process.exit(130);
    stopping = true;
    wake?.();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  await saveState(statePath, state);
  const wait = (delay: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, delay);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    }).finally(() => {
      wake = undefined;
    });

  for (;;) {
    if (!values["no-start"]) {
      try {
        await browser.start();
      } catch (error) {
        if (command === "once") throw error;
        const message = error instanceof Error ? error.message : String(error);
        const at = Date.now();
        print(format === "json" ? JSON.stringify({ type: "error", at, error: message }) : `${time(at)}  the profile did not start: ${message}`);
        await wait(scheduleDelay(intervalMs));
        if (stopping) return 0;
        continue;
      }
    }
    const result = await runPass({
      browser,
      state,
      ...(log ? { log } : {}),
      shouldStop: () => stopping,
      onEvent: (event) => print(format === "json" ? JSON.stringify(event) : describeEvent(event)),
    });
    state = result.state;
    await saveState(statePath, state);
    const at = state.lastPass?.at ?? Date.now();
    print(format === "json" ? JSON.stringify({ type: "pass", at, summary: result.summary }) : describePass(result.summary, at));
    const backOff = !!result.summary.blocked || result.summary.rateLimited || result.summary.securityCheck;
    if (command === "once" || stopping) return result.summary.securityCheck ? 5 : backOff ? 4 : result.summary.loginRequired ? 3 : 0;
    await wait(scheduleDelay(intervalMs, { backOff: backOff || result.summary.loginRequired }));
    if (stopping) return 0;
  }
}
