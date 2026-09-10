# Social Scales — Dashboard

The product frontend for **Social Scales Marketing Agency**: an AI-powered social media
operating system that turns business context into strategy, content, scheduling,
publishing and learning.

This is a **standalone frontend**. It runs today with no backend, reading from a typed
mock adapter, and is deliberately built so the real SMMA backend can be plugged in by
swapping one adapter implementation. See [INTEGRATION.md](./INTEGRATION.md).

---

## Run it locally

```bash
npm install
npm run dev
```

Open <http://localhost:3000>.

`/` redirects to `/dashboard` when onboarding is complete, otherwise to `/onboarding`.

### Optional environment

The app defaults to mock data with no configuration. To point it at a real backend:

```bash
cp .env.example .env.local
```

```ini
SOCIAL_SCALES_DATA_MODE=mock          # or: http
# NEXT_PUBLIC_SOCIAL_SCALES_API_URL=http://localhost:4000
# SOCIAL_SCALES_API_TOKEN=
```

Changing the mode requires a dev-server restart, not a code change.

---

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Development server with hot reload |
| `npm run build` | Production build (runs TypeScript as part of the build) |
| `npm start` | Serve the production build |
| `npm run lint` | ESLint (`eslint-config-next` + React Compiler rules) |
| `npx tsc --noEmit` | Typecheck on its own |

---

## Routes

| Route | Purpose |
| --- | --- |
| `/onboarding` | Six-step business setup: Business, Goals, Audience, Brand Voice, Platforms, First Strategy |
| `/dashboard` | What the system is doing, what is blocked on you, what publishes next, what it learned |
| `/clients` | Every brand running on the system, with plan state and pending approvals |
| `/plan` | Active weekly plan: objective, pillars, briefs, adherence, history |
| `/studio` | Flagship workspace: ideas → script → assets → 9:16 preview → approve/schedule |
| `/content` | The operating queue, filterable by lifecycle stage, client and platform |
| `/calendar` | Week and month scheduling views, scheduled queue, best posting times |
| `/analytics` | Measured performance plus the learning loop feeding the next plan |
| `/integrations` | Platform connection state and the video-generation seam |
| `/settings` | Workspace, brand, content defaults, approval rules, notifications, data source |

---

## Architecture in one picture

```
React components  (never touch a database, a queue, or a provider SDK)
        │
        ▼
Server components / server actions        src/app/**
        │
        ▼
SocialScalesAdapter  ── the only seam ──  src/lib/social-scales/adapter.ts
        │
        ├── MockSocialScalesAdapter       src/lib/social-scales/mock-adapter.ts   ← works now
        └── HttpSocialScalesAdapter       src/lib/social-scales/http-adapter.ts   ← integration-ready
```

Key directories:

```
src/
  app/                    routes, layouts, server actions
    (app)/                the authenticated shell (sidebar + topbar + footer)
  components/
    shell/                sidebar, topbar, page hero, logo
    ui/                   the single set of primitives everything composes from
  features/               per-screen composition (dashboard, studio, calendar, …)
  lib/
    social-scales/        contracts, adapter interface, mock + http implementations
    display.ts            enum → visual treatment (status colours, platform chips)
    utils.ts              formatting helpers
  mocks/fixtures.ts       ALL development fixture data, in one file
reference/                the four concept images this UI was built from
```

---

## About the data on screen

Everything is **development fixture data**. It is invented: no real client, campaign or
marketing result is represented. Screens that show measured numbers carry a visible
**Demo dataset** badge, and learning insights are phrased as observations about that
dataset rather than as customer evidence.

Fixtures are anchored to a fixed date (Thursday 10 September 2026) so renders are
deterministic and never produce hydration mismatches.

---

## What is intentionally not here

This frontend does not implement, and does not pretend to implement:

- real OAuth to TikTok / Instagram / YouTube / LinkedIn / X
- real video rendering or media storage
- authentication and sessions
- a database

Controls that depend on those are visibly disabled and say why (for example
*"Post now — no platform connected"*, *"Upload — backend only"*). Nothing in the UI
looks functional while doing nothing.
