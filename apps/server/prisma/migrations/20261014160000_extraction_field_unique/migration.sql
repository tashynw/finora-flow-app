-- One field of one attempt. labelText is the field name.
CREATE UNIQUE INDEX "document_extractions_documentId_attempt_labelText_key"
ON "document_extractions"("documentId", "attempt", "labelText");
