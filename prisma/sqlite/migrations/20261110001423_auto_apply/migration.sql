-- CreateTable
CREATE TABLE "ApplyAttempt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "applicationId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'FILLING',
    "url" TEXT NOT NULL,
    "ats" TEXT NOT NULL DEFAULT 'generic',
    "plan" JSONB,
    "message" TEXT,
    "screenshot" BLOB,
    "pageUrl" TEXT NOT NULL DEFAULT '',
    "confirmation" BLOB,
    "confirmationUrl" TEXT NOT NULL DEFAULT '',
    "submittedAt" DATETIME,
    "autoSubmitted" BOOLEAN NOT NULL DEFAULT false,
    "confirmationEmail" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ApplyAttempt_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "ApplyAttempt_applicationId_createdAt_idx" ON "ApplyAttempt"("applicationId", "createdAt");
