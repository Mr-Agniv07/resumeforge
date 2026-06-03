# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Layout

The git root is `resumeforge-fullstack/`, but the entire application lives in the `resumeforge/` subdirectory:

- `resumeforge/backend/` — Express API, single-file server in `server.js` (~410 lines, all routes/schemas/middleware live here).
- `resumeforge/frontend/` — two standalone static pages, **no build step, no framework, no bundler**:
  - `index.html` — the end-user app (Google sign-in, resume generation, UPI payment flow).
  - `admin.html` — the admin panel (review/approve payments, manage users).

## Commands

All backend commands run from `resumeforge/backend/`:

```bash
npm install
npm run dev      # nodemon (auto-reload) — use this while developing
npm start        # node server.js (production)
```

Frontend: open the `.html` files directly in a browser. There is nothing to build or compile.

There are **no tests and no linter** configured.

## Local development gotcha

Both frontend files **hardcode the backend URL to production** at the top of their inline `<script>`:

```js
const BACKEND = "https://resumeforge-hun8.onrender.com";
```

To run against a local backend you must edit this to `http://localhost:3001` in `index.html` (line ~415) and `admin.html` (line ~189). Likewise `GOOGLE_ID` (`index.html` ~416), `UPI_ID`/`UPI_NAME` (~417), and the admin key are client-side constants/prompts, not env-driven.

## Configuration

Backend config is entirely env-driven via `resumeforge/backend/.env` (copy from `.env.example`). Required keys: `ANTHROPIC_API_KEY`, `MONGO_URI`, `GOOGLE_CLIENT_ID`, `JWT_SECRET`, `ADMIN_SECRET`. Also `FRONTEND_URL` (CORS origin), `PORT` (default 3001), `FREE_MONTHLY_LIMIT` (default 2). `MAIL_USER`/`MAIL_PASS`/`RESEND_API_KEY` exist in `.env` and `nodemailer`/`resend` are installed, but **email is not yet wired into `server.js`**.

Note: the root `.gitignore` ignores `README.md`, `node_modules/`, and `.env`.

## Architecture

**Stack:** Express + Mongoose (MongoDB) on the backend; vanilla HTML/CSS/JS frontend; Anthropic SDK (`claude-sonnet-4-6`) for generation.

**Two Mongoose models** (defined inline in `server.js`): `User` and `Payment`.

**Authentication flow:**
1. Frontend uses Google Identity Services (GSI) to get a Google ID token.
2. `POST /api/auth/google` verifies that token with `google-auth-library`, finds-or-creates the `User`, and returns a 30-day app JWT.
3. All user-facing protected routes use `requireAuth`, which expects `Authorization: Bearer <jwt>`.

**Admin auth is separate:** `requireAdmin` checks the `x-admin-key` request header against `ADMIN_SECRET`. There is no admin login/session — the key is entered in the admin UI and sent on every request.

**`refreshUser(user)` is central** — call it on every authenticated request. It (a) auto-downgrades expired *time-limited* Pro plans (`proUntil < now` → `free`; lifetime Pro keeps `proUntil = null` and never expires), and (b) resets the monthly `cvCount` once `countResetAt` passes. There is no cron job.

**Pricing model — credits + lifetime Pro (the `PLANS` catalogue in `server.js` is the source of truth):**
- `single` ₹15 → +1 credit · `pack10` ₹59 → +10 credits · `pro` ₹499 → lifetime unlimited.
- `User.credits` are paid one-off generations that never expire. `User.signedIn` is true only after Google auth. `User.premiumTemplates` (granted by `pack10`/`pro`, not `single`) unlocks the CV template picker; the frontend exposes it as `templates` in the user payload and toggles between `tpl-modern`/`tpl-classic`/`tpl-slate` classes on `#cv-wrap` (pure CSS, same DOM).
- **Two free-tier tracks:** (1) signed-in users get `FREE_MONTHLY_LIMIT` free CVs/month tracked on `User.cvCount`; (2) anonymous (no-account) visitors get the same limit tracked per-browser on the `AnonSession` model, keyed by a localStorage UUID (`rf_anon_id`, sent as `anonId`). A per-IP backstop (`ANON_IP_LIMIT`, default 6) on `AnonSession` limits localStorage-clearing abuse without blocking shared networks. Anonymous *purchasers* still get zero free beyond this — only their credits.

**Payment flow — manual UPI verification (no gateway):**
1. User pays out-of-band via UPI QR/ID, submits UTR via `POST /api/payment/submit` (creates a `pending` Payment; duplicate UTRs rejected). The route flags the payment `anonymous` when no valid JWT is sent.
2. Admin reviews in `admin.html` → `PATCH /api/admin/payments/:id/approve` or `/reject`.
3. Approval either sets the user to lifetime `pro` (`proUntil = null`) or adds `credits`, based on `PLANS[payment.plan]`.

**Anonymous single-CV flow (no Google sign-in):** user pays ₹15 → after approval calls `POST /api/auth/claim` with `{ email, utr }`, which verifies an approved payment and issues a JWT. From then on generation works identically to a signed-in user, just charged against credits.

**Generation endpoints:**
- `POST /api/generate` (auth required) — picks the allowance in order **Pro (unlimited) → free monthly (signed-in only) → credits**, returns `402` if none, then prompts Claude for a **raw JSON resume object** (large fixed schema). Strips ``` fences, `JSON.parse`s, increments `cvCount`, and decrements `credits` when a credit was used. The request's `field` selects a `PROFESSIONS` entry (engineering/medical/legal/teaching/finance/business/design/sales/general) whose `guidance` + suggested `sections` are injected into the prompt to specialize the resume. The schema includes an optional `extraSections: [{ heading, items[] }]` the model fills with field-specific blocks (licenses, bar admissions, publications, portfolio, etc.), rendered in the CV's main column. The frontend separately maps `field` to the skills-section heading and to profession-aware input placeholders (`applyFieldHints`).
- `POST /api/linkedin` (auth required, **Pro-only**) — rewrites a LinkedIn "About" section.

**Security middleware:** `helmet`, `cors` (origin from `FRONTEND_URL`), and `express-rate-limit` (50 req / 15 min on `/api/`). `trust proxy` is set to 1 for correct client IPs behind Render's proxy.

## Important caveats

- **The `README.md` is outdated.** It describes an earlier, simpler version (IP-based free tier, no accounts, Razorpay). The actual system uses Google accounts + JWT + MongoDB + manual UPI/UTR verification. Trust `server.js` over the README.
- Adding/removing a backend route means touching `server.js` and, usually, wiring a `fetch` call into the relevant `.html` file — there is no shared API client.
