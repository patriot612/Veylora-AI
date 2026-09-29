# Veylora-AI — Audit and Implementation Plan

Date: 2026-09-28
Branch: `feat/production-foundation`
Specification: Final Spec Package v1.1 + Qelvion-AI Implementation Mechanics Handoff

## Audit result

The repository `main` contains only the placeholder file `Тест`. There is currently no application source, package manifest, Wrangler configuration, D1 migration set, queue consumer, tests, CI workflow, or Admin Mini App implementation to preserve.

The implementation therefore starts from the agreed architecture baseline rather than replacing an existing implementation.

## Source hierarchy

1. Final Spec Package v1.1 — requirements and fixed Telegram UX/design.
2. Qelvion-AI Implementation Mechanics Handoff — execution mechanics and boundaries.
3. Current official platform documentation — implementation details that can change over time.

The Handoff does not override the Final Spec.

## Non-negotiable architecture

Telegram -> Cloudflare Worker -> D1 / AI Gateway / Search Gateway / Queue -> Telegram.

- Cloudflare Worker is the application entry point.
- D1 is the persistent application database.
- Cloudflare Queue is reserved for genuinely heavy/long-running jobs.
- AI Gateway is an internal module, not a separate service.
- Search is a strict separate pipeline through Render/SearXNG and a selected Search model.
- Admin Mini App is separate from end-user UI and protected by server-side Telegram identity and RBAC.
- No Railway runtime is introduced.
- No duplicate billing, queue, provider-routing, or Search architecture is introduced.

## Gap matrix

| Area | Current | Gap | Risk | Required change | Verification |
|---|---|---|---|---|---|
| Toolchain | absent | Worker/TS/Wrangler/package/test baseline | Critical | scaffold | install/typecheck/test |
| D1 | absent | schema, indexes, migrations | Critical | implement schema | local migration + SQL |
| Telegram ingress | absent | webhook, routing, update idempotency | Critical | secure ingress | handler tests |
| Users/operations | absent | identity/state machine | Critical | operation model | unit/integration |
| Points | absent | atomic reserve/capture/release | Critical | unified ledger | concurrency tests |
| Models/providers | absent | registry and credential indirection | Critical | registry + adapters | routing tests |
| AI Gateway | absent | central provider invocation | Critical | gateway | adapter mocks |
| Chat/dialogs/roles | absent | fixed UX and persistence | High | Chat subsystem | flow tests |
| Search | absent | SearXNG -> editor -> sources | Critical | separate Search pipeline | grounding/timeout tests |
| Queue | absent | idempotent heavy jobs | Critical | Queue consumer | duplicate/retry/DLQ tests |
| Image | absent | generation + Telegram delivery | Critical | image processor | failure/retry tests |
| Voice | absent | STT/voice queue flow | High | voice processor | failure/retry tests |
| Documents | absent | bounded extraction/session | High | document pipeline | limits/expiry tests |
| Payments | absent | Telegram Stars lifecycle | High | payment handlers | mocked payment tests |
| Admin | absent | `/admin`, Mini App, RBAC | Critical | admin surface | authz tests |
| Cleanup | absent | retention/expiry | High | scheduled jobs | cron tests |
| Security | absent | secrets, authz, validation, audit | Critical | security baseline | negative tests |
| CI/CD | absent | automated verification/deploy | High | GitHub Actions | workflow runs |

## Implementation stages

### Stage 1 — Repository/toolchain foundation
- TypeScript project.
- Cloudflare Worker entry point.
- Wrangler configuration with D1 and Queue bindings.
- Vitest/unit test baseline and Worker test harness where appropriate.
- ESLint/formatting/typecheck.
- GitHub Actions for verification.
- `.gitignore` and secret hygiene.

### Stage 2 — Database
- Implement D1 schema and migrations.
- Add ownership/status/time indexes.
- Establish operation, reservation, queue-job and audit invariants.
- Validate migrations locally before moving on.

### Stage 3 — Telegram ingress
- Webhook secret validation.
- Update router.
- Telegram update idempotency.
- Server-derived user identity and upsert.

### Stage 4 — Users/plans/points/operations
- Free and subscription plan model.
- Daily points reset at 00:00 UTC+3.
- Bonus points.
- Atomic reservation.
- Capture/release state transitions.
- One active Chat operation per user.

### Stage 5 — Model Registry / Provider Registry / AI Gateway
- Family -> Model -> Provider -> Credential -> provider API.
- User-facing model abstraction.
- Server-only credentials.
- Provider adapters.
- Timeout and normalized error mapping.

### Stage 6 — Chat / Conversations / Roles
- 4096 character limit.
- Context handling and 200-message conversation limit.
- Dialog create/continue/archive/restore/delete.
- Role activation/reset behavior.

### Stage 7 — Search Mode
- Search UI state machine.
- Search Gateway.
- Render/SearXNG integration.
- Normalize/dedupe.
- Search Editor model grounding.
- Max 8 editor inputs / max 5 displayed sources.
- Five-minute timeout and no-result release.

### Stage 8 — Queue / Image / Voice
- Queue message references only.
- Idempotent consumer.
- Bounded retries and terminal failure.
- Image provider flow.
- Telegram media delivery retry.
- Voice/STT flow.

### Stage 9 — Documents
- PDF/DOCX/TXT.
- 10 MB upload limit.
- 50 PDF pages.
- 25,000 extracted characters.
- bounded chunking/retrieval.
- two-hour inactivity expiration.

### Stage 10 — Telegram UX and callbacks
- Implement the fixed message/button flows from the reference design.
- Prefer message editing over message chains.
- Keep Search separate from Chat.

### Stage 11 — Admin Mini App
- `/admin` authorization gate.
- server-side WebApp `initData` verification.
- owner/admin/support RBAC.
- Dashboard, Users, Models, Roles, Templates, Plans, Payments, Search, Queue/System, Configuration, Statistics, Audit.

### Stage 12 — Payments
- Telegram Stars invoice.
- pre-checkout validation.
- successful payment.
- order/subscription state.
- audit events.

### Stage 13 — Cleanup / scheduled jobs
- Conversation retention.
- Document session/chunk expiry.
- operational cleanup.

### Stage 14 — Security hardening
- Ownership predicates on all user-owned D1 access.
- Input validation.
- rate limiting/abuse controls.
- secret isolation.
- safe error handling.
- audit coverage.
- no sensitive content logging.

### Stage 15 — Full verification
For each subsystem verify success, invalid input, timeout, provider failure, retry, duplicate request, duplicate queue delivery, Telegram delivery failure, insufficient points, subscription restriction, unauthorized access, concurrency, and terminal state.

Final report must distinguish `PASS`, `NOT RUN`, `BLOCKED`, and `FAILED`.

## Stage completion rule

A stage is complete only after implementation, real checks/tests, changed-file inspection, requirement verification, and correction of discovered failures. Compilation alone is not sufficient.
