-- CreateEnum
CREATE TYPE "AIProviderKind" AS ENUM ('DETERMINISTIC', 'LLM');

-- CreateEnum
CREATE TYPE "AIJobStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'INVALID_OUTPUT', 'FAILED', 'UNAVAILABLE');

-- CreateEnum
CREATE TYPE "AIOperation" AS ENUM ('ASSET_ANALYSIS', 'COPY_VARIANTS', 'STRATEGY_DRAFT', 'CONTENT_PLAN', 'HOOK_REWRITE', 'LEARNING_SUMMARY');

-- CreateTable
CREATE TABLE "AIJob" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT,
    "operation" "AIOperation" NOT NULL,
    "status" "AIJobStatus" NOT NULL DEFAULT 'PENDING',
    "providerName" TEXT NOT NULL,
    "providerKind" "AIProviderKind" NOT NULL,
    "model" TEXT,
    "promptName" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "promptHash" TEXT NOT NULL,
    "inputHash" TEXT NOT NULL,
    "input" JSONB NOT NULL DEFAULT '{}',
    "output" JSONB,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "repairAttempts" INTEGER NOT NULL DEFAULT 0,
    "validationErrors" JSONB NOT NULL DEFAULT '[]',
    "errorKind" TEXT,
    "error" TEXT,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "costUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "latencyMs" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AIJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AIUsageLog" (
    "id" TEXT NOT NULL,
    "aiJobId" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "providerName" TEXT NOT NULL,
    "providerKind" "AIProviderKind" NOT NULL,
    "model" TEXT,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheReadTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheWriteTokens" INTEGER NOT NULL DEFAULT 0,
    "costUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "latencyMs" INTEGER NOT NULL DEFAULT 0,
    "ok" BOOLEAN NOT NULL DEFAULT true,
    "errorKind" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AIUsageLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AIJob_workspaceId_operation_createdAt_idx" ON "AIJob"("workspaceId", "operation", "createdAt");

-- CreateIndex
CREATE INDEX "AIJob_projectId_createdAt_idx" ON "AIJob"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "AIJob_status_idx" ON "AIJob"("status");

-- CreateIndex
CREATE INDEX "AIJob_inputHash_idx" ON "AIJob"("inputHash");

-- CreateIndex
CREATE INDEX "AIUsageLog_createdAt_idx" ON "AIUsageLog"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AIUsageLog_aiJobId_attempt_key" ON "AIUsageLog"("aiJobId", "attempt");

-- AddForeignKey
ALTER TABLE "AIJob" ADD CONSTRAINT "AIJob_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AIJob" ADD CONSTRAINT "AIJob_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AIUsageLog" ADD CONSTRAINT "AIUsageLog_aiJobId_fkey" FOREIGN KEY ("aiJobId") REFERENCES "AIJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
