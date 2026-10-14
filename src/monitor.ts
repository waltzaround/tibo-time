import { sendDiscord, webhookUrl } from "./discord.ts";
import { analyzePost, isReset, sourceTimezone } from "./analyze.ts";
import { errorCode, MonitorError } from "./http.ts";
import { loadPosts } from "./sources.ts";
import type { Alert, Env, Fetcher, Monitor, ResetAnalysis } from "./types.ts";

export function username(env: Env): string {
  const value = (env.X_USERNAME || "thsottiaux").toLowerCase();
  if (!/^[a-z0-9_]{1,15}$/.test(value)) throw new MonitorError("invalid_username");
  return value;
}

export async function poll(env: Env, fetcher: Fetcher = fetch, now = Date.now()) {
  const target = username(env);
  const db = env.DB;
  await db.prepare("INSERT OR IGNORE INTO monitors (username) VALUES (?)").bind(target).run();
  const owner = crypto.randomUUID();
  const lease = await db.prepare("UPDATE monitors SET lease_owner = ?, lease_until = ?, last_poll_at = ? WHERE username = ? AND lease_until <= ? RETURNING *")
    .bind(owner, now + 180_000, now, target, now).first<Monitor>();
  if (!lease) return { busy: true, initialized: false, queued: 0, sent: 0, dismissed: 0 };
  let queued = 0;
  let sent = 0;
  let dismissed = 0;
  let failure: unknown;
  try {
    webhookUrl(env.DISCORD_WEBHOOK_URL);
    if (!env.OPENAI_API_KEY) throw new MonitorError("missing_openai_api_key");
    sourceTimezone(env);
    try {
      const source = await loadPosts(env, lease, now, fetcher);
      const posts = [...new Map(source.posts.map((p) => [p.id, p])).values()];
      let latest = BigInt(lease.latest_id);
      for (const post of posts) if (BigInt(post.id) > latest) latest = BigInt(post.id);
      const statements: D1PreparedStatement[] = [];
      if (lease.initialized_at !== null) {
        for (const post of posts) {
          if (BigInt(post.id) <= BigInt(lease.baseline_id) || Date.parse(post.publishedAt) < lease.initialized_at) continue;
          statements.push(db.prepare("INSERT OR IGNORE INTO alerts (username, post_id, text, url, published_at, queued_at) VALUES (?, ?, ?, ?, ?, ?)")
            .bind(target, post.id, post.text, post.url, post.publishedAt, now));
        }
      }
      // D1 batches are atomic: never move the checkpoint before persisting alerts.
      statements.push(db.prepare("UPDATE monitors SET initialized_at = COALESCE(initialized_at, ?), baseline_id = CASE WHEN initialized_at IS NULL THEN ? ELSE baseline_id END, latest_id = ?, api_checked_until = ?, x_user_id = COALESCE(?, x_user_id) WHERE username = ? AND lease_owner = ?")
        .bind(now, latest.toString(), latest.toString(), source.checkedUntil ?? lease.api_checked_until, source.userId ?? null, target, owner));
      const results = await db.batch(statements);
      queued = results.slice(0, -1).reduce((sum, result) => sum + result.meta.changes, 0);
    } catch (error) { failure = error; }

    // Persisted notifications can still be delivered while the source is down.
    const pending = await db.prepare("SELECT * FROM alerts WHERE username = ? AND sent_at IS NULL AND dismissed_at IS NULL AND next_attempt_at <= ? ORDER BY published_at, post_id LIMIT 5")
      .bind(target, now).all<Alert>();
    for (const alert of pending.results) {
      // Renew before each delivery; do not send if another poll acquired the lease.
      const renewed = await db.prepare("UPDATE monitors SET lease_until = ? WHERE username = ? AND lease_owner = ? RETURNING username")
        .bind(Date.now() + 180_000, target, owner).first();
      if (!renewed) throw new MonitorError("poll_lease_lost");
      try {
        const post = { id: alert.post_id, text: alert.text, url: alert.url, publishedAt: alert.published_at };
        let analysis: ResetAnalysis;
        if (alert.analysis_json) {
          try { analysis = JSON.parse(alert.analysis_json); }
          catch { throw new MonitorError("invalid_cached_analysis"); }
        } else {
          analysis = await analyzePost(env, post, fetcher);
          await db.prepare("UPDATE alerts SET analysis_json = ?, analysis_model = ?, analyzed_at = ? WHERE username = ? AND post_id = ?")
            .bind(JSON.stringify(analysis), analysis.model, now, target, alert.post_id).run();
        }
        if (!isReset(analysis)) {
          await db.prepare("UPDATE alerts SET dismissed_at = ?, last_error = NULL WHERE username = ? AND post_id = ?").bind(now, target, alert.post_id).run();
          dismissed++;
          continue;
        }
        const id = await sendDiscord(env.DISCORD_WEBHOOK_URL, target, post, fetcher, analysis, env.DISPLAY_TIMEZONE);
        await db.prepare("UPDATE alerts SET sent_at = ?, discord_message_id = ?, last_error = NULL WHERE username = ? AND post_id = ?")
          .bind(now, id, target, alert.post_id).run();
        sent++;
      } catch (error) {
        const backoff = Math.min(3_600_000, 300_000 * 2 ** Math.min(alert.attempts, 4));
        const delay = Math.max(backoff, error instanceof MonitorError ? error.retryAfterMs : 0);
        await db.prepare("UPDATE alerts SET attempts = attempts + 1, next_attempt_at = ?, last_error = ? WHERE username = ? AND post_id = ?")
          .bind(now + delay, errorCode(error), target, alert.post_id).run();
        failure ??= error;
        break; // Avoid additional webhook calls during rate limits or outages.
      }
    }
    if (failure) throw failure;
    await db.prepare("UPDATE monitors SET last_success_at = ?, consecutive_failures = 0, last_error = NULL WHERE username = ? AND lease_owner = ?")
      .bind(now, target, owner).run();
    return { busy: false, initialized: lease.initialized_at === null, queued, sent, dismissed };
  } catch (error) {
    await db.prepare("UPDATE monitors SET consecutive_failures = consecutive_failures + 1, last_error = ? WHERE username = ? AND lease_owner = ?")
      .bind(errorCode(error), target, owner).run();
    throw error;
  } finally {
    await db.prepare("UPDATE monitors SET lease_until = 0, lease_owner = NULL WHERE username = ? AND lease_owner = ?").bind(target, owner).run();
  }
}

export async function status(env: Env, now = Date.now()) {
  const target = username(env);
  const state = await env.DB.prepare("SELECT username, initialized_at, last_poll_at, last_success_at, last_error, consecutive_failures FROM monitors WHERE username = ?").bind(target).first<Monitor>();
  const pending = await env.DB.prepare("SELECT COUNT(*) AS count, MAX(attempts) AS attempts FROM alerts WHERE username = ? AND sent_at IS NULL AND dismissed_at IS NULL").bind(target).first<{ count: number; attempts: number | null }>();
  const healthy = Boolean(state?.last_success_at && now - state.last_success_at < 20 * 60_000 && !state.consecutive_failures && !pending?.attempts);
  return { healthy, source: env.SOURCE, model: env.OPENAI_MODEL || "gpt-6-luna", monitor: state, pendingPosts: pending?.count ?? 0 };
}
