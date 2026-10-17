import { analysisFields } from "./discord.ts";
import { MonitorError, readText, request, requireHttps } from "./http.ts";
import type { Fetcher, Post, ResetAnalysis } from "./types.ts";

export function slackWebhookUrl(value: string): URL {
  const url = requireHttps(value, "slack_webhook_url");
  if (!["hooks.slack.com", "hooks.slack-gov.com"].includes(url.hostname)
    || !/^\/services\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(url.pathname)
    || url.port || url.search || url.hash) throw new MonitorError("invalid_slack_webhook_url");
  return url;
}

export async function sendSlack(webhook: string, account: string, post: Post | null, fetcher: Fetcher,
  analysis?: ResetAnalysis, displayZone?: string, demo = false): Promise<void> {
  const title = demo ? "🧪 DEMO — ChatGPT / Codex reset completed"
    : post ? (analysis?.classification === "completed" ? "ChatGPT / Codex reset completed" : "ChatGPT / Codex reset announced")
    : "Tibo Time: webhook test";
  const description = demo ? "TEST / DEMO — This demonstrates a completed usage reset. No real reset is being announced."
    : post?.text ?? "Your Slack webhook is working. This is a test message, not a reset announcement.";
  // All source text is plain_text so post content cannot create Slack mentions.
  const plain = (text: string) => ({ type: "plain_text", text, emoji: false });
  const blocks: unknown[] = [
    { type: "header", text: plain(title) },
    { type: "section", text: plain(description.slice(0, 2900)) },
  ];
  if (analysis) {
    for (const field of analysisFields(analysis, displayZone)) {
      const value = field.value.replace(/ · <t:\d+:R>/g, "");
      blocks.push({ type: "section", text: plain(`${field.name}\n${value}`) });
    }
  }
  // Use the canonical account/post link, never a URL supplied inside post text.
  const url = post && /^\d{10,19}$/.test(post.id) ? `https://x.com/${account}/status/${post.id}` : `https://x.com/${account}`;
  blocks.push({ type: "actions", elements: [{ type: "button", text: plain("View original post"), url }] });
  blocks.push({ type: "context", elements: [plain(demo ? "Test message only · Not a real reset announcement"
    : post ? `@${account} · ${analysis?.model ?? "AI"} interpretation; check the original post` : `Monitoring @${account}`)] });
  const response = await request(fetcher, slackWebhookUrl(webhook), {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: title, blocks, unfurl_links: false, unfurl_media: false }),
  }, "slack");
  if ((await readText(response, "slack", 10_000)).trim() !== "ok") throw new MonitorError("slack_missing_confirmation");
}
