-- CreateEnum
CREATE TYPE "RenderStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "RenderStage" AS ENUM ('QUEUED', 'VALIDATING', 'PREPARING', 'CLIPPING', 'ASSEMBLING', 'ENCODING', 'PROBING', 'REGISTERING', 'CLEANUP', 'DONE');

-- CreateEnum
CREATE TYPE "AssetOrigin" AS ENUM ('UPLOAD', 'RENDER');

-- AlterTable
ALTER TABLE "ContentAsset" ADD COLUMN     "origin" "AssetOrigin" NOT NULL DEFAULT 'UPLOAD';

-- CreateTable
CREATE TABLE "RenderJob" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "status" "RenderStatus" NOT NULL DEFAULT 'PENDING',
    "stage" "RenderStage" NOT NULL DEFAULT 'QUEUED',
    "idempotencyKey" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "sourceAssetIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "outputAssetId" TEXT,
    "outputKey" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "failureStage" "RenderStage",
    "errorKind" TEXT,
    "error" TEXT,
    "logExcerpt" TEXT,
    "outputProbe" JSONB,
    "provider" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RenderJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RenderJob_idempotencyKey_key" ON "RenderJob"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "RenderJob_outputAssetId_key" ON "RenderJob"("outputAssetId");

-- CreateIndex
CREATE INDEX "RenderJob_projectId_status_idx" ON "RenderJob"("projectId", "status");

-- CreateIndex
CREATE INDEX "RenderJob_variantId_createdAt_idx" ON "RenderJob"("variantId", "createdAt");

-- CreateIndex
CREATE INDEX "RenderJob_status_startedAt_idx" ON "RenderJob"("status", "startedAt");

-- AddForeignKey
ALTER TABLE "RenderJob" ADD CONSTRAINT "RenderJob_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RenderJob" ADD CONSTRAINT "RenderJob_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ContentVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RenderJob" ADD CONSTRAINT "RenderJob_outputAssetId_fkey" FOREIGN KEY ("outputAssetId") REFERENCES "ContentAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;
