CREATE TABLE "signed_links" (
    "id" TEXT NOT NULL,
    "tokenSha256" TEXT NOT NULL,
    "recordType" TEXT NOT NULL,
    "recordId" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "issuedToId" TEXT,

    CONSTRAINT "signed_links_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "signed_links_tokenSha256_key" ON "signed_links"("tokenSha256");
CREATE INDEX "signed_links_recordType_recordId_idx" ON "signed_links"("recordType", "recordId");

ALTER TABLE "signed_links" ADD CONSTRAINT "signed_links_issuedToId_fkey" FOREIGN KEY ("issuedToId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
