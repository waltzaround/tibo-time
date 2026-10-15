import { XMLParser, XMLValidator } from "fast-xml-parser";
import { MonitorError, readText, request, requireHttps } from "./http.ts";
import type { Env, Fetcher, Monitor, Post, PostContext } from "./types.ts";

const parser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  processEntities: true,
  htmlEntities: true,
});

function scalar(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "#text" in value) return scalar(value["#text"]);
  return "";
}

function array<T>(value: T | T[] | undefined): T[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

function plainText(html: string): string {
  return html.replace(/<blockquote\b[^>]*>[\s\S]*?<\/blockquote>/gi, "")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?\s*>|<\/p>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#(?:39|x27);/gi, "'")
    .trim();
}

// Deriving the timestamp from the post ID also handles feeds with missing dates.
export function postDate(id: string): string {
  return new Date(Number((BigInt(id) >> 22n) + 1288834974657n)).toISOString();
}

export function canonicalPost(link: string, username: string): { id: string; url: string } | null {
  try {
    const url = new URL(link);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    const match = url.pathname.match(/^\/([\w]+)\/status\/(\d{10,22})(?:\/|$)/);
    if (!match || match[1].toLowerCase() !== username.toLowerCase()) return null;
    return { id: match[2], url: `https://x.com/${username}/status/${match[2]}` };
  } catch { return null; }
}

export function parseFeed(xml: string, username: string): Post[] {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) throw new MonitorError("rss_invalid_xml");
  let doc;
  try { doc = parser.parse(xml); } catch { throw new MonitorError("rss_invalid_xml"); }
  const channel = doc.rss?.channel;
  const feed = doc.feed;
  if (!channel && !feed) throw new MonitorError("rss_not_a_feed");
  const entries = array<Record<string, unknown>>(channel?.item ?? feed?.entry);
  const posts = new Map<string, Post>();
  for (const item of entries) {
    const links = array(item.link).map((link) => typeof link === "object" && link !== null
      ? scalar((link as Record<string, unknown>)["@_href"]) || scalar(link)
      : scalar(link));
    links.push(scalar(item.guid), scalar(item.id));
    const post = links.map((link) => canonicalPost(link, username)).find(Boolean);
    if (!post) continue; // Ignore retweets and items belonging to other accounts.
    const text = plainText(scalar(item.encoded) || scalar(item.content) || scalar(item.description) || scalar(item.summary) || scalar(item.title));
    if (!text) throw new MonitorError("rss_missing_post_text");
    // X snowflakes provide the true creation date; provider refresh dates can be wrong.
    posts.set(post.id, { ...post, text, publishedAt: postDate(post.id) });
  }
  if (posts.size === 0) throw new MonitorError("rss_no_target_posts");
  return [...posts.values()];
}

async function json(response: Response, service: string): Promise<any> {
  try { return JSON.parse(await readText(response, service)); }
  catch (error) {
    if (error instanceof MonitorError) throw error;
    throw new MonitorError(`${service}_invalid_json`);
  }
}

export interface SourceResult { posts: Post[]; userId?: string; checkedUntil?: number }

export async function loadPosts(env: Env, monitor: Monitor, now: number, fetcher: Fetcher): Promise<SourceResult> {
  if (env.SOURCE === "rss") {
    const url = requireHttps(env.RSS_FEED_URL, "rss_feed_url");
    const response = await request(fetcher, url, {
      headers: { Accept: "application/rss+xml, application/atom+xml, application/xml", "User-Agent": "TiboTime/1.0" },
    }, "rss");
    return { posts: parseFeed(await readText(response, "rss"), monitor.username) };
  }
  if (env.SOURCE === "x") return loadOfficial(env, monitor, fetcher);
  if (env.SOURCE === "twitterapi") return loadThirdParty(env, monitor, now, fetcher);
  throw new MonitorError("invalid_source");
}

const contextFields = "created_at,note_tweet,author_id,referenced_tweets,in_reply_to_user_id";

// Follow only explicit same-author edges, never merely nearby posts. The bound
// limits extra API reads and prevents cycles or long threads consuming a poll.
export async function officialContext(tweet: any, known: Map<string, any>, env: Env, userId: string, fetcher: Fetcher): Promise<PostContext[]> {
  const context: PostContext[] = [];
  const seen = new Set<string>([tweet.id]);
  const queue = [tweet];
  let lookups = 0;
  while (queue.length && context.length < 3) {
    const current = queue.shift();
    for (const ref of current.referenced_tweets ?? []) {
      if (context.length >= 3 || !["quoted", "replied_to"].includes(ref.type) || !/^\d{10,19}$/.test(ref.id) || seen.has(ref.id)) continue;
      if (ref.type === "replied_to" && current.in_reply_to_user_id && current.in_reply_to_user_id !== userId) continue;
      seen.add(ref.id);
      if (!known.has(ref.id) && lookups < 3) {
        lookups++;
        const url = new URL(`https://api.x.com/2/tweets/${ref.id}`);
        url.searchParams.set("tweet.fields", contextFields);
        url.searchParams.set("expansions", "referenced_tweets.id");
        try {
          const body = await json(await request(fetcher, url, { headers: { Authorization: `Bearer ${env.X_BEARER_TOKEN}` } }, "x"), "x");
          for (const item of [body.data, ...(body.includes?.tweets ?? [])]) if (item?.id) known.set(item.id, item);
          if (!known.has(ref.id)) known.set(ref.id, null);
        } catch (error) {
          if (error instanceof MonitorError && ["x_http_403", "x_http_404"].includes(error.code)) known.set(ref.id, null);
          else throw error; // Keep the checkpoint on transient failure so context can be retried.
        }
      }
      const parent = known.get(ref.id);
      if (!parent || parent.author_id !== userId) continue;
      const text = parent.note_tweet?.text || parent.note_post?.text || parent.text;
      if (typeof text !== "string" || !text.trim()) continue;
      context.push({ id: parent.id, text, publishedAt: postDate(parent.id), author: env.X_USERNAME,
        relation: ref.type, referencedBy: current.id });
      queue.push(parent);
    }
  }
  return context;
}

async function loadOfficial(env: Env, monitor: Monitor, fetcher: Fetcher): Promise<SourceResult> {
  if (!env.X_BEARER_TOKEN) throw new MonitorError("missing_x_bearer_token");
  const headers = { Authorization: `Bearer ${env.X_BEARER_TOKEN}` };
  let userId = monitor.x_user_id;
  if (!userId) {
    const lookup = await json(await request(fetcher, `https://api.x.com/2/users/by/username/${monitor.username}`, { headers }, "x"), "x");
    if (!/^\d+$/.test(lookup.data?.id ?? "") || lookup.data?.username?.toLowerCase() !== monitor.username) throw new MonitorError("x_invalid_user");
    userId = lookup.data.id as string;
  }
  const posts: Post[] = [];
  const known = new Map<string, any>();
  const url = new URL(`https://api.x.com/2/users/${userId}/tweets`);
  url.searchParams.set("max_results", monitor.initialized_at === null ? "5" : "100");
  url.searchParams.set("exclude", "retweets"); // Replies can contain announcements.
  url.searchParams.set("tweet.fields", contextFields);
  url.searchParams.set("expansions", "referenced_tweets.id");
  if (monitor.initialized_at !== null && monitor.latest_id !== "0") url.searchParams.set("since_id", monitor.latest_id);
  for (let page = 0; page < 5; page++) {
    const body = await json(await request(fetcher, url, { headers }, "x"), "x");
    if (body.errors?.length || !body.meta || (body.data !== undefined && !Array.isArray(body.data))) throw new MonitorError("x_invalid_response");
    for (const item of [...(body.data ?? []), ...(body.includes?.tweets ?? [])]) if (item?.id) known.set(item.id, item);
    for (const tweet of body.data ?? []) {
      if (typeof tweet.id !== "string" || !/^\d{10,19}$/.test(tweet.id) || typeof tweet.text !== "string" || (tweet.author_id && tweet.author_id !== userId)) throw new MonitorError("x_invalid_post");
      const text = tweet.note_tweet?.text || tweet.note_post?.text || tweet.text;
      if (typeof text !== "string" || !text.trim()) throw new MonitorError("x_missing_post_text");
      const context = monitor.initialized_at === null ? [] : await officialContext(tweet, known, env, userId, fetcher);
      posts.push({ id: tweet.id, text, url: `https://x.com/${monitor.username}/status/${tweet.id}`, publishedAt: postDate(tweet.id), context });
    }
    // Initial run only establishes a baseline, without retrieving the full history.
    if (monitor.initialized_at === null || !body.meta.next_token) return { posts, userId };
    url.searchParams.set("pagination_token", body.meta.next_token);
  }
  // Do not advance the cursor if pagination was incomplete.
  throw new MonitorError("x_pagination_limit");
}

async function loadThirdParty(env: Env, monitor: Monitor, now: number, fetcher: Fetcher): Promise<SourceResult> {
  if (!env.TWITTERAPI_KEY) throw new MonitorError("missing_twitterapi_key");
  const url = new URL("https://api.twitterapi.io/twitter/tweet/advanced_search");
  // A 15-minute overlap catches modest indexing delays; IDs deduplicate results.
  const start = Math.max(monitor.initialized_at ?? now - 86_400_000, (monitor.api_checked_until ?? now - 86_400_000) - 900_000);
  url.searchParams.set("query", `from:${monitor.username} -filter:nativeretweets since_time:${Math.floor(start / 1000)} until_time:${Math.floor(now / 1000)}`);
  url.searchParams.set("queryType", "Latest");
  const posts: Post[] = [];
  for (let page = 0; page < 5; page++) {
    const body = await json(await request(fetcher, url, { headers: { "X-API-Key": env.TWITTERAPI_KEY } }, "twitterapi"), "twitterapi");
    if ((body.status && body.status !== "success") || !Array.isArray(body.tweets) || typeof body.has_next_page !== "boolean") throw new MonitorError("twitterapi_invalid_response");
    for (const tweet of body.tweets) {
      if (tweet.author?.userName?.toLowerCase() !== monitor.username || tweet.retweeted_tweet) continue;
      if (typeof tweet.id !== "string" || !/^\d{10,19}$/.test(tweet.id) || typeof tweet.text !== "string" || !tweet.text.trim()) throw new MonitorError("twitterapi_invalid_post");
      posts.push({ id: tweet.id, text: tweet.text, url: `https://x.com/${monitor.username}/status/${tweet.id}`, publishedAt: postDate(tweet.id) });
    }
    if (!body.has_next_page) return { posts, checkedUntil: now };
    if (typeof body.next_cursor !== "string" || !body.next_cursor || url.searchParams.get("cursor") === body.next_cursor) throw new MonitorError("twitterapi_invalid_cursor");
    url.searchParams.set("cursor", body.next_cursor);
  }
  throw new MonitorError("twitterapi_pagination_limit");
}
