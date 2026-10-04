# Integration guide

The package has two entry points:

| Entry | Contents | Runs in |
| --- | --- | --- |
| `@nextbrowser-oss/instagram-monitoring` | `runPass`, `checkAccount`, state and settings, events, keyword matching, `triage`, links, `scheduleDelay` | Anywhere. It has no Node imports; [`src/core.test.ts`](../src/core.test.ts) enforces this. |
| `@nextbrowser-oss/instagram-monitoring/node` | `nbcBrowser` (a browser over the `nbc`/`nextctl` CLI), `loadState`/`saveState`, the CLI | Node.js 22 or later |

## Installing

The package is consumed from Git. `prepare` builds `dist/` on install:

```bash
npm install github:nextbrowser-oss/nextbrowser-instagram-monitoring#<commit-or-tag>
```

Pin a commit or a tag rather than a branch, so a rebuild of the app never picks up an unreviewed change.

## The contract with Nextbrowser

The app owns everything that has a lifetime — the browser prepared for the selected profile, the timer, the storage. The engine owns only the logic of one pass.

```ts
import { normalizeState, runPass, scheduleDelay, withSettings } from "@nextbrowser-oss/instagram-monitoring";
import { cliBrowser } from "./lib/xreply/browser";

async function monitorPass(profileArgs: string[]) {
  const saved = normalizeState(await readAppData("instagram-monitor-state.json"));
  const { state, events, summary, matches } = await runPass({
    browser: cliBrowser(profileArgs),
    state: saved,
    log: (entry) => appendAppData("instagram-monitor-log.jsonl", entry),
    onStep: (step) => setStatus(step),
    onEvent: (event) => showNotification(event),
    shouldStop: () => stopRequested,
  });
  await writeAppData("instagram-monitor-state.json", state);
  showMatches(matches);
  const backOff = !!summary.blocked || summary.rateLimited || summary.securityCheck;
  return scheduleDelay(15 * 60_000, { backOff });
}

// Settings changed in the UI: patch them, normalized.
const next = withSettings(saved, { profiles: ["rival_store"], keywords: ["acme", "acme shop"] });
```

### What to show

`result.matches` holds every item the pass found that matched, new or not, inside the `maxItemAgeMs` window, most urgent first. A first pass announces nothing but still returns what it found, so a dashboard is never empty after Start. `result.events` holds what is new; a dashboard marks those. Each match carries `item.url` (a direct link to the comment or the post), `item.post` (the post it is under, its owner and the caption's opening) and `triage.reasons`. Show them: they are what makes a *high* believable and a match reviewable without opening Instagram.

`summary.loginRequired`, `summary.securityCheck` and `summary.rateLimited` each need their own message in a panel: each asks the person for something different.

### From a match to a reply

The engine never answers. In Nextbrowser, *Draft reply* hands a match to the Instagram skill's reply agent with one task: open `item.url` in the same profile, read the thread, write one reply to that comment, show it, and post it only after the user approves. Pass `item.url`, `item.key`, `item.author` and `item.post` to that flow.

### Showing the account before anything runs

`checkAccount` opens instagram.com in the profile, reads who is signed in, and stops there, leaving the page open for a person who is about to sign in. It also reports a pending security check.

```ts
import { checkAccount } from "@nextbrowser-oss/instagram-monitoring";

const { signedIn, handle, securityCheck, blocked } = await checkAccount({ browser: cliBrowser(profileArgs) });
```

### The browser

`MonitorBrowser` is a subset of the app's `XBrowser` (`src/lib/xreply/browser.ts`), so the app passes its existing `cliBrowser(profileArgs)`:

```ts
interface MonitorBrowser {
  open(url: string): Promise<void>;
  evaluate<T>(script: string, label?: string): Promise<T>;   // the script may return a promise
  waitForLoad(timeoutSeconds?: number): Promise<void>;
}
```

### Sharing the profile

The monitor, the reply agent, and the user's own agent runs may drive the same profile. They must take turns: run the monitor pass in the queue the app already uses for its other engine passes.

### State

The state is one JSON document. Store it as it is, and pass whatever comes back from storage through `normalizeState`, which accepts older files, hand edits, and nothing at all. The layout is in [events and state](events-and-state.md).

### Logging

`log` receives one JSON object per step: every request with its status, timing and what it was refused for, every source with how many items it held and how many were new, and every event. Append it to a rotated file; when a read fails on a user's machine, it is the full record.

## Outside the app: the Node adapter

```ts
import { runPass, withSettings } from "@nextbrowser-oss/instagram-monitoring";
import { loadState, nbcBrowser, saveState } from "@nextbrowser-oss/instagram-monitoring/node";

const browser = nbcBrowser({ profile: "my-instagram-profile" });
await browser.start();
const path = "state.json";
const state = withSettings(await loadState(path), { profiles: ["rival_store"] });
const result = await runPass({ browser, state });
await saveState(path, result.state);
```

`nbcBrowser` runs `nbc --profile <name> <command> … --format json` and reads nbc's `{ok, data, error}` envelope, with the app's runtime root and environment by default, so it drives the profiles the app manages. Override the runtime root with `runtimeRoot` and the binary with `binary`.
