# Veylora-AI production deployment prerequisites

The repository is production-configured, but external infrastructure and secrets must be supplied in the deployment account.

## Cloudflare resources

- D1 database: `veylora-ai`
- D1 database ID: `9adcc659-4c40-4a4a-be89-00f6921647f9`
- Queue: `veylora-ai-jobs`
- DLQ: `veylora-ai-jobs-dlq`
- Scheduled cleanup: hourly
- Image temporary result state: Telegram file_id stored only in D1 until delivery is settled.

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

1. Create the Cloudflare Worker secrets listed above.
2. Apply D1 migrations to the remote production database.
3. Deploy the Worker.
4. Configure the Telegram webhook with the Worker webhook secret.
5. Configure provider credentials/models/default models in Admin.
6. Configure SearXNG URL/authentication.
7. Run live smoke tests for Chat, Search, Image, Voice, Documents and Telegram Stars.

Remote D1 migration and live smoke tests are deliberately not performed by repository CI because they mutate production infrastructure and require the operator's Cloudflare/Telegram/provider credentials.
