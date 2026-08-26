import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api, toQuery } from '@/lib/api-client';
import { referenceKey } from '@/features/shared/use-reference-data';

export type AdminVendorOut = {
  id: string;
  code: string;
  name: string;
  email: string | null;
  phone: string | null;
  default_currency: string;
  payment_terms_days: number | null;
  is_active: boolean;
};

export type AdminGlAccountOut = {
  id: string;
  code: string;
  name: string;
  is_active: boolean;
};

export type AdminCostCentreOut = {
  id: string;
  code: string;
  name: string;
  department: string | null;
  is_active: boolean;
};

export type VendorCreateBody = {
  code: string;
  name: string;
  email: string | null;
  phone: string | null;
  default_currency: string;
  payment_terms_days: number | null;
  reason: string;
};

export type VendorUpdateBody = {
  name?: string;
  email?: string | null;
  phone?: string | null;
  default_currency?: string;
  payment_terms_days?: number | null;
  reason: string;
};

export type GlAccountCreateBody = {
  code: string;
  name: string;
  reason: string;
};

export type GlAccountUpdateBody = {
  name?: string;
  reason: string;
};

export type CostCentreCreateBody = {
  code: string;
  name: string;
  department: string | null;
  reason: string;
};

export type CostCentreUpdateBody = {
  name?: string;
  department?: string | null;
  reason: string;
};

export type ActiveBody = {
  is_active: boolean;
  reason: string;
};

export const referenceAdminKeys = {
  all: ['admin', 'reference'] as const,
  vendors: (includeInactive: boolean) =>
    ['admin', 'reference', 'vendors', includeInactive ? 'all' : 'active'] as const,
  glAccounts: (includeInactive: boolean) =>
    ['admin', 'reference', 'gl-accounts', includeInactive ? 'all' : 'active'] as const,
  costCentres: (includeInactive: boolean) =>
    ['admin', 'reference', 'cost-centres', includeInactive ? 'all' : 'active'] as const,
};

function invalidateReferenceCaches(queryClient: ReturnType<typeof useQueryClient>) {
  void queryClient.invalidateQueries({ queryKey: referenceAdminKeys.all });
  void queryClient.invalidateQueries({ queryKey: referenceKey });
}

export function useAdminVendors(includeInactive = true) {
  return useQuery({
    queryKey: referenceAdminKeys.vendors(includeInactive),
    queryFn: () =>
      api.get<AdminVendorOut[]>(
        `/admin/reference/vendors${toQuery({ include_inactive: includeInactive })}`,
      ),
  });
}

export function useCreateVendor() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: VendorCreateBody) =>
      api.post<AdminVendorOut>('/admin/reference/vendors', body),
    onSuccess: () => invalidateReferenceCaches(queryClient),
  });
}

export function useUpdateVendor() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: VendorUpdateBody }) =>
      api.put<AdminVendorOut>(`/admin/reference/vendors/${id}`, body),
    onSuccess: () => invalidateReferenceCaches(queryClient),
  });
}

export function useSetVendorActive() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: ActiveBody }) =>
      api.post<AdminVendorOut>(`/admin/reference/vendors/${id}/active`, body),
    onSuccess: () => invalidateReferenceCaches(queryClient),
  });
}

export function useAdminGlAccounts(includeInactive = true) {
  return useQuery({
    queryKey: referenceAdminKeys.glAccounts(includeInactive),
    queryFn: () =>
      api.get<AdminGlAccountOut[]>(
        `/admin/reference/gl-accounts${toQuery({ include_inactive: includeInactive })}`,
      ),
  });
}

export function useCreateGlAccount() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: GlAccountCreateBody) =>
      api.post<AdminGlAccountOut>('/admin/reference/gl-accounts', body),
    onSuccess: () => invalidateReferenceCaches(queryClient),
  });
}

export function useUpdateGlAccount() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: GlAccountUpdateBody }) =>
      api.put<AdminGlAccountOut>(`/admin/reference/gl-accounts/${id}`, body),
    onSuccess: () => invalidateReferenceCaches(queryClient),
  });
}

export function useSetGlAccountActive() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: ActiveBody }) =>
      api.post<AdminGlAccountOut>(`/admin/reference/gl-accounts/${id}/active`, body),
    onSuccess: () => invalidateReferenceCaches(queryClient),
  });
}

export function useAdminCostCentres(includeInactive = true) {
  return useQuery({
    queryKey: referenceAdminKeys.costCentres(includeInactive),
    queryFn: () =>
      api.get<AdminCostCentreOut[]>(
        `/admin/reference/cost-centres${toQuery({ include_inactive: includeInactive })}`,
      ),
  });
}

export function useCreateCostCentre() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CostCentreCreateBody) =>
      api.post<AdminCostCentreOut>('/admin/reference/cost-centres', body),
    onSuccess: () => invalidateReferenceCaches(queryClient),
  });
}

export function useUpdateCostCentre() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: CostCentreUpdateBody }) =>
      api.put<AdminCostCentreOut>(`/admin/reference/cost-centres/${id}`, body),
    onSuccess: () => invalidateReferenceCaches(queryClient),
  });
}

export function useSetCostCentreActive() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: ActiveBody }) =>
      api.post<AdminCostCentreOut>(
        `/admin/reference/cost-centres/${id}/active`,
        body,
      ),
    onSuccess: () => invalidateReferenceCaches(queryClient),
  });
}
