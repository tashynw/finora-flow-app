import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type {
  CheckInDetailOut,
  CheckInPage,
  CheckInStanding,
  ClaimOutcome,
  RaiseResponse,
  ReviewOutcome,
  VendorAnswerResponse,
  VendorQuestionOut,
} from '@finora/shared-types';

import { api, publicApi, toQuery } from '@/lib/api-client';

export const checkInKeys = {
  all: ['vendor-check-ins'] as const,
  list: (filters: CheckInFilters, page: number) =>
    ['vendor-check-ins', 'list', filters, page] as const,
  detail: (id: string) => ['vendor-check-ins', 'detail', id] as const,
  /**
   * Keyed by the supplier's token, and deliberately in a namespace of its own.
   *
   * Nothing under `vendor-check-ins` is ever invalidated by the supplier's page
   * and nothing the supplier's page holds is ever invalidated by ours. They are
   * two different readers looking at two different subsets of one record, and a
   * shared key would let one of them refetch through the other's credentials.
   */
  question: (token: string) => ['payment-check-in', token] as const,
};

export const PAGE_SIZE = 25;

export interface CheckInFilters {
  standing: CheckInStanding[];
  search: string;
}

export const NO_FILTERS: CheckInFilters = { standing: [], search: '' };

export function useVendorCheckIns(filters: CheckInFilters, page = 1) {
  return useQuery({
    queryKey: checkInKeys.list(filters, page),
    queryFn: () =>
      api.get<CheckInPage>(
        `/vendor-check-ins${toQuery({
          standing: filters.standing.length ? filters.standing : undefined,
          search: filters.search.trim() || undefined,
          page,
          page_size: PAGE_SIZE,
        })}`,
      ),
    staleTime: 10_000,
  });
}

export function useVendorCheckIn(id: string | undefined) {
  return useQuery({
    queryKey: checkInKeys.detail(id ?? ''),
    queryFn: () => api.get<CheckInDetailOut>(`/vendor-check-ins/${id ?? ''}`),
    enabled: Boolean(id),
  });
}

/**
 * Every write answers with the whole check-in, and that answer goes in the cache.
 *
 * `can_send`, `can_record_answer` and `can_review` are all computed server-side
 * from the standing plus the reader's permissions, so taking the server's word
 * for the record and its buttons together means a screen can never offer an
 * action the API is about to refuse.
 */
function useCheckInWrite<TVariables>(
  request: (id: string, variables: TVariables) => Promise<CheckInDetailOut>,
  checkInId: string | undefined,
  /** True when this can move an invoice, which is only ever the review. */
  movesInvoices = false,
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (variables: TVariables) => request(checkInId ?? '', variables),
    onSuccess: (detail) => {
      queryClient.setQueryData(checkInKeys.detail(detail.id), detail);
      void queryClient.invalidateQueries({ queryKey: ['vendor-check-ins', 'list'] });
      if (movesInvoices) {
        // Paid and Outstanding are real state changes on every invoice in the
        // check-in, so anything showing one of them is now out of date.
        void queryClient.invalidateQueries({ queryKey: ['invoices'] });
        void queryClient.invalidateQueries({ queryKey: ['payment-packages'] });
      }
    },
  });
}

/** Open one question per supplier in a package that has gone to the bank. */
export function useRaiseCheckIns() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (variables: { packageId: string }) =>
      api.post<RaiseResponse>('/vendor-check-ins', { package_id: variables.packageId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['vendor-check-ins'] });
    },
  });
}

/** Email the supplier the question and a link to answer it. */
export function useSendCheckIn(checkInId: string | undefined) {
  return useCheckInWrite<void>(
    (id) => api.post<CheckInDetailOut>(`/vendor-check-ins/${id}/send`),
    checkInId,
  );
}

/**
 * Write down what a supplier said by telephone.
 *
 * A claim like any other, and it moves nothing. The person who takes the call is
 * very often not the person allowed to conclude, which is the whole reason this
 * is separate from the review below.
 */
export function useRecordAnswer(checkInId: string | undefined) {
  return useCheckInWrite<{ claim: ClaimOutcome; respondentName: string; note: string }>(
    (id, variables) =>
      api.post<CheckInDetailOut>(`/vendor-check-ins/${id}/answer`, {
        claim: variables.claim,
        respondent_name: variables.respondentName,
        note: variables.note,
      }),
    checkInId,
  );
}

/** Conclude. The only route in the platform to Paid. */
export function useReviewCheckIn(checkInId: string | undefined) {
  return useCheckInWrite<{ outcome: ReviewOutcome; note: string }>(
    (id, variables) =>
      api.post<CheckInDetailOut>(`/vendor-check-ins/${id}/review`, {
        outcome: variables.outcome,
        note: variables.note,
      }),
    checkInId,
    true,
  );
}

// ------------------------------------------------------------- the supplier's

/**
 * What the supplier is being asked, fetched without a session.
 *
 * Never retried and never refetched in the background. A supplier's token is
 * spent when they answer, and a stray refetch after that point would replace the
 * thank-you they are reading with a refusal page.
 */
export function useVendorQuestion(token: string | undefined) {
  return useQuery({
    queryKey: checkInKeys.question(token ?? ''),
    queryFn: () => publicApi.get<VendorQuestionOut>(`/payment-check-in/${token ?? ''}`),
    enabled: Boolean(token),
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  });
}

/**
 * Record the supplier's answer. Spends the token and moves nothing.
 *
 * No cache invalidation on purpose. The supplier's browser holds one record and
 * the answer they just gave is the last thing that will happen to it from here;
 * refetching would spend a second request on a token that is now used up.
 */
export function useAnswerAsVendor(token: string | undefined) {
  return useMutation({
    mutationFn: (variables: { claim: ClaimOutcome; respondentName: string; note: string }) =>
      publicApi.post<VendorAnswerResponse>(`/payment-check-in/${token ?? ''}`, {
        claim: variables.claim,
        respondent_name: variables.respondentName,
        note: variables.note,
      }),
  });
}
