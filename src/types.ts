export interface Env {
  DB: D1Database;
  SOURCE: "rss" | "x" | "twitterapi";
  X_USERNAME: string;
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
  SOURCE_TIMEZONE?: string;
  DISPLAY_TIMEZONE?: string;
  RSS_FEED_URL?: string;
  X_BEARER_TOKEN?: string;
  TWITTERAPI_KEY?: string;
  DISCORD_WEBHOOK_URL: string;
  ADMIN_TOKEN: string;
}

export interface Post {
  id: string;
  text: string;
  url: string;
  publishedAt: string;
  context?: PostContext[];
}

export interface PostContext {
  id: string;
  text: string;
  publishedAt: string;
  author: string;
  relation: "quoted" | "replied_to";
  referencedBy: string;
}

export interface Monitor {
  username: string;
  initialized_at: number | null;
  baseline_id: string;
  latest_id: string;
  api_checked_until: number | null;
  x_user_id: string | null;
  last_poll_at: number | null;
  last_success_at: number | null;
  last_error: string | null;
  consecutive_failures: number;
}

export interface Alert {
  post_id: string;
  text: string;
  url: string;
  published_at: string;
  attempts: number;
  analysis_json: string | null;
  context_json: string | null;
}

export interface ResetAnalysis {
  classification: "announced" | "completed" | "not_reset" | "unclear";
  summary: string;
  precision: "exact" | "approximate" | "window" | "unknown";
  startsAt: string | null;
  endsAt: string | null;
  timeZone: string | null;
  sourceTimeText: string | null;
  assumptions: string[];
  model: string;
}

export type Fetcher = (url: string | URL, init?: RequestInit) => Promise<Response>;
