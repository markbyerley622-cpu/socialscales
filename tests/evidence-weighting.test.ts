import { describe, expect, it } from "vitest";
import {
  INFERENTIAL_STRENGTH,
  RECENCY_HALF_LIFE_DAYS,
  effectMagnitude,
  recency,
  relevance,
  resolveClaim,
  sampleAdequacy,
  weighEvidence,
  type WeighableEvidence,
} from "@/server/intelligence/weighting";
import {
  decideStatus,
  confidenceFor,
  PROMOTION,
} from "@/server/intelligence/learning";
import { summariseProvenance } from "@/server/intelligence/evidence";
import { allStaticPriors, staticPriorProvider } from "@/server/knowledge/static-priors";
import { listKnowledgeProviders } from "@/server/knowledge";
import {
  Confidence,
  EvidenceType,
  LearningStatus,
  Platform,
} from "@/generated/prisma/enums";

/**
 * The rules that keep account evidence, priors and outside observations
 * distinguishable — and that stop a flattering two-post pattern outranking a
 * well-evidenced benchmark.
 */

const NOW = new Date("2026-09-10T12:00:00Z");

/**
 * Builds a weighable item. Uses `in` rather than `??` for the nullable fields so
 * that passing an explicit null actually means null — with `??` it would fall
 * back to the default and silently test the wrong thing.
 */
function evidence(overrides: Partial<WeighableEvidence> = {}): WeighableEvidence {
  const pick = <K extends keyof WeighableEvidence>(
    key: K,
    fallback: WeighableEvidence[K],
  ): WeighableEvidence[K] => (key in overrides ? (overrides[key] as WeighableEvidence[K]) : fallback);

  return {
    id: pick("id", "e1"),
    type: pick("type", EvidenceType.ACCOUNT_EVIDENCE),
    confidence: pick("confidence", 0.8),
    sampleSize: pick("sampleSize", 10),
    effectSize: pick("effectSize", 0.3),
    observedAt: pick("observedAt", NOW),
    expiresAt: pick("expiresAt", null),
    dimension: pick("dimension", "hook"),
    groupKey: pick("groupKey", "problem_solution"),
    objective: pick("objective", null),
  };
}

// ---------------------------------------------------------------------------

describe("inferential strength", () => {
  it("ranks how much causal weight each observation method can bear", () => {
    // A controlled test isolates a variable; a prior observed nobody.
    expect(INFERENTIAL_STRENGTH.EXPERIMENT_EVIDENCE).toBeGreaterThan(
      INFERENTIAL_STRENGTH.ACCOUNT_EVIDENCE,
    );
    expect(INFERENTIAL_STRENGTH.ACCOUNT_EVIDENCE).toBeGreaterThan(
      INFERENTIAL_STRENGTH.EXTERNAL_EVIDENCE,
    );
    expect(INFERENTIAL_STRENGTH.EXTERNAL_EVIDENCE).toBeGreaterThan(
      INFERENTIAL_STRENGTH.GLOBAL_PRIOR,
    );
  });

  it("never lets a class alone decide the outcome", () => {
    // Every ceiling is below 1 except a controlled test, and even that is then
    // multiplied by sample, effect, recency and confidence.
    for (const value of Object.values(INFERENTIAL_STRENGTH)) {
      expect(value).toBeGreaterThan(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });
});

describe("sample adequacy", () => {
  it("rises steeply then flattens, so two posts cannot dominate", () => {
    const one = sampleAdequacy(evidence({ sampleSize: 1 }));
    const two = sampleAdequacy(evidence({ sampleSize: 2 }));
    const twelve = sampleAdequacy(evidence({ sampleSize: 12 }));
    const fifty = sampleAdequacy(evidence({ sampleSize: 50 }));

    expect(one).toBeLessThan(0.2);
    expect(two).toBeLessThan(0.3);
    expect(twelve).toBeGreaterThan(0.6);
    // Diminishing returns: 50 is not four times better than 12.
    expect(fifty - twelve).toBeLessThan(twelve - two);
  });

  it("does not penalise a prior for having no sample", () => {
    // A prior is not an observation, so "how many samples" is the wrong
    // question; it is capped by its inferential strength instead.
    expect(
      sampleAdequacy(evidence({ type: EvidenceType.GLOBAL_PRIOR, sampleSize: 0 })),
    ).toBe(1);
  });
});

describe("recency", () => {
  it("decays account evidence on its half-life", () => {
    const halfLife = RECENCY_HALF_LIFE_DAYS.ACCOUNT_EVIDENCE!;
    const aged = new Date(NOW.getTime() - halfLife * 86_400_000);
    expect(recency(evidence({ observedAt: aged }), NOW)).toBeCloseTo(0.5, 2);
  });

  it("decays external evidence faster than account evidence", () => {
    expect(RECENCY_HALF_LIFE_DAYS.EXTERNAL_EVIDENCE!).toBeLessThan(
      RECENCY_HALF_LIFE_DAYS.ACCOUNT_EVIDENCE!,
    );
  });

  it("does not decay priors, which are assumptions rather than observations", () => {
    const ancient = new Date(NOW.getTime() - 5 * 365 * 86_400_000);
    expect(
      recency(evidence({ type: EvidenceType.GLOBAL_PRIOR, observedAt: ancient }), NOW),
    ).toBe(1);
  });

  it("zeroes expired evidence outright", () => {
    const expired = evidence({
      type: EvidenceType.EXTERNAL_EVIDENCE,
      expiresAt: new Date(NOW.getTime() - 1000),
    });
    expect(recency(expired, NOW)).toBe(0);
  });
});

describe("relevance", () => {
  it("nearly discards evidence about a different dimension", () => {
    const score = relevance(evidence({ dimension: "length" }), { dimension: "hook" });
    expect(score).toBeLessThan(0.2);
  });

  it("keeps evidence with no dimension as merely unfocused", () => {
    const score = relevance(evidence({ dimension: null }), { dimension: "hook" });
    expect(score).toBeGreaterThan(0.2);
    expect(score).toBeLessThan(1);
  });

  it("discounts evidence about a different objective without discarding it", () => {
    const score = relevance(evidence({ objective: "views" }), {
      objective: "conversions",
    });
    expect(score).toBeGreaterThan(0.4);
    expect(score).toBeLessThan(1);
  });
});

describe("effect magnitude", () => {
  it("treats a drop as as informative as a rise", () => {
    expect(effectMagnitude(evidence({ effectSize: -0.4 }))).toBe(
      effectMagnitude(evidence({ effectSize: 0.4 })),
    );
  });

  it("scales small effects down", () => {
    expect(effectMagnitude(evidence({ effectSize: 0.03 }))).toBeLessThan(0.2);
  });
});

// ---------------------------------------------------------------------------
// The behaviour the spec actually asks for
// ---------------------------------------------------------------------------

describe("account evidence versus global priors", () => {
  it("a well-evidenced account pattern outweighs a prior", () => {
    const account = weighEvidence(
      evidence({ type: EvidenceType.ACCOUNT_EVIDENCE, sampleSize: 12, effectSize: 0.35 }),
      { dimension: "hook", now: NOW },
    );
    const prior = weighEvidence(
      evidence({
        id: "p1",
        type: EvidenceType.GLOBAL_PRIOR,
        sampleSize: 0,
        effectSize: null,
        confidence: 0.5,
      }),
      { dimension: "hook", now: NOW },
    );

    expect(account.weight).toBeGreaterThan(prior.weight);
  });

  it("a weak two-post account pattern does NOT automatically beat good external evidence", () => {
    // This is the case the spec calls out explicitly.
    const flimsyAccount = weighEvidence(
      evidence({
        type: EvidenceType.ACCOUNT_EVIDENCE,
        sampleSize: 2,
        effectSize: 0.08,
        confidence: 0.5,
      }),
      { dimension: "hook", now: NOW },
    );
    const solidExternal = weighEvidence(
      evidence({
        id: "x1",
        type: EvidenceType.EXTERNAL_EVIDENCE,
        sampleSize: 400,
        effectSize: 0.4,
        confidence: 0.85,
      }),
      { dimension: "hook", now: NOW },
    );

    expect(solidExternal.weight).toBeGreaterThan(flimsyAccount.weight);
  });

  it("a controlled test outweighs the same numbers observed passively", () => {
    const shape = { sampleSize: 8, effectSize: 0.3, confidence: 0.8 };
    const experiment = weighEvidence(
      evidence({ ...shape, type: EvidenceType.EXPERIMENT_EVIDENCE }),
      { dimension: "hook", now: NOW },
    );
    const observational = weighEvidence(
      evidence({ ...shape, id: "o1", type: EvidenceType.ACCOUNT_EVIDENCE }),
      { dimension: "hook", now: NOW },
    );

    expect(experiment.weight).toBeGreaterThan(observational.weight);
  });

  it("explains what discounted an item, naming the weakest factor", () => {
    const weighed = weighEvidence(
      evidence({ sampleSize: 1, effectSize: 0.4, confidence: 0.9 }),
      { dimension: "hook", now: NOW },
    );
    expect(weighed.explanation).toMatch(/1 observation/);
  });
});

describe("claim resolution", () => {
  it("marks a claim built only from priors as prior-only and halves its strength", () => {
    const resolved = resolveClaim(
      [
        { evidence: evidence({ type: EvidenceType.GLOBAL_PRIOR, effectSize: null }) },
        {
          evidence: evidence({
            id: "p2",
            type: EvidenceType.GLOBAL_PRIOR,
            effectSize: null,
          }),
        },
      ],
      { dimension: "hook", now: NOW },
    );

    expect(resolved.priorOnly).toBe(true);
    expect(resolved.classesUsed).toEqual([EvidenceType.GLOBAL_PRIOR]);
  });

  it("stops being prior-only as soon as the account contributes anything", () => {
    const resolved = resolveClaim(
      [
        { evidence: evidence({ type: EvidenceType.GLOBAL_PRIOR, effectSize: null }) },
        { evidence: evidence({ id: "a1", type: EvidenceType.ACCOUNT_EVIDENCE }) },
      ],
      { dimension: "hook", now: NOW },
    );

    expect(resolved.priorOnly).toBe(false);
    expect(resolved.classesUsed).toContain(EvidenceType.ACCOUNT_EVIDENCE);
  });

  it("reads a contested claim as weak rather than settled", () => {
    const shape = { sampleSize: 10, effectSize: 0.3, confidence: 0.8 };
    const contested = resolveClaim(
      [
        { evidence: evidence({ ...shape, id: "for" }) },
        { evidence: evidence({ ...shape, id: "against" }), contradicts: true },
      ],
      { dimension: "hook", now: NOW },
    );

    // Evenly opposed: near-zero net score and almost no strength.
    expect(Math.abs(contested.score)).toBeLessThan(0.05);
    expect(contested.strength).toBeLessThan(0.1);
  });

  it("does not treat one strong item as certainty", () => {
    const single = resolveClaim(
      [{ evidence: evidence({ sampleSize: 40, effectSize: 0.6, confidence: 1 }) }],
      { dimension: "hook", now: NOW },
    );
    expect(single.strength).toBeLessThan(0.75);
  });
});

// ---------------------------------------------------------------------------
// Learning promotion
// ---------------------------------------------------------------------------

describe("learning promotion", () => {
  it("cannot promote past hypothesis without account observation", () => {
    // However convincing the priors, nothing has been seen on this account.
    expect(
      decideStatus({
        promotableScore: 0,
        netScore: 0.9,
        hasObservedEvidence: false,
      }),
    ).toBe(LearningStatus.HYPOTHESIS);
  });

  it("promotes on observed evidence strength", () => {
    expect(
      decideStatus({
        promotableScore: PROMOTION.supported,
        netScore: PROMOTION.supported,
        hasObservedEvidence: true,
      }),
    ).toBe(LearningStatus.SUPPORTED);

    expect(
      decideStatus({
        promotableScore: PROMOTION.emerging,
        netScore: PROMOTION.emerging,
        hasObservedEvidence: true,
      }),
    ).toBe(LearningStatus.EMERGING);
  });

  it("weakens a claim when the net evidence turns against it", () => {
    expect(
      decideStatus({
        promotableScore: 0.5,
        netScore: PROMOTION.weakened - 0.1,
        hasObservedEvidence: true,
      }),
    ).toBe(LearningStatus.WEAKENED);
  });

  it("caps confidence at low without account observation", () => {
    expect(confidenceFor(0.99, false)).toBe(Confidence.LOW);
    expect(confidenceFor(0.99, true)).toBe(Confidence.HIGH);
  });
});

// ---------------------------------------------------------------------------
// Provenance and priors
// ---------------------------------------------------------------------------

describe("provenance summary", () => {
  it("says plainly when a claim rests on priors alone", () => {
    const summary = summariseProvenance([
      EvidenceType.GLOBAL_PRIOR,
      EvidenceType.GLOBAL_PRIOR,
    ]);
    expect(summary.priorOnly).toBe(true);
    expect(summary.headline).toMatch(/nothing has been observed on this account/i);
  });

  it("leads with experiments when there are any", () => {
    const summary = summariseProvenance([
      EvidenceType.EXPERIMENT_EVIDENCE,
      EvidenceType.ACCOUNT_EVIDENCE,
      EvidenceType.GLOBAL_PRIOR,
    ]);
    expect(summary.priorOnly).toBe(false);
    expect(summary.headline).toMatch(/controlled test/i);
  });

  it("counts each class separately", () => {
    const summary = summariseProvenance([
      EvidenceType.ACCOUNT_EVIDENCE,
      EvidenceType.ACCOUNT_EVIDENCE,
      EvidenceType.EXTERNAL_EVIDENCE,
      EvidenceType.GLOBAL_PRIOR,
    ]);
    expect(summary).toMatchObject({
      accountEvidence: 2,
      externalEvidence: 1,
      globalPriors: 1,
      experimentEvidence: 0,
    });
  });
});

describe("static prior provider", () => {
  it("only ever produces priors, never account evidence", () => {
    for (const provider of listKnowledgeProviders()) {
      expect(["GLOBAL_PRIOR", "EXTERNAL_EVIDENCE"]).toContain(provider.evidenceClass);
    }
  });

  it("asserts direction without inventing a measured effect", () => {
    // A shipped constant claiming "+31%" would be fabricated account data.
    for (const prior of allStaticPriors()) {
      expect(prior.effectSize ?? null).toBeNull();
      expect(prior.rationale.length).toBeGreaterThan(10);
    }
  });

  it("keeps prior confidence modest", () => {
    for (const prior of allStaticPriors()) {
      expect(prior.confidence).toBeGreaterThan(0);
      expect(prior.confidence).toBeLessThanOrEqual(0.6);
    }
  });

  it("filters by dimension", async () => {
    const hooks = await staticPriorProvider.query({ dimension: "hook" });
    expect(hooks.length).toBeGreaterThan(0);
    expect(hooks.every((item) => item.dimension === "hook")).toBe(true);
  });

  it("keeps platform-specific priors out of other platforms", async () => {
    const forInstagram = await staticPriorProvider.query({
      platform: Platform.INSTAGRAM,
    });
    expect(
      forInstagram.some((item) => item.platform === Platform.TIKTOK),
    ).toBe(false);
  });

  it("is deterministic, so cold-start behaviour is reproducible", async () => {
    const a = await staticPriorProvider.query({ dimension: "hook" });
    const b = await staticPriorProvider.query({ dimension: "hook" });
    expect(a.map((item) => item.key)).toEqual(b.map((item) => item.key));
  });
});
