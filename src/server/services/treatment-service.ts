import { prisma } from "@/server/db";
import type { Prisma } from "@/generated/prisma/client";
import {
  creativeTreatmentPrompt,
  runAiOperation,
  type ModelProvider,
  type TreatmentInput,
} from "@/server/ai/orchestration";
import type { AiJobSummary } from "@/server/ai/orchestration";
import { buildBrandContext } from "./brand-context";

/**
 * Creative treatments.
 *
 * A variant carries a hook and a caption; a treatment is the ordered, timed shot
 * plan that makes it shootable. It is stored on the variant rather than in its
 * own table because it is one treatment per variant — a second treatment is a
 * second variant, which is the honest way to run that comparison.
 *
 * The check that matters is against the brief. A brief commissions a piece to
 * say a particular thing, and a treatment that does not say it is a different
 * piece wearing the brief's name.
 */

export type TreatmentResult =
  | {
      ok: true;
      variantId: string;
      deliversKeyMessage: boolean;
      keyMessageNote: string;
      beats: number;
      job: AiJobSummary;
    }
  | { ok: false; reason: string; errorKind: string; job: AiJobSummary };

export async function writeTreatment(input: {
  variantId: string;
  provider?: ModelProvider;
}): Promise<TreatmentResult> {
  const variant = await prisma.contentVariant.findUniqueOrThrow({
    where: { id: input.variantId },
    include: {
      asset: {
        include: {
          project: { select: { id: true, workspaceId: true } },
          brief: true,
        },
      },
    },
  });

  const asset = variant.asset;
  const brand = await buildBrandContext(asset.projectId);
  const prohibitedTopics = await prisma.brand
    .findUnique({
      where: { projectId: asset.projectId },
      select: { prohibitedTopics: true },
    })
    .then((row) => row?.prohibitedTopics ?? []);

  const strategy = await prisma.strategyVersion.findFirst({
    where: { projectId: asset.projectId, status: "ACTIVE" },
    orderBy: { version: "desc" },
    select: { narrativeStructures: true },
  });

  const context: TreatmentInput = {
    brief: asset.brief
      ? {
          workingTitle: asset.brief.workingTitle,
          angle: asset.brief.angle,
          keyMessage: asset.brief.keyMessage,
          format: asset.brief.format,
          hookFamily: asset.brief.hookFamily,
          minSeconds: asset.brief.minSeconds,
          maxSeconds: asset.brief.maxSeconds,
          productionNotes: asset.brief.productionNotes,
        }
      : null,
    variant: {
      label: variant.label,
      hook: variant.hook,
      caption: variant.caption,
      cta: variant.cta,
    },
    asset: {
      title: asset.title,
      kind: asset.kind,
      durationSeconds: asset.durationSeconds,
      aspectRatio: asset.aspectRatio,
      hasAudio: asset.hasAudio,
    },
    brand: {
      tone: brand.tone,
      audience: brand.audience,
      valueProp: brand.valueProp,
      primaryCta: brand.primaryCta,
      bannedPhrases: brand.bannedPhrases,
      prohibitedTopics,
    },
    narrativeStructures: strategy?.narrativeStructures ?? [],
  };

  const result = await runAiOperation({
    prompt: creativeTreatmentPrompt,
    input: context,
    workspaceId: asset.project.workspaceId,
    projectId: asset.projectId,
    ...(input.provider ? { provider: input.provider } : {}),
  });

  if (!result.ok) {
    return { ok: false, reason: result.message, errorKind: result.errorKind, job: result.job };
  }

  const treatment = result.value;

  await prisma.contentVariant.update({
    where: { id: variant.id },
    data: {
      hookFamily: treatment.hookFamily,
      narrativeStructure: treatment.narrativeStructure,
      treatment: { beats: treatment.beats } as unknown as Prisma.InputJsonValue,
      ctaPlacement: treatment.ctaPlacement,
      deliversKeyMessage: treatment.deliversKeyMessage,
      keyMessageNote: treatment.keyMessageNote,
      generatedBy: result.job.provenance.providerName,
      model: result.job.provenance.model,
      promptVersion: `${result.job.provenance.promptName}@${result.job.provenance.promptVersion}`,
      aiJobId: result.job.id,
    },
  });

  return {
    ok: true,
    variantId: variant.id,
    deliversKeyMessage: treatment.deliversKeyMessage,
    keyMessageNote: treatment.keyMessageNote,
    beats: treatment.beats.length,
    job: result.job,
  };
}

export type TreatmentBeatRow = {
  startSeconds: number;
  endSeconds: number;
  shot: string;
  onScreenText: string | null;
  voiceover: string | null;
};

/** Reads the stored beats back, tolerating a variant that has no treatment. */
export function readBeats(treatment: unknown): TreatmentBeatRow[] {
  const beats = (treatment as { beats?: unknown } | null)?.beats;
  if (!Array.isArray(beats)) return [];
  return beats.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const row = entry as Record<string, unknown>;
    if (typeof row.startSeconds !== "number" || typeof row.endSeconds !== "number") {
      return [];
    }
    return [
      {
        startSeconds: row.startSeconds,
        endSeconds: row.endSeconds,
        shot: typeof row.shot === "string" ? row.shot : "",
        onScreenText: typeof row.onScreenText === "string" ? row.onScreenText : null,
        voiceover: typeof row.voiceover === "string" ? row.voiceover : null,
      },
    ];
  });
}

/**
 * Variants that were commissioned by a brief but do not deliver its key message.
 *
 * Worth surfacing rather than blocking: a treatment that misses the message is
 * sometimes the better piece of content, and that is an editorial call. What is
 * not acceptable is it happening without anyone noticing.
 */
export async function offBriefVariants(projectId: string) {
  return prisma.contentVariant.findMany({
    where: {
      asset: { projectId, briefId: { not: null } },
      deliversKeyMessage: false,
    },
    include: {
      asset: {
        select: {
          id: true,
          title: true,
          brief: { select: { workingTitle: true, keyMessage: true } },
        },
      },
    },
    orderBy: { updatedAt: "desc" },
  });
}
