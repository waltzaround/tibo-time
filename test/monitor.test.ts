import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test, type TestContext } from "node:test";
import { URL as NodeURL } from "node:url";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import worker from "../src/index.ts";
import { poll, status } from "../src/monitor.ts";
import { loadPosts, parseFeed } from "../src/sources.ts";
import type { Env, Fetcher, Monitor } from "../src/types.ts";

const now = Date.parse("2026-10-14T00:00:00Z");
const oldId = snowflake(now - 86_400_000);
const newId = snowflake(now + 60_000);
const newerId = snowflake(now + 120_000);

function snowflake(time: number): string {
  return ((BigInt(time) - 1288834974657n) << 22n).toString();
}

function rss(items: { id: string; text: string; author?: string }[]): string {
  return `<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><title>Tibo</title>${items.map((p) => `<item><title><![CDATA[${p.text}]]></title><link>https://x.com/${p.author ?? "thsottiaux"}/status/${p.id}</link><description><![CDATA[<p>${p.text}</p>]]></description></item>`).join("")}</channel></rss>`;
}

async function setup(t: TestContext): Promise<Env> {
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    compatibilityDate: "2026-07-30",
    d1Databases: ["DB"],
  }));
  t.after(() => mf.dispose());
  const db = await mf.getD1Database("DB");
  for (const migration of ["0001_initial.sql", "0002_luna_analysis.sql"]) {
    const schema = await readFile(new NodeURL(`../migrations/${migration}`, import.meta.url), "utf8");
    for (const statement of schema.split(";").filter((s) => s.trim())) await db.prepare(statement).run();
  }
  return {
    DB: db as unknown as D1Database,
    SOURCE: "rss",
    X_USERNAME: "thsottiaux",
    OPENAI_API_KEY: "test-openai-secret",
    OPENAI_MODEL: "gpt-6-luna",
    SOURCE_TIMEZONE: "America/Los_Angeles",
    DISPLAY_TIMEZONE: "Pacific/Auckland",
    RSS_FEED_URL: "https://feeds.example/tibo.xml?secret=never-log-me",
    DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/123456789/test-token",
    ADMIN_TOKEN: "admin-test-secret",
  };
}

function harness() {
  let xml = rss([{ id: oldId, text: "A global reset is landing." }]);
  let webhookStatus = 200;
  let sourceStatus = 200;
  let modelStatus = 200;
  let modelAnalysis: Record<string, unknown> | undefined;
  const sends: { url: URL; body: any }[] = [];
  const analyses: any[] = [];
  const fetcher: Fetcher = async (input, init) => {
    const url = new URL(input);
    if (url.hostname === "api.openai.com") {
      const body = JSON.parse(String(init?.body));
      analyses.push(body);
      if (modelStatus !== 200) return new Response("fail", { status: modelStatus });
      const post = JSON.parse(body.input[0].content);
      const raw = modelAnalysis ?? {
        classification: /reset/i.test(post.post_text) ? "announced" : "not_reset",
        summary: "Mocked model decision.", precision: "unknown", starts_at_local: null,
        ends_at_local: null, time_zone: null, source_time_text: null, assumptions: [],
      };
      return Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(raw) }] }] });
    }
    if (url.hostname === "discord.com") {
      sends.push({ url, body: JSON.parse(String(init?.body)) });
      if (webhookStatus !== 200) return new Response("fail", { status: webhookStatus, headers: { "Retry-After": "600" } });
      return Response.json({ id: String(1000000 + sends.length) });
    }
    return new Response(xml, { status: sourceStatus });
  };
  return {
    fetcher, sends, analyses,
    setFeed(value: string) { xml = value; },
    setWebhookStatus(value: number) { webhookStatus = value; },
    setSourceStatus(value: number) { sourceStatus = value; },
    setModelStatus(value: number) { modelStatus = value; },
    setAnalysis(value: Record<string, unknown>) { modelAnalysis = value; },
  };
}

test("RSS parsing preserves long post IDs, removes HTML, and ignores other authors", () => {
  const posts = parseFeed(rss([
    { id: newId, text: "All reset &amp; ready<br>for everyone" },
    { id: newerId, text: "Reset incoming", author: "someoneelse" },
    { id: newId, text: "All reset &amp; ready<br>for everyone" },
  ]), "thsottiaux");
  assert.equal(posts.length, 1);
  assert.equal(posts[0].id, newId);
  assert.equal(posts[0].text, "All reset & ready\nfor everyone");
  assert.equal(posts[0].publishedAt, new Date(now + 60_000).toISOString());
});

test("Atom feeds and Nitter links are normalized to the original X post", () => {
  const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>tag:example:1</id><title>Reset</title><link rel="alternate" href="https://nitter.example/thsottiaux/status/${newId}#m"/><content type="html">&lt;p&gt;Global reset for all paid users.&lt;/p&gt;</content></entry></feed>`;
  const posts = parseFeed(xml, "thsottiaux");
  assert.equal(posts[0].url, `https://x.com/thsottiaux/status/${newId}`);
  assert.equal(posts[0].text, "Global reset for all paid users.");
});

test("malformed, empty, challenge, and entity-containing feeds fail visibly", () => {
  for (const xml of ["<html>Sign in</html>", "<rss><channel></rss>", rss([]), '<!DOCTYPE rss [<!ENTITY x "reset">]><rss><channel/></rss>']) {
    assert.throws(() => parseFeed(xml, "thsottiaux"));
  }
});

test("first poll skips history; new reset alerts are delivered once in time order", async (t) => {
  const env = await setup(t);
  const h = harness();
  assert.equal((await poll(env, h.fetcher, now)).initialized, true);
  assert.equal(h.sends.length, 0);
  assert.equal(h.analyses.length, 0);
  h.setFeed(rss([
    { id: newerId, text: "Reset all propagated. @everyone" },
    { id: oldId, text: "A global reset is landing." },
    { id: newId, text: "Global reset for paid users." },
  ]));
  const result = await poll(env, h.fetcher, now + 300_000);
  assert.equal(result.queued, 2);
  assert.equal(result.sent, 2);
  assert.equal(h.sends[0].body.embeds[0].url, `https://x.com/thsottiaux/status/${newId}`);
  assert.deepEqual(h.sends[0].body.allowed_mentions, { parse: [] });
  assert.equal(h.sends[0].url.searchParams.get("wait"), "true");
  await poll(env, h.fetcher, now + 600_000);
  assert.equal(h.sends.length, 2);
  assert.equal((await status(env, now + 600_000)).healthy, true);
});

test("queued alerts survive feed disappearance; Discord 429 respects retry delay", async (t) => {
  const env = await setup(t);
  const h = harness();
  await poll(env, h.fetcher, now);
  h.setFeed(rss([{ id: newId, text: "Global reset landing." }]));
  h.setWebhookStatus(429);
  await assert.rejects(poll(env, h.fetcher, now + 300_000), /discord_http_429/);
  assert.equal((await status(env, now + 300_000)).pendingPosts, 1);
  assert.equal((await status(env, now + 300_000)).healthy, false);
  h.setFeed(rss([{ id: oldId, text: "A global reset is landing." }]));
  h.setWebhookStatus(200);
  await poll(env, h.fetcher, now + 600_000);
  assert.equal(h.sends.length, 1);
  await poll(env, h.fetcher, now + 900_000);
  assert.equal(h.sends.length, 2);
  assert.equal((await status(env, now + 900_000)).pendingPosts, 0);
  assert.equal(h.analyses.length, 1); // Discord retries reuse the saved decision.
});

test("queued notifications are retried even when the feed is unavailable", async (t) => {
  const env = await setup(t);
  const h = harness();
  await poll(env, h.fetcher, now);
  h.setFeed(rss([{ id: newId, text: "Reset processed." }]));
  h.setWebhookStatus(500);
  await assert.rejects(poll(env, h.fetcher, now + 300_000));
  h.setWebhookStatus(200);
  h.setSourceStatus(503);
  await assert.rejects(poll(env, h.fetcher, now + 900_000), /rss_http_503/);
  assert.equal(h.sends.length, 2);
  const state = await status(env, now + 900_000);
  assert.equal(state.pendingPosts, 0);
  assert.equal(state.monitor?.last_error, "rss_http_503");
  assert.equal(state.healthy, false);
});

test("an old pinned post appearing later does not generate a historical alert", async (t) => {
  const env = await setup(t);
  const h = harness();
  await poll(env, h.fetcher, now);
  h.setFeed(rss([{ id: snowflake(now - 7 * 86_400_000), text: "Reset last week." }, { id: oldId, text: "Reset." }]));
  await poll(env, h.fetcher, now + 300_000);
  assert.equal(h.sends.length, 0);
});

test("a delayed feed item after startup is still detected after a newer item", async (t) => {
  const env = await setup(t);
  const h = harness();
  await poll(env, h.fetcher, now);
  h.setFeed(rss([{ id: newerId, text: "New model shipped." }]));
  await poll(env, h.fetcher, now + 300_000);
  h.setFeed(rss([{ id: newerId, text: "New model shipped." }, { id: newId, text: "Reset all accounts." }]));
  await poll(env, h.fetcher, now + 600_000);
  assert.equal(h.sends.length, 1);
});

test("overlapping checks are serialized by the database lease", async (t) => {
  const env = await setup(t);
  const h = harness();
  await poll(env, h.fetcher, now);
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const fetcher: Fetcher = async (input, init) => {
    entered();
    await blocked;
    return h.fetcher(input, init);
  };
  const first = poll(env, fetcher, now + 300_000);
  await started;
  assert.equal((await poll(env, h.fetcher, now + 300_000)).busy, true);
  release();
  await first;
});

test("source failures never leak credential URLs into status or advance the cursor", async (t) => {
  const env = await setup(t);
  const h = harness();
  await poll(env, h.fetcher, now);
  const fetcher: Fetcher = async () => { throw new Error(env.RSS_FEED_URL); };
  await assert.rejects(poll(env, fetcher, now + 300_000), /rss_network_error/);
  const state = await status(env, now + 300_000);
  assert.equal(state.monitor?.last_error, "rss_network_error");
  assert.ok(!JSON.stringify(state).includes("never-log-me"));
  const checkpoint = await env.DB.prepare("SELECT latest_id FROM monitors").first<{ latest_id: string }>();
  assert.equal(checkpoint?.latest_id, oldId);
});

test("official API caches the user lookup, uses since_id, and reads long posts", async (t) => {
  const env = { ...await setup(t), SOURCE: "x" as const, X_BEARER_TOKEN: "test-token" };
  const calls: URL[] = [];
  const messages: any[] = [];
  const h = harness();
  let initial = true;
  const fetcher: Fetcher = async (input, init) => {
    const url = new URL(input);
    calls.push(url);
    if (url.hostname === "discord.com") {
      messages.push(JSON.parse(String(init?.body)));
      return Response.json({ id: "123456789" });
    }
    if (url.hostname === "api.openai.com") return h.fetcher(input, init);
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer test-token");
    if (url.pathname.includes("by/username")) return Response.json({ data: { id: "42", username: "thsottiaux" } });
    assert.equal(url.searchParams.get("exclude"), "retweets");
    assert.equal(url.searchParams.get("post.fields"), "created_at,note_post");
    if (initial) return Response.json({ data: [{ id: oldId, author_id: "42", text: "Old reset." }], meta: { result_count: 1 } });
    assert.equal(url.searchParams.get("since_id"), oldId);
    return Response.json({ data: [{ id: newId, author_id: "42", text: "Long update...", note_post: { text: "Long update with a reset for everyone." } }], meta: { result_count: 1 } });
  };
  await poll(env, fetcher, now);
  initial = false;
  await poll(env, fetcher, now + 300_000);
  assert.equal(calls.filter((u) => u.pathname.includes("by/username")).length, 1);
  assert.equal(messages[0].embeds[0].description, "Long update with a reset for everyone.");
});

test("official API pagination collects all new announcements before committing", async (t) => {
  const env = { ...await setup(t), SOURCE: "x" as const, X_BEARER_TOKEN: "test-token" };
  const h = harness();
  await poll({ ...env, SOURCE: "rss" }, h.fetcher, now);
  await env.DB.prepare("UPDATE monitors SET x_user_id = '42'").run();
  const fetcher: Fetcher = async (input, init) => {
    const url = new URL(input);
    if (["discord.com", "api.openai.com"].includes(url.hostname)) return h.fetcher(input, init);
    if (url.searchParams.has("pagination_token")) return Response.json({ data: [{ id: newId, author_id: "42", text: "Reset incoming." }], meta: { result_count: 1 } });
    return Response.json({ data: [{ id: newerId, author_id: "42", text: "Reset done." }], meta: { next_token: "page-2", result_count: 1 } });
  };
  assert.equal((await poll(env, fetcher, now + 300_000)).sent, 2);
});

test("third-party search applies time bounds, pagination, and author checks", async (t) => {
  const env = { ...await setup(t), SOURCE: "twitterapi" as const, TWITTERAPI_KEY: "test-api-key" };
  const h = harness();
  await poll({ ...env, SOURCE: "rss" }, h.fetcher, now);
  const monitor = await env.DB.prepare("SELECT * FROM monitors").first<Monitor>();
  assert.ok(monitor);
  let calls = 0;
  const fetcher: Fetcher = async (input, init) => {
    const url = new URL(input);
    assert.ok(url.searchParams.get("query")?.includes("from:thsottiaux"));
    assert.ok(url.searchParams.get("query")?.includes(`since_time:${now / 1000}`));
    assert.equal((init?.headers as Record<string, string>)["X-API-Key"], "test-api-key");
    calls++;
    return url.searchParams.has("cursor")
      ? Response.json({ tweets: [{ id: newId, text: "All reset.", author: { userName: "thsottiaux" } }], has_next_page: false })
      : Response.json({ tweets: [{ id: newerId, text: "Reset.", author: { userName: "other" } }], has_next_page: true, next_cursor: "next-page" });
  };
  const result = await loadPosts(env, monitor, now + 300_000, fetcher);
  assert.equal(calls, 2);
  assert.equal(result.posts.length, 1);
  assert.equal(result.checkedUntil, now + 300_000);
});

test("status and actions require a bearer token; health reflects stopped polling", async (t) => {
  const env = await setup(t);
  const h = harness();
  await poll(env, h.fetcher, now);
  const unauthenticated = await worker.fetch(new Request("https://worker.example/check", { method: "POST" }), env);
  assert.equal(unauthenticated.status, 401);
  const authenticated = await worker.fetch(new Request("https://worker.example/status", { headers: { Authorization: "Bearer admin-test-secret" } }), env);
  assert.equal(authenticated.status, 200);
  assert.equal((await status(env, now + 21 * 60_000)).healthy, false);
  env.ADMIN_TOKEN = "";
  assert.equal((await worker.fetch(new Request("https://worker.example/check", { method: "POST", headers: { Authorization: "Bearer " } }), env)).status, 401);
});

test("every new post is reviewed, including announcements without the word reset", async (t) => {
  const env = await setup(t);
  const h = harness();
  await poll(env, h.fetcher, now);
  h.setFeed(rss([{ id: newId, text: "Fresh usage for all paid users tomorrow at 10am PT." }]));
  h.setAnalysis({
    classification: "announced", summary: "Usage will be replenished for paid users.", precision: "exact",
    starts_at_local: "2026-10-14T10:00:00", ends_at_local: null, time_zone: "America/Los_Angeles",
    source_time_text: "tomorrow at 10am PT", assumptions: [],
  });
  await poll(env, h.fetcher, now + 300_000);
  assert.equal(h.analyses.length, 1);
  assert.equal(h.analyses[0].model, "gpt-6-luna");
  assert.equal(h.analyses[0].store, false);
  assert.equal(h.analyses[0].text.format.strict, true);
  const metadata = JSON.parse(h.analyses[0].input[0].content);
  assert.equal(metadata.publication_timestamp_utc, new Date(now + 60_000).toISOString());
  assert.ok(metadata.publication_in_source_timezone.startsWith("2026-10-13T17:01:00"));
  assert.ok(!JSON.stringify(metadata).includes("test-openai-secret"));
  const fields = h.sends[0].body.embeds[0].fields;
  assert.ok(fields[0].value.includes("15 October 2026"));
  assert.ok(fields[0].value.includes("6:00 am"));
  assert.ok(fields[0].value.includes("Pacific/Auckland"));
  assert.equal(fields[1].value, "tomorrow at 10am PT");
});

test("negative model decisions are saved, suppressed, and never reanalyzed", async (t) => {
  const env = await setup(t);
  const h = harness();
  await poll(env, h.fetcher, now);
  h.setFeed(rss([{ id: newId, text: "Should we do a reset? Vote!" }]));
  h.setAnalysis({
    classification: "not_reset", summary: "A poll, not an announcement.", precision: "unknown",
    starts_at_local: null, ends_at_local: null, time_zone: null, source_time_text: null, assumptions: [],
  });
  const result = await poll(env, h.fetcher, now + 300_000);
  assert.equal(result.dismissed, 1);
  assert.equal(h.sends.length, 0);
  await poll(env, h.fetcher, now + 600_000);
  assert.equal(h.analyses.length, 1);
  assert.equal((await status(env, now + 600_000)).pendingPosts, 0);
});

test("an OpenAI outage keeps posts queued for retry instead of sending unchecked alerts", async (t) => {
  const env = await setup(t);
  const h = harness();
  await poll(env, h.fetcher, now);
  h.setFeed(rss([{ id: newId, text: "All usage reset." }]));
  h.setModelStatus(503);
  await assert.rejects(poll(env, h.fetcher, now + 300_000), /openai_http_503/);
  assert.equal(h.sends.length, 0);
  assert.equal((await status(env, now + 300_000)).pendingPosts, 1);
  h.setFeed(rss([{ id: oldId, text: "Old reset." }]));
  h.setModelStatus(200);
  await poll(env, h.fetcher, now + 600_000);
  assert.equal(h.sends.length, 1);
  assert.equal(h.analyses.length, 2);
});
