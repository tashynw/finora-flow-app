import { keepPreviousData, useQuery } from '@tanstack/react-query';

import type { ApprovalPersonOut } from '@finora/shared-types';

import { api, toQuery } from '@/lib/api-client';

/**
 * Everybody who could hold a level or stand in for somebody.
 *
 * Cached for the session rather than refetched per dialog: the list changes when
 * somebody joins or leaves, which is not on the timescale of opening a modal.
 */
export function usePeople() {
  return useQuery({
    queryKey: ['admin', 'people'],
    queryFn: () => api.get<ApprovalPersonOut[]>('/admin/people'),
    staleTime: 5 * 60 * 1000,
  });
}

/** A short page of open accounts. An empty query is the first 10, in name order. */
export function usePeopleSearch(query: string, enabled: boolean) {
  const q = query.trim();
  return useQuery({
    queryKey: ['admin', 'people', 'search', q],
    queryFn: () =>
      api.get<ApprovalPersonOut[]>(
        `/admin/people${toQuery({ q, limit: q ? 20 : 10 })}`,
      ),
    enabled,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
}
