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
  departmentId: string | null;
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

type NestVendor = {
  id: string;
  code: string;
  name: string;
  email: string | null;
  phone: string | null;
  defaultCurrency: string;
  paymentTermsDays: number | null;
  isActive: boolean;
};

type NestGlAccount = {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
};

type NestCostCentre = {
  id: string;
  code: string;
  name: string;
  departmentId: string | null;
  isActive: boolean;
};

type NestDepartment = { id: string; name: string };

function toVendor(row: NestVendor): AdminVendorOut {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    email: row.email,
    phone: row.phone,
    default_currency: row.defaultCurrency,
    payment_terms_days: row.paymentTermsDays,
    is_active: row.isActive,
  };
}

function toGlAccount(row: NestGlAccount): AdminGlAccountOut {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    is_active: row.isActive,
  };
}

function vendorWrite(body: VendorCreateBody | VendorUpdateBody) {
  return {
    ...('code' in body ? { code: body.code } : {}),
    name: body.name,
    email: body.email,
    phone: body.phone,
    defaultCurrency: body.default_currency,
    paymentTermsDays: body.payment_terms_days,
    reason: body.reason,
  };
}

function activeWrite(body: ActiveBody) {
  return { isActive: body.is_active, reason: body.reason };
}

export function useAdminVendors(includeInactive = true) {
  return useQuery({
    queryKey: referenceAdminKeys.vendors(includeInactive),
    queryFn: async () => {
      const rows = await api.get<NestVendor[]>(
        `/vendors${toQuery({ includeInactive })}`,
      );
      return rows.map(toVendor);
    },
  });
}

export function useCreateVendor() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: VendorCreateBody) =>
      toVendor(await api.post<NestVendor>('/vendors', vendorWrite(body))),
    onSuccess: () => invalidateReferenceCaches(queryClient),
  });
}

export function useUpdateVendor() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, body }: { id: string; body: VendorUpdateBody }) =>
      toVendor(await api.put<NestVendor>(`/vendors/${id}`, vendorWrite(body))),
    onSuccess: () => invalidateReferenceCaches(queryClient),
  });
}

export function useSetVendorActive() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, body }: { id: string; body: ActiveBody }) =>
      toVendor(await api.post<NestVendor>(`/vendors/${id}/active`, activeWrite(body))),
    onSuccess: () => invalidateReferenceCaches(queryClient),
  });
}

export function useAdminGlAccounts(includeInactive = true) {
  return useQuery({
    queryKey: referenceAdminKeys.glAccounts(includeInactive),
    queryFn: async () => {
      const rows = await api.get<NestGlAccount[]>(
        `/gl-accounts${toQuery({ includeInactive })}`,
      );
      return rows.map(toGlAccount);
    },
  });
}

export function useCreateGlAccount() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: GlAccountCreateBody) =>
      toGlAccount(await api.post<NestGlAccount>('/gl-accounts', body)),
    onSuccess: () => invalidateReferenceCaches(queryClient),
  });
}

export function useUpdateGlAccount() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, body }: { id: string; body: GlAccountUpdateBody }) =>
      toGlAccount(await api.put<NestGlAccount>(`/gl-accounts/${id}`, body)),
    onSuccess: () => invalidateReferenceCaches(queryClient),
  });
}

export function useSetGlAccountActive() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, body }: { id: string; body: ActiveBody }) =>
      toGlAccount(
        await api.post<NestGlAccount>(`/gl-accounts/${id}/active`, activeWrite(body)),
      ),
    onSuccess: () => invalidateReferenceCaches(queryClient),
  });
}

export function useAdminCostCentres(includeInactive = true) {
  return useQuery({
    queryKey: referenceAdminKeys.costCentres(includeInactive),
    queryFn: async () => {
      const [rows, departments] = await Promise.all([
        api.get<NestCostCentre[]>(`/cost-centres${toQuery({ includeInactive })}`),
        api.get<NestDepartment[]>(`/departments${toQuery({ includeInactive: true })}`),
      ]);
      const names = new Map(departments.map((department) => [department.id, department.name]));
      return rows.map((row) => ({
        id: row.id,
        code: row.code,
        name: row.name,
        department: row.departmentId ? (names.get(row.departmentId) ?? null) : null,
        departmentId: row.departmentId,
        is_active: row.isActive,
      }));
    },
  });
}

export function useCreateCostCentre() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CostCentreCreateBody) =>
      api.post('/cost-centres', {
        code: body.code,
        name: body.name,
        departmentId: body.department,
        reason: body.reason,
      }),
    onSuccess: () => invalidateReferenceCaches(queryClient),
  });
}

export function useUpdateCostCentre() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: CostCentreUpdateBody }) =>
      api.put(`/cost-centres/${id}`, {
        name: body.name,
        departmentId: body.department,
        reason: body.reason,
      }),
    onSuccess: () => invalidateReferenceCaches(queryClient),
  });
}

export function useSetCostCentreActive() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: ActiveBody }) =>
      api.post(`/cost-centres/${id}/active`, activeWrite(body)),
    onSuccess: () => invalidateReferenceCaches(queryClient),
  });
}
