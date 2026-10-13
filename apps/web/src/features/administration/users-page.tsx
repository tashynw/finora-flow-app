/** Users and roles administration screen. */

import { useEffect, useState } from "react";
import { UserPlus, Users } from "lucide-react";
import { toast } from "sonner";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";

import { cn } from "@/lib/utils";
import { errorMessage } from "@/lib/api-client";
import { auditReason, requiredText } from "@/lib/form-schemas";
import { HookField } from "@/components/form/hook-field";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { DataTable, type Column } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { Input, Textarea } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { SkeletonText } from "@/components/ui/skeleton";
import { ViewTabs } from "@/components/ui/view-tabs";
import { ToneBadge } from "@/components/workflow/status-badge";
import { EmailText } from "@/features/shared/email-text";
import { PageHeader } from "@/features/shared/page-header";
import { Combobox } from "@/components/ui/combobox";
import { useDepartments } from "@/features/administration/use-departments";
import { useAuth } from "@/features/auth/auth-context";
import {
  ROLE_OPTIONS,
  useCreateUser,
  useResendInvite,
  useSetUserActive,
  useSetUserRoles,
  useUsers,
  type AdminUserOut,
} from "@/features/administration/use-users";

function roleLabel(id: string): string {
  return (
    ROLE_OPTIONS.find((role) => role.id === id)?.label ??
    id.replaceAll("_", " ")
  );
}

function RoleEditor({
  selected,
  onChange,
}: {
  selected: ReadonlySet<string>;
  onChange: (next: Set<string>) => void;
}) {
  return (
    <fieldset className="m-0 border-0 p-0">
      <legend className="mb-[var(--space-2)] text-[length:var(--text-body-sm)] font-semibold">
        Roles
      </legend>
      <ul className="m-0 flex list-none flex-col gap-[var(--space-2)] p-0">
        {ROLE_OPTIONS.map((role) => {
          const checked = selected.has(role.id);
          return (
            <li key={role.id}>
              <label className="flex cursor-pointer items-start gap-[var(--space-2)]">
                <input
                  type="checkbox"
                  className="mt-1 size-4 accent-[var(--color-primary)]"
                  checked={checked}
                  aria-label={role.label}
                  onChange={() => {
                    const next = new Set(selected);
                    if (next.has(role.id)) next.delete(role.id);
                    else next.add(role.id);
                    onChange(next);
                  }}
                />
                <span>
                  <span className="block font-medium text-[var(--color-text-strong)]">
                    {role.label}
                  </span>
                  <span className="block text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]">
                    {role.help}
                  </span>
                </span>
              </label>
            </li>
          );
        })}
      </ul>
      <p className="mt-[var(--space-3)] m-0 text-[length:var(--text-caption)] text-[var(--color-text-subtle)]">
        Administrator and Approver cannot be combined: editing the approval
        matrix and deciding approvals must sit with different people.
      </p>
    </fieldset>
  );
}

const inviteSchema = z.object({
  email: requiredText("An email address is required.").refine(
    (value) => z.email().safeParse(value).success,
    "Enter a valid email address.",
  ),
  displayName: requiredText("A display name is required."),
  departmentId: z.string(),
  roles: z.array(z.string()).min(1, "Choose at least one role."),
  reason: auditReason,
});

type InviteForm = z.infer<typeof inviteSchema>;

const emptyInvite: InviteForm = {
  email: "",
  displayName: "",
  departmentId: "",
  roles: ["requester"],
  reason: "",
};

function CreateUserModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const create = useCreateUser();
  const departments = useDepartments(false, open);
  const { control, handleSubmit, reset } = useForm<InviteForm>({
    resolver: zodResolver(inviteSchema),
    defaultValues: emptyInvite,
  });

  useEffect(() => {
    if (!open) return;
    reset(emptyInvite);
  }, [open, reset]);

  function close() {
    reset(emptyInvite);
    create.reset();
    onClose();
  }

  const onSubmit = handleSubmit((values) => {
    create.mutate(
      {
        email: values.email,
        display_name: values.displayName,
        department: null,
        department_id: values.departmentId || null,
        roles: values.roles,
        reason: values.reason,
      },
      {
        onSuccess: () => {
          toast.success("An invitation link has been sent to the user.");
          close();
        },
        onError: (error) => {
          toast.error(
            errorMessage(error) ?? "The invitation could not be sent.",
          );
        },
      },
    );
  });

  return (
    <Modal
      open={open}
      onClose={close}
      title="Invite user"
      description="They receive an email with a link to choose a password. Roles that grant incompatible rights are refused."
    >
      <form
        className="flex flex-col gap-[var(--space-4)]"
        onSubmit={onSubmit}
        noValidate
      >
        <HookField control={control} name="email" label="Email" required>
          {({ inputId, describedBy, invalid }, field) => (
            <Input
              id={inputId}
              type="email"
              aria-describedby={describedBy}
              invalid={invalid}
              {...field}
            />
          )}
        </HookField>
        <HookField
          control={control}
          name="displayName"
          label="Display name"
          required
        >
          {({ inputId, describedBy, invalid }, field) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              invalid={invalid}
              {...field}
            />
          )}
        </HookField>
        <HookField
          control={control}
          name="departmentId"
          label="Department"
          help={
            departments.data?.length
              ? "Optional. Choose one that already exists."
              : "Optional. Add departments under Reference data first."
          }
        >
          {({ inputId, describedBy, invalid }, field) => (
            <Combobox
              id={inputId}
              describedBy={describedBy}
              invalid={invalid}
              value={field.value}
              onChange={field.onChange}
              placeholder="Select a department"
              emptyLabel="No department found."
              clearLabel="No department"
              items={(departments.data ?? [])
                .filter((department) => department.isActive)
                .map((department) => ({
                  value: department.id,
                  label: `${department.name} · ${department.costCentreNumber}`,
                }))}
            />
          )}
        </HookField>
        <Controller
          control={control}
          name="roles"
          render={({ field, fieldState }) => (
            <>
              <RoleEditor
                selected={new Set(field.value)}
                onChange={(next) => field.onChange([...next])}
              />
              {fieldState.error?.message ? (
                <p role="alert" className="m-0 text-[var(--color-danger-700)]">
                  {fieldState.error.message}
                </p>
              ) : null}
            </>
          )}
        />
        <HookField control={control} name="reason" label="Why" required>
          {({ inputId, describedBy, invalid }, field) => (
            <Textarea
              id={inputId}
              aria-describedby={describedBy}
              invalid={invalid}
              rows={3}
              {...field}
            />
          )}
        </HookField>
        {create.isError ? (
          <p role="alert" className="m-0 text-[var(--color-danger-700)]">
            {errorMessage(create.error) ?? "The account could not be created."}
          </p>
        ) : null}
        <Button
          type="submit"
          isLoading={create.isPending}
          loadingLabel="Sending"
        >
          Invite
        </Button>
      </form>
    </Modal>
  );
}

const rolesSchema = z.object({
  roles: z.array(z.string()).min(1, "Choose at least one role."),
  reason: auditReason,
});

type RolesForm = z.infer<typeof rolesSchema>;

function EditRolesModal({
  user,
  onClose,
}: {
  user: AdminUserOut | null;
  onClose: () => void;
}) {
  const setRoles = useSetUserRoles();
  const { control, handleSubmit, reset } = useForm<RolesForm>({
    resolver: zodResolver(rolesSchema),
    defaultValues: { roles: [], reason: "" },
  });

  useEffect(() => {
    if (!user) return;
    reset({ roles: user.roles, reason: "" });
    setRoles.reset();
  }, [user, reset, setRoles]);

  const onSubmit = handleSubmit((values) => {
    if (!user) return;
    setRoles.mutate(
      { userId: user.id, body: { roles: values.roles, reason: values.reason } },
      { onSuccess: () => onClose() },
    );
  });

  return (
    <Modal
      open={user !== null}
      onClose={onClose}
      title={user ? `Roles for ${user.display_name}` : "Roles"}
      description="Changing roles is audited. Incompatible combinations are refused."
    >
      {user ? (
        <form
          className="flex flex-col gap-[var(--space-4)]"
          onSubmit={onSubmit}
          noValidate
        >
          <Controller
            control={control}
            name="roles"
            render={({ field, fieldState }) => (
              <>
                <RoleEditor
                  selected={new Set(field.value)}
                  onChange={(next) => field.onChange([...next])}
                />
                {fieldState.error?.message ? (
                  <p
                    role="alert"
                    className="m-0 text-[var(--color-danger-700)]"
                  >
                    {fieldState.error.message}
                  </p>
                ) : null}
              </>
            )}
          />
          <HookField control={control} name="reason" label="Why" required>
            {({ inputId, describedBy, invalid }, field) => (
              <Textarea
                id={inputId}
                aria-describedby={describedBy}
                invalid={invalid}
                rows={3}
                {...field}
              />
            )}
          </HookField>
          {setRoles.isError ? (
            <p role="alert" className="m-0 text-[var(--color-danger-700)]">
              {errorMessage(setRoles.error) ?? "The roles could not be saved."}
            </p>
          ) : null}
          <Button
            type="submit"
            isLoading={setRoles.isPending}
            loadingLabel="Saving"
          >
            Save roles
          </Button>
        </form>
      ) : null}
    </Modal>
  );
}

export function UsersPage() {
  const { user: me } = useAuth();
  const [includeInactive, setIncludeInactive] = useState(true);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<AdminUserOut | null>(null);
  const users = useUsers(includeInactive);
  const setActive = useSetUserActive();
  const resendInvite = useResendInvite();

  const rows = users.data ?? [];

  const columns: Column<AdminUserOut>[] = [
    {
      key: "name",
      header: "Name",
      width: "w-52",
      cell: (row) => (
        <span
          className={cn(
            "font-semibold",
            row.is_active
              ? "text-[var(--color-text-strong)]"
              : "text-[var(--color-text-muted)]",
          )}
        >
          {row.display_name}
        </span>
      ),
    },
    {
      key: "email",
      header: "Email",
      cell: (row) => <EmailText email={row.email} />,
    },
    {
      key: "department",
      header: "Department",
      width: "w-40",
      hideBelow: "lg",
      cell: (row) => (
        <span
          className={
            row.department ? undefined : "text-[var(--color-text-subtle)]"
          }
        >
          {row.department ?? "No department"}
        </span>
      ),
    },
    {
      key: "roles",
      header: "Roles",
      hideBelow: "md",
      cell: (row) => (
        <span>{row.roles.map(roleLabel).join(", ") || "No roles"}</span>
      ),
    },
    {
      key: "status",
      header: "Status",
      width: "w-32",
      cell: (row) =>
        !row.is_active ? (
          <ToneBadge label="Deactivated" tone="neutral" />
        ) : row.email_verified ? (
          <ToneBadge label="Active" tone="success" />
        ) : (
          <ToneBadge label="Invited" tone="warning" />
        ),
    },
    {
      key: "actions",
      header: <span className="sr-only">Actions</span>,
      width: "w-52",
      align: "right",
      cell: (row) => (
        <span className="inline-flex flex-wrap justify-end gap-1">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setEditing(row)}
          >
            Edit roles
          </Button>
          {row.is_active && !row.email_verified ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={resendInvite.isPending}
              onClick={() =>
                resendInvite.mutate(row.id, {
                  onSuccess: () => {
                    toast.success(
                      "An invitation link has been sent to the user.",
                    );
                  },
                  onError: (error) => {
                    toast.error(
                      errorMessage(error) ??
                        "The invitation could not be sent.",
                    );
                  },
                })
              }
            >
              Resend invite
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={
              setActive.isPending || (me?.id === row.id && row.is_active)
            }
            className={cn(!row.is_active && "text-[var(--color-success-700)]")}
            onClick={() => {
              const reason = window.prompt(
                row.is_active
                  ? "Why is this account being deactivated?"
                  : "Why is this account being reactivated?",
              );
              if (!reason || reason.trim().length < 3) return;
              setActive.mutate({
                userId: row.id,
                body: { is_active: !row.is_active, reason: reason.trim() },
              });
            }}
          >
            {row.is_active ? "Deactivate" : "Reactivate"}
          </Button>
        </span>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Users and roles"
        purpose="Accounts, roles, status and segregation controls: matrix editing and approving never share an account."
        toolbar={
          <ViewTabs
            label="Which accounts"
            tabs={[
              { id: "all", label: "All accounts" },
              { id: "active", label: "Active only" },
            ]}
            value={includeInactive ? "all" : "active"}
            onChange={(id) => setIncludeInactive(id === "all")}
          />
        }
        actions={
          <Button
            type="button"
            variant="primary"
            size="sm"
            onClick={() => setCreating(true)}
          >
            <UserPlus aria-hidden="true" className="size-4" />
            Invite user
          </Button>
        }
      />

      {setActive.isError ? (
        <Card className="mb-[var(--space-5)] border-[var(--color-danger-600)]">
          <CardContent>
            <p
              role="alert"
              className="m-0 text-[length:var(--text-body-sm)] text-[var(--color-danger-700)]"
            >
              {errorMessage(setActive.error) ??
                "The account could not be changed."}
            </p>
          </CardContent>
        </Card>
      ) : null}

      {users.isLoading ? (
        <Card>
          <CardContent>
            <SkeletonText lines={8} />
          </CardContent>
        </Card>
      ) : users.isError ? (
        <Card className="border-[var(--color-danger-600)]">
          <CardContent>
            <p role="alert" className="m-0 text-[var(--color-danger-700)]">
              {errorMessage(users.error) ??
                "The user list could not be loaded."}
            </p>
          </CardContent>
        </Card>
      ) : rows.length === 0 ? (
        <Card>
          <CardContent className="p-0">
            <EmptyState
              icon={Users}
              title="No accounts yet"
              explanation="Nobody has been granted access. Invite someone to begin."
              nextStep="Use Invite user, choose their roles, and they will get an email to set a password."
            />
          </CardContent>
        </Card>
      ) : (
        <DataTable
          ariaLabel="Accounts"
          columns={columns}
          rows={rows}
          getRowKey={(row) => row.id}
        />
      )}

      <CreateUserModal open={creating} onClose={() => setCreating(false)} />
      <EditRolesModal user={editing} onClose={() => setEditing(null)} />
    </>
  );
}
