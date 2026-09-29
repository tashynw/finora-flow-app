import { Navigate, Route, Routes, useLocation } from 'react-router-dom';

import { AppShell } from '@/layouts/app-shell';
import { SignInPage } from '@/features/auth/sign-in-page';
import { useAuth } from '@/features/auth/auth-context';
import { DashboardPage } from '@/features/dashboard/dashboard-page';
import { DocumentQueuePage } from '@/features/documents/document-queue-page';
import { DocumentReviewPage } from '@/features/documents/document-review-page';
import { EstimateDetailPage } from '@/features/estimates/estimate-detail-page';
import { EstimateRegisterPage } from '@/features/estimates/estimate-register-page';
import { InvoiceDetailPage } from '@/features/invoices/invoice-detail-page';
import { InvoiceRegisterPage } from '@/features/invoices/invoice-register-page';
import { SignedLinkPage } from '@/features/invoices/signed-link-page';
import { IntakeOperationsPage } from '@/features/intake/intake-operations-page';
import { IntakeQueuePage } from '@/features/intake/intake-queue-page';
import { MessageDetailPage } from '@/features/intake/message-detail-page';
import { SystemHealthPage } from '@/features/operations/system-health-page';
import { ApprovalQueuePage } from '@/features/approvals/approval-queue-page';
import { AssignmentsPage } from '@/features/administration/assignments-page';
import { DelegationPage } from '@/features/administration/delegation-page';
import { MatrixPage } from '@/features/administration/matrix-page';
import { UsersPage } from '@/features/administration/users-page';
import { ReferenceDataPage } from '@/features/administration/reference-data-page';
import { ThresholdsPage } from '@/features/administration/thresholds-page';
import { RetentionPage } from '@/features/administration/retention-page';
import { OperationalSettingsPage } from '@/features/administration/operational-settings-page';
import { ReportsPage } from '@/features/reports/reports-page';
import { PaymentPackageDetailPage } from '@/features/payments/payment-package-detail-page';
import { PaymentPackageRegisterPage } from '@/features/payments/payment-package-register-page';
import { AccrualPeriodPage } from '@/features/accruals/accrual-period-page';
import { AccrualRegisterPage } from '@/features/accruals/accrual-register-page';
import { WorkQueuePage } from '@/features/work/work-queue-page';
import { AuditTrailPage } from '@/features/audit/audit-trail-page';
import { CreditCardPeriodPage } from '@/features/credit-cards/credit-card-period-page';
import { CreditCardRegisterPage } from '@/features/credit-cards/credit-card-register-page';
import { PurchaseOrderDetailPage } from '@/features/purchase-orders/purchase-order-detail-page';
import { PurchaseOrderRegisterPage } from '@/features/purchase-orders/purchase-order-register-page';
import { VendorConfirmationDetailPage } from '@/features/vendor-confirmations/vendor-confirmation-detail-page';
import { VendorConfirmationRegisterPage } from '@/features/vendor-confirmations/vendor-confirmation-register-page';
import { NotFoundPage } from '@/features/shared/not-found-page';
import { ForbiddenPage } from '@/features/shared/forbidden-page';
import { FinoraMark } from '@/components/brand/finora-mark';

/**
 * Routing.
 *
 * Client-side permission checks keep a user out of a screen they cannot use;
 * the API's check is what actually protects the data.
 */

/**
 * Send an unauthenticated visitor to sign in, remembering where they were going.
 *
 * Written for the person who arrives from a link in an email. A reminder asking
 * them to confirm a delivery lands them on a token URL; bouncing them to the
 * dashboard after they sign in loses the token, and the only way back is to find
 * the email again. The intended location rides along in history state, which is
 * not part of the URL and so is never logged, bookmarked or shared.
 */
function SignInAndReturn() {
  const location = useLocation();
  return <Navigate to="/sign-in" replace state={{ from: location.pathname + location.search }} />;
}

/** After signing in, go where they were trying to go. */
function ReturnToIntendedPage() {
  const location = useLocation();
  const state = location.state as { from?: unknown } | null;
  // Only a path within this application is ever followed. An absolute URL in
  // history state would be an open redirect, and this state is reachable from a
  // link somebody else composed.
  const from =
    typeof state?.from === 'string' && state.from.startsWith('/') && !state.from.startsWith('//')
      ? state.from
      : '/';
  return <Navigate to={from} replace />;
}

export function App() {
  const { user, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div
        role="status"
        aria-live="polite"
        className="flex min-h-dvh flex-col items-center justify-center gap-4"
      >
        <FinoraMark showWordmark />
        <p className="m-0 text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]">
          Checking your session
        </p>
      </div>
    );
  }

  if (!user) {
    return (
      <Routes>
        <Route path="/sign-in" element={<SignInPage />} />
        <Route path="*" element={<SignInAndReturn />} />
      </Routes>
    );
  }

  const permissions = new Set(user.permissions);

  return (
    <AppShell>
      <Routes>
        <Route path="/sign-in" element={<ReturnToIntendedPage />} />
        <Route path="/" element={<DashboardPage />} />
        <Route
          path="/work"
          element={
            permissions.has('report:view') ? <WorkQueuePage /> : <ForbiddenPage />
          }
        />
        <Route
          path="/reports"
          element={
            permissions.has('report:view') ? <ReportsPage /> : <ForbiddenPage />
          }
        />
        <Route
          path="/audit"
          element={
            permissions.has('audit:view') ? <AuditTrailPage /> : <ForbiddenPage />
          }
        />
        <Route path="/operations" element={<SystemHealthPage />} />
        <Route
          path="/operations/intake"
          element={
            permissions.has('operations:view') ? (
              <IntakeOperationsPage />
            ) : (
              <ForbiddenPage />
            )
          }
        />

        {/* Checked here as well as in the API. The client-side check keeps a
            user out of a screen they cannot use; the API's check is what
            actually protects the data. */}
        <Route
          path="/intake"
          element={
            permissions.has('intake:view') ? (
              <IntakeQueuePage />
            ) : (
              <ForbiddenPage />
            )
          }
        />
        <Route
          path="/intake/:messageId"
          element={
            permissions.has('intake:view') ? (
              <MessageDetailPage />
            ) : (
              <ForbiddenPage />
            )
          }
        />

        {/* Reading a document is a different right from seeing that one exists,
            so these ask for `extraction:view` rather than `document:view`. */}
        <Route
          path="/documents"
          element={
            permissions.has('extraction:view') ? (
              <DocumentQueuePage />
            ) : (
              <ForbiddenPage />
            )
          }
        />
        <Route
          path="/documents/:documentId"
          element={
            permissions.has('extraction:view') ? (
              <DocumentReviewPage />
            ) : (
              <ForbiddenPage />
            )
          }
        />

        <Route
          path="/estimates"
          element={
            permissions.has('estimate:view') ? (
              <EstimateRegisterPage />
            ) : (
              <ForbiddenPage />
            )
          }
        />
        <Route
          path="/estimates/:estimateId"
          element={
            permissions.has('estimate:view') ? (
              <EstimateDetailPage />
            ) : (
              <ForbiddenPage />
            )
          }
        />

        <Route
          path="/invoices"
          element={
            permissions.has('invoice:view') ? <InvoiceRegisterPage /> : <ForbiddenPage />
          }
        />
        <Route
          path="/invoices/:invoiceId"
          element={permissions.has('invoice:view') ? <InvoiceDetailPage /> : <ForbiddenPage />}
        />

        <Route
          path="/purchase-orders"
          element={
            permissions.has('purchase_order:view') ? (
              <PurchaseOrderRegisterPage />
            ) : (
              <ForbiddenPage />
            )
          }
        />
        <Route
          path="/purchase-orders/:orderId"
          element={
            permissions.has('purchase_order:view') ? (
              <PurchaseOrderDetailPage />
            ) : (
              <ForbiddenPage />
            )
          }
        />

        <Route
          path="/payments"
          element={
            permissions.has('payment:view') ? <PaymentPackageRegisterPage /> : <ForbiddenPage />
          }
        />
        <Route
          path="/payments/:packageId"
          element={
            permissions.has('payment:view') ? <PaymentPackageDetailPage /> : <ForbiddenPage />
          }
        />

        <Route
          path="/credit-cards"
          element={
            permissions.has('credit_card:view') ? <CreditCardRegisterPage /> : <ForbiddenPage />
          }
        />
        <Route
          path="/credit-cards/:periodId"
          element={
            permissions.has('credit_card:view') ? <CreditCardPeriodPage /> : <ForbiddenPage />
          }
        />

        <Route
          path="/accruals"
          element={
            permissions.has('accrual:view') ? <AccrualRegisterPage /> : <ForbiddenPage />
          }
        />
        <Route
          path="/accruals/:periodId"
          element={
            permissions.has('accrual:view') ? <AccrualPeriodPage /> : <ForbiddenPage />
          }
        />

        {/* `vendor:confirmation_review` rather than `payment:mark_paid`, and it
            matches what the API asks of the same endpoints. Reading what a
            supplier said is a different right from concluding on it: the second
            is decided per record and arrives as `can_review` in the payload,
            which is why the Conclude button is not gated here. */}
        <Route
          path="/vendor-confirmations"
          element={
            permissions.has('vendor:confirmation_review') ? (
              <VendorConfirmationRegisterPage />
            ) : (
              <ForbiddenPage />
            )
          }
        />
        <Route
          path="/vendor-confirmations/:checkInId"
          element={
            permissions.has('vendor:confirmation_review') ? (
              <VendorConfirmationDetailPage />
            ) : (
              <ForbiddenPage />
            )
          }
        />

        <Route
          path="/approvals"
          element={permissions.has('approval:view') ? <ApprovalQueuePage /> : <ForbiddenPage />}
        />

        {/* Settings is a section rather than a page, and each screen in it asks
            for the right that screen changes. Arranging your own cover needs
            only the delegate right, which an approver holds and an
            administrator does not. */}
        <Route
          path="/settings"
          element={
            permissions.has('admin:approval_matrix') ? (
              <Navigate to="/settings/approval-matrix" replace />
            ) : (
              <Navigate to="/settings/cover" replace />
            )
          }
        />
        <Route
          path="/settings/users"
          element={
            permissions.has('admin:users') ? <UsersPage /> : <ForbiddenPage />
          }
        />
        <Route
          path="/settings/reference"
          element={
            permissions.has('admin:reference_data') ? (
              <ReferenceDataPage />
            ) : (
              <ForbiddenPage />
            )
          }
        />
        <Route
          path="/settings/thresholds"
          element={
            permissions.has('admin:thresholds') ? (
              <ThresholdsPage />
            ) : (
              <ForbiddenPage />
            )
          }
        />
        <Route
          path="/settings/retention"
          element={
            permissions.has('admin:retention') ? (
              <RetentionPage />
            ) : (
              <ForbiddenPage />
            )
          }
        />
        <Route
          path="/settings/operations"
          element={
            permissions.has('admin:ai_config') ? (
              <OperationalSettingsPage />
            ) : (
              <ForbiddenPage />
            )
          }
        />
        <Route
          path="/settings/approval-matrix"
          element={
            permissions.has('admin:approval_matrix') ? <MatrixPage /> : <ForbiddenPage />
          }
        />
        <Route
          path="/settings/approvers"
          element={
            permissions.has('admin:approval_matrix') ? <AssignmentsPage /> : <ForbiddenPage />
          }
        />
        <Route
          path="/settings/cover"
          element={
            permissions.has('approval:delegate') || permissions.has('admin:approval_matrix') ? (
              <DelegationPage />
            ) : (
              <ForbiddenPage />
            )
          }
        />

        {/* Not permission-gated. The token names a destination, not a right, and
            the page it lands on fetches the record through the ordinary
            authenticated endpoint — which is where authority is decided. Gating
            the landing itself would tell a holder which tokens are real. */}
        <Route path="/link/:token" element={<SignedLinkPage />} />

        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </AppShell>
  );
}
