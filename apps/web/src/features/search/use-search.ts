import { useQuery } from '@tanstack/react-query';

import { api, toQuery } from '@/lib/api-client';

export type SearchRecordType =
  | 'estimate'
  | 'invoice'
  | 'purchase_order'
  | 'payment_package'
  | 'document'
  | 'vendor_check_in';

export type SearchHitOut = {
  record_type: SearchRecordType;
  type_label: string;
  record_id: string;
  record_path: string;
  reference: string;
  title: string;
  subtitle: string;
  state: string | null;
  amount_formatted: string | null;
};

export type SearchResponse = {
  query: string;
  items: SearchHitOut[];
  total: number;
};

export const searchKeys = {
  all: ['search'] as const,
  query: (q: string) => ['search', q] as const,
};

export function useSearch(query: string, enabled: boolean) {
  const trimmed = query.trim();
  return useQuery({
    queryKey: searchKeys.query(trimmed),
    queryFn: () =>
      api.get<SearchResponse>(`/search${toQuery({ q: trimmed, limit: 25 })}`),
    enabled: enabled && trimmed.length >= 2,
    staleTime: 15_000,
  });
}
