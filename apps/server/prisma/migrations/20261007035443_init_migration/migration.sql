-- CreateEnum
CREATE TYPE "Role" AS ENUM ('REQUESTER', 'APPROVER', 'PAYMENT_COORDINATOR', 'FINANCE', 'ADMINISTRATOR', 'OPERATIONS', 'AUDITOR');

-- CreateEnum
CREATE TYPE "Currency" AS ENUM ('JMD', 'USD');

-- CreateEnum
CREATE TYPE "ApprovalLevel" AS ENUM ('UNIT_HEAD', 'MANAGER', 'HOD', 'COO');

-- CreateEnum
CREATE TYPE "ApprovalRecordType" AS ENUM ('ESTIMATE', 'INVOICE', 'PURCHASE_ORDER');

-- CreateEnum
CREATE TYPE "EstimateStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'CANCELLED', 'EXCEPTION');

-- CreateEnum
CREATE TYPE "PurchaseOrderStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('DRAFT', 'PENDING_SIGN_OFF', 'PENDING_APPROVAL', 'APPROVED', 'READY_FOR_SUBMISSION', 'SUBMITTED', 'PAID', 'OUTSTANDING', 'EXCEPTION', 'ACCRUAL_NEEDED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ApprovalRequestStatus" AS ENUM ('OPEN', 'APPROVED', 'REJECTED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "ApprovalStepStatus" AS ENUM ('WAITING', 'READY', 'APPROVED', 'REJECTED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "PaymentPackageStatus" AS ENUM ('OPEN', 'SUBMITTED', 'CANCELLED');

-- CreateTable
CREATE TABLE "user" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "image" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "role" TEXT,
    "banned" BOOLEAN DEFAULT false,
    "banReason" TEXT,
    "banExpires" TIMESTAMP(3),
    "jobTitle" TEXT,
    "outOfOfficeUntil" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "archivedReason" TEXT,
    "departmentId" TEXT,
    "delegateToId" TEXT,

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session" (
    "id" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "token" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "userId" TEXT NOT NULL,
    "impersonatedBy" TEXT,

    CONSTRAINT "session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "idToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "refreshTokenExpiresAt" TIMESTAMP(3),
    "scope" TEXT,
    "password" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "verification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "departments" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "costCentreNumber" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "departments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_assignments" (
    "id" TEXT NOT NULL,
    "level" "ApprovalLevel" NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "userId" TEXT NOT NULL,
    "departmentId" TEXT,

    CONSTRAINT "approval_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_rules" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "recordType" "ApprovalRecordType" NOT NULL,
    "level" "ApprovalLevel" NOT NULL,
    "minAmountMinorUnits" BIGINT NOT NULL,
    "maxAmountMinorUnits" BIGINT,
    "currency" "Currency" NOT NULL,
    "stepOrder" INTEGER NOT NULL,
    "isParallel" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "retiredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdById" TEXT,
    "departmentId" TEXT,

    CONSTRAINT "approval_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_settings" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "description" TEXT,
    "changeReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "system_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_order_thresholds" (
    "id" TEXT NOT NULL,
    "currency" "Currency" NOT NULL,
    "appliesAboveMinorUnits" BIGINT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "purchase_order_thresholds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mailbox_checkpoints" (
    "id" TEXT NOT NULL,
    "folder" TEXT NOT NULL,
    "uidValidity" BIGINT NOT NULL,
    "lastSeenUid" BIGINT NOT NULL,
    "lastPolledAt" TIMESTAMP(3),
    "lastResetAt" TIMESTAMP(3),
    "lastResetReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mailbox_checkpoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendors" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "taxRegistrationNumber" TEXT,
    "defaultCurrency" "Currency" NOT NULL DEFAULT 'JMD',
    "paymentTermsDays" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "bankName" TEXT,
    "bankAccountMasked" TEXT,
    "bankDetailsUpdatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "archivedAt" TIMESTAMP(3),
    "archivedReason" TEXT,

    CONSTRAINT "vendors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gl_accounts" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),
    "archivedReason" TEXT,

    CONSTRAINT "gl_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cost_centres" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),
    "archivedReason" TEXT,
    "departmentId" TEXT,

    CONSTRAINT "cost_centres_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inbound_messages" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "rawSha256" TEXT NOT NULL,
    "rawObjectKey" TEXT NOT NULL,
    "rawSizeBytes" BIGINT NOT NULL,
    "imapFolder" TEXT,
    "imapUid" BIGINT,
    "imapUidValidity" BIGINT,
    "messageId" TEXT,
    "subject" TEXT NOT NULL,
    "fromAddress" TEXT,
    "fromDisplayName" TEXT,
    "replyToAddress" TEXT,
    "toAddresses" JSONB NOT NULL,
    "ccAddresses" JSONB NOT NULL,
    "deliveredToAddresses" JSONB NOT NULL,
    "forwardedFromAddress" TEXT,
    "forwardedShape" TEXT,
    "inReplyTo" TEXT,
    "references" JSONB NOT NULL,
    "correlationBasis" TEXT,
    "automaticKind" TEXT,
    "sentAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "bodyText" TEXT NOT NULL,
    "parseWarnings" JSONB NOT NULL,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "uploadedById" TEXT,

    CONSTRAINT "inbound_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "s3_document" (
    "id" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "sha256" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "bucket" TEXT NOT NULL,
    "documentProcessed" BOOLEAN NOT NULL DEFAULT false,
    "documentProcessedAt" TIMESTAMP(3),
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "messageId" TEXT NOT NULL,

    CONSTRAINT "s3_document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_extractions" (
    "id" TEXT NOT NULL,
    "labelText" TEXT NOT NULL,
    "valueText" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "isCurrent" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "kindConfidence" DOUBLE PRECISION NOT NULL,
    "kindEvidence" JSONB,
    "textSource" TEXT NOT NULL,
    "pageCount" INTEGER NOT NULL,
    "reviewThreshold" DOUBLE PRECISION NOT NULL,
    "lowThreshold" DOUBLE PRECISION NOT NULL,
    "signals" JSONB NOT NULL,
    "notes" JSONB NOT NULL,
    "injectionFindings" JSONB NOT NULL,
    "acknowledgedSignals" JSONB NOT NULL,
    "gatewayOutcome" TEXT,
    "modelName" TEXT,
    "promptId" TEXT,
    "promptVersion" INTEGER,
    "promptSha256" TEXT,
    "modelLatencyMs" INTEGER,
    "suggestionsDiscarded" INTEGER NOT NULL,
    "completedAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "acceptedAt" TIMESTAMP(3),
    "acceptedNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "documentId" TEXT NOT NULL,
    "acceptedById" TEXT,

    CONSTRAINT "document_extractions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "extraction_review" (
    "id" TEXT NOT NULL,
    "review" TEXT NOT NULL,
    "correctedAt" TIMESTAMP(3),
    "correctionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "documentExtractionId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "correctedById" TEXT,

    CONSTRAINT "extraction_review_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "estimates" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "status" "EstimateStatus" NOT NULL DEFAULT 'DRAFT',
    "estimateNumber" TEXT,
    "estimateDate" DATE,
    "neededBy" DATE,
    "currency" "Currency",
    "totalMinorUnits" BIGINT,
    "description" TEXT NOT NULL DEFAULT '',
    "justification" TEXT NOT NULL DEFAULT '',
    "submittedAt" TIMESTAMP(3),
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "archivedAt" TIMESTAMP(3),
    "archivedReason" TEXT,
    "requesterId" TEXT NOT NULL,
    "documentId" TEXT,
    "vendorId" TEXT,
    "costCentreId" TEXT,
    "glAccountId" TEXT,
    "submittedById" TEXT,
    "departmentId" TEXT,

    CONSTRAINT "estimates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_orders" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "status" "PurchaseOrderStatus" NOT NULL DEFAULT 'DRAFT',
    "currency" "Currency",
    "totalMinorUnits" BIGINT,
    "description" TEXT NOT NULL DEFAULT '',
    "submittedAt" TIMESTAMP(3),
    "openedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "closedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "archivedAt" TIMESTAMP(3),
    "archivedReason" TEXT,
    "raisedById" TEXT NOT NULL,
    "vendorId" TEXT,
    "costCentreId" TEXT,
    "glAccountId" TEXT,
    "estimateId" TEXT,
    "submittedById" TEXT,
    "closedById" TEXT,
    "departmentId" TEXT,

    CONSTRAINT "purchase_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'DRAFT',
    "invoiceNumber" TEXT,
    "invoiceDate" DATE,
    "dueDate" DATE,
    "currency" "Currency",
    "totalMinorUnits" BIGINT,
    "description" TEXT NOT NULL DEFAULT '',
    "signedOffAt" TIMESTAMP(3),
    "signOffNote" TEXT,
    "submittedAt" TIMESTAMP(3),
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "archivedAt" TIMESTAMP(3),
    "archivedReason" TEXT,
    "requesterId" TEXT,
    "createdById" TEXT NOT NULL,
    "documentId" TEXT,
    "vendorId" TEXT,
    "estimateId" TEXT,
    "purchaseOrderId" TEXT,
    "costCentreId" TEXT,
    "glAccountId" TEXT,
    "signedOffById" TEXT,
    "submittedById" TEXT,
    "departmentId" TEXT,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_requests" (
    "id" TEXT NOT NULL,
    "recordType" TEXT NOT NULL,
    "recordId" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "status" "ApprovalRequestStatus" NOT NULL DEFAULT 'OPEN',
    "currentStepOrder" INTEGER,
    "amountMinorUnits" BIGINT NOT NULL,
    "currency" "Currency" NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "requesterId" TEXT NOT NULL,
    "departmentId" TEXT,
    "estimateId" TEXT,
    "purchaseOrderId" TEXT,
    "invoiceId" TEXT,

    CONSTRAINT "approval_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_steps" (
    "id" TEXT NOT NULL,
    "stepOrder" INTEGER NOT NULL,
    "level" "ApprovalLevel" NOT NULL,
    "status" "ApprovalStepStatus" NOT NULL,
    "decidedAt" TIMESTAMP(3),
    "decidedByLabel" TEXT,
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "requestId" TEXT NOT NULL,
    "decidedById" TEXT,
    "onBehalfOfId" TEXT,

    CONSTRAINT "approval_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_packages" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "status" "PaymentPackageStatus" NOT NULL DEFAULT 'OPEN',
    "description" TEXT NOT NULL DEFAULT '',
    "paymentMethod" TEXT,
    "intendedPaymentDate" DATE,
    "submittedAt" TIMESTAMP(3),
    "submissionReference" TEXT,
    "manifestSha256" TEXT,
    "manifestLineCount" INTEGER,
    "cancelledAt" TIMESTAMP(3),
    "cancelledReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdById" TEXT NOT NULL,
    "submittedById" TEXT,
    "cancelledById" TEXT,

    CONSTRAINT "payment_packages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_package_lines" (
    "id" TEXT NOT NULL,
    "invoiceReference" TEXT NOT NULL,
    "invoiceNumber" TEXT,
    "currency" "Currency" NOT NULL,
    "amountMinorUnits" BIGINT NOT NULL,
    "dueDate" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "packageId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "vendorId" TEXT,
    "addedById" TEXT NOT NULL,

    CONSTRAINT "payment_package_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendor_check_ins" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "correlationTag" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3),
    "answeredAt" TIMESTAMP(3),
    "claim" TEXT,
    "claimChannel" TEXT,
    "respondentName" TEXT,
    "respondentNote" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewOutcome" TEXT,
    "reviewNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "packageId" TEXT NOT NULL,
    "vendorId" TEXT,
    "createdById" TEXT NOT NULL,
    "reviewedById" TEXT,

    CONSTRAINT "vendor_check_ins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_card_accounts" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "lastFour" TEXT NOT NULL,
    "cardholderName" TEXT NOT NULL,
    "currency" "Currency" NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "archivedAt" TIMESTAMP(3),
    "archivedReason" TEXT,

    CONSTRAINT "credit_card_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_card_periods" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "statementDate" DATE NOT NULL,
    "currency" "Currency" NOT NULL,
    "sourceSha256" TEXT NOT NULL,
    "sourceFilename" TEXT NOT NULL,
    "importedAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),
    "closeReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "cardId" TEXT NOT NULL,
    "importedById" TEXT NOT NULL,
    "closedById" TEXT,

    CONSTRAINT "credit_card_periods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_card_transactions" (
    "id" TEXT NOT NULL,
    "sourceRow" INTEGER NOT NULL,
    "postedOn" DATE NOT NULL,
    "merchant" TEXT NOT NULL,
    "cardholder" TEXT NOT NULL,
    "description" TEXT,
    "externalReference" TEXT,
    "amountMinorUnits" BIGINT NOT NULL,
    "currency" "Currency" NOT NULL,
    "category" TEXT,
    "exceptionReason" TEXT,
    "codedAt" TIMESTAMP(3),
    "receiptWaived" BOOLEAN NOT NULL DEFAULT false,
    "receiptWaiverReason" TEXT,
    "receiptMatchConfidence" DOUBLE PRECISION,
    "matchedAt" TIMESTAMP(3),
    "suggestionEvidence" JSONB,
    "suggestionDisposition" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "periodId" TEXT NOT NULL,
    "glAccountId" TEXT,
    "costCentreId" TEXT,
    "codedById" TEXT,
    "receiptDocumentId" TEXT,
    "matchedById" TEXT,
    "suggestedGlAccountId" TEXT,
    "suggestedCostCentreId" TEXT,
    "suggestedReceiptDocumentId" TEXT,

    CONSTRAINT "credit_card_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accrual_periods" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "label" TEXT NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL,
    "lockedAt" TIMESTAMP(3),
    "lockReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "openedById" TEXT NOT NULL,
    "lockedById" TEXT,

    CONSTRAINT "accrual_periods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accrual_candidates" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "standing" TEXT NOT NULL,
    "currency" "Currency" NOT NULL,
    "amountMinorUnits" BIGINT NOT NULL,
    "originalAmountMinorUnits" BIGINT NOT NULL,
    "vendorName" TEXT NOT NULL,
    "invoiceNumber" TEXT,
    "invoiceReference" TEXT,
    "description" TEXT NOT NULL DEFAULT '',
    "editReason" TEXT,
    "note" TEXT,
    "finalizedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "periodId" TEXT NOT NULL,
    "invoiceId" TEXT,
    "glAccountId" TEXT,
    "costCentreId" TEXT,
    "finalizedById" TEXT,
    "departmentId" TEXT,

    CONSTRAINT "accrual_candidates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accrual_exports" (
    "id" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "official" BOOLEAN NOT NULL DEFAULT false,
    "filename" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "rowCount" INTEGER NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "periodId" TEXT NOT NULL,
    "generatedById" TEXT NOT NULL,

    CONSTRAINT "accrual_exports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_entries" (
    "id" TEXT NOT NULL,
    "sequence" BIGINT NOT NULL,
    "previousHash" TEXT NOT NULL,
    "entryHash" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "action" TEXT NOT NULL,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT,
    "actorLabel" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT,
    "correlationId" TEXT,
    "detail" JSONB NOT NULL,
    "sourceIp" TEXT,
    "userAgent" TEXT,

    CONSTRAINT "audit_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "state_transitions" (
    "id" TEXT NOT NULL,
    "recordType" TEXT NOT NULL,
    "recordId" TEXT NOT NULL,
    "fromState" TEXT NOT NULL,
    "toState" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "actorLabel" TEXT NOT NULL,
    "reason" TEXT,
    "correlationId" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "context" JSONB NOT NULL,
    "actorId" TEXT,

    CONSTRAINT "state_transitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "record_actions" (
    "id" TEXT NOT NULL,
    "recordType" TEXT NOT NULL,
    "recordId" TEXT NOT NULL,
    "permission" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT NOT NULL,

    CONSTRAINT "record_actions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_email_key" ON "user"("email");

-- CreateIndex
CREATE INDEX "session_userId_idx" ON "session"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "session_token_key" ON "session"("token");

-- CreateIndex
CREATE INDEX "account_userId_idx" ON "account"("userId");

-- CreateIndex
CREATE INDEX "verification_identifier_idx" ON "verification"("identifier");

-- CreateIndex
CREATE UNIQUE INDEX "departments_costCentreNumber_key" ON "departments"("costCentreNumber");

-- CreateIndex
CREATE UNIQUE INDEX "approval_assignments_level_userId_departmentId_key" ON "approval_assignments"("level", "userId", "departmentId");

-- CreateIndex
CREATE UNIQUE INDEX "system_settings_key_key" ON "system_settings"("key");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_order_thresholds_currency_key" ON "purchase_order_thresholds"("currency");

-- CreateIndex
CREATE UNIQUE INDEX "mailbox_checkpoints_folder_key" ON "mailbox_checkpoints"("folder");

-- CreateIndex
CREATE UNIQUE INDEX "vendors_code_key" ON "vendors"("code");

-- CreateIndex
CREATE UNIQUE INDEX "gl_accounts_code_key" ON "gl_accounts"("code");

-- CreateIndex
CREATE UNIQUE INDEX "cost_centres_code_key" ON "cost_centres"("code");

-- CreateIndex
CREATE UNIQUE INDEX "inbound_messages_idempotencyKey_key" ON "inbound_messages"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "estimates_reference_key" ON "estimates"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "estimates_documentId_key" ON "estimates"("documentId");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_orders_number_key" ON "purchase_orders"("number");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_reference_key" ON "invoices"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_documentId_key" ON "invoices"("documentId");

-- CreateIndex
CREATE UNIQUE INDEX "approval_requests_recordType_recordId_attempt_key" ON "approval_requests"("recordType", "recordId", "attempt");

-- CreateIndex
CREATE UNIQUE INDEX "approval_steps_requestId_stepOrder_level_key" ON "approval_steps"("requestId", "stepOrder", "level");

-- CreateIndex
CREATE UNIQUE INDEX "payment_packages_reference_key" ON "payment_packages"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "payment_package_lines_invoiceId_key" ON "payment_package_lines"("invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "vendor_check_ins_reference_key" ON "vendor_check_ins"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "vendor_check_ins_correlationTag_key" ON "vendor_check_ins"("correlationTag");

-- CreateIndex
CREATE UNIQUE INDEX "vendor_check_ins_packageId_vendorId_key" ON "vendor_check_ins"("packageId", "vendorId");

-- CreateIndex
CREATE UNIQUE INDEX "credit_card_accounts_lastFour_cardholderName_key" ON "credit_card_accounts"("lastFour", "cardholderName");

-- CreateIndex
CREATE UNIQUE INDEX "credit_card_periods_reference_key" ON "credit_card_periods"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "credit_card_periods_cardId_sourceSha256_key" ON "credit_card_periods"("cardId", "sourceSha256");

-- CreateIndex
CREATE UNIQUE INDEX "credit_card_transactions_periodId_sourceRow_key" ON "credit_card_transactions"("periodId", "sourceRow");

-- CreateIndex
CREATE UNIQUE INDEX "accrual_periods_reference_key" ON "accrual_periods"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "accrual_candidates_periodId_reference_key" ON "accrual_candidates"("periodId", "reference");

-- CreateIndex
CREATE UNIQUE INDEX "accrual_candidates_periodId_invoiceId_key" ON "accrual_candidates"("periodId", "invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "accrual_exports_periodId_version_key" ON "accrual_exports"("periodId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "audit_entries_sequence_key" ON "audit_entries"("sequence");

-- CreateIndex
CREATE UNIQUE INDEX "audit_entries_entryHash_key" ON "audit_entries"("entryHash");

-- CreateIndex
CREATE INDEX "audit_entries_subjectType_subjectId_idx" ON "audit_entries"("subjectType", "subjectId");

-- CreateIndex
CREATE INDEX "state_transitions_recordType_recordId_idx" ON "state_transitions"("recordType", "recordId");

-- CreateIndex
CREATE UNIQUE INDEX "record_actions_recordType_recordId_userId_permission_key" ON "record_actions"("recordType", "recordId", "userId", "permission");

-- AddForeignKey
ALTER TABLE "user" ADD CONSTRAINT "user_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user" ADD CONSTRAINT "user_delegateToId_fkey" FOREIGN KEY ("delegateToId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session" ADD CONSTRAINT "session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account" ADD CONSTRAINT "account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_assignments" ADD CONSTRAINT "approval_assignments_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_assignments" ADD CONSTRAINT "approval_assignments_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_rules" ADD CONSTRAINT "approval_rules_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_rules" ADD CONSTRAINT "approval_rules_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_centres" ADD CONSTRAINT "cost_centres_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inbound_messages" ADD CONSTRAINT "inbound_messages_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "s3_document" ADD CONSTRAINT "s3_document_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "inbound_messages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_extractions" ADD CONSTRAINT "document_extractions_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "s3_document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_extractions" ADD CONSTRAINT "document_extractions_acceptedById_fkey" FOREIGN KEY ("acceptedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "extraction_review" ADD CONSTRAINT "extraction_review_documentExtractionId_fkey" FOREIGN KEY ("documentExtractionId") REFERENCES "document_extractions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "extraction_review" ADD CONSTRAINT "extraction_review_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "extraction_review" ADD CONSTRAINT "extraction_review_correctedById_fkey" FOREIGN KEY ("correctedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "estimates" ADD CONSTRAINT "estimates_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "estimates" ADD CONSTRAINT "estimates_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "s3_document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "estimates" ADD CONSTRAINT "estimates_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "vendors"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "estimates" ADD CONSTRAINT "estimates_costCentreId_fkey" FOREIGN KEY ("costCentreId") REFERENCES "cost_centres"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "estimates" ADD CONSTRAINT "estimates_glAccountId_fkey" FOREIGN KEY ("glAccountId") REFERENCES "gl_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "estimates" ADD CONSTRAINT "estimates_submittedById_fkey" FOREIGN KEY ("submittedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "estimates" ADD CONSTRAINT "estimates_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_raisedById_fkey" FOREIGN KEY ("raisedById") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "vendors"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_costCentreId_fkey" FOREIGN KEY ("costCentreId") REFERENCES "cost_centres"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_glAccountId_fkey" FOREIGN KEY ("glAccountId") REFERENCES "gl_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_estimateId_fkey" FOREIGN KEY ("estimateId") REFERENCES "estimates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_submittedById_fkey" FOREIGN KEY ("submittedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_closedById_fkey" FOREIGN KEY ("closedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "s3_document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "vendors"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_estimateId_fkey" FOREIGN KEY ("estimateId") REFERENCES "estimates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "purchase_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_costCentreId_fkey" FOREIGN KEY ("costCentreId") REFERENCES "cost_centres"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_glAccountId_fkey" FOREIGN KEY ("glAccountId") REFERENCES "gl_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_signedOffById_fkey" FOREIGN KEY ("signedOffById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_submittedById_fkey" FOREIGN KEY ("submittedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_estimateId_fkey" FOREIGN KEY ("estimateId") REFERENCES "estimates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "purchase_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_steps" ADD CONSTRAINT "approval_steps_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "approval_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_steps" ADD CONSTRAINT "approval_steps_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_steps" ADD CONSTRAINT "approval_steps_onBehalfOfId_fkey" FOREIGN KEY ("onBehalfOfId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_packages" ADD CONSTRAINT "payment_packages_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_packages" ADD CONSTRAINT "payment_packages_submittedById_fkey" FOREIGN KEY ("submittedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_packages" ADD CONSTRAINT "payment_packages_cancelledById_fkey" FOREIGN KEY ("cancelledById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_package_lines" ADD CONSTRAINT "payment_package_lines_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "payment_packages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_package_lines" ADD CONSTRAINT "payment_package_lines_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_package_lines" ADD CONSTRAINT "payment_package_lines_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "vendors"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_package_lines" ADD CONSTRAINT "payment_package_lines_addedById_fkey" FOREIGN KEY ("addedById") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_check_ins" ADD CONSTRAINT "vendor_check_ins_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "payment_packages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_check_ins" ADD CONSTRAINT "vendor_check_ins_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "vendors"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_check_ins" ADD CONSTRAINT "vendor_check_ins_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_check_ins" ADD CONSTRAINT "vendor_check_ins_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_card_periods" ADD CONSTRAINT "credit_card_periods_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "credit_card_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_card_periods" ADD CONSTRAINT "credit_card_periods_importedById_fkey" FOREIGN KEY ("importedById") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_card_periods" ADD CONSTRAINT "credit_card_periods_closedById_fkey" FOREIGN KEY ("closedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_card_transactions" ADD CONSTRAINT "credit_card_transactions_periodId_fkey" FOREIGN KEY ("periodId") REFERENCES "credit_card_periods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_card_transactions" ADD CONSTRAINT "credit_card_transactions_glAccountId_fkey" FOREIGN KEY ("glAccountId") REFERENCES "gl_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_card_transactions" ADD CONSTRAINT "credit_card_transactions_costCentreId_fkey" FOREIGN KEY ("costCentreId") REFERENCES "cost_centres"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_card_transactions" ADD CONSTRAINT "credit_card_transactions_codedById_fkey" FOREIGN KEY ("codedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_card_transactions" ADD CONSTRAINT "credit_card_transactions_receiptDocumentId_fkey" FOREIGN KEY ("receiptDocumentId") REFERENCES "s3_document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_card_transactions" ADD CONSTRAINT "credit_card_transactions_matchedById_fkey" FOREIGN KEY ("matchedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_card_transactions" ADD CONSTRAINT "credit_card_transactions_suggestedGlAccountId_fkey" FOREIGN KEY ("suggestedGlAccountId") REFERENCES "gl_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_card_transactions" ADD CONSTRAINT "credit_card_transactions_suggestedCostCentreId_fkey" FOREIGN KEY ("suggestedCostCentreId") REFERENCES "cost_centres"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_card_transactions" ADD CONSTRAINT "credit_card_transactions_suggestedReceiptDocumentId_fkey" FOREIGN KEY ("suggestedReceiptDocumentId") REFERENCES "s3_document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accrual_periods" ADD CONSTRAINT "accrual_periods_openedById_fkey" FOREIGN KEY ("openedById") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accrual_periods" ADD CONSTRAINT "accrual_periods_lockedById_fkey" FOREIGN KEY ("lockedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accrual_candidates" ADD CONSTRAINT "accrual_candidates_periodId_fkey" FOREIGN KEY ("periodId") REFERENCES "accrual_periods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accrual_candidates" ADD CONSTRAINT "accrual_candidates_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accrual_candidates" ADD CONSTRAINT "accrual_candidates_glAccountId_fkey" FOREIGN KEY ("glAccountId") REFERENCES "gl_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accrual_candidates" ADD CONSTRAINT "accrual_candidates_costCentreId_fkey" FOREIGN KEY ("costCentreId") REFERENCES "cost_centres"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accrual_candidates" ADD CONSTRAINT "accrual_candidates_finalizedById_fkey" FOREIGN KEY ("finalizedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accrual_candidates" ADD CONSTRAINT "accrual_candidates_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accrual_exports" ADD CONSTRAINT "accrual_exports_periodId_fkey" FOREIGN KEY ("periodId") REFERENCES "accrual_periods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accrual_exports" ADD CONSTRAINT "accrual_exports_generatedById_fkey" FOREIGN KEY ("generatedById") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "state_transitions" ADD CONSTRAINT "state_transitions_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "record_actions" ADD CONSTRAINT "record_actions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
