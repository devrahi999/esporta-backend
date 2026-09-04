# Esporta Backend

The dedicated **application / business API layer** for Esporta — a NestJS
(TypeScript) service deployed to Vercel, sitting on top of the existing Supabase
Postgres/Auth/RLS, Cloudflare R2 (images), Cloudflare Stream (video), FCM (push)
and Gmail SMTP (security email).

> Follows `plan.md` (the master implementation plan). See
> [`docs/BACKEND_AUDIT.md`](docs/BACKEND_AUDIT.md) for the audit of the existing
> system and the Feature → Table → RPC → Edge-Function → Module migration map.

## Architecture in one line

```
Flutter ──HTTPS──▶ NestJS (this) ──▶ Supabase / R2 / Stream / FCM / Gmail
```

The backend verifies the Supabase JWT on every request (never trusts a
client-supplied user id), resolves the active profile via `can_act_as`, and
talks to Postgres with a **caller-scoped** client so RLS still applies. The
service-role key is used only for genuinely actor-less work.

## Status (by plan §42 phases)

| Phase | Scope | State |
|-------|-------|-------|
| 1 | Foundation: config, logging, error envelope, health, Supabase | ✅ done |
| 2 | Auth: JWT verify, active-profile context, guards, RLS-aware DB | ✅ done |
| 3 | Profiles, Teams, Posts, Comments, Reactions, Follows, Search, Lookups | ✅ done |
| 4 | Recruitment, Applications, Tryouts, Notifications, Push, Security | ✅ done |
| 5 | R2 image service (presigned upload/complete/delete/replace) | ✅ done |
| 6 | Cloudflare Stream + webhook + video lifecycle | ✅ done |
| 7 | FCM push sender + Gmail SMTP + internal dispatch + account-recovery | ✅ done |
| 8 | Admin APIs (~57 routes over capability-gated admin_* RPCs) | ✅ done |
| 9 | Analytics ingestion (analytics_events + POST /analytics/events) | ✅ done |
| 10 | Flutter migration | ⏳ (Flutter workstream — not this repo) |

## Project layout

```
esporta-backend/
├── api/index.ts            # Vercel serverless entry (imports compiled dist/)
├── src/
│   ├── main.ts             # local server entry
│   ├── bootstrap.ts        # shared app factory (prefix, CORS, validation)
│   ├── app.module.ts
│   ├── config/             # env validation (zod) + typed AppConfigService
│   ├── common/             # errors, envelope, logger, interceptors, filter, guards' helpers
│   ├── supabase/           # dual-client (caller-scoped + service-role) integration
│   ├── auth/               # JWT verification, active-profile guard, /auth/me
│   ├── profiles/ teams/    # identity domain (profile_json/save_profile, create_team, …)
│   ├── posts/ comments/ reactions/ follows/   # social graph + engagement
│   ├── search/ lookups/    # unified search (RPC-ranked) + reference data
│   ├── recruitment/ applications/ tryouts/    # hiring pipeline + state machine
│   ├── notifications/ push/  # in-app inbox + FCM device registration
│   ├── security/           # account security (recovery email, 2-step, sessions, login approval)
│   ├── media/              # R2 image presign + Cloudflare Stream video (providers/r2, providers/stream)
│   ├── email/              # the ONLY Esporta mail sender: SMTP (nodemailer) + templates + email_outbox drain
│   ├── webhooks/           # signed provider callbacks (Cloudflare Stream → media lifecycle)
│   ├── internal/           # DB→backend dispatch (push-dispatch, email-diagnostics), dispatch-secret gated
│   ├── admin/              # capability-gated admin_* RPC surface (core-admin API), AdminGuard
│   ├── analytics/          # POST /analytics/events ingestion → analytics_events
│   └── health/             # /health, /health/db, /health/storage, /health/stream
├── docs/BACKEND_AUDIT.md
├── vercel.json
└── .env.example            # variable NAMES only
```

## Local development

```bash
cp .env.example .env        # fill SUPABASE_URL / ANON / SERVICE_ROLE at minimum
npm install
npm run start:dev           # http://localhost:3000
```

Quick checks:

```bash
curl localhost:3000/health
curl localhost:3000/api/v1/auth/me -H "Authorization: Bearer <supabase-access-token>"
```

## Scripts

- `npm run build` — `nest build` → `dist/` (tsc; emits decorator metadata).
- `npm run typecheck` — `tsc --noEmit` over `src/`.
- `npm run start` / `start:dev` — local server.
- `npm test` — Jest unit tests.

## Deployment (Vercel)

Set the Vercel project **Root Directory** to `esporta-backend/`. `vercel.json`
runs `npm run build` and rewrites all routes to the `api/index.ts` function,
which serves the compiled Nest app. Configure every secret from `.env.example`
as a Project Environment Variable (`SUPABASE_SERVICE_ROLE_KEY` and provider keys
are server-side only — never shipped to Flutter).

## API conventions

- Prefix: `/api/v1` (health at `/health`).
- Envelope (§30): `{ success, data, error: { code, message }, meta }`.
- `error.code` values are a contract (see `src/common/errors/error-codes.ts`).
- Requests may send `X-Active-Profile-Id`; the server validates it.
- Every response carries an `x-request-id` header echoed in `meta.requestId`.
