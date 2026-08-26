/** Users and roles administration screen. */

import { useEffect, useState } from 'react';
import { UserPlus, Users } from 'lucide-react';

import { cn } from '@/lib/utils';
import { errorMessage } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input, Textarea } from '@/components/ui/field';
import { Modal } from '@/components/ui/modal';
import { SkeletonText } from '@/components/ui/skeleton';
import { ToneBadge } from '@/components/workflow/status-badge';
import { PageHeader } from '@/features/shared/page-header';
import { useAuth } from '@/features/auth/auth-context';
import {
  ROLE_OPTIONS,
  useCreateUser,
  useSetUserActive,
  useSetUserRoles,
  useUsers,
  type AdminUserOut,
} from '@/features/administration/use-users';

function RoleEditor({
  selected,
  onChange,
}: {
  selected: ReadonlySet<string>;
  onChange: (next: Set<string>) => void;
}) {
  return (
    <fieldset className="m-0 border-0 p-0">
      <legend className="mb-[var(--space-2)] text-[var(--text-body-sm)] font-semibold">
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
                  <span className="block text-[var(--text-body-sm)] text-[var(--color-text-muted)]">
                    {role.help}
                  </span>
                </span>
              </label>
            </li>
          );
        })}
      </ul>
      <p className="mt-[var(--space-3)] m-0 text-[var(--text-caption)] text-[var(--color-text-subtle)]">
        Administrator and Approver cannot be combined: editing the approval matrix
        and deciding approvals must sit with different people.
      </p>
    </fieldset>
  );
}

function CreateUserModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const create = useCreateUser();
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [department, setDepartment] = useState('');
  const [roles, setRoles] = useState<Set<string>>(new Set(['requester']));
  const [reason, setReason] = useState('');

  function reset() {
    setEmail('');
    setDisplayName('');
    setDepartment('');
    setRoles(new Set(['requester']));
    setReason('');
    create.reset();
  }

  return (
    <Modal
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      title="Create account"
      description="A reason is required. Roles that grant incompatible rights are refused."
    >
      <div className="flex flex-col gap-[var(--space-4)]">
        <Field label="Email">
          {({ inputId, describedBy, invalid }) => (
            <Input
              id={inputId}
              type="email"
              aria-describedby={describedBy}
              invalid={invalid}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          )}
        </Field>
        <Field label="Display name">
          {({ inputId, describedBy, invalid }) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              invalid={invalid}
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
            />
          )}
        </Field>
        <Field label="Department" help="Optional.">
          {({ inputId, describedBy, invalid }) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              invalid={invalid}
              value={department}
              onChange={(event) => setDepartment(event.target.value)}
            />
          )}
        </Field>
        <RoleEditor selected={roles} onChange={setRoles} />
        <Field label="Why">
          {({ inputId, describedBy, invalid }) => (
            <Textarea
              id={inputId}
              aria-describedby={describedBy}
              invalid={invalid}
              rows={3}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          )}
        </Field>
        {create.isError ? (
          <p role="alert" className="m-0 text-[var(--color-danger-700)]">
            {errorMessage(create.error) ?? 'The account could not be created.'}
          </p>
        ) : null}
        <Button
          type="button"
          disabled={
            create.isPending ||
            !email.trim() ||
            !displayName.trim() ||
            roles.size === 0 ||
            reason.trim().length < 3
          }
          onClick={() =>
            create.mutate(
              {
                email: email.trim(),
                display_name: displayName.trim(),
                department: department.trim() || null,
                roles: [...roles],
                reason: reason.trim(),
              },
              {
                onSuccess: () => {
                  reset();
                  onClose();
                },
              },
            )
          }
        >
          {create.isPending ? 'Creating…' : 'Create account'}
        </Button>
      </div>
    </Modal>
  );
}

function EditRolesModal({
  user,
  onClose,
}: {
  user: AdminUserOut | null;
  onClose: () => void;
}) {
  const setRoles = useSetUserRoles();
  const [roles, setSelected] = useState<Set<string>>(new Set());
  const [reason, setReason] = useState('');

  const open = user !== null;

  useEffect(() => {
    if (user) {
      setSelected(new Set(user.roles));
      setReason('');
      setRoles.reset();
    }
  }, [user, setRoles]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={user ? `Roles for ${user.display_name}` : 'Roles'}
      description="Changing roles is audited. Incompatible combinations are refused."
    >
      {user ? (
        <div className="flex flex-col gap-[var(--space-4)]">
          <RoleEditor selected={roles} onChange={setSelected} />
          <Field label="Why">
            {({ inputId, describedBy, invalid }) => (
              <Textarea
                id={inputId}
                aria-describedby={describedBy}
                invalid={invalid}
                rows={3}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            )}
          </Field>
          {setRoles.isError ? (
            <p role="alert" className="m-0 text-[var(--color-danger-700)]">
              {errorMessage(setRoles.error) ?? 'The roles could not be saved.'}
            </p>
          ) : null}
          <Button
            type="button"
            disabled={setRoles.isPending || reason.trim().length < 3}
            onClick={() =>
              setRoles.mutate(
                {
                  userId: user.id,
                  body: { roles: [...roles], reason: reason.trim() },
                },
                { onSuccess: () => onClose() },
              )
            }
          >
            {setRoles.isPending ? 'Saving…' : 'Save roles'}
          </Button>
        </div>
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

  const rows = users.data ?? [];

  return (
    <div className="flex flex-col gap-[var(--space-6)]">
      <PageHeader
        title="Users and roles"
        purpose="Who can sign in, and which roles they hold. Editing the approval matrix and deciding approvals cannot sit on the same account."
        actions={
          <Button type="button" onClick={() => setCreating(true)}>
            <UserPlus aria-hidden="true" className="size-4" />
            Create account
          </Button>
        }
      />

      <label className="flex cursor-pointer items-center gap-[var(--space-2)] text-[var(--text-body-sm)]">
        <input
          type="checkbox"
          className="size-4 accent-[var(--color-primary)]"
          checked={includeInactive}
          onChange={(event) => setIncludeInactive(event.target.checked)}
        />
        Show deactivated accounts
      </label>

      {users.isLoading ? (
        <SkeletonText lines={8} />
      ) : users.isError ? (
        <p role="alert" className="m-0 text-[var(--color-danger-700)]">
          {errorMessage(users.error) ?? 'The user list could not be loaded.'}
        </p>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Users}
          title="No accounts yet"
          explanation="Nobody has been granted access. Create an account to begin."
          nextStep="Use Create account and name the roles they need."
        />
      ) : (
        <Card className="surface-card overflow-hidden">
          <CardContent className="p-0">
            <ul className="m-0 list-none p-0">
              {rows.map((row) => (
                <li
                  key={row.id}
                  className="flex flex-col gap-[var(--space-3)] border-b border-[var(--color-divider)] px-[var(--space-5)] py-[var(--space-4)] last:border-b-0 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <p className="m-0 flex flex-wrap items-baseline gap-x-[var(--space-2)]">
                      <span className="font-semibold text-[var(--color-text-strong)]">
                        {row.display_name}
                      </span>
                      <span className="text-[var(--text-body-sm)] text-[var(--color-text-muted)]">
                        {row.email}
                      </span>
                      {!row.is_active ? (
                        <ToneBadge label="Deactivated" tone="neutral" />
                      ) : null}
                    </p>
                    <p className="m-0 truncate text-[var(--text-body-sm)] text-[var(--color-text-muted)]">
                      {row.department ?? 'No department'}
                      {' · '}
                      {row.roles.map((role) => role.replaceAll('_', ' ')).join(', ') || 'No roles'}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-[var(--space-2)]">
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      onClick={() => setEditing(row)}
                    >
                      Edit roles
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      disabled={
                        setActive.isPending || (me?.id === row.id && row.is_active)
                      }
                      className={cn(!row.is_active && 'text-[var(--color-success-700)]')}
                      onClick={() => {
                        const reason = window.prompt(
                          row.is_active
                            ? 'Why is this account being deactivated?'
                            : 'Why is this account being reactivated?',
                        );
                        if (!reason || reason.trim().length < 3) return;
                        setActive.mutate({
                          userId: row.id,
                          body: { is_active: !row.is_active, reason: reason.trim() },
                        });
                      }}
                    >
                      {row.is_active ? 'Deactivate' : 'Reactivate'}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <CreateUserModal open={creating} onClose={() => setCreating(false)} />
      <EditRolesModal user={editing} onClose={() => setEditing(null)} />
    </div>
  );
}
