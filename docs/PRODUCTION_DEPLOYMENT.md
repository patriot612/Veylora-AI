# Veylora-AI production deployment prerequisites

The repository is production-configured, but external infrastructure and secrets must be supplied in the deployment account.

## Cloudflare resources

- D1 database: `veylora-ai`
- D1 database ID: `9adcc659-4c40-4a4a-be89-00f6921647f9`
- Queue: `veylora-ai-jobs`
- DLQ: `veylora-ai-jobs-dlq`
- R2 bucket: `veylora-ai-results`
- Worker binding: `RESULTS`
- Scheduled cleanup: hourly

The R2 bucket is used only for temporary binary image results that must survive a Telegram delivery retry. Binary payloads are never placed in Queue messages.

## Cloudflare Secrets

Create these as Worker secrets; never commit their values:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_WEBHOOK_SECRET`
- `CREDENTIAL_ENCRYPTION_KEY`
- `SEARXNG_URL`
- `SEARXNG_AUTH_TOKEN`
- `ADMIN_OWNER_TELEGRAM_ID`
- `ADMIN_WEBAPP_URL`

## Provider credentials

AI provider credentials are not Worker secrets. They are entered through the provider/credential registry and stored encrypted in D1 using `CREDENTIAL_ENCRYPTION_KEY`.

Current provider adapters seeded by the project:

- Pollinations
- xKiro
- Groq

## Deployment order

1. Create the R2 bucket `veylora-ai-results`.
2. Create the Cloudflare Worker secrets listed above.
3. Apply D1 migrations to the remote production database.
4. Deploy the Worker.
5. Configure the Telegram webhook with the Worker webhook secret.
6. Configure provider credentials/models/default models in Admin.
7. Configure SearXNG URL/authentication.
8. Run live smoke tests for Chat, Search, Image, Voice, Documents and Telegram Stars.

Remote D1 migration and live smoke tests are deliberately not performed by repository CI because they mutate production infrastructure and require the operator's Cloudflare/Telegram/provider credentials.
