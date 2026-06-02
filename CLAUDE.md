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

**`refreshUser(user)` is central** — call it on every authenticated request. It (a) auto-downgrades expired Pro plans (`proUntil < now` → `free`), and (b) resets the monthly `cvCount` once `countResetAt` passes. This is how plan expiry and free-tier quota reset happen; there is no cron job.

**Payment model — manual UPI verification (no payment gateway):**
1. User pays out-of-band via a UPI QR / UPI ID shown in the frontend, then submits their transaction UTR via `POST /api/payment/submit` (creates a `pending` Payment; duplicate UTRs are rejected).
2. An admin reviews pending payments in `admin.html` and calls `PATCH /api/admin/payments/:id/approve` or `/reject`.
3. Approval upgrades the user to `pro` and sets `proUntil` to **now + 31 days** for the `pro` plan or **+7 days** for the `single` plan. Pricing: pro = ₹499, single = ₹199.

**Generation endpoints:**
- `POST /api/generate` (auth required) — enforces the free-tier `cvCount` limit, then prompts Claude to return a **raw JSON resume object** (a large fixed schema: summary, experience, education, skills, certifications, projects, languages, coverLetter). The handler strips ``` fences and `JSON.parse`s the response, then increments `cvCount`.
- `POST /api/linkedin` (auth required, **Pro-only**) — rewrites a LinkedIn "About" section.

**Security middleware:** `helmet`, `cors` (origin from `FRONTEND_URL`), and `express-rate-limit` (50 req / 15 min on `/api/`). `trust proxy` is set to 1 for correct client IPs behind Render's proxy.

## Important caveats

- **The `README.md` is outdated.** It describes an earlier, simpler version (IP-based free tier, no accounts, Razorpay). The actual system uses Google accounts + JWT + MongoDB + manual UPI/UTR verification. Trust `server.js` over the README.
- Adding/removing a backend route means touching `server.js` and, usually, wiring a `fetch` call into the relevant `.html` file — there is no shared API client.
