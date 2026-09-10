# Domain model

How the concepts in the product specification map onto the tables in this
codebase, and the rules that govern the intelligence layer.

---

## Naming map

The spec and the schema use different words for some of the same things. The
schema names are older and load-bearing across ~20k lines, so they were kept and
mapped rather than renamed.

| Spec concept | This codebase | Note |
|---|---|---|
| Workspace | `Workspace` | Tenant boundary. Added in the intelligence phase. |
| Brand | `Project` | **A `Project` is a brand** — one product idea under test. |
| BrandProfile | `Brand` | 1:1 with `Project`. Identity, voice, prohibited topics. |
| AudienceProfile | `AudienceSegment` | Many per brand. |
| BusinessObjective | `BusinessObjective` | Many per brand, weighted. |
| ContentPillar | `ContentPillar` | |
| SocialAccount | `SocialAccount` | |
| RawAsset | `ContentAsset` | |
| AssetAnalysis | `AIAnalysis` | Append-only per analysis run. |
| CreativeVariant | `ContentVariant` | Copy treatment today; gains an EDL later. |
| Publication | `Post` → `PostPlatform` | `PostPlatform` is the per-destination unit. |
| PerformanceSnapshot | `AnalyticsSnapshot` | Append-only, bucketed by post age. |
| ContentRecommendation | `Recommendation` | |
| StrategyVersion | `StrategyVersion` | Immutable, versioned, diffable. |
| Learning | `Learning` | With `LearningEvidence`. |
| EvidenceSource | `EvidenceSource` | The centre of the intelligence layer. |

`Project` doing double duty as "brand" is the one wart. It is documented here
rather than renamed because a rename buys clarity and costs a migration plus a
sweep of every page, service and test — a bad trade against a working system.

---

## The intelligence model

```
                 SOCIALSCALE INTELLIGENCE
                         |
            +------------+------------+
            |                         |
     ACCOUNT INTELLIGENCE      GLOBAL / EXTERNAL
            |                         |
     historical results        priors / trends /
     experiments               benchmarks
     user feedback             competitor context
            |                         |
            +------------+------------+
                         |
                  STRATEGY ENGINE
                         |
                 CONTENT DIRECTOR
                         |
                   PUBLISH / TEST
                         |
                     ANALYTICS
                         |
                    LEARNINGS
                         |
                         +----> feeds back into strategy
```

### The four evidence classes

Every observation that can influence a decision is an `EvidenceSource` with a
`type`. **The type is never erased and never converted.**

| Class | What it is | Where it comes from |
|---|---|---|
| `ACCOUNT_EVIDENCE` | This brand's own published results, creative features, analytics, approvals and feedback | The brand's own `PostPlatform` + `AnalyticsSnapshot` history |
| `EXPERIMENT_EVIDENCE` | A controlled test on this account with a control and a variant | `Experiment` |
| `EXTERNAL_EVIDENCE` | Observations of the wider market — trends, competitors, benchmarks | Future knowledge providers |
| `GLOBAL_PRIOR` | General content knowledge shipped with the system | `static-priors.ts` |

**The hierarchy is a hierarchy of claims, not a ranking:**

- A **global prior** proposes what *may* work. It is an assumption. It observed
  nobody.
- **Account evidence** shows what *appears to* work for this brand. It cannot
  separate the hook from the topic, the day or the algorithm.
- **Experiment evidence** tests whether one variable *likely caused* an outcome,
  because it held the others still.
- **External evidence** adds market context that the account cannot see from
  inside itself.

### Cold start

A brand with no history plans from priors, its stated business context and its
audience, and the system says so. `coldStartState()` reports it, and
`summariseProvenance()` produces the line the UI shows:

> Based on general priors only — nothing has been observed on this account yet.

As the account publishes, priors are outweighed automatically. Not by a rule
that says "prefer account evidence", but because real observations carry sample
size, measured effect and higher inferential strength, and priors carry none of
those.

---

## Weighting

There is **no fixed blend** such as 80/20. Every item's weight is the product of
six factors, each 0..1, so a weakness anywhere pulls the whole item down:

```
weight = inferentialStrength × relevance × recency
       × sampleAdequacy × effectMagnitude × confidence
```

| Factor | What it measures |
|---|---|
| `inferentialStrength` | What the *method of observation* can support. Experiment 1.0 · account 0.7 · external 0.45 · prior 0.25 |
| `relevance` | Whether it answers the question asked — same dimension, group and objective |
| `recency` | Exponential decay on a per-class half-life. Account 90d · experiment 180d · external 30d · priors never |
| `sampleAdequacy` | `n / (n + 6)`. Saturating, so 2 posts score 0.25 and 24 score 0.8 |
| `effectMagnitude` | `|effect| / 0.3`, capped. A 3% difference is real but small |
| `confidence` | As asserted by the producer |

The `inferentialStrength` numbers are epistemic ceilings, not preferences, and
they are the only place provenance enters the arithmetic. They are documented and
overridable in `src/server/intelligence/weighting.ts`.

**Consequence, tested explicitly:** a two-post account pattern with an 8% effect
scores *below* a 400-sample external benchmark with a 40% effect. Provenance
alone never wins.

### Resolution

`resolveClaim()` combines items. Contradicting evidence **subtracts** rather than
being filtered out, so a genuinely contested claim reads as contested rather than
as settled in favour of whichever side was counted first. Strength combines
one-sidedness with total weight, and is halved when only priors contributed.

---

## Learning lifecycle

```
HYPOTHESIS ──> EMERGING ──> SUPPORTED
     ↑              │            │
     └──────────────┴──> WEAKENED
                          │
                          └──> SUPERSEDED
```

- Everything enters as `HYPOTHESIS`. A prior can *suggest* one; it can never
  promote one.
- Only `ACCOUNT_EVIDENCE` and `EXPERIMENT_EVIDENCE` can promote a claim, because
  only they observed this brand.
- Confidence is capped at `LOW` while there is no account observation, however
  internally consistent the priors are.
- Net-negative evidence moves a claim to `WEAKENED`. Nothing is deleted;
  `supersededById` keeps the chain intact.

---

## Traceability

Every strategic artefact links back to the evidence behind it:

```
EvidenceSource ──< LearningEvidence       >── Learning
               ──< StrategyEvidence       >── StrategyVersion
               ──< RecommendationEvidence >── Recommendation
```

Each link stores the computed `strength`, so the "why this?" panel shows real
numbers rather than a restated assertion. `StrategyEvidence.decision` records
*which* strategy decision an item backs.

---

## Adding a knowledge provider

Implement `ContentKnowledgeProvider` and register it in
`src/server/knowledge/index.ts`. A provider declares `GLOBAL_PRIOR` or
`EXTERNAL_EVIDENCE`; **there is no code path from a provider to
`ACCOUNT_EVIDENCE`**, and the registry enforces that rather than trusting each
provider.

Provider output is *replaced* on each run, never appended — a provider restates a
current view, and appending would let re-running it manufacture a large apparent
sample from one opinion.

External evidence must carry `observedAt`, a `reference` where one exists, and an
`expiresAt`, because market observations go stale in a way priors do not.

---

## The AI boundary

Everything that talks to a model goes through one function.

```
caller (route / component / service / worker)
   |
   v
runAiOperation({ prompt, input, workspaceId })
   |
   +-- select provider ......... auto | deterministic | anthropic
   +-- render versioned prompt . PromptRegistry, hashed
   +-- provider.complete() ..... AIUsageLog row per attempt
   +-- validate ................ Zod schema, then refine(value, input)
   +-- repair / retry .......... invalid output -> corrective turn
   +-- persist ................. AIJob: status, provenance, cost, latency
   |
   v
AiResult<T>  ->  { ok: true, value, job } | { ok: false, errorKind, message, job }
```

Callers import `runAiOperation` and a registered prompt. They do **not** import a
provider, construct a client, or read `ANTHROPIC_API_KEY`. Two tests in
`tests/ai-orchestration.test.ts` enforce that by scanning the source tree, so the
boundary is a fact rather than an agreement.

### The two provider kinds

| | `DETERMINISTIC` | `LLM` |
|---|---|---|
| What it is | rules, templates, arithmetic | a hosted model |
| `model` | always null | the model id |
| Cost | zero | priced per token at call time |
| Repair | refused — invalid output is a bug | attempted |
| Label shown | "Generated by rules … no language model was used" | "Generated by claude-opus-5 …" |

`AiProvenance.deterministic` is derived from the provider's declared `kind` and
from nothing else — not the provider's name, not whether a model string happens to
be populated. There is no configuration that makes rule output read as model
output.

### Availability is a state, not a crash

With no `ANTHROPIC_API_KEY`, `anthropicProvider.availability()` returns
`{ available: false, reason }`. Under `AI_MODEL_PROVIDER=auto` the request falls
back to rules, and the unavailable model is written to `AIUsageLog` as a real
attempt with `errorKind = UNAVAILABLE` and zero cost — so the fallback appears in
the record rather than the rule answer appearing from nowhere. Under
`AI_MODEL_PROVIDER=anthropic` there is no substitution: the job fails.

### Adding an operation

1. Add a value to the `AIOperation` enum (a migration).
2. Create `src/server/ai/orchestration/prompts/<name>.ts` and call
   `registerPrompt` with: a Zod `schema`, `render()`, a `deterministic()`
   implementation, and optionally `refine()` for rules the schema cannot express.
3. Export it from `prompts/index.ts`.
4. Bump `version` on any later change to wording, schema or token budget — the
   registry refuses a duplicate name+version, so forgetting fails at import.
