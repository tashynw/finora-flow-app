import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type {
  ApprovalLevel,
  ApprovalOutcome,
  EstimateDetail,
  EstimateDraftRequest,
  EstimatePage,
} from '@finora/shared-types';

import { api, toQuery } from '@/lib/api-client';
import type { WorkflowState } from '@/lib/workflow';

export { useReferenceData } from '@/features/shared/use-reference-data';

export const estimateKeys = {
  all: ['estimates'] as const,
  list: (filters: EstimateFilters, offset: number) =>
    ['estimates', 'list', filters, offset] as const,
  detail: (id: string) => ['estimates', 'detail', id] as const,
};

export const PAGE_SIZE = 25;

export interface EstimateFilters {
  state: WorkflowState[];
  /** Only estimates this person raised. */
  mine: boolean;
  /** Only estimates open for this person's decision. */
  awaitingMe: boolean;
  search: string;
}

export const NO_FILTERS: EstimateFilters = {
  state: [],
  mine: false,
  awaitingMe: false,
  search: '',
};

/**
 * The estimate register.
 *
 * Not polled. Unlike the document queue, nothing appears here without a person
 * putting it there, and an approver's own decision writes the answer straight
 * into the cache. Refetched when the window regains focus, which is what covers
 * the case that matters: an approver returning to the tab after somebody else
 * has decided a step.
 */
export function useEstimates(filters: EstimateFilters, offset = 0) {
  return useQuery({
    queryKey: estimateKeys.list(filters, offset),
    queryFn: () =>
      api.get<EstimatePage>(
        `/estimates${toQuery({
          status: filters.state.length ? filters.state : undefined,
          mine: filters.mine ? true : undefined,
          awaiting_me: filters.awaitingMe ? true : undefined,
          search: filters.search.trim() || undefined,
          limit: PAGE_SIZE,
          offset,
        })}`,
      ),
    staleTime: 10_000,
  });
}

export function useEstimate(id: string | undefined) {
  return useQuery({
    queryKey: estimateKeys.detail(id ?? ''),
    queryFn: () => api.get<EstimateDetail>(`/estimates/${id ?? ''}`),
    enabled: Boolean(id),
  });
}

/**
 * Every write returns the whole estimate, and its answer is written straight
 * into the cache.
 *
 * One approval can close a route, move the estimate to approved, empty the
 * problem list and take away every button at once. Taking the server's own
 * answer for all of it means an approver never sees their decision land while
 * the route beside it still says it is waiting on them.
 */
function useEstimateWrite<TVariables>(
  request: (id: string, variables: TVariables) => Promise<EstimateDetail>,
  estimateId: string | undefined,
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (variables: TVariables) => request(estimateId ?? '', variables),
    onSuccess: (detail) => {
      queryClient.setQueryData(estimateKeys.detail(detail.id), detail);
      void queryClient.invalidateQueries({ queryKey: ['estimates', 'list'] });
    },
  });
}

/** Raise a draft, blank or from an accepted document reading. */
export function useCreateEstimate() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (variables: { documentId?: string }) =>
      api.post<EstimateDetail>('/estimates', {
        document_id: variables.documentId ?? null,
      }),
    onSuccess: (detail) => {
      queryClient.setQueryData(estimateKeys.detail(detail.id), detail);
      void queryClient.invalidateQueries({ queryKey: ['estimates', 'list'] });
    },
  });
}

export function useSaveEstimate(estimateId: string | undefined) {
  return useEstimateWrite<EstimateDraftRequest>(
    (id, draft) => api.put<EstimateDetail>(`/estimates/${id}`, draft),
    estimateId,
  );
}

export function useSubmitEstimate(estimateId: string | undefined) {
  return useEstimateWrite<void>(
    (id) => api.post<EstimateDetail>(`/estimates/${id}/submit`),
    estimateId,
  );
}

export function useWithdrawEstimate(estimateId: string | undefined) {
  return useEstimateWrite<{ reason: string }>(
    (id, { reason }) => api.post<EstimateDetail>(`/estimates/${id}/withdraw`, { reason }),
    estimateId,
  );
}

export function useCancelEstimate(estimateId: string | undefined) {
  return useEstimateWrite<{ reason: string }>(
    (id, { reason }) => api.post<EstimateDetail>(`/estimates/${id}/cancel`, { reason }),
    estimateId,
  );
}

export function useDecideEstimate(estimateId: string | undefined) {
  return useEstimateWrite<{
    stepOrder: number;
    level: ApprovalLevel;
    outcome: ApprovalOutcome;
    comment?: string;
  }>(
    (id, { stepOrder, level, outcome, comment }) =>
      api.post<EstimateDetail>(`/estimates/${id}/decision`, {
        step_order: stepOrder,
        level,
        outcome,
        comment: comment ?? null,
      }),
    estimateId,
  );
}
