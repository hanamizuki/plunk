-- CreateEnum
CREATE TYPE "ProjectDisabledReason" AS ENUM ('PAYMENT_FAILED', 'EMAIL_REPUTATION', 'PHISHING_DETECTED', 'MANUAL');

-- AlterTable
ALTER TABLE "projects" ADD COLUMN "disabledReason" "ProjectDisabledReason";
