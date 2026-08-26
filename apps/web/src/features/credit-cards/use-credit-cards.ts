import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type {
  CreditCardCloseBody,
  CreditCardCodeBody,
  CreditCardCreate,
  CreditCardPeriodDetail,
  CreditCardPeriodSummary,
  CreditCardReceiptBody,
  CreditCardStanding,
  CreditCardSummary,
  CreditCardTransactionOut,
} from '@finora/shared-types';

import { api, toQuery } from '@/lib/api-client';

export const creditCardKeys = {
  all: ['credit-cards'] as const,
  cards: ['credit-cards', 'cards'] as const,
  periods: (standing?: CreditCardStanding) =>
    ['credit-cards', 'periods', standing ?? 'all'] as const,
  period: (id: string) => ['credit-cards', 'period', id] as const,
};

export function useCreditCards() {
  return useQuery({
    queryKey: creditCardKeys.cards,
    queryFn: () => api.get<CreditCardSummary[]>('/credit-cards/cards'),
    staleTime: 30_000,
  });
}

export function useCreditCardPeriods(standing?: CreditCardStanding) {
  return useQuery({
    queryKey: creditCardKeys.periods(standing),
    queryFn: () =>
      api.get<CreditCardPeriodSummary[]>(
        `/credit-cards/periods${toQuery({ standing })}`,
      ),
    staleTime: 10_000,
  });
}

export function useCreditCardPeriod(id: string | undefined) {
  return useQuery({
    queryKey: creditCardKeys.period(id ?? ''),
    queryFn: () => api.get<CreditCardPeriodDetail>(`/credit-cards/periods/${id ?? ''}`),
    enabled: Boolean(id),
  });
}

export function useCreateCreditCard() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreditCardCreate) =>
      api.post<CreditCardSummary>('/credit-cards/cards', body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: creditCardKeys.cards });
    },
  });
}

export function useImportStatement(cardId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      file: File;
      period_start: string;
      period_end: string;
      statement_date: string;
    }) => {
      const form = new FormData();
      form.append('file', input.file);
      form.append('period_start', input.period_start);
      form.append('period_end', input.period_end);
      form.append('statement_date', input.statement_date);
      return api.upload<CreditCardPeriodDetail>(
        `/credit-cards/cards/${cardId ?? ''}/statements`,
        form,
      );
    },
    onSuccess: (detail) => {
      queryClient.setQueryData(creditCardKeys.period(detail.id), detail);
      void queryClient.invalidateQueries({ queryKey: ['credit-cards', 'periods'] });
    },
  });
}

export function useCodeTransaction(periodId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      transactionId,
      body,
    }: {
      transactionId: string;
      body: CreditCardCodeBody;
    }) =>
      api.post<CreditCardTransactionOut>(
        `/credit-cards/transactions/${transactionId}/code`,
        body,
      ),
    onSuccess: () => {
      if (periodId) {
        void queryClient.invalidateQueries({ queryKey: creditCardKeys.period(periodId) });
      }
      void queryClient.invalidateQueries({ queryKey: ['credit-cards', 'periods'] });
    },
  });
}

export function useMatchReceipt(periodId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      transactionId,
      body,
    }: {
      transactionId: string;
      body: CreditCardReceiptBody;
    }) =>
      api.post<CreditCardTransactionOut>(
        `/credit-cards/transactions/${transactionId}/receipt`,
        body,
      ),
    onSuccess: () => {
      if (periodId) {
        void queryClient.invalidateQueries({ queryKey: creditCardKeys.period(periodId) });
      }
    },
  });
}

export function useClosePeriod(periodId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreditCardCloseBody) =>
      api.post<CreditCardPeriodDetail>(`/credit-cards/periods/${periodId ?? ''}/close`, body),
    onSuccess: (detail) => {
      queryClient.setQueryData(creditCardKeys.period(detail.id), detail);
      void queryClient.invalidateQueries({ queryKey: ['credit-cards', 'periods'] });
    },
  });
}
