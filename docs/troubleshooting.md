# Troubleshooting

Start with the log. In the app it is the monitor's log file (*Show log* in the panel); in the CLI, run with `--verbose`. Every `request` entry carries the endpoint, the status, the time it took, and, when it failed, Instagram's own message (`reason`) and what it was taken for (`login_required`, `checkpoint`, `throttled`, `refused`).

## "The profile is not signed in to Instagram"

Instagram answers nothing signed out: every endpoint returns `401` with `require_login`. Its message often reads like a rate limit ("Please wait a few minutes…", translated into the account's language) — the monitor goes by `require_login`, not by the words. Open the profile, sign in to instagram.com, and the next pass picks up from there; nothing seen before is announced again.

## "Instagram wants this account to pass a security check"

Instagram answered `checkpoint_required` or `challenge_required`, or redirected to `/challenge/`. It wants a person to confirm the account — a code by email or SMS, a password, a "this was me". Open instagram.com in the profile and complete it by hand. The monitor never tries; until it is done, every pass stops at the first request and waits three intervals before the next.

A check right after the first sign-in on a new proxy is common. Several in a row mean the account is being read too often or from an address Instagram distrusts: raise the interval, lower `maxCommentReads`, or use a steadier proxy.

## "Instagram is limiting this account"

`429`, `feedback_required`, or an answer flagged as spam. Instagram slows down accounts that do too much; the monitor stops and waits three intervals. If it repeats:

- raise `--interval` (30 minutes is a sound start for a busy account);
- lower `--max-comment-reads` and `--posts-per-profile`;
- watch fewer profiles;
- do not run other automation on the same account at the same time.

## "instagram.com answered with a page instead of data"

An endpoint the monitor reads returned HTML. Instagram has changed or closed it. Check for a newer version of this package, and open an issue with the `request` log line (status and `refused`).

Profiles and tagged posts are read with the GraphQL queries instagram.com's own profile page sends (`PolarisProfilePostsQuery`, `PolarisProfilePageContentQuery`, `PolarisProfileTaggedTabContentQuery`, in `src/scripts.ts`). Instagram rotates their doc ids now and then; a rotated one fails with an execution error in `reason`. To find the new id, open any profile in a signed-in browser, watch the POSTs to `/graphql/query` and `/api/graphql` in DevTools, and copy the `doc_id` sent with the same `fb_api_req_friendly_name`. Keep the monitor's requests on `/graphql/query` without the `x-asbd-id` and `x-fb-friendly-name` headers: from `robots.txt`, which has no page tokens, either one makes Instagram answer with its home page.

## "@name is private" or "@name was not found"

A private profile shows its posts only to followers: follow it from the monitored account, or remove it. "Not found" means the username is misspelled, changed, or the account is gone.

## A comment I expected is missing

- It was written before its source's starting line: the first pass announces nothing, and a post seen for the first time is only recorded.
- The post is older than the account's `ownPosts` newest posts, or a watched profile's `postsPerProfile` newest.
- The pass had read `maxCommentReads` threads already; the summary says how many wait, and the next pass reads them.
- The thread is read one page deep, newest first: on a post with hundreds of comments, older ones are not read.
- Under a watched profile's post, only comments that name a keyword are reported.
- It is older than `maxItemAgeMs`.

## The same comment shows twice

It should not: a comment's key is `comment:<id>` wherever it was found. If it does, open an issue with both log lines.

## The profile does not start

`instagram-monitor` starts the profile through nbc, which reports why a start failed:

| nbc says | Meaning |
| --- | --- |
| `ClawBrowser does not expose managed-proxy privacy capability 2` | The browser runtime is older than nbc needs for proxied profiles. Update it from the Nextbrowser app. |
| `SESSION_NOT_FOUND` | nbc is looking in the wrong runtime root. Point `--runtime-root` at the app's (`~/.nextbrowser/runtime` on macOS). |
| `API_KEY_REQUIRED`, `API_KEY_INVALID` | The Nextbrowser account setup is incomplete. Sign in to the app. |

## Reporting a problem

Open a [bug report](https://github.com/nextbrowser-oss/nextbrowser-instagram-monitoring/issues/new/choose) with the version or commit and the relevant `--verbose` lines, with usernames and comment text removed if they are private.
