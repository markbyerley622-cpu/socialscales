-- AlterEnum
ALTER TYPE "AIOperation" ADD VALUE 'CREATIVE_TREATMENT';

-- AlterTable
ALTER TABLE "ContentVariant" ADD COLUMN     "aiJobId" TEXT,
ADD COLUMN     "ctaPlacement" TEXT,
ADD COLUMN     "deliversKeyMessage" BOOLEAN,
ADD COLUMN     "generatedBy" TEXT,
ADD COLUMN     "hookFamily" TEXT,
ADD COLUMN     "keyMessageNote" TEXT,
ADD COLUMN     "model" TEXT,
ADD COLUMN     "narrativeStructure" TEXT,
ADD COLUMN     "promptVersion" TEXT,
ADD COLUMN     "treatment" JSONB;

-- CreateIndex
CREATE INDEX "ContentVariant_hookFamily_idx" ON "ContentVariant"("hookFamily");
