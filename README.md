# Tibo Time

<img width="475" height="398" alt="Screenshot 2026-10-18 at 7 10 29 AM" src="https://github.com/user-attachments/assets/91011061-a363-4b65-ba8c-f20dc0c292bf" />


**Never miss a ChatGPT or Codex usage reset.**

If you use Codex or ChatGPT heavily, surprise usage resets are pretty valuable. They mean refreshed limits and more opportunities to keep building.

Every so often, Thibault "Tibo" Sottiaux from OpenAI announces additional usage resets on X. Unless you're constantly checking his posts, they're easy to miss.

Tibo Time watches for these announcements and sends you a Discord/Slack notification when one appears.

No refreshing X. Just a heads-up when there might be more usage available.

## How it works

Tibo Time runs on Cloudflare Workers and checks [@thsottiaux](https://x.com/thsottiaux) every ten minutes.

1. **Watches X** — Checks for new posts using the official X API.
2. **Understands announcements** — Uses OpenAI to identify upcoming and completed resets, including announcements that don't explicitly say "reset".
3. **Figures out the timing** — Interprets dates and times mentioned in posts, including relative references such as "tomorrow at 10am PT".
4. **Notifies Discord / Slack** — Sends the announcement, original post and any inferred reset timing to your chosen channel.

It also follows linked posts within a conversation, so announcements spread across multiple replies aren't interpreted in isolation.

Posts explicitly containing the word "reset" always trigger an alert, even if the AI doesn't classify them as an announcement.

## Installation

Tibo Time is designed to be self-hosted on Cloudflare Workers.

### Requirements

You'll need:

- Node.js 22+
- A Cloudflare account
- An X API bearer token
- An OpenAI API key
- A Discord/Slack webhook

**1. Clone and install**

```bash
git clone https://github.com/waltzaround/tibo-time.git
cd tibo-time
npm install
```

**2. Connect Cloudflare**

```bash
npx wrangler login
```

**3. Create the database**

Tibo Time uses Cloudflare D1 to remember which posts have been checked, prevent duplicate notifications and retry failed deliveries.

```bash
npx wrangler d1 create tibo-time
```

Copy the database ID returned by Cloudflare into `wrangler.jsonc`, replacing the existing `database_id` with your own.

Apply the database migrations:

```bash
npm run db:remote
```

**4. Configure your credentials**

Choose Discord, Slack, or both.

For Discord, create a webhook under **Channel Settings → Integrations → Webhooks**, then save it as a secret:

```bash
npx wrangler secret put DISCORD_WEBHOOK_URL
```

For Slack, create a Slack app, enable **Incoming Webhooks**, choose **Add New Webhook to Workspace**, and select your channel. Save the generated URL as a secret:

```bash
npx wrangler secret put SLACK_WEBHOOK_URL
```

See [Slack’s incoming webhook setup guide](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/). The webhook determines the channel; Tibo Time does not need a Slack bot token.

At least one webhook must be configured. With both secrets present, new alerts go to both destinations. Completed deliveries are recorded separately, so a failure on one service does not cause a normal retry to resend to the other. Adding Slack does not replay posts already marked delivered.

Then add the remaining credentials to Cloudflare:

```bash
npx wrangler secret put X_BEARER_TOKEN
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put ADMIN_TOKEN
```

Each command prompts you to enter its value.

Use a long, randomly generated value for `ADMIN_TOKEN`.

**5. Deploy**

```bash
npm run deploy
```

That's it. Cloudflare handles the scheduled checks automatically.

The Worker polls every ten minutes, without needing a server running at home.

Cron Trigger changes can take up to 15 minutes to propagate.

### Verify it's working

Run the included admin client:

```bash
node scripts/admin.mjs
```

Enter your Worker URL and admin token when prompted.

From here you can:

- Check monitoring status
- Trigger a manual check
- Send a test notification to Discord or Slack, including a labelled completed-reset demo
- Check service health

For webhook tests, the admin client lets you choose Discord or Slack. The authenticated endpoints also accept `POST /test-webhook?target=slack` or `POST /test-webhook?target=slack&demo=completed`. Without a target, tests use Discord when configured, otherwise Slack.

The first successful check establishes a baseline, so you won't receive notifications for old posts.

### Upgrading an existing installation for Slack

Run `npm run db:remote` before `npm run deploy` to add the Slack delivery column (`0004_slack_delivery.sql`). Keep `DISCORD_WEBHOOK_URL` to continue Discord alerts, or remove it from Cloudflare for Slack-only operation. Deployments preserve existing secrets.

## A few things worth knowing

**Notifications aren't confirmation of a reset.**
Tibo Time monitors public announcements, not your individual ChatGPT or Codex account. It doesn't check whether your personal usage limits have actually refreshed.

**Timing is inferred.**
When announcements mention a time, OpenAI interprets it using the original post's publication date. The Worker converts it to UTC and displays it in New Zealand time (Pacific/Auckland). Unclear times remain unknown rather than being guessed.

**Occasional false positives are possible.**
Any new post containing the standalone word "reset" generates an alert, even if it's a joke or unrelated discussion. This is intentional to reduce the chance of missing an announcement.

**API usage may cost money.**
Cloudflare Workers and D1 should fit within their free allowances for this workload, but the X API and OpenAI API have separate usage-based charges.

## Under the hood

Built with:

- **Cloudflare Workers** — Scheduled polling every ten minutes
- **Cloudflare D1** — Post history, classification results and delivery tracking
- **Official X API** — Fetches new posts from Tibo
- **OpenAI** — Classifies announcements and interprets reset timing
- **Discord/Slack Webhooks** — Delivers notifications

The Worker stores processed posts, retries failures and avoids reclassifying the same post unnecessarily.

Alternative RSS and TwitterAPI.io sources are also supported through configuration.

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars
```

Add your credentials to `.dev.vars`, then run:

```bash
npm run db:local
npm run dev
```

The local Worker runs at `http://localhost:8787`.

Note that local development uses a separate database, but actual X API requests, OpenAI calls and Discord/Slack notifications can still incur costs or send real messages.

To validate changes:

```bash
npm run check
npm run build
```

---

Made because surprise resets are useful, and constantly checking X isn't.
