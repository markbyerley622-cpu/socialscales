import { prisma } from "@/server/db";
import type { BrandContext } from "@/server/ai/types";

/**
 * Assembles the per-project context the AI layer is allowed to use. Every
 * project gets its own voice, audience and CTA, so suggestions for Travel AI
 * never read like suggestions for Creator AI.
 */
export async function buildBrandContext(projectId: string): Promise<BrandContext> {
  const project = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
    include: {
      brand: true,
      pillars: { orderBy: { name: "asc" } },
      hashtags: { orderBy: { usageCount: "desc" }, take: 12 },
    },
  });

  return {
    projectName: project.name,
    audience: project.brand?.audience ?? "general audience",
    tone: project.brand?.tone ?? "clear and direct",
    valueProp: project.brand?.valueProp ?? project.description ?? project.name,
    primaryCta: project.brand?.primaryCta ?? "Link in bio",
    website: project.brand?.website ?? null,
    bannedPhrases: project.brand?.bannedPhrases ?? [],
    pillars: project.pillars.map((pillar) => pillar.name),
    knownHashtags: project.hashtags.map((hashtag) => hashtag.tag),
  };
}
