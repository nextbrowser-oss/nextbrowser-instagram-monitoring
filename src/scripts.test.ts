// @vitest-environment happy-dom
/// <reference lib="dom" />
//
// The page scripts run here against stand-in answers shaped like
// instagram.com's own: the web app's GraphQL-style profile, the API-style
// comments, activity and tagged posts, and the failures it answers with —
// a sign-in wall, a security check, a rate limit, a page instead of data.
// None of these has been captured from a live session yet; they follow the
// shapes the web app is known to receive, and a live run is still owed.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TEXT_MAX,
  WEB_APP_ID,
  activityScript,
  allScripts,
  commentsPath,
  commentsScript,
  meScript,
  originScript,
  profileScript,
  tagsScript,
  type ActivitySnapshot,
  type CommentsSnapshot,
  type MeSnapshot,
  type OriginSnapshot,
  type ProfileSnapshot,
  type TagsSnapshot,
} from "./scripts.js";

async function run<T>(script: string): Promise<T> {
  return JSON.parse(JSON.stringify(await (0, eval)(script))) as T;
}

function page(url: string): void {
  (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(url);
}

interface Answer {
  status?: number;
  type?: string;
  /** A string is sent as it is, so a test can send ids JSON cannot hold. */
  body: unknown;
  url?: string;
}

function answer(response: Answer) {
  const asked: { path: string; init: RequestInit }[] = [];
  vi.stubGlobal("fetch", async (path: string, init: RequestInit) => {
    asked.push({ path, init });
    const { status = 200, type = "application/json; charset=utf-8", body, url = `https://www.instagram.com${path}` } = response;
    return {
      status,
      ok: status >= 200 && status < 300,
      url,
      headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? type : null) },
      text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    };
  });
  return asked;
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.cookie = "csrftoken=; expires=Thu, 01 Jan 1970 00:00:00 GMT";
});

describe("every script", () => {
  it.each(Object.entries(allScripts()))("%s is a single valid expression", (_name, script) => {
    expect(() => new Function(`return ${script};`)).not.toThrow();
  });
});

describe("originScript", () => {
  it("knows instagram.com, its sign-in page and its security check", async () => {
    page("https://www.instagram.com/robots.txt");
    expect(await run<OriginSnapshot>(originScript())).toMatchObject({ on_instagram: true, login_page: false, checkpoint_page: false });
    page("https://www.instagram.com/accounts/login/?next=%2F");
    expect((await run<OriginSnapshot>(originScript())).login_page).toBe(true);
    page("https://www.instagram.com/challenge/?next=%2F");
    expect((await run<OriginSnapshot>(originScript())).checkpoint_page).toBe(true);
    page("https://example.com/");
    expect((await run<OriginSnapshot>(originScript())).on_instagram).toBe(false);
  });
});

describe("the request", () => {
  it("sends the web app's own headers and the session's CSRF token", async () => {
    page("https://www.instagram.com/robots.txt");
    document.cookie = "csrftoken=abc123";
    const asked = answer({ body: { user: { pk: 100, username: "acme_shop", full_name: "Acme" }, status: "ok" } });
    await run(meScript());
    expect(asked[0]).toMatchObject({ path: "/api/v1/accounts/current_user/?edit=true", init: { credentials: "include" } });
    expect(asked[0]!.init.headers).toMatchObject({ "x-ig-app-id": WEB_APP_ID, "x-requested-with": "XMLHttpRequest", "x-csrftoken": "abc123" });
  });

  it("knows a signed-out session, even when the message reads like a rate limit", async () => {
    page("https://www.instagram.com/robots.txt");
    answer({ status: 401, body: { message: "Vänta några minuter och försök sedan igen.", require_login: true, status: "fail" } });
    expect(await run<MeSnapshot>(meScript())).toMatchObject({ ok: false, signed_in: false, login_required: true, throttled: false });
  });

  it("knows a redirect to the sign-in page", async () => {
    page("https://www.instagram.com/robots.txt");
    answer({ type: "text/html", body: "<html><title>Login • Instagram</title></html>", url: "https://www.instagram.com/accounts/login/?next=/api/v1/news/inbox/" });
    expect(await run<ActivitySnapshot>(activityScript())).toMatchObject({ login_required: true, refused: "" });
  });

  it("knows a security check", async () => {
    page("https://www.instagram.com/robots.txt");
    answer({ status: 400, body: { message: "checkpoint_required", checkpoint_url: "/challenge/123/", status: "fail" } });
    expect(await run<MeSnapshot>(meScript())).toMatchObject({ checkpoint: true, login_required: false, ok: false });
  });

  it("knows a rate limit", async () => {
    page("https://www.instagram.com/robots.txt");
    answer({ status: 400, body: { message: "feedback_required", spam: true, status: "fail" } });
    expect(await run<MeSnapshot>(meScript())).toMatchObject({ throttled: true, ok: false, reason: "feedback_required" });
  });

  it("reports a page instead of data", async () => {
    page("https://www.instagram.com/robots.txt");
    answer({ type: "text/html", body: "<!DOCTYPE html><html><head><title>Instagram</title></head><body></body></html>" });
    expect(await run<TagsSnapshot>(tagsScript("100"))).toMatchObject({ ok: false, refused: "Instagram", posts: [] });
  });

  it("reports a request that never got an answer", async () => {
    page("https://www.instagram.com/robots.txt");
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(await run<MeSnapshot>(meScript())).toMatchObject({ status: 0, error: "Failed to fetch" });
  });
});

describe("profileScript", () => {
  it("reads the counts and the newest posts, keeping media ids whole", async () => {
    page("https://www.instagram.com/robots.txt");
    // Sent as text: 3254998171211465227 is past what a Number holds exactly.
    answer({
      body: `{"data":{"user":{"id":"9001","username":"rival_store","full_name":"Rival","is_private":false,
        "edge_followed_by":{"count":9000},"edge_follow":{"count":12},
        "edge_owner_to_timeline_media":{"count":340,"edges":[{"node":{"id":"3254998171211465227","shortcode":"C0dEx1","taken_at_timestamp":1790935200,
          "edge_media_to_caption":{"edges":[{"node":{"text":"Our summer sale"}}]},"edge_media_to_comment":{"count":42},"edge_liked_by":{"count":800},
          "is_video":false,"pinned_for_users":[{"id":"9001"}]}}]}}},"status":"ok"}`,
    });
    const snapshot = await run<ProfileSnapshot>(profileScript("rival_store"));
    expect(snapshot).toMatchObject({ found: true, private: false, followers: 9000, following: 12, posts_count: 340, user: { pk: "9001", username: "rival_store" } });
    expect(snapshot.posts[0]).toEqual({
      pk: "3254998171211465227", shortcode: "C0dEx1", taken_at: 1790935200, caption: "Our summer sale",
      comments: 42, likes: 800, video: false, pinned: true, owner: "rival_store",
    });
  });

  it("finds no profile in a 404", async () => {
    page("https://www.instagram.com/robots.txt");
    answer({ status: 404, body: { data: { user: null }, status: "ok" } });
    expect(await run<ProfileSnapshot>(profileScript("nobody_here"))).toMatchObject({ status: 404, found: false });
  });
});

describe("commentsScript", () => {
  it("reads the comments, their threads and when they were written", async () => {
    page("https://www.instagram.com/robots.txt");
    const asked = answer({
      body: `{"comments":[{"pk":18012345678901234,"text":"Does it ship to Canada?","created_at":1790935500,"user":{"username":"buyer"},
        "child_comment_count":0,"comment_like_count":3}],"comment_count":43,"status":"ok"}`,
    });
    const snapshot = await run<CommentsSnapshot>(commentsScript("3254998171211465227_9001"));
    expect(asked[0]!.path).toBe(commentsPath("3254998171211465227"));
    expect(snapshot.count).toBe(43);
    expect(snapshot.comments).toEqual([{ pk: "18012345678901234", text: "Does it ship to Canada?", created_at: 1790935500, user: "buyer", replies: 0, likes: 3 }]);
  });

  it("cuts a long comment", async () => {
    page("https://www.instagram.com/robots.txt");
    answer({ body: { comments: [{ pk: "1", text: "x".repeat(TEXT_MAX + 10), user: { username: "a" } }], status: "ok" } });
    expect((await run<CommentsSnapshot>(commentsScript("1"))).comments[0]!.text).toHaveLength(TEXT_MAX);
  });
});

describe("activityScript", () => {
  it("reads new and earlier entries, with the comment and the post they point at", async () => {
    page("https://www.instagram.com/robots.txt");
    answer({
      body: `{"new_stories":[{"story_type":66,"pk":"abc","args":{"text":"fan mentioned you in a comment: @acme_shop is this legit?","profile_name":"fan",
        "timestamp":1790935600.5,"comment_id":18000000000000001,"media":[{"id":"3254998171211465227_100","image":"https://x"}]}}],
        "old_stories":[{"story_type":101,"args":{"text":"fan2 started following you.","profile_name":"fan2","timestamp":1790900000}}],"status":"ok"}`,
    });
    const snapshot = await run<ActivitySnapshot>(activityScript());
    expect(snapshot.stories).toEqual([
      { pk: "abc", story_type: 66, text: "fan mentioned you in a comment: @acme_shop is this legit?", profile: "fan", timestamp: 1790935600.5, comment_id: "18000000000000001", media_id: "3254998171211465227" },
      { pk: "", story_type: 101, text: "fan2 started following you.", profile: "fan2", timestamp: 1790900000, comment_id: "", media_id: "" },
    ]);
  });
});

describe("tagsScript", () => {
  it("reads the posts the account is tagged in", async () => {
    page("https://www.instagram.com/robots.txt");
    answer({
      body: `{"items":[{"pk":3254998171211400001,"id":"3254998171211400001_77","code":"Tg1","taken_at":1790935000,"caption":{"text":"Unboxing"},
        "comment_count":2,"like_count":10,"media_type":2,"user":{"username":"blogger"}}],"status":"ok"}`,
    });
    expect((await run<TagsSnapshot>(tagsScript("100"))).posts).toEqual([
      { pk: "3254998171211400001", shortcode: "Tg1", taken_at: 1790935000, caption: "Unboxing", comments: 2, likes: 10, video: true, pinned: false, owner: "blogger" },
    ]);
  });
});
