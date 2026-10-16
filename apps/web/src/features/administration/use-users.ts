import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { nestApi, toQuery } from "@/lib/api-client";
import { toast } from "sonner";

export type AdminUserOut = {
  id: string;
  email: string;
  display_name: string;
  department: string | null;
  department_id: string | null;
  job_title: string | null;
  is_active: boolean;
  email_verified: boolean;
  roles: string[];
  permissions: string[];
};

export type UserCreateBody = {
  email: string;
  display_name: string;
  department: string | null;
  department_id?: string | null;
  roles: string[];
  reason: string;
};

export type UserProfileBody = {
  display_name: string;
  department_id: string | null;
  job_title: string | null;
  reason: string;
};

export type UserRolesBody = {
  roles: string[];
};

export type UserActiveBody = {
  is_active: boolean;
  reason: string;
};

export const ROLE_OPTIONS = [
  {
    id: "requester",
    label: "Requester",
    help: "Raise estimates and confirm goods or services arrived.",
  },
  {
    id: "approver",
    label: "Approver",
    help: "Decide on routes. Cannot also edit the approval matrix.",
  },
  {
    id: "payment_coordinator",
    label: "Payment coordinator",
    help: "Assemble packages and send them to the bank.",
  },
  {
    id: "finance",
    label: "Finance",
    help: "Invoices, credit cards, accruals and Paid/Outstanding review.",
  },
  {
    id: "administrator",
    label: "Administrator",
    help: "Users, roles and the approval matrix. Cannot also decide approvals.",
  },
  {
    id: "operations",
    label: "Operations",
    help: "Intake health, retries and platform operations.",
  },
  {
    id: "auditor",
    label: "Auditor",
    help: "Read the trail. Cannot change anything.",
  },
] as const;

export const userAdminKeys = {
  all: ["admin", "users"] as const,
  list: (includeInactive: boolean) =>
    ["admin", "users", includeInactive ? "all" : "active"] as const,
};

export function useUsers(includeInactive = true) {
  return useQuery({
    queryKey: userAdminKeys.list(includeInactive),
    queryFn: () =>
      nestApi.get<AdminUserOut[]>(
        `/admin/users${toQuery({ include_inactive: includeInactive })}`,
      ),
  });
}

export function useCreateUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: UserCreateBody) =>
      nestApi.post<AdminUserOut>("/admin/users", body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: userAdminKeys.all });
      void queryClient.invalidateQueries({ queryKey: ["admin", "people"] });
    },
  });
}

export function useUpdateUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, body }: { userId: string; body: UserProfileBody }) =>
      nestApi.put<AdminUserOut>(`/admin/users/${userId}`, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: userAdminKeys.all });
      void queryClient.invalidateQueries({ queryKey: ["admin", "people"] });
    },
  });
}

export function useSetUserRoles() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, body }: { userId: string; body: UserRolesBody }) =>
      nestApi.put<AdminUserOut>(`/admin/users/${userId}/roles`, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: userAdminKeys.all });
      void queryClient.invalidateQueries({ queryKey: ["admin", "people"] });
      toast.success("Roles updated successfully");
    },
  });
}

export function useResendInvite() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) =>
      nestApi.post<AdminUserOut>(`/admin/users/${userId}/resend-invite`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: userAdminKeys.all });
    },
  });
}

export function useSetUserActive() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, body }: { userId: string; body: UserActiveBody }) =>
      nestApi.post<AdminUserOut>(`/admin/users/${userId}/active`, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: userAdminKeys.all });
      void queryClient.invalidateQueries({ queryKey: ["admin", "people"] });
    },
  });
}
