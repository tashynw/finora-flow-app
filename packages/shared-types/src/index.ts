/**
 * Shared API contract types.
 *
 * `src/generated/api.ts` is produced from the API's own OpenAPI schema and must
 * never be hand-edited. Regenerate both the schema and the types with
 * `pnpm schema:generate` from the repository root.
 *
 * This file gives the generated schemas readable names. It deliberately adds no
 * types of its own for anything the API returns, so the browser cannot hold a
 * belief about a response shape that the API does not actually guarantee.
 *
 * The OpenAPI component namespace is flat, so a name that reads naturally inside
 * one router — `DraftRequest`, `ActionsOut` — collides with the same name in
 * another. The generator resolves a collision by emitting the Python import path
 * as the type name, which is both unreadable and unstable: it appears and vanishes
 * as models drift into and out of structural equality. Every model that could
 * collide therefore carries its record type in its name on the API side.
 */

import type { components, operations, paths } from './generated/api.js';

export type { components, operations, paths };

type Schemas = components['schemas'];

export type AcceptRequest = Schemas['AcceptRequest'];
export type AcknowledgeRequest = Schemas['AcknowledgeRequest'];
export type AdjustmentOut = Schemas['AdjustmentOut'];
export type ApprovalAssignRequest = Schemas['ApprovalAssignRequest'];
export type ApprovalAssignmentOut = Schemas['ApprovalAssignmentOut'];
export type ApprovalCoverRequest = Schemas['ApprovalCoverRequest'];
export type ApprovalDelegationOut = Schemas['ApprovalDelegationOut'];
export type ApprovalLevel = Schemas['ApprovalLevel'];
export type ApprovalOutcome = Schemas['ApprovalOutcome'];
export type ApprovalPersonOut = Schemas['ApprovalPersonOut'];
export type ApprovalQueueItemOut = Schemas['ApprovalQueueItemOut'];
export type ApprovalQueueOut = Schemas['ApprovalQueueOut'];
export type AttachmentSummary = Schemas['AttachmentSummary'];
export type AttemptSummary = Schemas['AttemptSummary'];
export type AuthMethodsResponse = Schemas['AuthMethodsResponse'];
export type BacklogReport = Schemas['BacklogReport'];
export type BoxOut = Schemas['BoxOut'];
export type CheckInDetailOut = Schemas['CheckInDetailOut'];
export type CheckInLineOut = Schemas['CheckInLineOut'];
export type CheckInPage = Schemas['CheckInPage'];
export type CheckInReviewRequest = Schemas['CheckInReviewRequest'];
export type CheckInStanding = Schemas['CheckInStanding'];
export type CheckInSummary = Schemas['CheckInSummary'];
export type CheckpointReport = Schemas['CheckpointReport'];
export type ClaimChannel = Schemas['ClaimChannel'];
export type ClaimOutcome = Schemas['ClaimOutcome'];
export type ConfidenceBand = Schemas['ConfidenceBand'];
export type CorrectionRequest = Schemas['CorrectionRequest'];
export type CreditCardCloseBody = Schemas['CreditCardCloseBody'];
export type CreditCardCodeBody = Schemas['CreditCardCodeBody'];
export type CreditCardCreate = Schemas['CreditCardCreate'];
export type CreditCardDisposeBody = Schemas['CreditCardDisposeBody'];
export type CreditCardMoneyOut = Schemas['CreditCardMoneyOut'];
export type CreditCardPeriodDetail = Schemas['CreditCardPeriodDetail'];
export type CreditCardPeriodSummary = Schemas['CreditCardPeriodSummary'];
export type CreditCardReceiptBody = Schemas['CreditCardReceiptBody'];
export type CreditCardReferenceRef = Schemas['CreditCardReferenceRef'];
export type CreditCardStanding = Schemas['finora__domain__credit_cards__PeriodStanding'];
export type CreditCardSummary = Schemas['CreditCardSummary'];
export type CreditCardTransactionOut = Schemas['CreditCardTransactionOut'];
export type AccrualCandidateEdit = Schemas['AccrualEditCandidateBody'];
export type AccrualCandidateFinalize = Schemas['AccrualFinalizeCandidateBody'];
export type AccrualCandidateOut = Schemas['AccrualCandidateOut'];
export type AccrualExportRequest = Schemas['AccrualExportBody'];
export type AccrualExportSummary = Schemas['AccrualExportOut'];
export type AccrualMoneyOut = Schemas['AccrualMoneyOut'];
export type AccrualPeriodDetail = Schemas['AccrualPeriodDetail'];
export type AccrualPeriodLock = Schemas['AccrualLockBody'];
export type AccrualPeriodOpen = Schemas['AccrualOpenBody'];
export type AccrualPeriodSummary = Schemas['AccrualPeriodSummary'];
export type AccrualStanding = Schemas['finora__domain__accruals__PeriodStanding'];
export type AccrualCandidateStanding = Schemas['CandidateStanding'];
export type CurrentUserResponse = Schemas['CurrentUserResponse'];
export type DependencyReport = Schemas['DependencyReport'];
export type DependencyState = Schemas['DependencyState'];
export type DocumentDetail = Schemas['DocumentDetail'];
export type DocumentKind = Schemas['DocumentKind'];
export type DocumentPage = Schemas['DocumentPage'];
export type DocumentSignal = Schemas['DocumentSignal'];
export type DocumentSummary = Schemas['DocumentSummary'];
export type EstimateActionsOut = Schemas['EstimateActionsOut'];
export type EstimateCreateRequest = Schemas['EstimateCreateRequest'];
export type EstimateDecisionRequest = Schemas['EstimateDecisionRequest'];
export type EstimateDetail = Schemas['EstimateDetail'];
export type EstimateDraftRequest = Schemas['EstimateDraftRequest'];
export type EstimatePage = Schemas['EstimatePage'];
export type EstimateProblem = Schemas['EstimateProblem'];
export type EstimateProblemOut = Schemas['EstimateProblemOut'];
export type EstimateReasonRequest = Schemas['EstimateReasonRequest'];
export type EstimateSummary = Schemas['EstimateSummary'];
export type EvidenceOut = Schemas['EvidenceOut'];
export type ExtractionOut = Schemas['ExtractionOut'];
export type ExtractionStatus = Schemas['ExtractionStatus'];
export type FieldName = Schemas['FieldName'];
export type FieldOrigin = Schemas['FieldOrigin'];
export type FieldOut = Schemas['FieldOut'];
export type FieldReview = Schemas['FieldReview'];
export type IntakeSource = Schemas['IntakeSource'];
export type IntakeStatus = Schemas['IntakeStatus'];
export type InvoiceActionsOut = Schemas['InvoiceActionsOut'];
export type InvoiceCreateRequest = Schemas['InvoiceCreateRequest'];
export type InvoiceDecisionRequest = Schemas['InvoiceDecisionRequest'];
export type InvoiceDetail = Schemas['InvoiceDetail'];
export type InvoiceDraftRequest = Schemas['InvoiceDraftRequest'];
export type InvoicePage = Schemas['InvoicePage'];
export type InvoiceProblem = Schemas['InvoiceProblem'];
export type InvoiceProblemOut = Schemas['InvoiceProblemOut'];
export type InvoiceReasonRequest = Schemas['InvoiceReasonRequest'];
export type InvoiceReferenceData = Schemas['InvoiceReferenceData'];
export type InvoiceSummary = Schemas['InvoiceSummary'];
export type LinkedEstimateOut = Schemas['LinkedEstimateOut'];
export type LinkedPurchaseOrderOut = Schemas['LinkedPurchaseOrderOut'];
export type LivenessResponse = Schemas['LivenessResponse'];
export type MailboxReport = Schemas['MailboxReport'];
export type MatrixAuditOut = Schemas['MatrixAuditOut'];
export type MatrixNoteOut = Schemas['MatrixNoteOut'];
export type MatrixOut = Schemas['MatrixOut'];
export type MatrixReadingOut = Schemas['MatrixReadingOut'];
export type MatrixRetireRequest = Schemas['MatrixRetireRequest'];
export type MatrixRuleOut = Schemas['MatrixRuleOut'];
export type MatrixRuleRequest = Schemas['MatrixRuleRequest'];
export type MessageDetail = Schemas['MessageDetail'];
export type MessagePage = Schemas['MessagePage'];
export type MessageSummary = Schemas['MessageSummary'];
export type NamedRefOut = Schemas['NamedRefOut'];
export type OperationsReport = Schemas['OperationsReport'];
export type AddLinesRequest = Schemas['AddLinesRequest'];
export type AddLinesResponse = Schemas['AddLinesResponse'];
export type EligibleInvoiceOut = Schemas['EligibleInvoiceOut'];
export type ManifestOut = Schemas['ManifestOut'];
export type MoneyOut = Schemas['MoneyOut'];
export type PackageDraftRequest = Schemas['PackageDraftRequest'];
export type PackageLineOut = Schemas['PackageLineOut'];
export type PackageProblem = Schemas['PackageProblem'];
export type PackageProblemOut = Schemas['PackageProblemOut'];
export type PackageReasonRequest = Schemas['PackageReasonRequest'];
export type PackageStanding = Schemas['PackageStanding'];
export type PackageSubmitRequest = Schemas['PackageSubmitRequest'];
export type PackageSubmitResponse = Schemas['PackageSubmitResponse'];
export type PaymentMethod = Schemas['PaymentMethod'];
export type PaymentPackageDetail = Schemas['PaymentPackageDetail'];
export type PaymentPackagePage = Schemas['PaymentPackagePage'];
export type PaymentPackageSummary = Schemas['PaymentPackageSummary'];
export type PlannedStepOut = Schemas['PlannedStepOut'];
export type PurchaseOrderAmendRequest = Schemas['PurchaseOrderAmendRequest'];
export type PurchaseOrderDecisionRequest = Schemas['PurchaseOrderDecisionRequest'];
export type PurchaseOrderDetail = Schemas['PurchaseOrderDetail'];
export type PurchaseOrderDraftRequest = Schemas['PurchaseOrderDraftRequest'];
export type PurchaseOrderPage = Schemas['PurchaseOrderPage'];
export type PurchaseOrderProblemOut = Schemas['PurchaseOrderProblemOut'];
export type PurchaseOrderReasonRequest = Schemas['PurchaseOrderReasonRequest'];
export type PurchaseOrderReferenceData = Schemas['PurchaseOrderReferenceData'];
export type PurchaseOrderSummary = Schemas['PurchaseOrderSummary'];
export type RaisedRecordOut = Schemas['RaisedRecordOut'];
export type RegisterSummaryOut = Schemas['RegisterSummaryOut'];
export type RegisterStatOut = Schemas['RegisterStatOut'];
export type RegisterSliceOut = Schemas['RegisterSliceOut'];
export type RaiseRequest = Schemas['RaiseRequest'];
export type RaiseResponse = Schemas['RaiseResponse'];
export type RecordAnswerRequest = Schemas['RecordAnswerRequest'];
export type RefusedOut = Schemas['RefusedOut'];
export type ReadRequested = Schemas['ReadRequested'];
export type ReadinessResponse = Schemas['ReadinessResponse'];
export type ReferenceData = Schemas['ReferenceData'];
export type ReminderPurpose = Schemas['ReminderPurpose'];
export type ResolveRequest = Schemas['ResolveRequest'];
export type ResolvedOut = Schemas['ResolvedOut'];
export type ReviewOutcome = Schemas['ReviewOutcome'];
export type ReviewRequest = Schemas['ReviewRequest'];
export type RouteOut = Schemas['RouteOut'];
export type RoutePreviewOut = Schemas['RoutePreviewOut'];
export type RouteState = Schemas['RouteState'];
export type ScanVerdict = Schemas['ScanVerdict'];
export type SignInRequest = Schemas['SignInRequest'];
export type SignOffOut = Schemas['SignOffOut'];
export type SignOffRequest = Schemas['SignOffRequest'];
export type SignalOut = Schemas['SignalOut'];
export type SignedUrlResponse = Schemas['SignedUrlResponse'];
export type StepOut = Schemas['StepOut'];
export type StepState = Schemas['StepState'];
export type SuggestionOut = Schemas['SuggestionOut'];
export type TransitionOut = Schemas['TransitionOut'];
export type UploadAccepted = Schemas['UploadAccepted'];
export type ValidationError = Schemas['ValidationError'];
export type VendorAnswerRequest = Schemas['VendorAnswerRequest'];
export type VendorAnswerResponse = Schemas['VendorAnswerResponse'];
export type VendorLineOut = Schemas['VendorLineOut'];
export type VendorQuestionOut = Schemas['VendorQuestionOut'];
export type ViewerUrl = Schemas['ViewerUrl'];

// `WorkflowState` is deliberately not re-exported. `@/lib/workflow` owns that
// union together with the labels and descriptions the interface renders, and two
// exported names for one set of states would let a screen import the one without
// the wording.

/**
 * Error body shape used by every non-2xx response.
 *
 * This is asserted by an API test rather than described in the OpenAPI schema,
 * because FastAPI documents only the validation error model by default.
 */
export interface ApiProblem {
  code: string;
  detail: string;
  fields?: { field: string; message: string }[];
}
