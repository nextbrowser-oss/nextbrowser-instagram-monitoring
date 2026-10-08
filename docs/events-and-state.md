# Events and state

## Events

Every event is a plain JSON object with a `type` and an `at` (the pass time, epoch milliseconds). A pass returns its events in `result.events`; with `onEvent` it also hands each one over as it happens.

### `new_item`

Something new that needs a look: a mention, a tag, a reply, a comment on the account's post, a watched profile's new post, or a comment under it that names a keyword.

```json
{
  "type": "new_item",
  "at": 1791018900000,
  "account": "acme_shop",
  "source": { "kind": "own_comments", "name": "your posts" },
  "keywords": [],
  "triage": { "urgency": "high", "score": 4, "reasons": ["Comments on your post", "Asks a question", "No reply yet"] },
  "item": {
    "key": "comment:18032",
    "id": "18032",
    "kind": "comment",
    "author": "tom_k",
    "text": "Does the large one ship to Canada?",
    "url": "https://www.instagram.com/p/C0dEx1/c/18032/",
    "post": { "id": "3254998171211465227", "shortcode": "C0dEx1", "owner": "acme_shop", "caption": "New drop is live", "url": "https://www.instagram.com/p/C0dEx1/" },
    "createdAt": 1791018600000,
    "likes": 0,
    "replies": 0,
    "addressed": "comment_on_post"
  }
}
```

| Field | Meaning |
| --- | --- |
| `source.kind` | `activity`, `own_comments`, `tags`, `profile_posts`, or `profile_comments`. `source.name` is `activity`, `your posts`, `tags`, or `@handle`. |
| `keywords` | The keywords the item names. |
| `triage` | `urgency` (`high`, `medium`, `low`), `score`, and `reasons`, strongest first. |
| `item.key` | `comment:<id>`, `post:<id>`, or `activity:<id>`: the same wherever the item was found. |
| `item.kind` | `comment`, `post`, or `activity` (an activity entry with no comment behind it, such as a caption mention). |
| `item.url` | A direct link: the comment (`/p/<shortcode>/c/<id>/`), the post, or the activity page. |
| `item.post` | The post the item is under, or the post itself, for context. |
| `item.replies` | A comment's thread size, or a post's comment count. |
| `item.addressed` | `mention`, `tag`, `reply`, or `comment_on_post`, when the item concerns the account. |

### `followers_changed`

```json
{ "type": "followers_changed", "at": 1791020700000, "handle": "acme_shop", "own": true, "previous": 12480, "current": 12517, "delta": 37 }
```

### `signed_in`, `signed_out`, `account_changed`, `security_check`

```json
{ "type": "signed_in", "at": 1791018000000, "handle": "acme_shop" }
{ "type": "signed_out", "at": 1791021600000, "handle": "acme_shop" }
{ "type": "account_changed", "at": 1791025200000, "previous": "acme_shop", "current": "other_brand" }
{ "type": "security_check", "at": 1791027000000, "handle": "acme_shop" }
```

- **`signed_out`** is emitted once when the session ends. Nothing is read until someone signs the profile in again.
- **`account_changed`** starts the account's activity, tags and posts over.
- **`security_check`** is emitted on every pass Instagram holds the account at a check; complete it in the profile.

## The pass summary

| Field | Meaning |
| --- | --- |
| `signedIn`, `handle` | Who the pass found signed in. |
| `loginRequired` | The profile is not signed in. |
| `securityCheck` | Instagram wants a security check. |
| `rateLimited` | Instagram is limiting the account. |
| `blocked` | Why the pass stopped reading, when it did. Back off. |
| `requests` | Requests made to instagram.com. |
| `sourcesRead`, `baselines` | Sources read, and how many of them were read for the first time. |
| `itemsRead`, `matches` | Entries read, and those that matched inside the age window. |
| `newItems`, `urgent` | New matches, and how many are *high*. |
| `commentReads`, `commentReadsDeferred` | Threads read, and threads that grew but wait for the next pass. |
| `followerChecks`, `followerChanges` | Follower counts read, and those that changed. |
| `stopped` | `shouldStop` ended the pass early. |
| `failed` | The pass ended on an error nothing else explains — a browser that died, a script that threw. The note says what. |
| `notes` | Up to five sentences a person can read. |

## The state document

```jsonc
{
  "version": 1,
  "settings": { /* see below */ },
  "account": { "handle": "acme_shop", "pk": "100", "signedIn": true, "checkedAt": 1791018900000 },
  "sources": {
    "activity":                  { "since": 1791018000000, "filter": "", "lastReadAt": 1791018900000, "lastNewAt": 1791018900000 },
    "comments:own":              { "since": 1791018000000, "filter": "", "lastReadAt": 1791018900000 },
    "tags":                      { "since": 1791018000000, "filter": "", "lastReadAt": 1791018900000 },
    "profile:rival_store:posts": { "since": 1791018000000, "filter": "all", "lastReadAt": 1791018900000 },
    "profile:rival_store:comments": { "since": 1791018000000, "filter": "acme|acme shop", "lastReadAt": 1791018900000 }
  },
  "seen": ["comment:18031", "comment:18032", "post:3254998171211400002"],   // last 5,000 item keys
  "posts": {
    "3254998171211465227": { "owner": "acme_shop", "shortcode": "C0dEx1", "comments": 14, "takenAt": 1790935200000, "checkedAt": 1791018900000 }
  },
  "followers": {
    "acme_shop": { "handle": "acme_shop", "followers": 12517, "following": 310, "posts": 412, "checkedAt": 1791020700000, "changedAt": 1791020700000,
                   "history": [{ "at": 1791018000000, "value": 12480 }, { "at": 1791020700000, "value": 12517 }] }
  },
  "lastPass": { "at": 1791020700000, "finishedAt": 1791020742000, "newItems": 0, "urgent": 0, "followerChanges": 1, "notes": [] }
}
```

- `sources[*].since` is the source's starting line; `filter` the keyword set it was read with.
- `posts` is what makes comment reads cheap: a post's comment count when its thread was last read. Up to 300 posts.
- `followers[*].history` keeps every change, up to 200, enough to draw a chart.
- `queries`, present only after Instagram rotated a query, holds the doc ids and relay provider flags a pass read off instagram.com (`{ "posts": { "docId": "…", "providers": { … } }, …, "resolvedAt": … }`). Later passes use them instead of the built-in ones.

Pass anything read from storage through `normalizeState`.

## Settings

| Setting | Default | Range and meaning |
| --- | --- | --- |
| `profiles` | `[]` | Up to 10 handles. A pasted `@name` or profile URL is accepted. |
| `keywords` | `[]` | Up to 20 words or phrases, 2–60 characters. |
| `excludeKeywords` | `[]` | Up to 20 words that drop an item even when a keyword matched. |
| `watchActivity` | `true` | Read the activity feed. |
| `watchOwnComments` | `true` | Read threads under the account's newest posts. |
| `watchTags` | `true` | Read the posts the account is tagged in. |
| `watchProfileComments` | `true` | Read keyword comments under watched profiles' posts. |
| `urgentTerms` | a built-in list | Up to 50. `[]` turns the rule off. |
| `ownPosts` | `6` | 0–12 of the account's newest posts. |
| `postsPerProfile` | `3` | 0–12 of each watched profile's newest posts. |
| `maxCommentReads` | `10` | 0–30 threads per pass. |
| `maxItemAgeMs` | 48 h | Older items are not announced. `0` turns the limit off. |
| `trackFollowers` | `true` | Track follower counts. Costs no request. |
| `parkTab` | `true` | Leave the tab on `about:blank` after a pass. |

`scheduleDelay(intervalMs)` returns the interval with a ±20% spread, never under five minutes, and three times as long with `backOff`.
