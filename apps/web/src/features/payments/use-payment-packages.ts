import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type {
  AddLinesResponse,
  EligibleInvoiceOut,
  ManifestOut,
  PackageDraftRequest,
  PackageStanding,
  PackageSubmitResponse,
  PaymentPackageDetail,
  PaymentPackagePage,
} from '@finora/shared-types';

import { api, toQuery } from '@/lib/api-client';

export const paymentPackageKeys = {
  all: ['payment-packages'] as const,
  list: (filters: PackageFilters, page: number) =>
    ['payment-packages', 'list', filters, page] as const,
  detail: (id: string) => ['payment-packages', 'detail', id] as const,
  manifest: (id: string) => ['payment-packages', 'manifest', id] as const,
  /** Approved invoices not yet spoken for by any package. */
  eligible: ['payment-packages', 'eligible'] as const,
};

export const PAGE_SIZE = 25;

export interface PackageFilters {
  /**
   * Filtered on standing rather than on a state, because a package has no state.
   * Open, submitted and cancelled are read from two timestamps.
   */
  standing: PackageStanding[];
  search: string;
}

export const NO_FILTERS: PackageFilters = { standing: [], search: '' };

export function usePaymentPackages(filters: PackageFilters, page = 1) {
  return useQuery({
    queryKey: paymentPackageKeys.list(filters, page),
    queryFn: () =>
      api.get<PaymentPackagePage>(
        `/payment-packages${toQuery({
          standing: filters.standing.length ? filters.standing : undefined,
          search: filters.search.trim() || undefined,
          page,
          page_size: PAGE_SIZE,
        })}`,
      ),
    staleTime: 10_000,
  });
}

export function usePaymentPackage(id: string | undefined) {
  return useQuery({
    queryKey: paymentPackageKeys.detail(id ?? ''),
    queryFn: () => api.get<PaymentPackageDetail>(`/payment-packages/${id ?? ''}`),
    enabled: Boolean(id),
  });
}

/**
 * What could still go into a package.
 *
 * Not cached for long. Every add takes an invoice off this list for everybody,
 * and two coordinators working at the same time should not both be offered the
 * same bill. The server refuses the second of them either way; a short staleness
 * is what keeps that refusal rare rather than routine.
 */
export function useEligibleInvoices(enabled = true) {
  return useQuery({
    queryKey: paymentPackageKeys.eligible,
    queryFn: () => api.get<EligibleInvoiceOut[]>('/payment-packages/eligible-invoices'),
    staleTime: 5_000,
    enabled,
  });
}

/**
 * The manifest as it currently stands.
 *
 * Fetched rather than derived, because the file that goes to the bank is
 * composed by the server and its digest is the evidence of what was sent. A
 * browser building its own version of it would be building a different file.
 */
export function useManifest(id: string | undefined, enabled = true) {
  return useQuery({
    queryKey: paymentPackageKeys.manifest(id ?? ''),
    queryFn: () => api.get<ManifestOut>(`/payment-packages/${id ?? ''}/manifest`),
    enabled: Boolean(id) && enabled,
  });
}

/**
 * Every write answers with the whole package, and that answer goes into the
 * cache.
 *
 * Adding an invoice changes its state, the package's totals, its outstanding
 * problems and whether it may be sent at all. Taking the server's answer for all
 * of it means the totals on screen and the button beside them can never disagree
 * about what the package contains.
 */
function usePackageWrite<TVariables, TResult>(
  request: (id: string, variables: TVariables) => Promise<TResult>,
  packageId: string | undefined,
  // Passed in rather than sniffed from the result, because submitting answers
  // with the package alongside the manifest while the rest answer with the
  // package itself.
  packageFrom: (result: TResult) => PaymentPackageDetail,
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (variables: TVariables) => request(packageId ?? '', variables),
    onSuccess: (result) => {
      const detail = packageFrom(result);
      queryClient.setQueryData(paymentPackageKeys.detail(detail.id), detail);
      void queryClient.invalidateQueries({ queryKey: ['payment-packages', 'list'] });
      void queryClient.invalidateQueries({ queryKey: paymentPackageKeys.eligible });
      void queryClient.invalidateQueries({ queryKey: paymentPackageKeys.manifest(detail.id) });
      // Every invoice in the package moved state, so any register or detail
      // showing one of them is now describing where it was rather than where
      // it is.
      void queryClient.invalidateQueries({ queryKey: ['invoices'] });
    },
  });
}

export function useCreatePaymentPackage() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (draft: PackageDraftRequest) =>
      api.post<PaymentPackageDetail>('/payment-packages', draft),
    onSuccess: (detail) => {
      queryClient.setQueryData(paymentPackageKeys.detail(detail.id), detail);
      void queryClient.invalidateQueries({ queryKey: ['payment-packages', 'list'] });
    },
  });
}

const itself = (detail: PaymentPackageDetail) => detail;

export function useSavePaymentPackage(packageId: string | undefined) {
  return usePackageWrite<PackageDraftRequest, PaymentPackageDetail>(
    (id, draft) => api.put<PaymentPackageDetail>(`/payment-packages/${id}`, draft),
    packageId,
    itself,
  );
}

/** Put approved invoices in. Partial: what could not go in comes back named. */
export function useAddToPackage(packageId: string | undefined) {
  return usePackageWrite<{ invoiceIds: string[] }, AddLinesResponse>(
    (id, { invoiceIds }) =>
      api.post<AddLinesResponse>(`/payment-packages/${id}/lines`, { invoice_ids: invoiceIds }),
    packageId,
    (result) => result.package,
  );
}

/** Take one invoice back out, returning it to approved and unpaid. */
export function useRemoveFromPackage(packageId: string | undefined) {
  return usePackageWrite<{ invoiceId: string }, PaymentPackageDetail>(
    (id, { invoiceId }) =>
      api.delete<PaymentPackageDetail>(`/payment-packages/${id}/lines/${invoiceId}`),
    packageId,
    itself,
  );
}

/** Send it, recording the bank's reference and the digest of what went. */
export function useSubmitPackage(packageId: string | undefined) {
  return usePackageWrite<{ submissionReference: string }, PackageSubmitResponse>(
    (id, { submissionReference }) =>
      api.post<PackageSubmitResponse>(`/payment-packages/${id}/submit`, {
        submission_reference: submissionReference,
      }),
    packageId,
    (result) => result.package,
  );
}

/** Abandon it, returning everything in it to approved and unpaid. */
export function useCancelPackage(packageId: string | undefined) {
  return usePackageWrite<{ reason: string }, PaymentPackageDetail>(
    (id, { reason }) => api.post<PaymentPackageDetail>(`/payment-packages/${id}/cancel`, { reason }),
    packageId,
    itself,
  );
}
