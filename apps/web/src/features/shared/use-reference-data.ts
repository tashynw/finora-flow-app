import { useQuery } from '@tanstack/react-query';

import type { ReferenceData } from '@finora/shared-types';

import { api } from '@/lib/api-client';

/** The one cache entry the selector contents live under. */
export const referenceKey = ['reference'] as const;

/**
 * Vendors, cost centres, accounts and currencies — the contents of every
 * selector on a finance form.
 *
 * Defined once and shared by every feature that has a form, rather than once per
 * feature: two hooks reading one cache key would have to agree on the key and
 * the staleness by convention, and the first one to drift would quietly fetch
 * the vendor list twice.
 *
 * Cached for the session. These change when an administrator changes them, which
 * is a different order of frequency from anything else on a page, and a stale
 * list is visible as a missing option rather than as a wrong number.
 */
export function useReferenceData() {
  return useQuery({
    queryKey: referenceKey,
    queryFn: () => api.get<ReferenceData>('/reference'),
    staleTime: 10 * 60_000,
  });
}
