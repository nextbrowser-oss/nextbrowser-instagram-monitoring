# CLI reference

`instagram-monitor` runs the engine against one Nextbrowser profile from a terminal. It exists for developing the engine and for running it without the app. The profile must be signed in to instagram.com.

```bash
npm ci && npm run build
node dist/node/bin.js <command> --profile <name> [options]
```

## Commands

| Command | What it does |
| --- | --- |
| `run` | Runs passes until stopped. Waits `--interval` between them, with a random spread. |
| `once` | Runs one pass and exits. |
| `state` | Prints the saved state as JSON. |

## What is watched

| Flag | Default | Meaning |
| --- | --- | --- |
| `--profiles a,b` | none | Profiles to watch, with or without `@`. Replaces the saved list. |
| `--keywords "a,b c"` | none | Words and phrases, separated by commas. |
| `--exclude "a,b"` | none | Words that drop an item even when a keyword matched. |
| `--urgent-terms "a,b"` | a built-in list | Terms that make an item urgent. |
| `--no-activity` / `--activity` | on | Mentions, replies and comments from the activity feed. |
| `--no-own-comments` / `--own-comments` | on | Comment threads under the account's newest posts. |
| `--no-tags` / `--tags` | on | Posts the account is tagged in. |
| `--no-profile-comments` / `--profile-comments` | on | Keyword comments under watched profiles' posts. |
| `--no-followers` / `--followers` | on | Follower counts. |

## How much

| Flag | Default | Meaning |
| --- | --- | --- |
| `--interval 15m` | 15 min | Time between passes. Minimum 5 min, spread ±20%. |
| `--own-posts 6` | 6 | The account's newest posts whose comments are watched (0–12). |
| `--posts-per-profile 3` | 3 | Each watched profile's newest posts read for keyword comments (0–12). |
| `--max-comment-reads 10` | 10 | Comment threads one pass may read (0–30). |
| `--max-age 48h` | 48 h | Older items are not announced. |

Durations accept `ms`, `s`, `m`, `h`, and `d`; a plain number means seconds.

## Browser and output

| Flag | Default | Meaning |
| --- | --- | --- |
| `--nbc PATH` | app's `nextctl`, then `nbc` | The CLI that drives the profile. `NBC_BIN` and `NEXTCTL_BIN` also work. |
| `--runtime-root DIR` | the app's | Where the app keeps profiles and sessions. |
| `--runtime NAME` | profile's own | Passed to nbc as `--runtime`. |
| `--no-start` | starts | Do not start the profile; fail if it is not running. |
| `--keep-tab` | parks | Leave the last page open instead of `about:blank`. |
| `--state FILE` | `~/.nextbrowser/instagram-monitoring/<profile>.json` | Where the state is kept. |
| `--format text\|json` | text on a terminal | The format of stdout. |
| `--verbose` | off | The engine's log and every nbc call on stderr, as JSON lines. |

Settings given as flags are saved in the state file and apply to later runs too.

In `text` format a match takes two lines: the time, the urgency, who did what and what they wrote; then, indented, the reasons and the direct link.

```text
09:15  HIGH    @tom_k commented on your post: Does the large one ship to Canada?
        [Comments on your post · Asks a question · No reply yet]  https://www.instagram.com/p/C0dEx1/c/18032/
```

In `json` format, stdout carries every [event](events-and-state.md#events), a `{"type":"pass","at":…,"summary":{…}}` after each pass, and `{"type":"error",…}` when the profile would not start.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Finished, or stopped with <kbd>Ctrl</kbd>+<kbd>C</kbd>. |
| `1` | An error, such as a profile that would not start under `once`, or a bad flag. |
| `2` | No command, or an unknown one. |
| `3` | `once` found the profile signed out. |
| `4` | `once` was refused or rate-limited. |
| `5` | `once` met a security check. |
| `130` | A second <kbd>Ctrl</kbd>+<kbd>C</kbd> while a pass was finishing. |
