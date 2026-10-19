-- AlterEnum
ALTER TYPE "PaymentPackageStatus" ADD VALUE 'COMPLETED';

-- AlterTable
ALTER TABLE "payment_packages" ADD COLUMN "completedAt" TIMESTAMP(3);
