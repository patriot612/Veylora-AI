# Veylora-AI — Cloudflare setup from a phone

This guide is for the current T3 v1.1 repository layout.

## What the repository expects

Cloudflare Worker:
- name: `veylora-ai`
- entrypoint: `src/index.ts`
- production branch: `main`
- webhook path: `/telegram/webhook`
- health check: `/healthz`
- admin app: `/admin`

Cloudflare D1:
- database name: `veylora-ai`
- binding: `DB`
- migrations directory: `migrations/`

Cloudflare Queues:
- producer queue: `veylora-ai-jobs`
- dead-letter queue: `veylora-ai-jobs-dlq`
- binding: `AI_JOBS`

There is no R2 requirement in T3 v1.1.

Images follow the T3 no-permanent-storage rule:
- provider result is delivered to Telegram;
- after Telegram accepts the image, the returned Telegram `file_id` is the temporary reference;
- the application keeps that reference only until the operation is settled;
- image binaries are not stored permanently in D1 or another application object store.

## 1. Finish the GitHub side

Open the repository in GitHub on your phone.

1. Open Pull Request #1.
2. Wait until the `Verify` check is green.
3. Merge the PR into `main`.
4. After the merge, use `main` as the production branch in Cloudflare Workers Builds.

Do not configure production from `feat/production-foundation`.

## 2. Open Cloudflare

In a mobile browser, open the Cloudflare dashboard and go to **Workers & Pages**.

Choose:

**Create application → Import a repository**

Connect GitHub and select:

`patriot612/Veylora-AI`

Cloudflare Workers Builds should be connected to the repository. The Worker name must match the `name` in `wrangler.jsonc`, which is `veylora-ai`.

Recommended build settings for this repository:

- Production branch: `main`
- Root directory: repository root
- Build command: leave empty
- Deploy command: `npx wrangler deploy`
- Preview command: leave empty

Save and deploy.

Cloudflare should provide a `workers.dev` URL. Keep that URL; it will be used for the webhook and Admin Mini App.

## 3. Check the D1 database

In Cloudflare, open **D1**.

Find:

`veylora-ai`

The repository currently references database ID:

`9adcc659-4c40-4a4a-be89-00f6921647f9`

If the database in your account has this ID, do not change the repository.

If your Cloudflare account has a different D1 database, stop here and replace the repository's `database_id` with the real ID before production deployment.

The Worker binding must be:

- variable name: `DB`
- database: `veylora-ai`

## 4. Create the Queues

In Cloudflare, open **Queues**.

Create:

`veylora-ai-jobs`

Create:

`veylora-ai-jobs-dlq`

The names must match `wrangler.jsonc`.

The Worker uses `AI_JOBS` as the producer binding and consumes both the main queue and the DLQ.

## 5. Add the seven Worker secrets

Open:

**Workers & Pages → veylora-ai → Settings → Variables and Secrets**

Add these as **Secret** values:

`TELEGRAM_BOT_TOKEN`
Your Telegram bot token from BotFather.

`TELEGRAM_WEBHOOK_SECRET`
A random secret containing only letters, numbers, `_` or `-`.

`CREDENTIAL_ENCRYPTION_KEY`
A strong random secret. Never send this value in chat and never commit it to GitHub.

`SEARXNG_URL`
The HTTPS URL of your SearXNG service.

`SEARXNG_AUTH_TOKEN`
The authentication token for the SearXNG service.

`ADMIN_OWNER_TELEGRAM_ID`
Your numeric Telegram user ID.

`ADMIN_WEBAPP_URL`
Use the final Worker URL plus `/admin`.

Example shape:

`https://<your-worker-host>/admin`

After adding or changing secrets, choose **Deploy**.

## 6. Apply the D1 migrations to production

The repository's migration history is under `migrations/`.

Do not run only a local migration.

You must apply the migrations to the remote D1 database.

The command is:

```
npx wrangler d1 migrations apply veylora-ai --remote
```

### Phone-only way

Use a browser-based development environment connected to the GitHub repository, such as GitHub Codespaces.

Open a terminal in the repository, then run:

```
npm install
npx wrangler login
npx wrangler d1 migrations apply veylora-ai --remote
```

Complete the Cloudflare authorization in the browser.

When Wrangler asks for confirmation, approve the migration.

Then verify:

```
npx wrangler d1 migrations list veylora-ai --remote
```

All repository migrations should be applied.

## 7. Deploy the Worker

With `main` connected in Workers Builds, a push/merge to `main` triggers the Cloudflare build.

You can also deploy from the terminal:

```
npx wrangler deploy
```

For normal operation, keep the Git integration enabled so future pushes to `main` deploy automatically.

## 8. Check the Worker before Telegram

Open:

`https://<your-worker-host>/healthz`

Expected response is JSON with:

- `ok: true`
- `environment: "production"`

Do not configure Telegram until this URL responds correctly.

## 9. Configure the Telegram webhook

The exact webhook endpoint is:

`https://<your-worker-host>/telegram/webhook`

Set the Telegram webhook using Bot API `setWebhook`.

Parameters:

- `url`: the Worker webhook URL above
- `secret_token`: exactly the same value as `TELEGRAM_WEBHOOK_SECRET`
- `allowed_updates`: `message`, `callback_query`, `pre_checkout_query`

For example, the request body is:

```json
{
  "url": "https://<your-worker-host>/telegram/webhook",
  "secret_token": "<same-value-as-TELEGRAM_WEBHOOK_SECRET>",
  "allowed_updates": ["message", "callback_query", "pre_checkout_query"]
}
```

Telegram sends the secret back in the `X-Telegram-Bot-Api-Secret-Token` header.

After setting the webhook, call Bot API `getWebhookInfo` and check that:

- `url` is the expected webhook URL;
- `last_error_message` is absent or empty;
- `pending_update_count` is not unexpectedly growing.

## 10. Open Admin

In Telegram, send:

`/admin`

The owner ID must match `ADMIN_OWNER_TELEGRAM_ID`.

Open **Open Admin Mini App**.

The Admin application is served by the same Worker.

## 11. Configure providers and models

In Admin:

1. Providers — verify provider entries.
2. Credentials — enter the real provider credentials.
3. Models — create or enable the actual models.
4. Assign model type correctly:
   - Chat
   - Search
   - Image
   - Voice
5. Set the required default model configuration.
6. Make sure subscription-only flags and point costs are correct.
7. Configure plan prices in Telegram Stars.

Provider credentials are stored encrypted in D1 using `CREDENTIAL_ENCRYPTION_KEY`.

They are not Worker plaintext variables.

## 12. Configure Search

In Admin → Search:

- set the primary SearXNG URL;
- set fallback URL if you use one;
- enable Search;
- set search limits;
- verify the SearXNG authentication token is available to the Worker.

The Search service is separate from normal Chat processing.

## 13. Configure plans and subscriptions

In Admin → Plans:

- enter the real Telegram Stars price for each enabled plan;
- verify daily points;
- verify retention hours;
- verify Voice availability.

The seed migration contains the plan structure, but production prices are configuration and must be set in Admin.

## 14. Live smoke test order

Run these tests from Telegram in this order:

1. `/start`
2. normal Chat message
3. change Chat model
4. open My dialogs
5. create a new dialog
6. archive and restore a dialog
7. delete an archived dialog and verify confirmation
8. open Image mode
9. generate one image
10. verify the image arrives in Telegram
11. Search with `/search ...`
12. enable Documents and send a PDF/DOCX/TXT
13. enable Voice if the plan allows it
14. test a Telegram Stars purchase
15. open `/admin` again and check queue/operations/errors

For Image mode specifically, the application must not require an R2 bucket. After Telegram accepts the image, Telegram's returned `file_id` is the temporary result reference.

## 15. Production troubleshooting order

If something fails, check in this order:

### Worker does not deploy
Check:
- Worker name is `veylora-ai`
- repository is `patriot612/Veylora-AI`
- branch is `main`
- deploy command is `npx wrangler deploy`

### Worker deploys but /healthz fails
Check Worker deployment status and logs.

### Telegram webhook is rejected
Check:
- webhook URL uses HTTPS;
- path is exactly `/telegram/webhook`;
- `TELEGRAM_WEBHOOK_SECRET` matches the `secret_token` used in `setWebhook`.

### Admin says access denied
Check:
- `ADMIN_OWNER_TELEGRAM_ID` is your numeric Telegram ID;
- the bot token is correct;
- you opened Admin from the same Telegram account.

### Chat says model is unavailable
Check Admin → Models:
- model is enabled;
- model type is `chat`;
- provider is enabled;
- credential exists;
- default Chat model is configured.

### Search fails
Check:
- `SEARXNG_URL`;
- `SEARXNG_AUTH_TOKEN`;
- SearXNG is reachable from the Worker;
- Search is enabled in Admin.

### Image generation fails
Check:
- Image model exists and is enabled;
- provider credential is valid;
- model type is `image`;
- user has enough points;
- Queue `veylora-ai-jobs` exists;
- Worker consumer is attached to the queue.

## T3 storage rule for images

Do not add an R2 bucket just to satisfy image delivery.

T3 v1.1 specifies no permanent image storage. The temporary image reference is Telegram `file_id`, kept only for the delivery/settlement lifecycle.

R2 is not part of the required production architecture for this project.
