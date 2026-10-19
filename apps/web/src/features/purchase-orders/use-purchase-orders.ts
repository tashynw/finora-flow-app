import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type {
  ApprovalLevel,
  ApprovalOutcome,
  PurchaseOrderDetail,
  PurchaseOrderDraftRequest,
  PurchaseOrderPage,
  PurchaseOrderReferenceData,
} from '@finora/shared-types';

import { api, toQuery } from '@/lib/api-client';
import type { WorkflowState } from '@/lib/workflow';

export const purchaseOrderKeys = {
  all: ['purchase-orders'] as const,
  list: (filters: OrderFilters, page: number) =>
    ['purchase-orders', 'list', filters, page] as const,
  detail: (id: string) => ['purchase-orders', 'detail', id] as const,
  /** Vendors, cost centres, accounts and approved estimates the form offers. */
  reference: ['purchase-orders', 'reference'] as const,
};

export const PAGE_SIZE = 25;

export interface OrderFilters {
  state: WorkflowState[];
  /**
   * Live commitments only.
   *
   * Separate from `state` because open is not a state: it is an approved order
   * nobody has closed. A screen filtering for what can still be billed against
   * should not have to know that.
   */
  openOnly: boolean;
  awaitingMeOnly: boolean;
  search: string;
}

export const NO_FILTERS: OrderFilters = {
  state: [],
  openOnly: false,
  awaitingMeOnly: false,
  search: '',
};

export function usePurchaseOrders(filters: OrderFilters, page = 1) {
  return useQuery({
    queryKey: purchaseOrderKeys.list(filters, page),
    queryFn: () =>
      api.get<PurchaseOrderPage>(
        `/purchase-orders${toQuery({
          status: filters.state.length ? filters.state : undefined,
          open_only: filters.openOnly ? true : undefined,
          awaiting_me_only: filters.awaitingMeOnly ? true : undefined,
          search: filters.search.trim() || undefined,
          limit: PAGE_SIZE,
          offset: (page - 1) * PAGE_SIZE,
        })}`,
      ),
    staleTime: 10_000,
  });
}

export function usePurchaseOrder(id: string | undefined) {
  return useQuery({
    queryKey: purchaseOrderKeys.detail(id ?? ''),
    queryFn: () => api.get<PurchaseOrderDetail>(`/purchase-orders/${id ?? ''}`),
    enabled: Boolean(id),
  });
}

/**
 * What the order form can offer.
 *
 * Cached briefly rather than indefinitely because the approved estimates in it
 * carry the authority an order may be raised against. A stale vendor is a
 * missing option; a stale estimate would offer cover that has since been spent.
 */
export function useOrderReferenceData() {
  return useQuery({
    queryKey: purchaseOrderKeys.reference,
    queryFn: () => api.get<PurchaseOrderReferenceData>('/purchase-orders/reference-data'),
    staleTime: 30_000,
  });
}

/**
 * Every write answers with the whole order, and that answer goes into the cache.
 *
 * Submitting an order can open it outright or send it round for approval, and
 * which of the two happened decides every control on the page. Taking the
 * server's answer for all of it means the buttons and the route can never
 * disagree about what state the commitment is in.
 */
function useOrderWrite<TVariables>(
  request: (id: string, variables: TVariables) => Promise<PurchaseOrderDetail>,
  orderId: string | undefined,
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (variables: TVariables) => request(orderId ?? '', variables),
    onSuccess: (detail) => {
      queryClient.setQueryData(purchaseOrderKeys.detail(detail.id), detail);
      void queryClient.invalidateQueries({ queryKey: ['purchase-orders', 'list'] });
      // An order that opens or closes changes what an invoice may be billed
      // against, and by how much.
      void queryClient.invalidateQueries({ queryKey: ['invoices', 'linkable'] });
    },
  });
}

export function useCreatePurchaseOrder() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (variables: { estimateId?: string }) =>
      api.post<PurchaseOrderDetail>('/purchase-orders', {
        estimate_id: variables.estimateId ?? null,
      }),
    onSuccess: (detail) => {
      queryClient.setQueryData(purchaseOrderKeys.detail(detail.id), detail);
      void queryClient.invalidateQueries({ queryKey: ['purchase-orders', 'list'] });
    },
  });
}

export function useSavePurchaseOrder(orderId: string | undefined) {
  return useOrderWrite<PurchaseOrderDraftRequest>(
    (id, draft) => api.put<PurchaseOrderDetail>(`/purchase-orders/${id}`, draft),
    orderId,
  );
}

/** Commit the order: opens it outright, or sends it for approval. */
export function useSubmitPurchaseOrder(orderId: string | undefined) {
  return useOrderWrite<void>(
    (id) => api.post<PurchaseOrderDetail>(`/purchase-orders/${id}/submit`),
    orderId,
  );
}

/** Pull an order back from approvers so it can be corrected. */
export function useWithdrawPurchaseOrder(orderId: string | undefined) {
  return useOrderWrite<{ reason: string }>(
    (id, { reason }) => api.post<PurchaseOrderDetail>(`/purchase-orders/${id}/withdraw`, { reason }),
    orderId,
  );
}

/**
 * Change a live order's figure.
 *
 * Raising it un-approves the order, because the signature was given for an
 * amount and does not carry to a larger one.
 */
export function useAmendPurchaseOrder(orderId: string | undefined) {
  return useOrderWrite<{ totalMinorUnits: number; reason: string }>(
    (id, { totalMinorUnits, reason }) =>
      api.post<PurchaseOrderDetail>(`/purchase-orders/${id}/amend`, {
        total_minor_units: totalMinorUnits,
        reason,
      }),
    orderId,
  );
}

/** Finish an order: it was honoured, and nothing further is expected. */
export function useClosePurchaseOrder(orderId: string | undefined) {
  return useOrderWrite<{ reason: string }>(
    (id, { reason }) => api.post<PurchaseOrderDetail>(`/purchase-orders/${id}/close`, { reason }),
    orderId,
  );
}

/** Withdraw an order that should never have existed. */
export function useCancelPurchaseOrder(orderId: string | undefined) {
  return useOrderWrite<{ reason: string }>(
    (id, { reason }) => api.post<PurchaseOrderDetail>(`/purchase-orders/${id}/cancel`, { reason }),
    orderId,
  );
}

export function useDecidePurchaseOrder(orderId: string | undefined) {
  return useOrderWrite<{
    stepOrder: number;
    level: ApprovalLevel;
    outcome: ApprovalOutcome;
    comment?: string;
  }>(
    (id, { stepOrder, level, outcome, comment }) =>
      api.post<PurchaseOrderDetail>(`/purchase-orders/${id}/decisions`, {
        step_order: stepOrder,
        level,
        outcome,
        comment: comment ?? null,
      }),
    orderId,
  );
}
