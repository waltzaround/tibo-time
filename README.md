# Tibo Time

A Cloudflare Worker that watches [@thsottiaux](https://x.com/thsottiaux) through the official X API, uses OpenAI **GPT-6 Luna** to classify posts and infer reset timing, and sends ChatGPT / Codex reset announcements to a Discord webhook. Cloudflare runs a check every five minutes; D1 stores the startup baseline, pending posts, model decisions, delivery receipts, and a lease that prevents overlapping checks.

The first successful check establishes a baseline and sends **no historical alerts**. Every subsequent new post is reviewed by Luna, including posts without the word "reset". The model distinguishes upcoming announcements and completed resets from unrelated posts, polls, requests, and ambiguous discussion. Only announcements/completed resets are delivered, with the original text and link. Model decisions are stored so repeated source reads and Discord retries do not normally trigger another analysis. The watcher does not confirm that your account's usage was actually reset.

## Reset timing

Luna uses the post's publication timestamp to interpret relative phrases such as "tomorrow at 10am PT". The Worker converts the inferred local time to UTC with timezone rules, then displays it in **Pacific/Auckland** along with the original timing phrase and any assumptions. Discord also shows a relative timestamp for single inferred times.

- `SOURCE_TIMEZONE` defaults to `America/Los_Angeles` **as an assumption when the post gives no timezone**. Change this in `wrangler.jsonc` if needed. Relative dates follow the source timezone, not the reader's timezone or the polling time.
- PT uses Pacific daylight-saving rules. Literal PST is UTC-08:00; PDT is UTC-07:00. The model is instructed to preserve that distinction.
- Exact clock times, approximate times, and whole-day/deadline windows stay distinct. "Tomorrow" alone becomes a day window, not an invented activation hour. A time not stated or unclear stays unknown; completed posts do not substitute their publication time for the reset time.
- Ambiguous/nonexistent DST times and invalid calendar dates are downgraded to unknown. Timing evidence must be an exact substring of the post. These checks prevent several common conversion errors, but model interpretation can still be wrong; alerts label timing as inferred and link to the source.

`OPENAI_MODEL` is configured as `gpt-6-luna`, using the Responses API with strict structured output and `store: false`. No web tools or other model tools are enabled. [OpenAI Docs: Luna](https://developers.openai.com/api/docs/models/gpt-6-luna), [structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs)

The automated tests mock model responses to verify the API request, decision persistence, suppression, retries, and timezone conversion. A live model quality check requires the OpenAI API key, which will be supplied later.

## Choose a source

The project is configured with `SOURCE: "x"` in `wrangler.jsonc`. Supply an X app bearer token when ready to deploy. Alternative sources remain available:

| Source | Required secret | How it reads posts |
| --- | --- | --- |
| `x` (default) | `X_BEARER_TOKEN` | Official X user timeline, fetching only new posts with `since_id` |
| `rss` | `RSS_FEED_URL` | RSS 2.0 or Atom feed from a provider you choose |
| `twitterapi` | `TWITTERAPI_KEY` | TwitterAPI.io advanced search with time bounds and a 15-minute overlap |

Prices checked on 14 October 2026:

- **Official X:** US$0.005 per returned post and US$0.01 per user lookup, with no subscription or minimum spend. This worker caches the lookup and excludes reposts. For example, 300 new posts/month cost about US$1.50 plus the initial lookup and baseline fetch. Empty polls return no billable post resources. X normally deduplicates repeated reads in the same UTC day, but describes this as a soft guarantee. [Official pricing](https://docs.x.com/x-api/getting-started/pricing)
- **OpenAI Luna:** US$0.10 per million input tokens and US$0.50 per million output tokens, billed separately from X. Each new post normally needs one analysis; empty polls make no model calls. Reasoning tokens and retries also affect usage. [OpenAI model pricing](https://developers.openai.com/api/docs/models/gpt-6-luna)
- **TwitterAPI.io:** US$0.00015 per returned post, with a US$0.00015 minimum per call. Five-minute polling means 8,640 checks per 30 days: **US$1.296 minimum**, plus extra returned results, overlap reads, and pagination. This is an estimate, not a monthly cap. [Pricing](https://twitterapi.io/pricing), [account monitoring guide](https://twitterapi.io/blog/how-to-monitor-twitter-accounts-for-new-tweets-in-real-time)
- **RSS:** bring any working feed for the account. [RSS.app](https://rss.app/rss-feed/create-twitter-rss-feed) can generate one from the profile URL. Its [Basic plan](https://rss.app/pricing) lists US$8.32/month billed annually with a **60-minute** provider refresh; Developer lists US$16.64/month billed annually with a **15-minute** refresh. Worker polling does not make a provider refresh sooner. Public [Nitter](https://github.com/zedeus/nitter) feeds may be disabled or unavailable; verify a feed returns recent posts before relying on it.

This workload should fit Cloudflare's free Workers/D1 allowances, assuming small feeds and normal traffic. The Worker free tier also has a CPU limit; check invocation metrics after deployment. [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)

## Deploy

Requires Node.js 22+, a Cloudflare account, a Discord webhook, an X app bearer token, and an OpenAI API key with Luna access. Credentials have not been supplied and the watcher has not been deployed. No custom domain is required.

1. Install and verify:

   ```sh
   npm install
   npm run check
   npm run build
   npx wrangler login
   ```

2. Create D1:

   ```sh
   npx wrangler d1 create tibo-time
   ```

   Replace the all-zero `database_id` in `wrangler.jsonc` with the ID returned by that command, then apply the schema:

   ```sh
   npm run db:remote
   ```

3. Add secrets using the interactive prompts:

   ```sh
   npx wrangler secret put DISCORD_WEBHOOK_URL
   npx wrangler secret put ADMIN_TOKEN
   ```

   Use a long random `ADMIN_TOKEN`. Create an app in the X Developer Console, then add its bearer token:

   ```sh
   npx wrangler secret put X_BEARER_TOKEN
   npx wrangler secret put OPENAI_API_KEY
   ```

   If you later change `SOURCE`, add the corresponding secret from the source table instead.

   Create the Discord webhook in the destination channel's **Settings → Integrations → Webhooks**, and copy its webhook URL. Treat the entire URL as a secret. For a forum channel, configure an existing thread using `?thread_id=...` in the webhook URL.

4. Deploy:

   ```sh
   npm run deploy
   ```

   Wrangler prints the `https://tibo-time.<your-subdomain>.workers.dev` URL. Cloudflare notes that Cron Trigger changes can take up to 15 minutes to propagate. [Cron documentation](https://developers.cloudflare.com/workers/configuration/cron-triggers/)

5. Test the webhook and initialize immediately using the admin client below. `/test-webhook` sends an explicitly labelled test message. `/check` establishes the baseline on a fresh database. Confirm `/status` shows `initialized_at`, a recent `last_success_at`, and `healthy: true`.

## Admin client

The root endpoint identifies the service; it does not indicate monitoring health. `/status`, `/health`, `/check`, and `/test-webhook` require `Authorization: Bearer <ADMIN_TOKEN>`. Tokens in URL query strings are not accepted.

To avoid putting a token in shell history, use a small interactive client:

```sh
node scripts/admin.mjs
```

It prompts for the Worker URL, token, and action. `status` prints diagnostics; `health` returns HTTP 503 if polling has stopped for 20 minutes, a check failed, or delivery retries are outstanding. `check` polls immediately; `test-webhook` sends a test. Do not send your webhook or API credentials to these endpoints.

Cloudflare logs contain result counts and static error codes, without source URLs or secret values:

```sh
npx wrangler tail
```

## Local development

```sh
cp .dev.vars.example .dev.vars
# Fill in X_BEARER_TOKEN, OPENAI_API_KEY, DISCORD_WEBHOOK_URL, and ADMIN_TOKEN.
npm run db:local
npm run dev
```

Use the admin client with `http://localhost:8787`. Local development uses a separate local database, but configured X/OpenAI requests and Discord sends are real. The automated tests use mocked network requests and local D1; they send no Discord messages and spend no API credits.

## Delivery and limits

- New posts are written to D1 before advancing the source checkpoint. Classification failures and failed deliveries remain queued even if the post disappears from the RSS feed. The worker retries them on subsequent checks, including when the source is unavailable. An OpenAI outage does not bypass classification or silently discard a post.
- The worker processes up to five queued posts per check, uses exponential retry delays, honors `Retry-After`, and disables automatic mentions. A cached model decision is reused for delivery retries. `wait=true` requires Discord to return a saved-message receipt.
- Delivery is **at least once**. Normal repeats are deduplicated by account and post ID. If Discord accepts a message but the response or subsequent D1 write fails, a retry may create a duplicate; Discord webhooks offer no atomic transaction with D1.
- RSS feeds must expose direct post links such as `/thsottiaux/status/<id>`. The parser accepts mirror links and normalizes them to X. It rejects HTML challenges, invalid XML, empty feeds, or feeds without posts from the target account. It uses X snowflake IDs for publication dates, so provider refresh timestamps do not revive old posts.
- RSS monitoring can miss posts that leave the provider's limited feed between successful polls, and a provider serving stale but valid XML cannot be detected as an outage. API searches can also have indexing delays. `/health` checks successful polling and deliveries, not completeness or freshness of the upstream data.
- API adapters paginate up to five pages per check. If more pages remain, the check fails and preserves the checkpoint; change the limit or catch up manually after an unusually large outage.
- Source switching preserves the startup baseline and delivered IDs. TwitterAPI.io's first check after switching searches since startup; it may reread many posts. Pick a source before deploying for predictable costs.
- Stopping or deleting the Worker stops polling. The D1 database contains stored alert text and delivery state; retain it to avoid losing pending messages. No external account or Discord channel was configured automatically.
