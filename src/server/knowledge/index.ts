import { EvidenceType } from "@/generated/prisma/enums";
import { replaceProviderEvidence } from "@/server/intelligence/evidence";
import { staticPriorProvider } from "./static-priors";
import type {
  ContentKnowledgeProvider,
  KnowledgeItem,
  KnowledgeQuery,
} from "./types";

/**
 * The knowledge registry.
 *
 * This is the only route by which outside knowledge becomes evidence, and it is
 * where the provenance rule is enforced rather than trusted: a provider declares
 * `GLOBAL_PRIOR` or `EXTERNAL_EVIDENCE`, and `ingestProvider` will not write
 * anything else. There is no code path from a provider to `ACCOUNT_EVIDENCE`.
 *
 * Only the static prior provider is registered today. Trend, competitor,
 * benchmark and research providers slot in here with no change to the strategy,
 * learning or recommendation layers, because all of them read `EvidenceSource`
 * rather than calling providers directly.
 */

const providers: ContentKnowledgeProvider[] = [staticPriorProvider];

export function listKnowledgeProviders(): ContentKnowledgeProvider[] {
  return providers;
}

export function enabledKnowledgeProviders(): ContentKnowledgeProvider[] {
  return providers.filter((provider) => provider.enabled);
}

export function getKnowledgeProvider(
  name: string,
): ContentKnowledgeProvider | undefined {
  return providers.find((provider) => provider.name === name);
}

/** Maps a provider's declared class onto the evidence enum. Nothing else is allowed. */
function evidenceTypeFor(
  provider: ContentKnowledgeProvider,
): "GLOBAL_PRIOR" | "EXTERNAL_EVIDENCE" {
  return provider.evidenceClass === "EXTERNAL_EVIDENCE"
    ? EvidenceType.EXTERNAL_EVIDENCE
    : EvidenceType.GLOBAL_PRIOR;
}

export type IngestResult = {
  provider: string;
  evidenceType: EvidenceType;
  written: number;
};

/**
 * Runs one provider and replaces its previous contribution.
 *
 * Replacement rather than append: a provider restates a current view, and
 * appending would let re-running it manufacture a large apparent sample from a
 * single opinion.
 */
export async function ingestProvider(input: {
  provider: ContentKnowledgeProvider;
  workspaceId: string;
  /** Null keeps the evidence workspace-wide, which is right for generic priors. */
  projectId?: string | null;
  query?: KnowledgeQuery;
}): Promise<IngestResult> {
  const { provider } = input;
  if (!provider.enabled) {
    return { provider: provider.name, evidenceType: evidenceTypeFor(provider), written: 0 };
  }

  const items = await provider.query(input.query ?? {});
  const evidenceType = evidenceTypeFor(provider);

  const written = await replaceProviderEvidence({
    workspaceId: input.workspaceId,
    projectId: input.projectId ?? null,
    type: evidenceType,
    provider: provider.name,
    items: items.map((item) => toEvidence(item, provider)),
  });

  return { provider: provider.name, evidenceType, written };
}

/** Runs every enabled provider. */
export async function ingestAllKnowledge(input: {
  workspaceId: string;
  projectId?: string | null;
  query?: KnowledgeQuery;
}): Promise<IngestResult[]> {
  const results: IngestResult[] = [];
  for (const provider of enabledKnowledgeProviders()) {
    results.push(await ingestProvider({ ...input, provider }));
  }
  return results;
}

function toEvidence(item: KnowledgeItem, provider: ContentKnowledgeProvider) {
  return {
    sourceEntityType: provider.kind,
    sourceEntityId: item.key,
    claim: item.claim,
    dimension: item.dimension,
    groupKey: item.groupKey,
    metric: item.metric,
    // A prior asserts a direction, not a measured value against a baseline.
    value: null,
    baseline: null,
    effectSize: item.effectSize ?? null,
    // Not an observation of anything, so it carries no sample.
    sampleSize: 0,
    confidence: item.confidence,
    observedAt: new Date(),
    expiresAt: item.expiresAt ?? null,
    platform: item.platform ?? null,
    objective: item.objective ?? null,
    metadata: {
      rationale: item.rationale,
      reference: item.reference ?? null,
      providerKind: provider.kind,
    },
  };
}

export * from "./types";
