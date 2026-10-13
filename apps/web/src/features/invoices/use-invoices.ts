import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type {
  ApprovalLevel,
  ApprovalOutcome,
  InvoiceDetail,
  InvoiceDraftRequest,
  InvoicePage,
  InvoiceReferenceData,
  RegisterSummaryOut,
  ResolvedOut,
} from '@finora/shared-types';

import { api, toQuery } from '@/lib/api-client';
import type { WorkflowState } from '@/lib/workflow';

export const invoiceKeys = {
  all: ['invoices'] as const,
  list: (filters: InvoiceFilters, offset: number) =>
    ['invoices', 'list', filters, offset] as const,
  summary: ['invoices', 'summary'] as const,
  detail: (id: string) => ['invoices', 'detail', id] as const,
  /** Estimates and orders this invoice could be billed against. */
  linkable: ['invoices', 'linkable'] as const,
};

export const PAGE_SIZE = 25;

export interface InvoiceFilters {
  state: WorkflowState[];
  /** Only invoices this person raised. */
  mine: boolean;
  /** Only invoices open for this person's approval decision. */
  awaitingMe: boolean;
  /** Only invoices waiting for this person to confirm they received the goods. */
  awaitingMySignOff: boolean;
  /** Only invoices whose payment due date has passed. */
  overdue: boolean;
  search: string;
}

export const NO_FILTERS: InvoiceFilters = {
  state: [],
  mine: false,
  awaitingMe: false,
  awaitingMySignOff: false,
  overdue: false,
  search: '',
};

/**
 * The invoice register.
 *
 * Refetched on focus rather than polled, for the same reason as the estimate
 * register: nothing lands here on its own. The exception the interval would
 * cover — a reminder going out, an escalation raising the level — changes only
 * wording on a row that is already there, and is not worth a request every few
 * seconds from every open tab.
 */
export function useInvoices(filters: InvoiceFilters, offset = 0) {
  return useQuery({
    queryKey: invoiceKeys.list(filters, offset),
    queryFn: () =>
      api.get<InvoicePage>(
        `/invoices${toQuery({
          status: filters.state.length ? filters.state : undefined,
          mine: filters.mine ? true : undefined,
          awaiting_me: filters.awaitingMe ? true : undefined,
          awaiting_my_sign_off: filters.awaitingMySignOff ? true : undefined,
          overdue: filters.overdue ? true : undefined,
          search: filters.search.trim() || undefined,
          limit: PAGE_SIZE,
          offset,
        })}`,
      ),
    staleTime: 10_000,
  });
}

/**
 * Whole-register headline figures for the stat band.
 *
 * Scoped by the API to exactly the invoices this caller may list, so the totals
 * shown can always be reached by opening the register. Kept slightly staler than
 * the list because a headline that lags a row by a few seconds misleads nobody.
 */
export function useInvoiceSummary() {
  return useQuery({
    queryKey: invoiceKeys.summary,
    queryFn: () => api.get<RegisterSummaryOut>('/invoices/summary'),
    staleTime: 30_000,
  });
}

export function useInvoice(id: string | undefined) {
  return useQuery({
    queryKey: invoiceKeys.detail(id ?? ''),
    queryFn: () => api.get<InvoiceDetail>(`/invoices/${id ?? ''}`),
    enabled: Boolean(id),
  });
}

/**
 * Approved estimates and open orders this invoice could be billed against.
 *
 * Separate from the reference data above and cached for far less time, because
 * these carry remaining balances. A stale vendor list shows a missing option; a
 * stale remaining balance would tell somebody an invoice fits inside an estimate
 * that a colleague has since used up.
 */
export function useLinkableRecords() {
  return useQuery({
    queryKey: invoiceKeys.linkable,
    queryFn: () => api.get<InvoiceReferenceData>('/invoices/reference/linkable'),
    staleTime: 30_000,
  });
}

/**
 * Every write returns the whole invoice, and its answer is written straight into
 * the cache.
 *
 * Confirming receipt closes the sign-off panel, stops the reminder cycle, opens
 * an approval route and changes every button on the page. Taking the server's
 * own answer for all of it means the panel and the route can never disagree.
 */
function useInvoiceWrite<TVariables>(
  request: (id: string, variables: TVariables) => Promise<InvoiceDetail>,
  invoiceId: string | undefined,
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (variables: TVariables) => request(invoiceId ?? '', variables),
    onSuccess: (detail) => {
      queryClient.setQueryData(invoiceKeys.detail(detail.id), detail);
      void queryClient.invalidateQueries({ queryKey: ['invoices', 'list'] });
      // An invoice that has been sent on consumes part of the estimate or order
      // it is billed against, so the remaining balances offered to the next
      // invoice are now wrong.
      void queryClient.invalidateQueries({ queryKey: invoiceKeys.linkable });
    },
  });
}

/** Record an invoice, blank or from an accepted document reading. */
export function useCreateInvoice() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (variables: { documentId?: string }) =>
      api.post<InvoiceDetail>('/invoices', {
        document_id: variables.documentId ?? null,
      }),
    onSuccess: (detail) => {
      queryClient.setQueryData(invoiceKeys.detail(detail.id), detail);
      void queryClient.invalidateQueries({ queryKey: ['invoices', 'list'] });
    },
  });
}

export function useSaveInvoice(invoiceId: string | undefined) {
  return useInvoiceWrite<InvoiceDraftRequest>(
    (id, draft) => api.put<InvoiceDetail>(`/invoices/${id}`, draft),
    invoiceId,
  );
}

/** Ask the requester to confirm the goods or services arrived. */
export function useRequestSignOff(invoiceId: string | undefined) {
  return useInvoiceWrite<void>(
    (id) => api.post<InvoiceDetail>(`/invoices/${id}/request-sign-off`),
    invoiceId,
  );
}

/** Confirm receipt. Sends the invoice on for approval. */
export function useSignOff(invoiceId: string | undefined) {
  return useInvoiceWrite<{ note?: string }>(
    (id, { note }) => api.post<InvoiceDetail>(`/invoices/${id}/sign-off`, { note: note ?? null }),
    invoiceId,
  );
}

/** Say the goods or services did not arrive as billed. */
export function useDeclineSignOff(invoiceId: string | undefined) {
  return useInvoiceWrite<{ reason: string }>(
    (id, { reason }) => api.post<InvoiceDetail>(`/invoices/${id}/decline`, { reason }),
    invoiceId,
  );
}

/** Take back a request for confirmation, and stop the reminders with it. */
export function useRecallInvoice(invoiceId: string | undefined) {
  return useInvoiceWrite<{ reason: string }>(
    (id, { reason }) => api.post<InvoiceDetail>(`/invoices/${id}/recall`, { reason }),
    invoiceId,
  );
}

export function useCancelInvoice(invoiceId: string | undefined) {
  return useInvoiceWrite<{ reason: string }>(
    (id, { reason }) => api.post<InvoiceDetail>(`/invoices/${id}/cancel`, { reason }),
    invoiceId,
  );
}

export function useDecideInvoice(invoiceId: string | undefined) {
  return useInvoiceWrite<{
    stepOrder: number;
    level: ApprovalLevel;
    outcome: ApprovalOutcome;
    comment?: string;
  }>(
    (id, { stepOrder, level, outcome, comment }) =>
      api.post<InvoiceDetail>(`/invoices/${id}/decision`, {
        step_order: stepOrder,
        level,
        outcome,
        comment: comment ?? null,
      }),
    invoiceId,
  );
}

/**
 * Exchange the token from a reminder's link for the record it points at.
 *
 * Deliberately a mutation rather than a query: the token is single use, and a
 * query would spend it again on every refetch and remount. The answer says which
 * record to open and whether this signed-in person is the one who was asked; it
 * confers no authority by itself, and every refusal reason the server gives is
 * shown to the reader unchanged.
 */
export function useResolveLink() {
  return useMutation({
    mutationFn: (variables: { token: string }) =>
      api.post<ResolvedOut>('/links/resolve', { token: variables.token }),
  });
}
