-- CreateEnum
CREATE TYPE "ContentPlanStatus" AS ENUM ('DRAFT', 'ACTIVE', 'SUPERSEDED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "BriefStatus" AS ENUM ('PLANNED', 'IN_PRODUCTION', 'READY', 'FULFILLED', 'SKIPPED');

-- CreateTable
CREATE TABLE "ContentPlan" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "strategyVersionId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "ContentPlanStatus" NOT NULL DEFAULT 'DRAFT',
    "startsOn" TIMESTAMP(3) NOT NULL,
    "endsOn" TIMESTAMP(3) NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "summary" TEXT NOT NULL,
    "targetMix" JSONB NOT NULL DEFAULT '{}',
    "rationale" JSONB NOT NULL DEFAULT '{}',
    "generatedBy" TEXT NOT NULL,
    "model" TEXT,
    "promptVersion" TEXT,
    "supersededById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContentPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContentBrief" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "status" "BriefStatus" NOT NULL DEFAULT 'PLANNED',
    "workingTitle" TEXT NOT NULL,
    "angle" TEXT NOT NULL,
    "keyMessage" TEXT NOT NULL,
    "pillarSlug" TEXT,
    "format" "ContentFormat" NOT NULL DEFAULT 'UNKNOWN',
    "hookFamily" TEXT,
    "minSeconds" INTEGER,
    "maxSeconds" INTEGER,
    "targetAudienceId" TEXT,
    "objectiveKpi" TEXT,
    "plannedFor" TIMESTAMP(3),
    "platforms" "Platform"[] DEFAULT ARRAY[]::"Platform"[],
    "productionNotes" TEXT,
    "strategyBasis" TEXT NOT NULL,
    "isExperiment" BOOLEAN NOT NULL DEFAULT false,
    "hypothesisIndex" INTEGER,
    "postId" TEXT,
    "skipReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContentBrief_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ContentPlan_supersededById_key" ON "ContentPlan"("supersededById");

-- CreateIndex
CREATE INDEX "ContentPlan_projectId_status_idx" ON "ContentPlan"("projectId", "status");

-- CreateIndex
CREATE INDEX "ContentPlan_strategyVersionId_idx" ON "ContentPlan"("strategyVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "ContentPlan_projectId_version_key" ON "ContentPlan"("projectId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "ContentBrief_postId_key" ON "ContentBrief"("postId");

-- CreateIndex
CREATE INDEX "ContentBrief_projectId_status_idx" ON "ContentBrief"("projectId", "status");

-- CreateIndex
CREATE INDEX "ContentBrief_plannedFor_idx" ON "ContentBrief"("plannedFor");

-- CreateIndex
CREATE UNIQUE INDEX "ContentBrief_planId_sequence_key" ON "ContentBrief"("planId", "sequence");

-- AddForeignKey
ALTER TABLE "ContentPlan" ADD CONSTRAINT "ContentPlan_supersededById_fkey" FOREIGN KEY ("supersededById") REFERENCES "ContentPlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentPlan" ADD CONSTRAINT "ContentPlan_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentPlan" ADD CONSTRAINT "ContentPlan_strategyVersionId_fkey" FOREIGN KEY ("strategyVersionId") REFERENCES "StrategyVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentBrief" ADD CONSTRAINT "ContentBrief_planId_fkey" FOREIGN KEY ("planId") REFERENCES "ContentPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentBrief" ADD CONSTRAINT "ContentBrief_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentBrief" ADD CONSTRAINT "ContentBrief_targetAudienceId_fkey" FOREIGN KEY ("targetAudienceId") REFERENCES "AudienceSegment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentBrief" ADD CONSTRAINT "ContentBrief_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE SET NULL ON UPDATE CASCADE;
