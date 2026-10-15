import { MonitorError, readText, request, requireHttps } from "./http.ts";
import type { Fetcher, Post, ResetAnalysis } from "./types.ts";

export async function sendResetDemo(webhook: string, account: string, fetcher: Fetcher): Promise<string> {
  return sendDiscord(webhook, account, {
    id: "demo", text: "TEST / DEMO — This demonstrates a completed ChatGPT / Codex usage reset. No real reset is being announced.",
    url: `https://x.com/${account}`, publishedAt: new Date().toISOString(),
  }, async (url, init) => {
    const body = JSON.parse(String(init?.body));
    body.embeds[0].title = "🧪 DEMO — ChatGPT / Codex reset completed";
    body.embeds[0].footer = { text: "Test message only · Not a real reset announcement" };
    return fetcher(url, { ...init, body: JSON.stringify(body) });
  }, { classification: "completed", summary: "Demo reset", precision: "unknown", startsAt: null, endsAt: null,
    timeZone: null, sourceTimeText: null, assumptions: [], model: "demo" });
}

export function webhookUrl(value: string): URL {
  const url = requireHttps(value, "discord_webhook_url");
  if (!["discord.com", "canary.discord.com", "ptb.discord.com", "discordapp.com"].includes(url.hostname) || !/^\/api(?:\/v\d+)?\/webhooks\/\d+\/[^/]+$/.test(url.pathname)) throw new MonitorError("invalid_discord_webhook_url");
  url.searchParams.set("wait", "true");
  return url;
}

export function analysisFields(analysis: ResetAnalysis, displayZone = "Pacific/Auckland") {
  const fields: { name: string; value: string }[] = [];
  if (analysis.startsAt) {
    let format: Intl.DateTimeFormat;
    try { format = new Intl.DateTimeFormat("en-NZ", { timeZone: displayZone, dateStyle: "full", timeStyle: "short" }); }
    catch { throw new MonitorError("invalid_display_timezone"); }
    const start = format.format(new Date(analysis.startsAt));
    const relative = `<t:${Math.floor(Date.parse(analysis.startsAt) / 1000)}:R>`;
    fields.push({
      name: analysis.precision === "window" ? "Reset window (inferred)" : `Reset time (inferred${analysis.precision === "approximate" ? ", approximate" : ""})`,
      value: analysis.endsAt ? `${start} → ${format.format(new Date(analysis.endsAt))}\n${displayZone}` : `${start}\n${displayZone} · ${relative}`,
    });
  } else {
    fields.push({ name: "Reset time", value: analysis.classification === "completed" ? "Already completed; exact time not determined." : "Time not stated or unclear." });
  }
  if (analysis.sourceTimeText) fields.push({ name: "Timing in the post", value: analysis.sourceTimeText.slice(0, 500) });
  if (analysis.assumptions.length) fields.push({ name: "Timing assumptions", value: analysis.assumptions.join("\n").slice(0, 1000) });
  return fields;
}

export async function sendDiscord(webhook: string, username: string, post: Post | null, fetcher: Fetcher, analysis?: ResetAnalysis, displayZone?: string): Promise<string> {
  const response = await request(fetcher, webhookUrl(webhook), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "Tibo Time",
      allowed_mentions: { parse: [] },
      embeds: [{
        title: post ? (analysis?.classification === "completed" ? "ChatGPT / Codex reset completed" : "ChatGPT / Codex reset announced") : "Tibo Time: webhook test",
        description: post ? post.text.slice(0, 3800) : "Your Discord webhook is working. This is a test message, not a reset announcement.",
        url: post?.url ?? `https://x.com/${username}`,
        color: post ? 0x10b981 : 0x64748b,
        ...(post ? { timestamp: post.publishedAt } : {}),
        ...(analysis ? { fields: analysisFields(analysis, displayZone) } : {}),
        footer: { text: post ? `@${username} · ${analysis?.model ?? "AI"} interpretation; check the original post` : `Monitoring @${username}` },
      }],
    }),
  }, "discord");
  let message;
  try { message = JSON.parse(await readText(response, "discord", 100_000)); }
  catch { throw new MonitorError("discord_invalid_response"); }
  if (typeof message.id !== "string" || !/^\d+$/.test(message.id)) throw new MonitorError("discord_missing_confirmation");
  return message.id;
}
