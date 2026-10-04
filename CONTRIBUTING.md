# Contributing to Nextbrowser Instagram Monitoring

Thank you for helping improve the Instagram monitoring engine behind Nextbrowser. Contributions of all sizes are welcome: bug reports, fixes to how instagram.com is read, better triage rules, tests, documentation, and new features.

Please keep contributions focused, factual, and easy to review. By participating, you agree to follow our [Code of Conduct](CODE_OF_CONDUCT.md).

## Before you start

- Search existing issues and pull requests to avoid duplicate work.
- For a small fix, a documentation correction, or a test improvement, open a pull request directly.
- For a new kind of event, a new source, a new triage rule, or a new dependency, open an issue first so the approach can be discussed.
- Do not report security vulnerabilities publicly. Follow [SECURITY.md](SECURITY.md).

## Development setup

You need Git and Node.js 22 or later. A live check additionally needs [Nextbrowser](https://github.com/nextbrowser-oss/nextbrowser-app) and a profile signed in to instagram.com — preferably a test account, since Instagram restricts accounts that read too fast.

```bash
git clone https://github.com/YOUR-USERNAME/nextbrowser-instagram-monitoring.git
cd nextbrowser-instagram-monitoring
git remote add upstream https://github.com/nextbrowser-oss/nextbrowser-instagram-monitoring.git
npm ci
npm test
```

## Repository structure

| Path | What lives there |
| --- | --- |
| `src/engine.ts` | The pass: landing, account, sources, comment threads, followers, parking the tab. |
| `src/scripts.ts` | The page scripts evaluated on instagram.com and the paths they read. Each one is a single JSON-returning expression. |
| `src/keywords.ts`, `src/triage.ts`, `src/items.ts`, `src/ids.ts` | Pure rules: what matches, how urgent it is, how an answer becomes an item, how a media id becomes a link. |
| `src/state.ts`, `src/events.ts` | The state document, settings, and events: the public contract. |
| `src/node/` | The Node adapter: nbc browser, state file, CLI. The only code allowed to import Node. |
| `src/testing/` | The fake instagram.com used by engine tests. |
| `scripts/` | Maintenance helpers, such as the README terminal renderer. |
| `docs/` | Documentation and the README translation. |

## Ground rules for this engine

- **Read-only.** The engine must never like, comment, reply, follow, send a message, or change a setting on instagram.com. Every request is a `GET`. `src/core.test.ts` checks the scripts for the obvious ways to break this.
- **Triage stays explainable.** Every rule adds points and a reason a person can read. A rule that cannot say why it fired does not belong here, and neither does a call to a model or any other service.
- **The core stays browser-safe.** Nothing under `src/` outside `src/node/` may import a Node module or use `process`. `src/core.test.ts` fails if it does, because the app runs the core in its renderer.
- **Passes stay pure.** `runPass` never mutates the state it is given, and it never sleeps longer than the pause between two requests. Timers and storage belong to the host.
- **Pacing limits stay.** Do not lower the minimum pass interval, the pause between requests, the comment-read budget, or the keyword and profile caps.
- **Explain site knowledge.** An endpoint, a field, or a quirk of instagram.com gets a comment saying what instagram.com does and why the code handles it that way.

## Changing what is read from instagram.com

A change to a page script or a path needs:

1. a stand-in answer in `src/scripts.test.ts` reproducing the response, trimmed from a real one, with personal data removed;
2. a test that fails without the change;
3. the endpoint and the date it was observed, in the pull request.

Where possible, run the changed read once against a live profile and describe the result in the pull request, for example with `node dist/node/bin.js once --profile <name> --verbose`.

## Changing the triage

A new rule, or a new weight, needs a case in `src/rules.test.ts` for an item it should rank differently and one it should leave alone, and an update to the table in [how it works](docs/how-it-works.md#4-urgency-triage).

## Required checks

```bash
npm run typecheck
npm test
npm run build
```

If a check cannot be run on your platform, say so in the pull request. Do not claim a check passed if it was skipped.

The terminal image in the README is generated from the CLI's own formatters. After changing CLI output, regenerate it:

```bash
npm run build && npm run render:terminal
```

## Documentation and translations

`README.md` is the canonical English README. A semantic change to it must also update [`docs/i18n/ru/README.md`](docs/i18n/ru/README.md). Keep commands, paths, and product names identical, and check relative links from each file's location.

Do not add unverified features, platform support, metrics, or screenshots.

## Commits and pull requests

Use Conventional Commit prefixes in the imperative mood:

```text
fix: read the comment id of a grouped activity entry
feat: rank a comment that tags the brand in a story reply
docs: explain why a thread is read only when it grew
```

A pull request should include the problem and the chosen solution, links to related issues, the checks you ran and their results, and any risks or follow-up work. Keep it free of generated `dist/` output, credentials, cookies, and personal data from instagram.com.

Thank you for making Nextbrowser better.
