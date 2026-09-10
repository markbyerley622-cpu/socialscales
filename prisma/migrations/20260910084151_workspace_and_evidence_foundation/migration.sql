/*
  Warnings:

  - Added the required column `workspaceId` to the `Project` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "EvidenceType" AS ENUM ('ACCOUNT_EVIDENCE', 'GLOBAL_PRIOR', 'EXTERNAL_EVIDENCE', 'EXPERIMENT_EVIDENCE');

-- CreateEnum
CREATE TYPE "EvidenceRelationship" AS ENUM ('SUPPORTS', 'CONTRADICTS', 'CONTEXTUALIZES');

-- CreateEnum
CREATE TYPE "LearningStatus" AS ENUM ('HYPOTHESIS', 'EMERGING', 'SUPPORTED', 'WEAKENED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "ObjectiveKind" AS ENUM ('REACH', 'IMPRESSIONS', 'WATCH_TIME', 'RETENTION', 'FOLLOWERS', 'ENGAGEMENT', 'PROFILE_VISITS', 'WEBSITE_TRAFFIC', 'LEADS', 'BOOKINGS', 'PURCHASES', 'REVENUE', 'CUSTOM');

-- CreateEnum
CREATE TYPE "AwarenessStage" AS ENUM ('UNAWARE', 'PROBLEM_AWARE', 'SOLUTION_AWARE', 'PRODUCT_AWARE', 'MOST_AWARE');

-- CreateEnum
CREATE TYPE "StrategyStatus" AS ENUM ('DRAFT', 'ACTIVE', 'SUPERSEDED', 'ARCHIVED');

-- AlterTable
ALTER TABLE "Brand" ADD COLUMN     "competitors" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "differentiators" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "geography" TEXT,
ADD COLUMN     "industry" TEXT,
ADD COLUMN     "pricingNotes" TEXT,
ADD COLUMN     "productsServices" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "prohibitedTopics" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "visualStyle" TEXT;

-- AlterTable
-- Added nullable first: there are existing projects, and a required column
-- with no default cannot be added to a populated table. Backfilled below.
ALTER TABLE "Project" ADD COLUMN     "workspaceId" TEXT;

-- AlterTable
ALTER TABLE "Recommendation" ADD COLUMN     "generatedBy" TEXT,
ADD COLUMN     "model" TEXT,
ADD COLUMN     "promptVersion" TEXT;

-- CreateTable
CREATE TABLE "Workspace" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BusinessObjective" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "kind" "ObjectiveKind" NOT NULL,
    "kpi" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 1,
    "targetValue" DOUBLE PRECISION,
    "optimizationWeight" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "attributionLimitations" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessObjective_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AudienceSegment" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "demographics" JSONB NOT NULL DEFAULT '{}',
    "pains" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "desires" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "objections" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "motivations" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "awarenessStage" "AwarenessStage" NOT NULL DEFAULT 'PROBLEM_AWARE',
    "priority" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AudienceSegment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvidenceSource" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT,
    "type" "EvidenceType" NOT NULL,
    "sourceEntityType" TEXT NOT NULL,
    "sourceEntityId" TEXT,
    "provider" TEXT,
    "claim" TEXT NOT NULL,
    "dimension" TEXT,
    "groupKey" TEXT,
    "metric" TEXT NOT NULL,
    "value" DOUBLE PRECISION,
    "baseline" DOUBLE PRECISION,
    "effectSize" DOUBLE PRECISION,
    "sampleSize" INTEGER NOT NULL DEFAULT 0,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "platform" "Platform",
    "objective" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EvidenceSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Learning" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT,
    "claim" TEXT NOT NULL,
    "scope" JSONB NOT NULL DEFAULT '{}',
    "dimension" TEXT,
    "groupKey" TEXT,
    "metric" TEXT NOT NULL,
    "status" "LearningStatus" NOT NULL DEFAULT 'HYPOTHESIS',
    "confidence" "Confidence" NOT NULL DEFAULT 'LOW',
    "supportingCount" INTEGER NOT NULL DEFAULT 0,
    "contradictingCount" INTEGER NOT NULL DEFAULT 0,
    "sampleSize" INTEGER NOT NULL DEFAULT 0,
    "effectSize" DOUBLE PRECISION,
    "supersededById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Learning_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LearningEvidence" (
    "learningId" TEXT NOT NULL,
    "evidenceSourceId" TEXT NOT NULL,
    "relationship" "EvidenceRelationship" NOT NULL DEFAULT 'SUPPORTS',
    "strength" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LearningEvidence_pkey" PRIMARY KEY ("learningId","evidenceSourceId")
);

-- CreateTable
CREATE TABLE "StrategyVersion" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "StrategyStatus" NOT NULL DEFAULT 'DRAFT',
    "summary" TEXT NOT NULL,
    "targetAudienceId" TEXT,
    "primaryObjectiveId" TEXT,
    "secondaryObjectiveId" TEXT,
    "contentPillars" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "recommendedFormats" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "hookFamilies" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "narrativeStructures" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "ctaStrategy" TEXT,
    "platformStrategy" JSONB NOT NULL DEFAULT '{}',
    "cadence" JSONB NOT NULL DEFAULT '{}',
    "hypotheses" JSONB NOT NULL DEFAULT '[]',
    "risks" JSONB NOT NULL DEFAULT '[]',
    "accountState" JSONB NOT NULL DEFAULT '{}',
    "confidence" "Confidence" NOT NULL DEFAULT 'LOW',
    "generatedBy" TEXT NOT NULL,
    "model" TEXT,
    "promptVersion" TEXT,
    "supersededById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StrategyVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StrategyEvidence" (
    "strategyVersionId" TEXT NOT NULL,
    "evidenceSourceId" TEXT NOT NULL,
    "relationship" "EvidenceRelationship" NOT NULL DEFAULT 'SUPPORTS',
    "strength" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "decision" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StrategyEvidence_pkey" PRIMARY KEY ("strategyVersionId","evidenceSourceId")
);

-- CreateTable
CREATE TABLE "RecommendationEvidence" (
    "recommendationId" TEXT NOT NULL,
    "evidenceSourceId" TEXT NOT NULL,
    "relationship" "EvidenceRelationship" NOT NULL DEFAULT 'SUPPORTS',
    "strength" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecommendationEvidence_pkey" PRIMARY KEY ("recommendationId","evidenceSourceId")
);

-- CreateIndex
CREATE UNIQUE INDEX "Workspace_slug_key" ON "Workspace"("slug");

-- CreateIndex
CREATE INDEX "BusinessObjective_projectId_active_idx" ON "BusinessObjective"("projectId", "active");

-- CreateIndex
CREATE INDEX "AudienceSegment_projectId_idx" ON "AudienceSegment"("projectId");

-- CreateIndex
CREATE INDEX "EvidenceSource_workspaceId_type_idx" ON "EvidenceSource"("workspaceId", "type");

-- CreateIndex
CREATE INDEX "EvidenceSource_projectId_dimension_groupKey_idx" ON "EvidenceSource"("projectId", "dimension", "groupKey");

-- CreateIndex
CREATE INDEX "EvidenceSource_observedAt_idx" ON "EvidenceSource"("observedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Learning_supersededById_key" ON "Learning"("supersededById");

-- CreateIndex
CREATE INDEX "Learning_workspaceId_status_idx" ON "Learning"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "Learning_projectId_dimension_status_idx" ON "Learning"("projectId", "dimension", "status");

-- CreateIndex
CREATE INDEX "LearningEvidence_evidenceSourceId_idx" ON "LearningEvidence"("evidenceSourceId");

-- CreateIndex
CREATE UNIQUE INDEX "StrategyVersion_supersededById_key" ON "StrategyVersion"("supersededById");

-- CreateIndex
CREATE INDEX "StrategyVersion_projectId_status_idx" ON "StrategyVersion"("projectId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "StrategyVersion_projectId_version_key" ON "StrategyVersion"("projectId", "version");

-- CreateIndex
CREATE INDEX "StrategyEvidence_evidenceSourceId_idx" ON "StrategyEvidence"("evidenceSourceId");

-- CreateIndex
CREATE INDEX "RecommendationEvidence_evidenceSourceId_idx" ON "RecommendationEvidence"("evidenceSourceId");

-- CreateIndex
CREATE INDEX "Project_workspaceId_idx" ON "Project"("workspaceId");

-- AddForeignKey
-- ---------------------------------------------------------------------------
-- Backfill: every existing project joins one default workspace.
--
-- Written by hand rather than left to the generator, because the generator's
-- only options were to fail or to drop the table. Existing brands, assets,
-- posts and analytics must survive this migration untouched.
-- ---------------------------------------------------------------------------
INSERT INTO "Workspace" ("id", "slug", "name", "createdAt", "updatedAt")
SELECT 'ws_default', 'default', 'Default workspace', NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM "Workspace" WHERE "id" = 'ws_default');

UPDATE "Project" SET "workspaceId" = 'ws_default' WHERE "workspaceId" IS NULL;

-- Safe now that every row has a value.
ALTER TABLE "Project" ALTER COLUMN "workspaceId" SET NOT NULL;

ALTER TABLE "Project" ADD CONSTRAINT "Project_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessObjective" ADD CONSTRAINT "BusinessObjective_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AudienceSegment" ADD CONSTRAINT "AudienceSegment_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvidenceSource" ADD CONSTRAINT "EvidenceSource_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvidenceSource" ADD CONSTRAINT "EvidenceSource_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Learning" ADD CONSTRAINT "Learning_supersededById_fkey" FOREIGN KEY ("supersededById") REFERENCES "Learning"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Learning" ADD CONSTRAINT "Learning_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Learning" ADD CONSTRAINT "Learning_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LearningEvidence" ADD CONSTRAINT "LearningEvidence_learningId_fkey" FOREIGN KEY ("learningId") REFERENCES "Learning"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LearningEvidence" ADD CONSTRAINT "LearningEvidence_evidenceSourceId_fkey" FOREIGN KEY ("evidenceSourceId") REFERENCES "EvidenceSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StrategyVersion" ADD CONSTRAINT "StrategyVersion_supersededById_fkey" FOREIGN KEY ("supersededById") REFERENCES "StrategyVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StrategyVersion" ADD CONSTRAINT "StrategyVersion_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StrategyVersion" ADD CONSTRAINT "StrategyVersion_targetAudienceId_fkey" FOREIGN KEY ("targetAudienceId") REFERENCES "AudienceSegment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StrategyEvidence" ADD CONSTRAINT "StrategyEvidence_strategyVersionId_fkey" FOREIGN KEY ("strategyVersionId") REFERENCES "StrategyVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StrategyEvidence" ADD CONSTRAINT "StrategyEvidence_evidenceSourceId_fkey" FOREIGN KEY ("evidenceSourceId") REFERENCES "EvidenceSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecommendationEvidence" ADD CONSTRAINT "RecommendationEvidence_recommendationId_fkey" FOREIGN KEY ("recommendationId") REFERENCES "Recommendation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecommendationEvidence" ADD CONSTRAINT "RecommendationEvidence_evidenceSourceId_fkey" FOREIGN KEY ("evidenceSourceId") REFERENCES "EvidenceSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;
