# Walkthrough: from a comment to an approved reply

This walkthrough follows one comment through the four steps of the monitoring workflow — detect, triage, draft, approve — first in the Nextbrowser app, then with the standalone CLI. The account, the posts and the people are sample data; the CLI lines are what the CLI's own formatters print.

The example: **Acme** sells home goods as `@acme_shop`. Its main competitor is `@rival_store`. Acme wants to hear about every question under its own posts, every mention, and any time a competitor's customers mention Acme.

## 1. Set up

**In Nextbrowser:**

1. Open **Skills → Instagram** and switch to **Monitoring**.
2. Choose the browser profile Acme's team uses for Instagram and press **Open instagram.com**. Sign in as `@acme_shop` in the window that opens. The panel now reads `@acme_shop · Signed in`.
3. Under **What to watch**:
   - **Profiles:** `rival_store`
   - **Keywords:** `acme`, `acme shop`
   - **Skip:** `giveaway`
4. Leave the switches on (activity, comments on your posts, tags, comments under watched profiles).
5. Set the dial to 15 minutes and press **Start**.

**With the CLI** (same settings, saved in the state file for later runs):

```bash
node dist/node/bin.js run --profile acme --profiles rival_store --keywords "acme, acme shop" --exclude giveaway --interval 15m
```

## 2. The first pass draws the starting line

The first pass reads every source once and announces nothing: what is already there is the starting line, and a monitor that greets you with yesterday's 200 comments is noise, not news. It does read the comment threads of the newest posts (up to `maxCommentReads`), so a dashboard can list what is there inside the age window right away. It records each post's comment count, so from now on it reads a thread only when that count grows.

```text
09:00  signed in as @acme_shop
09:00  pass @acme_shop: starting line: 5 sources, 7 matches; followers: 2 read, 0 changed
```

In the app, *Needs a look* already lists the 7 matches it found within the last 48 hours — none of them marked *New*.

## 3. Detect: a customer writes, a competitor posts

Between 09:00 and 09:15:

- `@mila.makes` comments under one of Acme's posts: *"@acme_shop my order never arrived, can you check?"*
- `@tom_k` asks under Acme's newest post: *"Does the large one ship to Canada?"*
- `@rival_store` posts *"Summer sale starts today: 30% off everything"*.
- Under that post, `@shopper22` writes *"acme does the same thing cheaper, anyone tried?"*

The 09:15 pass finds all four: Mila's comment in the activity feed (it mentions `@acme_shop`), Tom's because the post's comment count grew, Rival's post as a new post of a watched profile, and Shopper's because it names the keyword `acme`. Mila's comment is also under the post Tom commented on; it is reported once, because both reads give it the same key.

## 4. Triage: most urgent first, with the reasons

```text
09:15  HIGH    @mila.makes mentioned you: @acme_shop my order never arrived, can you check?
        [Mentions you · Says "never arrived" · Asks a question]  https://www.instagram.com/p/C0dEx1/c/18031/
09:15  HIGH    @tom_k commented on your post: Does the large one ship to Canada?
        [Comments on your post · Asks a question · No reply yet]  https://www.instagram.com/p/C0dEx1/c/18032/
09:15  low     @shopper22 commented on @rival_store's post: acme does the same thing cheaper, anyone tried?
        [Asks a question]  https://www.instagram.com/p/C0dEx1/c/18033/
09:15  low     @rival_store posted: Summer sale starts today: 30% off everything
        https://www.instagram.com/p/C1aB2c/
09:15  pass @acme_shop: 5 sources: 4 new (2 urgent) of 11 matches; 2 threads read; followers: 2 read, 0 changed
```

Why each one landed where it did ([the rules](how-it-works.md#triage)):

| Match | Points | Level |
| --- | --- | --- |
| Mila: mentions you (+4), says "never arrived" (+3), asks a question (+1) | 8 | high |
| Tom: comments on your post (+2), asks a question (+1), nobody replied yet (+1) | 4 | high |
| Shopper: asks a question (+1); the keyword makes it relevant, and it is a lead, not an emergency | 1 | low |
| Rival's post: nothing urgent about a sale | 0 | low |

Every line links straight to the comment, and in the app every match shows the post it is under, so it can be judged without opening Instagram.

## 5. Draft: hand a match to the reply agent

In the app, press **Draft reply** on Mila's comment. The connected agent (Claude Code or Codex) receives one task: open this comment in the same browser profile, read the thread, and write one reply that answers this comment in the account's own voice. It shows the draft in the chat:

> **Draft for @mila.makes** (on your post, comment 18031):
> "Hi Mila, so sorry about this! Could you DM us your order number? We'll track it down today."
>
> Post this reply?

Nothing has been posted yet.

## 6. Approve, and only then publish

Answer **yes** and the agent posts that reply under Mila's comment and reports whether Instagram confirmed it. Answer with changes and it redrafts. Answer **no** and nothing happens. Back in the panel, mark the match **Done** so it leaves *Needs a look*.

The engine never posts, likes or follows — every request it makes is a `GET`. Publishing exists only in the reply agent, and only after an explicit approval.

## 7. When something goes wrong

Monitoring keeps saying what it could not do instead of going quiet:

```text
11:30  security check for @acme_shop: open instagram.com in the profile and complete it
11:30  pass @acme_shop: security check
        Instagram wants this account to pass a security check before it answers again. Open instagram.com in the profile and complete it; monitoring picks up on the next pass.
```

The next pass waits three intervals. Open the profile, complete the check by hand, and monitoring continues from where it stopped: nothing it saw before is announced again, and nothing that arrived in between is lost while it is inside the 48-hour window. [Troubleshooting](troubleshooting.md) covers every such state.
