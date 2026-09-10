-- CreateEnum
CREATE TYPE "DistributionFit" AS ENUM ('READY', 'NEEDS_OPTIMIZATION', 'BLOCKED');

-- CreateEnum
CREATE TYPE "DistributionStatus" AS ENUM ('ASSESSED', 'OPTIMIZING', 'DISPATCHED', 'EXPORTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DistributionRoute" AS ENUM ('AUTOMATED', 'MANUAL');

-- CreateTable
CREATE TABLE "Distribution" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "fit" "DistributionFit" NOT NULL,
    "status" "DistributionStatus" NOT NULL DEFAULT 'ASSESSED',
    "route" "DistributionRoute",
    "issues" JSONB NOT NULL DEFAULT '[]',
    "caption" TEXT NOT NULL,
    "hashtags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "optimizedFromAssetId" TEXT,
    "optimizeRenderJobId" TEXT,
    "postId" TEXT,
    "dispatchedAt" TIMESTAMP(3),
    "exportedAt" TIMESTAMP(3),
    "exportedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Distribution_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Distribution_projectId_status_idx" ON "Distribution"("projectId", "status");

-- CreateIndex
CREATE INDEX "Distribution_variantId_idx" ON "Distribution"("variantId");

-- CreateIndex
CREATE UNIQUE INDEX "Distribution_assetId_platform_key" ON "Distribution"("assetId", "platform");

-- AddForeignKey
ALTER TABLE "Distribution" ADD CONSTRAINT "Distribution_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Distribution" ADD CONSTRAINT "Distribution_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ContentVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Distribution" ADD CONSTRAINT "Distribution_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "ContentAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Distribution" ADD CONSTRAINT "Distribution_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Distribution" ADD CONSTRAINT "Distribution_exportedById_fkey" FOREIGN KEY ("exportedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
