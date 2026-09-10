-- AlterTable
ALTER TABLE "AIAnalysis" ADD COLUMN     "aiJobId" TEXT,
ADD COLUMN     "basis" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "confidence" "Confidence" NOT NULL DEFAULT 'LOW',
ADD COLUMN     "promptVersion" TEXT,
ADD COLUMN     "unknowns" TEXT[] DEFAULT ARRAY[]::TEXT[],
ALTER COLUMN "model" DROP NOT NULL;

-- AlterTable
ALTER TABLE "ContentAsset" ADD COLUMN     "briefId" TEXT;

-- CreateIndex
CREATE INDEX "ContentAsset_briefId_idx" ON "ContentAsset"("briefId");

-- AddForeignKey
ALTER TABLE "ContentAsset" ADD CONSTRAINT "ContentAsset_briefId_fkey" FOREIGN KEY ("briefId") REFERENCES "ContentBrief"("id") ON DELETE SET NULL ON UPDATE CASCADE;
