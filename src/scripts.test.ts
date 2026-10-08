// @vitest-environment happy-dom
/// <reference lib="dom" />
//
// The page scripts run here against stand-in answers shaped like
// instagram.com's own: the web app's GraphQL-style profile, the API-style
// comments, activity and tagged posts, and the failures it answers with —
// a sign-in wall, a security check, a rate limit, a page instead of data.
// The identity, profile (GraphQL) and tagged (GraphQL) shapes follow answers
// captured from a signed-in session on 2026-10-08; the comment and activity
// shapes follow what the web app is known to receive.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_QUERIES,
  PROFILE_CONTENT_QUERY,
  PROFILE_POSTS_QUERY,
  PROFILE_TAGGED_QUERY,
  TEXT_MAX,
  WEB_APP_ID,
  activityScript,
  allScripts,
  commentsPath,
  commentsScript,
  meScript,
  originScript,
  profileScript,
  resolveQueriesScript,
  tagsScript,
  type ActivitySnapshot,
  type CommentsSnapshot,
  type MeSnapshot,
  type OriginSnapshot,
  type ProfileSnapshot,
  type QueriesSnapshot,
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

/** The doc id a GraphQL request asked for, to route answers by query. */
function docOf(init: RequestInit): string {
  return new URLSearchParams(String(init?.body ?? "")).get("doc_id") ?? "";
}

/** answerBy answers each request by its path, for scripts that make several. */
function answerBy(route: (path: string, init: RequestInit) => Answer) {
  const asked: { path: string; init: RequestInit }[] = [];
  vi.stubGlobal("fetch", async (path: string, init: RequestInit) => {
    asked.push({ path, init });
    const { status = 200, type = "application/json; charset=utf-8", body, url = `https://www.instagram.com${path}` } = route(path, init);
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
  document.cookie = "ds_user_id=; expires=Thu, 01 Jan 1970 00:00:00 GMT";
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
    const asked = answer({ body: { form_data: { username: "acme_shop", first_name: "Acme" }, status: "ok" } });
    await run(meScript());
    expect(asked[0]).toMatchObject({ path: "/api/v1/accounts/edit/web_form_data/", init: { credentials: "include" } });
    expect(asked[0]!.init.headers).toMatchObject({ "x-ig-app-id": WEB_APP_ID, "x-requested-with": "XMLHttpRequest", "x-csrftoken": "abc123" });
  });

  it("reads the signed-in account from the edit form, and its pk from ds_user_id", async () => {
    page("https://www.instagram.com/robots.txt");
    document.cookie = "ds_user_id=26611528281";
    answer({ body: { form_data: { username: "acme_shop", first_name: "Acme", last_name: "Shop", email: "x@example.com" }, status: "ok" } });
    const me = await run<MeSnapshot>(meScript());
    expect(me).toMatchObject({ ok: true, signed_in: true, user: { pk: "26611528281", username: "acme_shop", full_name: "Acme Shop" } });
    expect(JSON.stringify(me)).not.toContain("example.com");
  });

  it("is not signed in when instagram.com answers with its home page", async () => {
    page("https://www.instagram.com/robots.txt");
    answer({ type: "text/html", body: "<!DOCTYPE html><html><head><title>Instagram</title></head><body></body></html>", url: "https://www.instagram.com/" });
    expect(await run<MeSnapshot>(meScript())).toMatchObject({ signed_in: false, user: null, refused: "Instagram" });
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
  const timeline = (nodes: string) => `{"data":{"xdt_api__v1__feed__user_timeline_graphql_connection":{"edges":[${nodes}],"page_info":{"has_next_page":true}},"xdt_viewer":{}},"extensions":{"is_final":true}}`;
  const content = `{"data":{"user":{"pk":"9001","id":"9001","username":"rival_store","full_name":"Rival","is_private":false,
    "follower_count":9000,"following_count":12,"media_count":340},"viewer":{}},"extensions":{"is_final":true}}`;

  it("reads the posts by username, then the counts by the owner's pk, keeping media ids whole", async () => {
    page("https://www.instagram.com/robots.txt");
    // Sent as text: 3254998171211465227 is past what a Number holds exactly.
    const asked = answerBy((_path, init) => docOf(init) === PROFILE_POSTS_QUERY.docId
      ? { body: timeline(`{"node":{"pk":"3254998171211465227","id":"3254998171211465227_9001","code":"C0dEx1","taken_at":1790935200,
          "caption":{"text":"Our summer sale"},"comment_count":42,"like_count":800,"media_type":1,
          "user":{"pk":"9001","id":"9001","username":"rival_store"},"timeline_pinned_user_ids":["9001"]}}`) }
      : { body: content });
    const snapshot = await run<ProfileSnapshot>(profileScript("rival_store"));
    expect(snapshot).toMatchObject({ ok: true, found: true, private: false, followers: 9000, following: 12, posts_count: 340, user: { pk: "9001", username: "rival_store" } });
    expect(snapshot.posts[0]).toEqual({
      pk: "3254998171211465227", shortcode: "C0dEx1", taken_at: 1790935200, caption: "Our summer sale",
      comments: 42, likes: 800, video: false, pinned: true, owner: "rival_store",
    });
    expect(asked.map((a) => a.path)).toEqual(["/graphql/query", "/graphql/query"]);
    expect(asked.map((a) => docOf(a.init))).toEqual([PROFILE_POSTS_QUERY.docId, PROFILE_CONTENT_QUERY.docId]);
    const posts = new URLSearchParams(String(asked[0]!.init.body));
    expect(asked[0]!.init.method).toBe("POST");
    expect(posts.get("doc_id")).toBe(PROFILE_POSTS_QUERY.docId);
    expect(JSON.parse(posts.get("variables")!)).toMatchObject({ username: "rival_store", data: { count: 12 } });
    expect(asked[0]!.init.headers).toMatchObject({ "x-ig-app-id": WEB_APP_ID, "content-type": "application/x-www-form-urlencoded" });
    expect(asked[0]!.init.headers).not.toHaveProperty("x-fb-friendly-name");
    expect(asked[0]!.init.headers).not.toHaveProperty("x-asbd-id");
    expect(JSON.parse(new URLSearchParams(String(asked[1]!.init.body)).get("variables")!)).toMatchObject({ id: "9001" });
  });

  it("finds the pk of a profile without posts by search", async () => {
    page("https://www.instagram.com/robots.txt");
    const asked = answerBy((path, init) => docOf(init) === PROFILE_POSTS_QUERY.docId
      ? { body: timeline("") }
      : path.startsWith("/web/search/topsearch/")
        ? { body: { users: [{ user: { pk: "8000", username: "rival_store_fans" } }, { user: { pk: "9001", username: "Rival_Store" } }], status: "ok" } }
        : { body: content.replace('"is_private":false', '"is_private":true') });
    const snapshot = await run<ProfileSnapshot>(profileScript("rival_store"));
    expect(snapshot).toMatchObject({ found: true, private: true, followers: 9000, posts: [] });
    expect(asked[1]!.path).toBe("/web/search/topsearch/?context=blended&include_reel=false&query=rival_store");
    expect(JSON.parse(new URLSearchParams(String(asked[2]!.init.body)).get("variables")!)).toMatchObject({ id: "9001" });
  });

  it("finds no profile when the posts query fails and search has no such name", async () => {
    page("https://www.instagram.com/robots.txt");
    answerBy((_path, init) => docOf(init) === PROFILE_POSTS_QUERY.docId
      ? { body: `{"errors":[{"message":"execution error","severity":"CRITICAL"}],"data":{"xdt_api__v1__feed__user_timeline_graphql_connection":null}}` }
      : { body: { users: [], status: "ok" } });
    expect(await run<ProfileSnapshot>(profileScript("nobody_here"))).toMatchObject({ ok: true, found: false, posts: [] });
  });

  it("finds no profile when the posts query answers only errors and search has no such name", async () => {
    page("https://www.instagram.com/robots.txt");
    answerBy((_path, init) => docOf(init) === PROFILE_POSTS_QUERY.docId
      ? { body: `{"errors":[{"message":"A server error field_exception occured.","code":1357005}],"extensions":{"is_final":true}}` }
      : { body: { users: [], status: "ok" } });
    expect(await run<ProfileSnapshot>(profileScript("nobody_here"))).toMatchObject({ ok: true, found: false, posts: [] });
  });

  it("reports a broken query when search finds the profile but the counts query fails too", async () => {
    page("https://www.instagram.com/robots.txt");
    answerBy((path) => path.startsWith("/web/search/topsearch/")
      ? { body: { users: [{ user: { pk: "9001", username: "rival_store" } }], status: "ok" } }
      : { body: { errors: [{ message: "Query not found", severity: "CRITICAL" }], data: null } });
    expect(await run<ProfileSnapshot>(profileScript("rival_store"))).toMatchObject({ ok: false, found: false, reason: "Query not found" });
  });

  it("sends the query's relay provider flags with the variables", async () => {
    page("https://www.instagram.com/robots.txt");
    const asked = answer({ body: { errors: [{ message: "execution error", severity: "CRITICAL" }], data: null, status: "ok" } });
    await run<ProfileSnapshot>(profileScript("rival_store", { ...DEFAULT_QUERIES, posts: { ...DEFAULT_QUERIES.posts, docId: "123456789", providers: { __relay_internal__pv__Xrelayprovider: false } } }));
    const body = new URLSearchParams(String(asked[0]!.init.body));
    expect(body.get("doc_id")).toBe("123456789");
    expect(JSON.parse(body.get("variables")!)).toEqual({ data: expect.any(Object), username: "rival_store", __relay_internal__pv__Xrelayprovider: false });
  });

  it("calls a query Instagram no longer knows broken, without searching for the name", async () => {
    page("https://www.instagram.com/robots.txt");
    const asked = answer({ body: { errors: [{ message: "execution error", severity: "CRITICAL" }], data: null, status: "ok" } });
    expect(await run<ProfileSnapshot>(profileScript("rival_store"))).toMatchObject({ ok: false, found: false, query_broken: true, reason: "execution error" });
    expect(asked).toHaveLength(1);
  });

  it("calls an invalid request broken too", async () => {
    page("https://www.instagram.com/robots.txt");
    answer({ status: 400, body: { message: "invalid request", errors: [{ message: "execution error", severity: "CRITICAL" }], status: "fail" } });
    expect(await run<ProfileSnapshot>(profileScript("rival_store"))).toMatchObject({ ok: false, query_broken: true });
  });

  it("does not call an unknown name a broken query", async () => {
    page("https://www.instagram.com/robots.txt");
    answerBy((_path, init) => docOf(init) === PROFILE_POSTS_QUERY.docId
      ? { body: `{"errors":[{"message":"A server error field_exception occured.","code":1357005}],"extensions":{"is_final":true}}` }
      : { body: { users: [], status: "ok" } });
    const snapshot = await run<ProfileSnapshot>(profileScript("nobody_here"));
    expect(snapshot.query_broken).toBeFalsy();
  });

  it("finds no profile in a 404", async () => {
    page("https://www.instagram.com/robots.txt");
    answer({ status: 404, body: { data: { user: null }, status: "ok" } });
    expect(await run<ProfileSnapshot>(profileScript("nobody_here"))).toMatchObject({ status: 404, found: false });
  });
});

describe("resolveQueriesScript", () => {
  afterEach(() => {
    delete (window as unknown as { require?: unknown }).require;
  });

  it("reads each query's doc id and provider flags off the page's modules", async () => {
    page("https://www.instagram.com/acme/tagged/");
    const modules: Record<string, unknown> = {
      "PolarisProfilePostsQuery.graphql": { params: { id: "111111111", providedVariables: { __relay_internal__pv__Arelayprovider: { get: () => true }, "not a flag": { get: () => 1 } } } },
      "PolarisProfilePageContentQuery.graphql": { default: { params: { id: "222222222", providedVariables: { __relay_internal__pv__Brelayprovider: { get: () => { throw new Error("no"); } } } } } },
      "PolarisProfileTaggedTabContentQuery.graphql": { params: { id: "333333333" } },
    };
    (window as unknown as { require: (name: string) => unknown }).require = (name) => {
      if (!(name in modules)) throw new Error(`Requiring unknown module "${name}"`);
      return modules[name];
    };
    expect(await run<QueriesSnapshot>(resolveQueriesScript())).toEqual({
      ok: true,
      missing: [],
      queries: {
        posts: { docId: "111111111", providers: { __relay_internal__pv__Arelayprovider: true } },
        content: { docId: "222222222", providers: { __relay_internal__pv__Brelayprovider: null } },
        tagged: { docId: "333333333", providers: {} },
      },
    });
  });

  it("says which queries the page has not defined", async () => {
    page("https://www.instagram.com/robots.txt");
    expect(await run<QueriesSnapshot>(resolveQueriesScript())).toEqual({
      ok: false,
      queries: {},
      missing: ["PolarisProfilePostsQuery", "PolarisProfilePageContentQuery", "PolarisProfileTaggedTabContentQuery"],
    });
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

  it("takes the ids from where the entry leads when its fields leave them out", async () => {
    page("https://www.instagram.com/robots.txt");
    answer({
      body: `{"new_stories":[{"story_type":12,"pk":"def","args":{"text":"buyer commented: does it ship?","inline_follow":{"user_info":{"username":"buyer"}},
        "timestamp":1790935700,"destination":"comments_v2?media_id=3254998171211465227_100&target_comment_id=18000000000000009"}}],"old_stories":[],"status":"ok"}`,
    });
    expect((await run<ActivitySnapshot>(activityScript())).stories).toEqual([
      { pk: "def", story_type: 12, text: "buyer commented: does it ship?", profile: "buyer", timestamp: 1790935700, comment_id: "18000000000000009", media_id: "3254998171211465227" },
    ]);
  });
});

describe("tagsScript", () => {
  it("reads the posts the account is tagged in", async () => {
    page("https://www.instagram.com/robots.txt");
    const asked = answer({
      body: `{"data":{"xdt_api__v1__usertags__user_id__feed_connection":{"edges":[{"node":{"pk":"3254998171211400001","id":"3254998171211400001_77","code":"Tg1","taken_at":1790935000,"caption":{"text":"Unboxing"},
        "comment_count":2,"like_count":10,"media_type":2,"user":{"pk":"77","username":"blogger"}}}]}},"extensions":{"is_final":true}}`,
    });
    expect((await run<TagsSnapshot>(tagsScript("100"))).posts).toEqual([
      { pk: "3254998171211400001", shortcode: "Tg1", taken_at: 1790935000, caption: "Unboxing", comments: 2, likes: 10, video: true, pinned: false, owner: "blogger" },
    ]);
    const body = new URLSearchParams(String(asked[0]!.init.body));
    expect(asked[0]!.path).toBe(PROFILE_TAGGED_QUERY.path);
    expect(body.get("doc_id")).toBe(PROFILE_TAGGED_QUERY.docId);
    expect(JSON.parse(body.get("variables")!)).toMatchObject({ user_id: "100", count: 12 });
  });
});
