-- CreateEnum
CREATE TYPE "FailureCategory" AS ENUM ('AUTH_SESSION', 'SELECTOR_DRIFT', 'TRANSIENT', 'PLATFORM_REJECTED', 'MEDIA_REJECTED', 'HUMAN_ACTION_REQUIRED', 'BLOCKED_DISCONNECTED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "AdapterMode" AS ENUM ('OFFICIAL_API', 'BROWSER_ASSISTED', 'SIMULATED');

-- CreateEnum
CREATE TYPE "PublishStage" AS ENUM ('QUEUED', 'PREFLIGHT', 'SESSION_RESTORED', 'AUTHENTICATED', 'COMPOSER_OPENED', 'MEDIA_UPLOADED', 'METADATA_ENTERED', 'SUBMITTED', 'CONFIRMED', 'VERIFIED');

-- AlterEnum
ALTER TYPE "AccountStatus" ADD VALUE 'CHALLENGE';

-- AlterEnum
ALTER TYPE "JobStatus" ADD VALUE 'BLOCKED';

-- AlterTable
ALTER TABLE "PlatformSession" ADD COLUMN     "profileKey" TEXT;

-- AlterTable
ALTER TABLE "PostPlatform" ADD COLUMN     "adapterMode" "AdapterMode",
ADD COLUMN     "platformAccountId" TEXT,
ADD COLUMN     "verificationMethod" TEXT,
ADD COLUMN     "verifiedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "PublishAttempt" ADD COLUMN     "adapterMode" "AdapterMode",
ADD COLUMN     "failureCategory" "FailureCategory",
ADD COLUMN     "stageReached" "PublishStage" NOT NULL DEFAULT 'QUEUED';
