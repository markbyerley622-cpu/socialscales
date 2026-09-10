-- CreateTable
CREATE TABLE "WorkerStatus" (
    "id" TEXT NOT NULL,
    "livePublishing" BOOLEAN NOT NULL,
    "aiProvider" TEXT NOT NULL,
    "queuePrefix" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "hostname" TEXT,

    CONSTRAINT "WorkerStatus_pkey" PRIMARY KEY ("id")
);
