# Decisions

Non-obvious choices, why they were made, and what they cost. Newest last.

---

## 2026-09-10 · Single Next app with a server layer, not a monorepo

**Context.** The brief asks for clear separation between UI, database, jobs,
platform adapters, analytics, the recommendation engine, browser automation, AI
services and storage.

**Decision.** One Next.js app with a strict `src/server/*` module layout, plus a
separate worker entry point that imports the same modules.

**Alternatives.** A pnpm workspace with one package per concern.

**Rationale.** The separation the brief cares about is a *dependency* boundary,
and module structure enforces that just as well as package boundaries at this
size. A workspace would have added install complexity and Windows path friction
for no boundary that is not already enforced.

**Consequences.** Nothing stops an import from crossing a layer except review.
If the worker is ever deployed separately from the web app, this becomes a real
split rather than a directory move.

---

## 2026-09-10 · Hand-rolled auth instead of a library

**Decision.** Opaque session tokens in Postgres, scrypt password hashing from
`node:crypto`, an HMAC-signed `httpOnly` cookie.

**Alternatives.** Auth.js v5.

**Rationale.** The requirement is one operator account. Auth.js at the time of
writing is a fast-moving beta whose API is past the point where its behaviour can
be assumed; misconfiguring it is a more realistic risk than getting an opaque
token wrong. scrypt avoids a native build step for argon2/bcrypt on Windows.

**Consequences.** No OAuth providers without real work. If SSO is ever needed,
this is the thing to replace.

---

## 2026-09-10 · scrypt with an explicit `maxmem`

**Context.** N=2¹⁵, r=8 requires 128·N·r = exactly 32 MiB, which is precisely
Node's default `maxmem` ceiling — so it fails.

**Decision.** Raise `maxmem` to 64 MiB rather than lower the work factor.
Verification also accepts a larger ceiling derived from the stored parameters, so
a hash created with stronger settings still verifies.

---

## 2026-09-10 · Pure-JS container probing, no ffmpeg

**Decision.** Parse ISO-BMFF boxes (`mvhd`, `tkhd`, `hdlr`) and PNG/JPEG headers
directly for duration, dimensions, aspect ratio and audio presence.

**Alternatives.** Shell out to ffprobe.

**Rationale.** Zero install burden, and these are exactly the four facts that
decide whether a platform will accept a file. Values are read from the bytes, so
they are real rather than assumed.

**Consequences.** WebM duration is not available and is reported as `null`
instead of a guess. Anything beyond these four facts needs a real decoder.

---

## 2026-09-10 · Charts hand-drawn as inline SVG

**Decision.** Drop Recharts; render the area chart, diverging lift bars and
sparklines as inline SVG in small client components.

**Rationale.** Three chart forms did not justify a charting dependency whose
current major version is past reliable knowledge. Hand-drawing also makes the
data-viz mark specs exact: 2px lines, hairline grid, one axis, direct labels,
4px rounded data-ends, a real crosshair.

**Consequences.** A fourth or fifth chart form would change this calculus.

---

## 2026-09-10 · Colour palette validated, not chosen by eye

**Decision.** Project accents are `#d95926 / #199e70 / #9085e9`, validated with
the data-viz palette validator against this app's actual chart surface
(`#14141a`): lightness band, chroma floor, all-pairs CVD separation (worst ΔE
9.4), normal-vision separation (worst ΔE 24.6) and 3:1 contrast all pass. The
above/below-median diverging pair passes all-pairs at ΔE 25.7.

Status colours sit outside that categorical system and deliberately fail its
checks — so every status badge ships an icon **and** a text label, and colour
never carries meaning alone.

**Consequences.** New project accents must be re-validated, not just picked.

---

## 2026-09-10 · Idempotency is a database constraint

**Decision.** `PublishJob.idempotencyKey` is unique per `PostPlatform`. The
runner refuses any destination already `PUBLISHED`, and claims a job with a
conditional update so a second worker holding the same id does nothing.

**Rationale.** "Never publish twice" is the one guarantee that must not depend on
application discipline or on Redis being healthy.

**Consequences.** Re-publishing deliberately requires creating a new post, which
is the correct friction.

---

## 2026-09-10 · Postgres is truth, Redis is delivery

**Decision.** Every queued job has a row. `sweepDueJobs` reconciles the two every
60 seconds; a missing Redis job is re-added and a stale delayed one is promoted.

**Rationale.** Losing Redis should delay work, never lose it, and never
double-publish it.

**Consequences.** Two places describe the same job. The sweeper is the thing that
keeps them honest and is worth keeping tested.

---

## 2026-09-10 · BullMQ job ids are built by one helper

**Context.** BullMQ rejects a custom job id containing `:` — it uses that as its
own Redis key separator. Interpolated ids like `analyze:${assetId}` therefore
failed at `add()`, and the failure was invisible because the caller had a
fallback path.

**Decision.** All custom ids go through `queueJobId(...parts)`, which joins with
hyphens and strips colons. A unit test asserts the output never contains one.

**Consequences.** None, beyond remembering to use it.

---

## 2026-09-10 · Comparative analytics pin every post to one age window

**Context.** Reading each post at its most mature snapshot is right for display
and wrong for comparison: a 4-day-old post is read at 7d while a 40-day-old post
is read at 30d, so recent posts look systematically worse. Every project appeared
to be declining.

**Decision.** `loadPostFacts({ window })` pins the read to one window and skips
posts that have not reached it. Momentum uses `24h`, the earliest window every
published post attains.

**Consequences.** Momentum ignores posts under a day old, and says so.

---

## 2026-09-10 · The proxy does not bounce signed-in users away from /login

**Context.** The proxy checks the cookie's HMAC only — no database round trip. It
cannot distinguish a live session from a well-formed cookie whose session has
expired, been revoked, or vanished with the database. Redirecting on that check
sent such requests to the console, which redirected them back: an infinite loop
with no way out except clearing cookies.

**Decision.** Public paths always render. The login page performs the
authoritative `getCurrentUser()` check and redirects only on a real session.

**Consequences.** One extra query on the login page, which is not a hot path.

---

## 2026-09-10 · Tests use a separate database, and verify it at runtime

**Context.** The first version pointed tests at a `?schema=contentos_test`
connection string. Prisma's CLI honours that parameter — migrations really did
land in that schema — but the `pg` driver adapter ignores it, so the client
talked to `public`. The suite looked isolated while truncating the development
database on every run.

**Decision.** Tests target a separate **database** (`<db>_test`), created
automatically, which both the CLI and the driver honour. `resetDatabase` asks the
server `select current_database()` and refuses to truncate anything whose name
does not end in `_test`.

**Rationale.** The guard checks what is actually true at runtime rather than what
the configuration claims. That is the check that would have caught the original
bug immediately.

**Consequences.** Slightly slower first run while the database is created.

---

## 2026-09-10 · Trends come from our own history, and say so

**Decision.** No external trend API. The Trends page reports movement in our own
hashtags against our own earlier results, with `source = local-history` on every
row and a header explaining exactly that.

**Alternatives.** Scraping trending pages; shipping plausible-looking fake data.

**Rationale.** Scraping is out of scope by the brief's own rules, and fabricated
trend data would poison the one thing this system is for. Reporting a real, small
signal honestly beats reporting a large invented one.

**Consequences.** The page is less impressive than a competitor's trend feed, and
is not lying.

---

## 2026-09-10 · Accounts seed as DISCONNECTED

**Decision.** The demo seed does not pretend accounts are connected.

**Rationale.** A connected account means a real stored browser session, which
cannot exist without a human signing in. Showing "Connected" would be the first
lie the interface tells, and the whole product rests on its numbers being
trustworthy.

**Consequences.** The Accounts screen looks emptier on first run. Simulated
publishing works regardless, which is the point.

---

## 2026-09-10 · The worker reports its own publishing mode; the console reads that

**Context.** The live/simulation banner read the web process's own
`ENABLE_LIVE_PUBLISHING`. But the *worker* is what publishes, and it is a
separate process with its own environment. Running the worker live while the web
app was configured for simulation produced a console that said "Simulation mode"
while real publishing was enabled.

**Decision.** The worker upserts a singleton `WorkerStatus` row on start and on
every sweep. `effectivePublishingMode()` prefers a live worker's report over
local configuration, reports which source it used, and flags disagreement.

**Alternatives.** Sharing one env file (does not survive separate deployments);
inferring from queue activity (silent when the queue is empty).

**Rationale.** A safety indicator has to describe reality, not local intent. When
no worker has checked in, the UI says so rather than presenting the web
process's guess as fact.

**Consequences.** One extra table and a 60-second heartbeat. The console now also
tells you when the worker is not running at all, which was previously invisible.

---

## 2026-09-10 · Adapters classify their own failures

**Decision.** Adapters raise `AdapterFailure(message, category, stage)`. The
runner uses that category directly, and only falls back to matching an error
string when an adapter did not classify.

**Rationale.** Only the adapter knows whether "element not found" means the DOM
drifted, the session died, or a checkpoint is showing. Retry policy is driven by
category, so guessing it means retrying things that can never succeed — or worse,
retrying a submission that may already have published.

**Consequences.** Every adapter owes the runner a classified failure. The
simulator does this too, precisely so it behaves like the thing it stands in for.

---

## 2026-09-10 · A disconnected account blocks rather than fails

**Decision.** A live publish against an account that is not CONNECTED, or has no
stored session, sets the job to `BLOCKED` and the destination back to `PENDING` —
consuming no attempt. Reconnecting releases blocked jobs back onto the queue.

**Rationale.** Nothing was attempted, so nothing failed. Burning a retry for an
operator's disconnection would exhaust the budget of a job that is still perfectly
valid, and would surface as a red failure the operator cannot act on beyond
reconnecting anyway.

**Consequences.** `BLOCKED` is a distinct state to reason about, and the sweeper
deliberately leaves it alone.

---

## 2026-09-10 · A dedicated automation profile, plus an encrypted portable copy

**Decision.** Each account gets a persistent Chromium profile under
`storage/browser-profiles/<accountId>`, and the storageState is *also* encrypted
into Postgres. `assertDedicatedProfile` refuses to launch against anything else.

**Alternatives.** storageState alone (loses IndexedDB, service workers and device
storage platforms bind sessions to); a persistent profile alone (not portable, and
plaintext on disk is not a credential store).

**Rationale.** The profile is what makes a session survive in practice; the
encrypted row is what makes it portable and secure. The assertion exists because
deriving the path correctly is not the same as guaranteeing it, and the cost of
being wrong is automating someone's real browser profile.

**Consequences.** Two places hold session state. The profile is treated as a
cache: cold profiles are seeded from the encrypted copy, never the reverse.

---

## 2026-09-10 · A successful click is not proof of publication

**Decision.** `PublishOutcome` carries optional `PublicationEvidence`, populated
only by re-reading the platform's own content list. `verifiedAt` and
`verificationMethod` are recorded on the destination, and the UI shows
"Unconfirmed" when they are absent. A TikTok submit that cannot be confirmed
fails as `PLATFORM_REJECTED`, which is never auto-retried.

**Rationale.** The dangerous failure is a post that published while the system
believes it did not, because the obvious response — retry — duplicates it. Making
verification explicit turns that into a state a human decides about.

**Consequences.** Publishing costs an extra page load. Instagram and YouTube have
no verification implementation yet, so their publications record as unverified —
visibly, rather than by silently assuming success.

---

## 2026-09-10 · The simulator's failure rate is configuration, not a constant

**Context.** The simulator failed a fixed fraction of first attempts,
deterministic per destination id. Ids are random per run, so this was effectively
a coin flip — and made roughly one test run in eight fail for reasons unrelated to
what was being tested.

**Decision.** `SIMULATED_FAILURE_RATE`, defaulting to 0.125 so a demo install
still exercises the retry path. Tests pin it to 0, and the retry-path test pins it
to 1.

**Rationale.** A failure injector nobody can turn off is not a feature, it is
flakiness. Making it explicit also made the retry path testable on purpose rather
than by luck.

---

## 2026-09-10 · One AI boundary, and the deterministic provider is never disguised

**Context.** Phase 2 introduces model interaction. Two things could go wrong
quietly: model calls spreading into routes, components and workers where nothing
records them; and rule-based output being read as model output, which would make
the system look more capable than it is and, worse, make a template look like an
insight.

**Decision.** `runAiOperation` in `src/server/ai/orchestration` is the only place
a model is called. A provider declares `kind` — `DETERMINISTIC` or `LLM` — and
that declaration is written to `AIJob`, carried in `AiProvenance`, and rendered by
`provenanceLabel()`. The deterministic provider's `model` is null and its label
says "no language model was used". Two tests enforce the boundary mechanically by
scanning `src/**` for `@anthropic-ai/sdk` imports and `ANTHROPIC_API_KEY` reads
outside their one permitted file each.

**Alternatives.** Letting each service call the SDK with a shared helper; deriving
"was this a model?" from whether the model field is set.

**Rationale.** A convention that only a reviewer enforces is not a boundary. The
provenance claim has one source — the provider's own declaration — rather than
being re-derived per screen from whatever field happens to be populated.

**Consequences.** Adding an operation means registering a prompt with a schema and
a deterministic implementation, which is more work than a bare SDK call. That is
the intended cost.

---

## 2026-09-10 · Every prompt ships a deterministic implementation

**Context.** There is no `ANTHROPIC_API_KEY` in this environment, and there may
not be one in a given deployment. The obvious options were to block the feature
or to stub it.

**Decision.** `PromptDefinition` requires a `deterministic()` function alongside
`render()` and `schema`. Rule output goes through the *same* schema validation as
model output. In `auto` mode a missing key falls back to rules, and the fallback
is recorded as a real attempt on the job with reason `UNAVAILABLE` rather than
being silent.

**Rationale.** It keeps the whole system exercisable end-to-end without a key,
which makes the AI layer testable at all; and running rules through the same
validation means a rule that drifts out of contract fails visibly instead of
shipping a malformed object a model would be blamed for.

**Consequences.** Two implementations per operation to keep in sync — mitigated by
the shared schema, which fails loudly when they diverge. The deterministic
provider refuses repair attempts: a rule producing invalid output is a bug, and
retrying it would only hide it.

---

## 2026-09-10 · Brand rules are repaired, not discovered in review

**Context.** A schema can express "caption is a string under 2000 characters". It
cannot express "must not contain this brand's banned phrases", because those
depend on the request's own input.

**Decision.** `PromptDefinition.refine(value, input)` returns a list of problems
after schema validation passes, and those problems feed the same repair loop.

**Rationale.** A banned phrase caught here costs one repair round-trip. The same
phrase caught in the approval queue costs a person's attention, and caught after
publication costs more than that.

**Consequences.** A repair costs a real call, and the cost appears in
`AIUsageLog` — attempts are billed individually, so a job that needed two repairs
reports three calls rather than one.

---

## 2026-09-10 · Cost is priced at call time and unknown models are flagged

**Context.** Prices change. A report that recomputes historical spend from
today's price table reports a number that was never true.

**Decision.** `AIUsageLog.costUsd` is computed from the price table at the moment
of the call and never recomputed. A model with no entry in the table prices at
zero with `priced: false`, so the total is reported as a floor rather than a
guess.

**Consequences.** Adding a model means adding its prices, or its usage silently
contributes nothing to the bill — which the `priced` flag is there to surface.

---

## 2026-09-10 · A strategy may only cite evidence that exists

**Context.** The most damaging thing a strategy layer can do is produce a
confident plan with fabricated support. It reads exactly like a well-founded one,
and there is no way to tell them apart after the fact.

**Decision.** `buildStrategyContext` publishes `citableEvidenceIds`, and the
`strategy-draft` prompt's `refine` rejects any `basedOn` id that is not in it. The
same check rejects audiences, objectives, pillars and formats this brand does not
have. An invented citation is a validation failure that goes through the repair
loop, and a strategy that cannot be repaired is never written.

**Alternatives.** Filtering unknown ids out silently; letting the strategy carry
free-text justifications instead of ids.

**Rationale.** Silent filtering turns a fabrication into a strategy with slightly
less support, which is worse than a failure because nobody learns that it
happened. Free-text justification cannot be checked at all.

**Consequences.** `StrategyEvidence` rows can never dangle. The engine also links
the options the strategy *chose* — not only the ones it remembered to cite —
because picking "problem_solution" hooks rests on that option's evidence either
way.

---

## 2026-09-10 · Strategy confidence is capped by the account, not by the argument

**Context.** A coherent argument built entirely from shipped priors reads as
confident. Nothing in the text distinguishes it from one built on two hundred
posts of this brand's own results.

**Decision.** `confidenceCeiling(context)` caps confidence from the account's
state alone: LOW while the account is cold or while every analytics number on
file is simulated; MEDIUM from four account observations; HIGH only with an
experiment and twelve observations. A draft claiming more is rejected with the
reason.

**Rationale.** Confidence is a claim about evidence, so evidence is what should
set it. Letting a generator assert its own confidence puts the one number an
operator will act on entirely inside the thing being checked.

**Consequences.** Every strategy this system can produce today is LOW confidence,
because nothing has been published for real. That is the correct answer, and it
will change on its own as real results arrive.

---

## 2026-09-10 · Strategy versions are immutable

**Context.** Strategy changes as evidence arrives. The tempting shape is one
mutable row per project.

**Decision.** `StrategyVersion` is append-only. A new version is created, the
previous ACTIVE one becomes SUPERSEDED with `supersededById` pointing forward,
and each version stores `accountState` — a snapshot of what the account looked
like when it was written.

**Rationale.** The question worth answering later is "what did we believe then,
and on what?", and a mutable row destroys the only copy of that answer. The
snapshot matters because re-deriving the basis from today's data would show a
picture the strategy was never written from.

**Consequences.** More rows, and a history screen to read them. Activation is a
transaction so two concurrent activations cannot both end ACTIVE.

---

## 2026-09-10 · A plan implements exactly one strategy version

**Context.** Strategies are versioned and superseded. A plan built while v1 was
active, read after v3 exists, would otherwise appear to implement v3 — and its
briefs would look like they were derived from decisions nobody had made yet.

**Decision.** `ContentPlan.strategyVersionId` is a required FK with
`onDelete: Restrict`, set once when the plan is created. A later strategy never
becomes an existing plan's strategy.

**Rationale.** The plan is the record of what was asked for, on the basis that
existed then. Re-pointing it at a newer strategy would make the record lie in the
most convincing possible way.

**Consequences.** Replanning after a strategy change is an explicit act, and the
old plan stays readable next to the strategy it actually came from.

---

## 2026-09-10 · A brief must say what happens, not restate the strategy

**Context.** The obvious failure mode of a planning layer is a plan made of
strategy paraphrase: forty rows saying "numeric hook, screen recording, proof
pillar". It looks like a plan and cannot be produced from.

**Decision.** `angle` has a 20-character floor and `refine` rejects a brief whose
angle normalises to its own `strategyBasis`. The deterministic implementation,
which genuinely can only rotate the strategy's choices, says so in the brief text
and in the plan's `gaps` rather than pretending otherwise.

**Rationale.** A rule-based planner cannot invent a specific idea, and dressing a
rotation up as one would be exactly the kind of quiet overclaim the rest of this
system is built to avoid. Saying "this is a rotation slot; a person supplies what
is on screen" is more useful than a fabricated angle.

**Consequences.** With no API key the plan is a scaffold with honest labels
rather than a finished creative brief. That is the true state of things.

---

## 2026-09-10 · Placeholder posting times are labelled, not recommended

**Context.** Every brief needs a time. The system does not know a good time to
post for any of these accounts, because nothing has been published for real.

**Decision.** `planSlots()` uses the project's own schedule slots where they
exist. Where they do not, it spreads evenly at a fixed neutral hour, and
`ContentPlan.rationale.cadenceSource` records which of the two was used.

**Alternatives.** Shipping a "best times to post" table from general knowledge.

**Rationale.** A per-platform best-time table would be a global prior wearing the
costume of an account-specific recommendation — the exact conflation the evidence
model exists to prevent. An obvious placeholder invites the operator to set a real
time; a confident wrong one does not.

---

## 2026-09-10 · Skipped briefs are kept, with the reason

**Context.** Plans are not fully executed. The tempting cleanup is to delete what
was not made.

**Decision.** `BriefStatus.SKIPPED` with a required `skipReason` — the server
action refuses an empty one. `planAdherence()` reports planned mix against
delivered mix, where delivered counts only briefs a post was actually made from.

**Rationale.** "We planned six screen recordings and made one, because nobody had
the footage" is a finding about the operation. Deleting the five destroys it, and
counting them as delivered would be worse.

---

## 2026-09-10 · Analysis stores its basis and its unknowns, not just its answers

**Context.** The analysis path reads a filename and container facts. It has not
seen or heard the media. Storing `topic: "CSV imports"` next to nothing else
makes a filename guess indistinguishable from knowledge.

**Decision.** `AIAnalysis` gained `confidence`, `basis[]` and `unknowns[]`, and
the `asset-analysis` schema requires at least one item in `basis`. `transcript`
is null rather than empty — nothing in this path has heard the audio.
`AIAnalysis.model` became nullable, because a deterministic provider has no
model and writing the provider name there would be a small lie.

**Rationale.** The spec's rule is that unsupported guesses must not be stored as
fact. The enforceable version of that is requiring every conclusion to arrive
with what it rests on, and requiring what could not be determined to be named
rather than filled in plausibly.

**Consequences.** The asset screen shows both lists and a confidence badge, so an
operator can see that a topic came from the filename before acting on it.

---

## 2026-09-10 · Copy scoring stays rule-based

**Context.** Analysis and copy generation now go through `runAiOperation`. The
obvious next step is to route the scorecard through it too.

**Decision.** It stays on `heuristicProvider.scoreCopy`. The scorecard is a set
of writing heuristics — hook, clarity, curiosity, CTA, trend relevance — and the
UI labels it as such.

**Rationale.** Asking a model to score its own copy produces a number that reads
like a prediction of performance and is not one. Performance claims belong to the
learning engine and only from this account's own evidence. Keeping the scorecard
deterministic keeps that boundary obvious rather than a matter of wording.

---

## 2026-09-10 · An asset claims a brief; nothing is matched automatically

**Context.** With briefs and assets both present, matching them by pillar,
format and date would work most of the time.

**Decision.** `ContentAsset.briefId` is set only by `attachAssetToBrief`, which
someone calls. Attaching moves the brief to IN_PRODUCTION, analysing the asset
moves it to READY, and creating a post from it marks it FULFILLED with the post
id. Re-attaching another asset never walks a fulfilled brief backwards.

**Rationale.** "Most of the time" is the problem. A wrong automatic match gives a
confident and false answer to "why did we post this?", which is worse than the
honest "this asset is not linked to a brief" — and an unlinked asset still
publishes fine.

**Consequences.** Traceability is opt-in per asset. The asset screen offers the
open briefs in a dropdown, and says plainly what is lost by leaving it unlinked.

---

## 2026-09-10 · The key-message claim is checked against the beats

**Context.** A brief commissions a piece to say a particular thing. A treatment
that does not say it is a different piece wearing the brief's name — and the
treatment itself is the only thing that knows.

**Decision.** `creative-treatment` output carries `deliversKeyMessage` plus a
one-line note, and `refine` checks the claim against what was actually written:
if fewer than half the key message's content words appear anywhere in the beats'
shots, on-screen text or voiceover, a `true` is rejected. The deterministic
implementation makes it true by construction — the middle beat speaks the key
message verbatim — rather than asserting it.

**Alternatives.** Trusting the flag; requiring delivery and rejecting anything
else.

**Rationale.** An unchecked self-report is worth nothing, and the bar is
deliberately low — half the content words catches a treatment about something
else entirely, not a paraphrase. Requiring delivery would be worse than trusting
the flag: a treatment that misses the message is sometimes the better piece of
content, and that is an editorial call. `offBriefVariants()` surfaces those
rather than blocking them; what is unacceptable is it happening unnoticed.

**Consequences.** An honest `false` is accepted and badged "Off brief" on the
variant card, with the note explaining what is missing.

---

## 2026-09-10 · Null is silence; an empty string is a mistake

**Context.** A beat with no voiceover and a beat with an empty voiceover are
indistinguishable downstream, and generators reach for `""` readily.

**Decision.** `refine` rejects a whitespace-only `voiceover` or `onScreenText`
with the instruction to use `null`.

**Rationale.** A renderer, an accessibility pass and a duration estimate all need
to tell "deliberately silent" from "nobody filled this in". The distinction costs
one validation rule now and is unrecoverable later.

---

## 2026-09-10 · Rendering is two ffmpeg passes, not one filter graph

**Context.** A cut of N clips can be expressed as a single `filter_complex` with
per-clip trim, scale, pad, drawtext and a concat at the end. It is one process
and marginally faster.

**Decision.** Two stages instead. Stage one writes a normalised intermediate per
clip; stage two concatenates them, mixes audio and encodes once.

**Alternatives.** The single graph; ffmpeg's `concat` filter rather than the
demuxer.

**Rationale.** The failure modes this has to report precisely are per-clip ones —
a source that will not decode, a trim past the end, a font that will not load. In
one graph they all surface as the same "Error while filtering" and the operator
learns nothing. In two stages the failure names the clip, and the intermediates
are still on disk to look at.

**Consequences.** More temp files and a second encode of the audio. The
intermediates are all forced to identical geometry, frame rate, sample rate and
channel layout, which is what makes the concat demuxer safe — and sources with no
audio get generated silence so the stream count never changes mid-timeline.

---

## 2026-09-10 · The output path is derived from the request, not assigned

**Context.** A worker killed mid-render must not produce a second file on retry,
and must not leave a half-written one that looks finished.

**Decision.** `RenderJob.idempotencyKey` is a hash of the variant and the resolved
EDL, and the output key is `renders/<projectId>/<key>.mp4`. The renderer writes to
a scratch directory, probes the result, and only then moves it to that key. The
`ContentAsset` row is written last.

**Rationale.** Each ordering choice covers a specific crash point. Probing before
the move means a broken encode never lands at the real key. Writing the asset row
last means a crash between the move and the row leaves a *complete, correct* file
exactly where the next attempt expects one — which `adoptExistingOutput()` then
reuses rather than spending minutes reproducing identical bytes.

**Consequences.** Re-rendering the same cut is free. Changing anything about the
cut changes the key, so it is genuinely a different render with its own file.

---

## 2026-09-10 · A rendered cut is an ordinary ContentAsset

**Context.** The output needs to be approved, scheduled and published. All three
already work, on assets.

**Decision.** The render output is a `ContentAsset` with `origin: RENDER`. No new
path through approval, scheduling, the composer, the media route or the TikTok
publisher.

**Rationale.** The alternative — a separate "rendered output" entity with its own
publishing path — would duplicate the most safety-critical code in the system for
no gain. `origin` is enough to tell a cut from an upload wherever that matters,
and the EDL builder uses it to make sure a previous render is never treated as
raw footage for the next one.

**Consequences.** The Phase 2 publishing subsystem is untouched by Phase 7. A
rendered cut appears in the content library alongside its sources.

---

## 2026-09-10 · ffmpeg's exit code is not proof of a usable file

**Context.** A broken filter chain can exit zero having written a valid but empty
container, and a mis-specified scale produces a perfectly valid file of the wrong
shape that fails later, at upload, with a worse error.

**Decision.** `verifyOutputProbe()` runs ffprobe on the result and requires: a
non-empty MP4 container, a video stream, H.264, exactly the specified dimensions,
portrait orientation, a non-zero duration, and a runtime within half of what the
EDL asked for. Anything else is `OUTPUT_INVALID` and no asset row is written.

**Rationale.** The duration check is the one that earns its place: a cut that
comes out a third of its planned length means clips were silently dropped, which
otherwise reads as success.

**Consequences.** Every accepted render has been probed. `RenderJob.outputProbe`
stores the result, so what was verified is on the record rather than implied.

---

## 2026-09-10 · Retry only what a retry could fix

**Context.** BullMQ will retry anything that throws. Most render failures are
deterministic.

**Decision.** `RenderErrorKind` carries a retryable flag. `FFMPEG_FAILED`,
`OUTPUT_MISSING`, `TIMEOUT` and `UNKNOWN` are retryable; `MISSING_ASSET`,
`INVALID_TIMING`, `UNSUPPORTED_SOURCE`, `CORRUPT_MEDIA`, `FFMPEG_UNAVAILABLE`,
`FONT_UNAVAILABLE`, `OUTPUT_INVALID` and `CANCELLED` are not. The worker only
rethrows for the retryable ones.

**Rationale.** An out-of-range trim will fail identically three times over ninety
seconds of backoff, and the operator sees the real reason a minute and a half
later than they could have.

**Consequences.** A non-retryable failure is final until someone acts. The
renders screen offers a retry button for exactly that.

---

## 2026-09-10 · A destination is assessed before anything is sent to it

**Context.** A cut can be too long for one platform and fine for another, and
the failure otherwise surfaces mid-publish — in TikTok's own uploader, after a
worker drove a browser to get there.

**Decision.** `Distribution` is one row per (cut, platform), carrying a `fit` of
READY, NEEDS_OPTIMIZATION or BLOCKED, the adapter's own issues, and the caption
that platform should receive. Neither route will act on a destination that is not
READY.

**Rationale.** The three-way split is the useful one: "fine", "fixable by
re-rendering" and "re-rendering will not help". Collapsing the last two into
"failed" would send an operator to render a shorter AVI.

**Consequences.** Assessment is a step. It is cheap — no encoding, only the
adapters' declared constraints — and re-assessing updates the row rather than
adding a second opinion. A destination that has already gone out keeps its
status: re-running an assessment does not un-dispatch anything.

---

## 2026-09-10 · The manual route sends the same text the automated one would

**Context.** Not every platform has an implemented publish path, and an operator
may prefer to post by hand even where one exists.

**Decision.** `exportForManualUpload` hands over the file plus the caption
**composed by that platform's adapter** — including the truncation its own limit
forces — and records who took it and when.

**Rationale.** A manual upload that says something different from what the
automated path would have sent makes the two incomparable, which quietly ruins
the analytics the whole system exists to gather. Retyping loses the truncation;
copying the raw variant text loses the platform's own caption rules.

**Consequences.** An exported cut is a recorded event rather than a file that
left without trace. The screen shows the exact caption with a copy button, the
download, and a link to that platform's composer.

---

## 2026-09-10 · Optimisation trims the EDL, not the encoded file

**Context.** A cut that overruns a platform's limit needs a shorter version.
The quick way is `-t` on the finished file.

**Decision.** `optimizeForPlatform` rebuilds the EDL, drops whole clips from the
end and shortens the last survivor to land on the budget, then renders that as a
separate cut with its own idempotency key and its own file.

**Rationale.** A blanket trim of the encoded file cuts wherever the clock lands —
which is usually mid-sentence and often removes the call to action, silently. The
EDL knows where the beats are, so it can drop the least important ones and keep
the hook intact.

**Consequences.** The derivative is a second render, so it costs an encode. The
full-length original is untouched and stays available for platforms that accept
it.

---

## 2026-09-10 · A rendered cut publishes with the variant it was rendered from

**Context.** `createPost` required the variant to belong to the asset being
published. A rendered cut is a *derived* asset — the variant whose treatment
produced it still belongs to the source footage — so dispatching a cut through
the existing publish path failed on that check.

**Decision.** The check now accepts the pairing when a `RenderJob` joins that
exact asset and variant. Everything else about `createPost` is unchanged.

**Alternatives.** Copying the variant onto the rendered asset.

**Rationale.** Duplicating the variant would sever the link between the copy that
was written and the analytics it eventually earns, and would leave two rows
claiming to be the same creative treatment. This is the single integration point
rendering needed in the publishing subsystem, and it is guarded by a real join
rather than a loosened rule.

**Consequences.** Found by running the chain end to end, not by a test — the
Phase 8 fixture had hung the variant straight off the cut, a shape the system
never produces. The fixture now models the real one and two regression tests
cover both directions of the rule.

---

## 2026-09-15 · `/api/health` reports auth configuration, not just data source

**Context.** Production shipped to Vercel without `AUTH_COOKIE_SECRET`. Every
signal said it was healthy: the build succeeded, `/api/health` returned
`status: "ok"`, `/login` rendered, and a *wrong* password returned the ordinary
"does not match". The variable was first read at the worst possible moment — the
first *correct* password, when `login` signs the session cookie — and produced an
opaque 500 with an error digest. `PRODUCTION_ENV.md` already promised that a
missing required variable "reports `status: "misconfigured"` on `/api/health`";
that was implemented for `DATABASE_URL` and for nothing else.

**Decision.** A new `resolveAuthConfig()` (`src/server/auth/config.ts`) checks
`AUTH_COOKIE_SECRET` and `SESSION_ENCRYPTION_KEY`, and `/api/health` reports the
result as `auth` and refuses to say `ok` when it is broken. Presence and format
only, never a value — the endpoint is public.

**Alternatives.** Validating both eagerly in `src/env.ts` (rejected: that is the
build-time failure mode commit 678f142 deliberately removed, because a failed
build leaves the host serving a stale bundle). Surfacing the configuration error
on the login page itself (rejected: it tells an unauthenticated visitor what is
wrong with the deployment, and health is the place that already does this).

**Rationale.** Lazy env getters are the right trade — ship, then say so — but
only the first half was built. Nothing *said so* until a human hit the one code
path that read the variable. Health is polled, unauthenticated, and already
carries `dataSource.problem` for exactly this purpose.

**Consequences.** A deployment missing either variable now returns 503 from
`/api/health`, so anything polling it will notice; the database counts are still
reported, because losing them on a configuration fault would trade one blind
spot for another. Only constraints the code already enforces are reported —
`SESSION_ENCRYPTION_KEY` gets a 64-hex check because `crypto.ts` throws on
anything else, while `AUTH_COOKIE_SECRET` is presence-only, since no code
enforces the 64+ characters `PRODUCTION_ENV.md` recommends and failing a working
deployment over a recommendation is how a check becomes noise.
