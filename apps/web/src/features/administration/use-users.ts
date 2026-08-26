import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api, toQuery } from '@/lib/api-client';

export type AdminUserOut = {
  id: string;
  email: string;
  display_name: string;
  department: string | null;
  is_active: boolean;
  roles: string[];
  permissions: string[];
};

export type UserCreateBody = {
  email: string;
  display_name: string;
  department: string | null;
  roles: string[];
  reason: string;
};

export type UserRolesBody = {
  roles: string[];
  reason: string;
};

export type UserActiveBody = {
  is_active: boolean;
  reason: string;
};

export const ROLE_OPTIONS = [
  {
    id: 'requester',
    label: 'Requester',
    help: 'Raise estimates and confirm goods or services arrived.',
  },
  {
    id: 'approver',
    label: 'Approver',
    help: 'Decide on routes. Cannot also edit the approval matrix.',
  },
  {
    id: 'payment_coordinator',
    label: 'Payment coordinator',
    help: 'Assemble packages and send them to the bank.',
  },
  {
    id: 'finance',
    label: 'Finance',
    help: 'Invoices, credit cards, accruals and Paid/Outstanding review.',
  },
  {
    id: 'administrator',
    label: 'Administrator',
    help: 'Users, roles and the approval matrix. Cannot also decide approvals.',
  },
  {
    id: 'operations',
    label: 'Operations',
    help: 'Intake health, retries and platform operations.',
  },
  {
    id: 'auditor',
    label: 'Auditor',
    help: 'Read the trail. Cannot change anything.',
  },
] as const;

export const userAdminKeys = {
  all: ['admin', 'users'] as const,
  list: (includeInactive: boolean) =>
    ['admin', 'users', includeInactive ? 'all' : 'active'] as const,
};

export function useUsers(includeInactive = true) {
  return useQuery({
    queryKey: userAdminKeys.list(includeInactive),
    queryFn: () =>
      api.get<AdminUserOut[]>(
        `/admin/users${toQuery({ include_inactive: includeInactive })}`,
      ),
  });
}

export function useCreateUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: UserCreateBody) =>
      api.post<AdminUserOut>('/admin/users', body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: userAdminKeys.all });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'people'] });
    },
  });
}

export function useSetUserRoles() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, body }: { userId: string; body: UserRolesBody }) =>
      api.put<AdminUserOut>(`/admin/users/${userId}/roles`, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: userAdminKeys.all });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'people'] });
    },
  });
}

export function useSetUserActive() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, body }: { userId: string; body: UserActiveBody }) =>
      api.post<AdminUserOut>(`/admin/users/${userId}/active`, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: userAdminKeys.all });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'people'] });
    },
  });
}
