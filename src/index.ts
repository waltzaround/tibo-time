import { sendDiscord } from "./discord.ts";
import { errorCode } from "./http.ts";
import { poll, status, username } from "./monitor.ts";
import type { Env } from "./types.ts";

function json(value: unknown, code = 200): Response {
  return new Response(JSON.stringify(value), { status: code, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

export default {
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    try { console.log(JSON.stringify({ event: "poll", ...await poll(env) })); }
    catch (error) {
      console.error(JSON.stringify({ event: "poll_failed", error: errorCode(error) }));
      // Throw a sanitized error so Cloudflare marks the scheduled invocation failed.
      throw new Error(errorCode(error));
    }
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/" && request.method === "GET") return json({ service: "tibo-time", account: "@" + username(env) });
    if (!env.ADMIN_TOKEN || request.headers.get("Authorization") !== `Bearer ${env.ADMIN_TOKEN}`) return json({ error: "unauthorized" }, 401);
    try {
      if (path === "/status" && request.method === "GET") return json(await status(env));
      if (path === "/health" && request.method === "GET") {
        const result = await status(env);
        return json({ healthy: result.healthy }, result.healthy ? 200 : 503);
      }
      if (path === "/check" && request.method === "POST") {
        const result = await poll(env);
        return json(result, result.busy ? 409 : 200);
      }
      if (path === "/test-webhook" && request.method === "POST") {
        const id = await sendDiscord(env.DISCORD_WEBHOOK_URL, username(env), null, fetch);
        return json({ sent: true, messageId: id });
      }
      return json({ error: "not_found" }, 404);
    } catch (error) {
      console.error(JSON.stringify({ event: "request_failed", error: errorCode(error) }));
      return json({ error: errorCode(error) }, 502);
    }
  },
} satisfies ExportedHandler<Env>;
