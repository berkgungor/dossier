-- CreateEnum
CREATE TYPE "ApplyStatus" AS ENUM ('FILLING', 'REVIEW', 'NEEDS_YOU', 'SUBMITTING', 'SUBMITTED', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "ApplyAttempt" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "status" "ApplyStatus" NOT NULL DEFAULT 'FILLING',
    "url" TEXT NOT NULL,
    "ats" TEXT NOT NULL DEFAULT 'generic',
    "plan" JSONB,
    "message" TEXT,
    "screenshot" BYTEA,
    "pageUrl" TEXT NOT NULL DEFAULT '',
    "confirmation" BYTEA,
    "confirmationUrl" TEXT NOT NULL DEFAULT '',
    "submittedAt" TIMESTAMP(3),
    "autoSubmitted" BOOLEAN NOT NULL DEFAULT false,
    "confirmationEmail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApplyAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ApplyAttempt_applicationId_createdAt_idx" ON "ApplyAttempt"("applicationId", "createdAt");

-- AddForeignKey
ALTER TABLE "ApplyAttempt" ADD CONSTRAINT "ApplyAttempt_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;
