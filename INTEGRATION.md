# Integration guide

> **Status: integrated.** Option B below is done. The dashboard now runs inside
> the backend's own Next.js app and reads this database directly through
> `PrismaSocialScalesAdapter` — no HTTP hop, no second deployment, and no React
> component was changed to get there. The rest of this document is kept because
> it is still the contract: it describes the seam the adapter implements, and
> what a *different* backend would have to provide.

How to connect this frontend to a Social Scales SMMA backend, and what the
backend has to provide.

The short version, for a standalone deployment: **implement the endpoints listed
below, set two environment variables, restart.** No React component changes.

---

## 1. The boundary

```
React component
      │  receives an already-shaped view model, never raw records
      ▼
Server component  (page.tsx)          or   Server action  (src/app/actions.ts)
      │  calls getAdapter()
      ▼
SocialScalesAdapter                        src/lib/social-scales/adapter.ts
      │
      ├── MockSocialScalesAdapter           mock-adapter.ts   fixtures, works offline
      ├── HttpSocialScalesAdapter           http-adapter.ts   a separate backend
      └── PrismaSocialScalesAdapter         prisma-adapter.ts ← in use here
```

Rules that keep this seam intact:

1. **No component imports a concrete adapter.** Only `getAdapter()` from
   `src/lib/social-scales/index.ts`, and only from a server component or server action.
2. **No component imports `src/mocks/`.** Fixtures reach the UI through the mock adapter
   and nowhere else.
3. **The UI vocabulary is `contracts.ts`.** No Prisma models, job payloads, provider SDK
   types or HTTP shapes cross this line. The backend maps *into* these types.
4. **Writes go through server actions** (`src/app/actions.ts`), which return a
   discriminated `ActionResult<T>` so failures render as messages rather than crashes.

---

## 2. Switching to the real backend

```ini
# .env.local

# The default in this repository. Reads this app's own Postgres directly.
SOCIAL_SCALES_DATA_MODE=prisma

# Or, for UI work with no database:
# SOCIAL_SCALES_DATA_MODE=mock

# Or, to point at a separate backend over HTTP:
# SOCIAL_SCALES_DATA_MODE=http
# NEXT_PUBLIC_SOCIAL_SCALES_API_URL=https://api.your-smma-backend.example
# SOCIAL_SCALES_API_TOKEN=<optional bearer token>
```

`resolveDataMode()` in `src/lib/social-scales/index.ts` reads these. `prisma` is
the default now that the UI lives inside the backend.

`HttpSocialScalesAdapter` already implements the full interface: real `fetch` plumbing,
typed errors, and Zod validation on the responses that have schemas. Every method knows
its endpoint. What is missing is the server on the other end.

---

## 3. Endpoints the backend must expose

All responses are JSON and must match the corresponding type in
`src/lib/social-scales/contracts.ts`.

### Workspace and onboarding

| Method | Path | Returns |
| --- | --- | --- |
| GET | `/api/workspace` | `Workspace` |
| GET | `/api/onboarding` | `OnboardingState` |
| PATCH | `/api/onboarding/draft` | `OnboardingState` |
| POST | `/api/onboarding/complete` | `{ planId: string }` |

### Dashboard and clients

| Method | Path | Returns |
| --- | --- | --- |
| GET | `/api/dashboard` | `DashboardView` |
| GET | `/api/clients` | `Client[]` |
| GET | `/api/clients/:id` | `Client \| null` |

`DashboardView` is a composed read model — it is cheaper for the backend to assemble it
once than for the UI to make eight calls. It carries the active plan summary, pipeline
counts, approvals, upcoming posts, activity, insights, headline metrics, one series and
the week-at-a-glance grid.

### Plan

| Method | Path | Returns |
| --- | --- | --- |
| GET | `/api/plan?clientId=` | `ContentPlan \| null` |
| GET | `/api/plan/history?clientId=` | `PlanHistoryEntry[]` |
| POST | `/api/plan` | `ContentPlan` |
| POST | `/api/plan/:planId/approve` | `ContentPlan` |

### Content queue

| Method | Path | Returns |
| --- | --- | --- |
| GET | `/api/content?status=&clientId=&platform=&search=` | `ContentQueueView` |
| GET | `/api/content/:id` | `ContentItem \| null` (Zod-validated) |
| PATCH | `/api/content/:id/script` | `ScriptDraft` |
| POST | `/api/content/:id/script/rewrite` | `ScriptDraft` |
| POST | `/api/content/:id/approve` | `ContentItem` (Zod-validated) |
| POST | `/api/content/:id/schedule` | `ContentItem` (Zod-validated) |

`ContentQueueView.counts` must be the counts for the **whole** queue, not the filtered
page — the tab badges depend on it.

### Studio and ideas

| Method | Path | Returns |
| --- | --- | --- |
| GET | `/api/studio?contentItemId=` | `StudioView` |
| GET | `/api/ideas?clientId=` | `ContentIdea[]` |
| POST | `/api/ideas` | `ContentIdea` |
| POST | `/api/ideas/generate` | `ContentIdea[]` |

### Calendar, analytics, integrations

| Method | Path | Returns |
| --- | --- | --- |
| GET | `/api/calendar?start=&mode=&clientId=&platform=` | `CalendarView` |
| GET | `/api/analytics?period=&clientId=&platform=` | `AnalyticsSummary` |
| GET | `/api/insights` | `LearningInsight[]` |
| GET | `/api/integrations` | `IntegrationProvider[]` |

`start` is **optional**. When absent the backend decides what "now" means and returns
`rangeStart` / `rangeEnd` accordingly; the UI paginates from the `rangeStart` it gets
back, so it never has to guess a timezone.

---

## 4. Generation — the video pipeline seam

This is where a render service (AAMP or anything else) attaches. The UI already models
the whole job lifecycle; it just has nothing producing one.

| Method | Path | Returns |
| --- | --- | --- |
| POST | `/api/content/:id/generate` | `GenerationJob` (Zod-validated) |
| GET | `/api/generation-jobs/:generationJobId` | `GenerationJob \| null` (Zod-validated) |

```ts
interface GenerationJob {
  generationJobId: string;
  contentItemId: string;
  status: "QUEUED" | "PLANNING" | "GENERATING" | "RENDERING" | "QA" | "READY" | "FAILED";
  progress: number;          // 0-100
  previewUrl: string | null;
  finalVideoUrl: string | null;
  thumbnailUrl: string | null;
  qaStatus: "PENDING" | "PASSED" | "FLAGGED" | "FAILED";
  failureReason: string | null;
  createdAt: string;
  completedAt: string | null;
}
```

```
QUEUED → PLANNING → GENERATING → RENDERING → QA → READY
                                              └──→ FAILED
```

The UI never learns which provider produced the file. Swapping render backends is a
backend concern and requires no frontend change.

**Still to build when the pipeline lands:** the Studio currently shows job status but
does not poll. Add polling (or a stream) against `getGenerationJob` and render
`previewUrl` / `finalVideoUrl` in the preview panel once they are non-null.

---

## 5. Merging into the main SMMA repository — **done**

The frontend was built to be lifted, not rewritten. It has been. What follows is
the record of how, and what it would take to do it again elsewhere.

**Option A — keep it standalone.** Point `NEXT_PUBLIC_SOCIAL_SCALES_API_URL` at the
backend and deploy the two separately. Nothing else changes.

**Option B — fold it into the backend's Next.js app.** This is what was done.

How the two surfaces share one app:

| Concern | Resolution |
| --- | --- |
| Routes | Dashboard keeps `src/app/(app)/` and owns `/`. The backend's operator console moved to `src/app/(ops)/ops/` and owns `/ops/*`. Route groups mean each keeps its own layout, and no URL collides. |
| Design tokens | One `@theme` block holds the dashboard palette. The console's six conflicting token values are redefined on a `.ops-theme` wrapper. Tailwind v4 utilities compile to `var(--color-*)`, so `bg-surface` resolves per-tree without either side renaming a class. |
| `primitives.tsx` | Both defined `Card`, `Badge`, `EmptyState` and `Divider` differently. The dashboard keeps `components/ui/primitives.tsx`; the console's moved to `components/ui/ops-primitives.tsx`. |
| `lib/utils.ts` | Merged. Only `cn` overlapped and the implementations were identical; the two sets of formatters are kept side by side because they round differently on purpose. |
| Root layout | Dashboard branding and the Inter font, plus the console's `sonner` toast host, which its server actions report through. |
| Auth | The backend's proxy already gated every path but `/login`, so the dashboard inherited real sessions — the "Authentication and sessions → host app" gap in §7 is closed. |
| `package.json` | One manifest. `recharts` added, `lucide-react` floor raised. Every other dependency already matched exactly. |

The payoff was as designed: **the UI already spoke a vocabulary the backend
could satisfy, so integration was one new file** —
`src/lib/social-scales/prisma-adapter.ts` — plus mechanical route and token work.
No React component was modified.

`src/mocks/` and `mock-adapter.ts` are deliberately kept: `SOCIAL_SCALES_DATA_MODE=mock`
still runs the whole UI with no database, which is useful for frontend work.

---

## 6. Contract drift

`HttpSocialScalesAdapter` validates the responses that carry Zod schemas
(`ContentItem`, `ScheduledPost`, `GenerationJob`) and throws
`AdapterError("INVALID_RESPONSE")` when the backend disagrees with the frontend. That
surfaces as a readable error panel rather than a screen of `undefined`.

Extend `responseSchemas` in `contracts.ts` to cover more payloads as the backend
stabilises. Error codes available: `NOT_CONFIGURED`, `NOT_FOUND`, `UNAUTHORIZED`,
`UPSTREAM_ERROR`, `INVALID_RESPONSE`.

---

## 7. Known gaps

Things a real deployment must add. None of them require restructuring the UI.

| Gap | Where it lands |
| --- | --- |
| ~~Authentication and sessions~~ | **Closed.** The host app's proxy gates every path but `/login`; the dashboard runs behind a real session |
| Real OAuth for social platforms | Backend; `/integrations` renders whatever status the adapter reports |
| Generation-job polling / streaming | Studio — see section 4. `generateContent` now queues a real FFmpeg render and `getGenerationJob` reports its true stage, but the Studio still does not poll |
| ~~Media upload and asset storage~~ | **Closed in the backend.** Upload, validation, probing and storage exist at `/ops/content`; the Studio tile is still disabled and still says so |
| Immediate publish ("Post now") | Backend; the button is disabled and explains why |
| Calendar drag-and-drop | Not implemented — rescheduling is done through the Studio publish slot |
| Content queue pagination | The queue renders everything the adapter returns; add paging when volumes grow |
| Multi-workspace switching | The topbar switcher changes local UI state only; wire it to a real workspace scope |
| Settings persistence | Content/approval/notification preferences persist to `localStorage` only |
| Server-side search | The topbar search routes to `/content?search=`, which the adapter filters |

---

## 8. Verification performed on this build

| Gate | Result |
| --- | --- |
| `npx tsc --noEmit` | 0 errors |
| `npm run lint` | 0 problems |
| `npm run build` | Succeeded, 12 routes |
| All routes served | 200 (`/` → 307 redirect, unknown → 404) |
| Browser console | No errors on any route |
| Mobile (390px) | No horizontal overflow on any route |
| Interactive flows | Script rewrite, idea generation, video-job queue, approve (Studio and drawer), calendar week/month navigation — all verified against the running app |
