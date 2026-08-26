/** Reference data administration — vendors, GL accounts and cost centres. */

import { useEffect, useState, type ReactNode } from 'react';
import { BookMarked, Plus } from 'lucide-react';

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
import {
  useAdminCostCentres,
  useAdminGlAccounts,
  useAdminVendors,
  useCreateCostCentre,
  useCreateGlAccount,
  useCreateVendor,
  useSetCostCentreActive,
  useSetGlAccountActive,
  useSetVendorActive,
  useUpdateCostCentre,
  useUpdateGlAccount,
  useUpdateVendor,
  type AdminCostCentreOut,
  type AdminGlAccountOut,
  type AdminVendorOut,
} from '@/features/administration/use-reference-admin';

type Catalogue = 'vendors' | 'gl-accounts' | 'cost-centres';

const TABS: { id: Catalogue; label: string }[] = [
  { id: 'vendors', label: 'Vendors' },
  { id: 'gl-accounts', label: 'GL accounts' },
  { id: 'cost-centres', label: 'Cost centres' },
];

function CreateVendorModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const create = useCreateVendor();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [currency, setCurrency] = useState('JMD');
  const [reason, setReason] = useState('');

  function reset() {
    setCode('');
    setName('');
    setEmail('');
    setCurrency('JMD');
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
      title="Add vendor"
      description="A reason is required. Codes cannot be reused once taken."
    >
      <div className="flex flex-col gap-[var(--space-4)]">
        <Field label="Code">
          {({ inputId, describedBy, invalid }) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              invalid={invalid}
              value={code}
              onChange={(event) => setCode(event.target.value)}
            />
          )}
        </Field>
        <Field label="Name">
          {({ inputId, describedBy, invalid }) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              invalid={invalid}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          )}
        </Field>
        <Field label="Email" help="Optional.">
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
        <Field label="Currency">
          {({ inputId, describedBy, invalid }) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              invalid={invalid}
              maxLength={3}
              value={currency}
              onChange={(event) => setCurrency(event.target.value.toUpperCase())}
            />
          )}
        </Field>
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
            {errorMessage(create.error) ?? 'The vendor could not be created.'}
          </p>
        ) : null}
        <Button
          type="button"
          disabled={
            create.isPending ||
            !code.trim() ||
            !name.trim() ||
            currency.trim().length !== 3 ||
            reason.trim().length < 3
          }
          onClick={() =>
            create.mutate(
              {
                code: code.trim(),
                name: name.trim(),
                email: email.trim() || null,
                phone: null,
                default_currency: currency.trim().toUpperCase(),
                payment_terms_days: null,
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
          {create.isPending ? 'Adding…' : 'Add vendor'}
        </Button>
      </div>
    </Modal>
  );
}

function EditVendorModal({
  vendor,
  onClose,
}: {
  vendor: AdminVendorOut | null;
  onClose: () => void;
}) {
  const update = useUpdateVendor();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [currency, setCurrency] = useState('JMD');
  const [reason, setReason] = useState('');
  const open = vendor !== null;

  useEffect(() => {
    if (vendor) {
      setName(vendor.name);
      setEmail(vendor.email ?? '');
      setCurrency(vendor.default_currency);
      setReason('');
      update.reset();
    }
  }, [vendor, update]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={vendor ? `Edit ${vendor.code}` : 'Edit vendor'}
      description="Changing a vendor is audited. Bank details are not edited here."
    >
      {vendor ? (
        <div className="flex flex-col gap-[var(--space-4)]">
          <Field label="Name">
            {({ inputId, describedBy, invalid }) => (
              <Input
                id={inputId}
                aria-describedby={describedBy}
                invalid={invalid}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            )}
          </Field>
          <Field label="Email" help="Optional.">
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
          <Field label="Currency">
            {({ inputId, describedBy, invalid }) => (
              <Input
                id={inputId}
                aria-describedby={describedBy}
                invalid={invalid}
                maxLength={3}
                value={currency}
                onChange={(event) => setCurrency(event.target.value.toUpperCase())}
              />
            )}
          </Field>
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
          {update.isError ? (
            <p role="alert" className="m-0 text-[var(--color-danger-700)]">
              {errorMessage(update.error) ?? 'The vendor could not be saved.'}
            </p>
          ) : null}
          <Button
            type="button"
            disabled={
              update.isPending ||
              !name.trim() ||
              currency.trim().length !== 3 ||
              reason.trim().length < 3
            }
            onClick={() =>
              update.mutate(
                {
                  id: vendor.id,
                  body: {
                    name: name.trim(),
                    email: email.trim() || null,
                    default_currency: currency.trim().toUpperCase(),
                    reason: reason.trim(),
                  },
                },
                { onSuccess: () => onClose() },
              )
            }
          >
            {update.isPending ? 'Saving…' : 'Save vendor'}
          </Button>
        </div>
      ) : null}
    </Modal>
  );
}

function CreateGlAccountModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const create = useCreateGlAccount();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [reason, setReason] = useState('');

  function reset() {
    setCode('');
    setName('');
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
      title="Add GL account"
      description="A reason is required. Codes cannot be reused once taken."
    >
      <div className="flex flex-col gap-[var(--space-4)]">
        <Field label="Code">
          {({ inputId, describedBy, invalid }) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              invalid={invalid}
              value={code}
              onChange={(event) => setCode(event.target.value)}
            />
          )}
        </Field>
        <Field label="Name">
          {({ inputId, describedBy, invalid }) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              invalid={invalid}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          )}
        </Field>
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
            {errorMessage(create.error) ?? 'The GL account could not be created.'}
          </p>
        ) : null}
        <Button
          type="button"
          disabled={
            create.isPending ||
            !code.trim() ||
            !name.trim() ||
            reason.trim().length < 3
          }
          onClick={() =>
            create.mutate(
              {
                code: code.trim(),
                name: name.trim(),
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
          {create.isPending ? 'Adding…' : 'Add GL account'}
        </Button>
      </div>
    </Modal>
  );
}

function EditGlAccountModal({
  account,
  onClose,
}: {
  account: AdminGlAccountOut | null;
  onClose: () => void;
}) {
  const update = useUpdateGlAccount();
  const [name, setName] = useState('');
  const [reason, setReason] = useState('');
  const open = account !== null;

  useEffect(() => {
    if (account) {
      setName(account.name);
      setReason('');
      update.reset();
    }
  }, [account, update]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={account ? `Edit ${account.code}` : 'Edit GL account'}
      description="Changing a GL account is audited."
    >
      {account ? (
        <div className="flex flex-col gap-[var(--space-4)]">
          <Field label="Name">
            {({ inputId, describedBy, invalid }) => (
              <Input
                id={inputId}
                aria-describedby={describedBy}
                invalid={invalid}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            )}
          </Field>
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
          {update.isError ? (
            <p role="alert" className="m-0 text-[var(--color-danger-700)]">
              {errorMessage(update.error) ?? 'The GL account could not be saved.'}
            </p>
          ) : null}
          <Button
            type="button"
            disabled={update.isPending || !name.trim() || reason.trim().length < 3}
            onClick={() =>
              update.mutate(
                {
                  id: account.id,
                  body: { name: name.trim(), reason: reason.trim() },
                },
                { onSuccess: () => onClose() },
              )
            }
          >
            {update.isPending ? 'Saving…' : 'Save GL account'}
          </Button>
        </div>
      ) : null}
    </Modal>
  );
}

function CreateCostCentreModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const create = useCreateCostCentre();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [department, setDepartment] = useState('');
  const [reason, setReason] = useState('');

  function reset() {
    setCode('');
    setName('');
    setDepartment('');
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
      title="Add cost centre"
      description="A reason is required. Codes cannot be reused once taken."
    >
      <div className="flex flex-col gap-[var(--space-4)]">
        <Field label="Code">
          {({ inputId, describedBy, invalid }) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              invalid={invalid}
              value={code}
              onChange={(event) => setCode(event.target.value)}
            />
          )}
        </Field>
        <Field label="Name">
          {({ inputId, describedBy, invalid }) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              invalid={invalid}
              value={name}
              onChange={(event) => setName(event.target.value)}
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
            {errorMessage(create.error) ?? 'The cost centre could not be created.'}
          </p>
        ) : null}
        <Button
          type="button"
          disabled={
            create.isPending ||
            !code.trim() ||
            !name.trim() ||
            reason.trim().length < 3
          }
          onClick={() =>
            create.mutate(
              {
                code: code.trim(),
                name: name.trim(),
                department: department.trim() || null,
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
          {create.isPending ? 'Adding…' : 'Add cost centre'}
        </Button>
      </div>
    </Modal>
  );
}

function EditCostCentreModal({
  centre,
  onClose,
}: {
  centre: AdminCostCentreOut | null;
  onClose: () => void;
}) {
  const update = useUpdateCostCentre();
  const [name, setName] = useState('');
  const [department, setDepartment] = useState('');
  const [reason, setReason] = useState('');
  const open = centre !== null;

  useEffect(() => {
    if (centre) {
      setName(centre.name);
      setDepartment(centre.department ?? '');
      setReason('');
      update.reset();
    }
  }, [centre, update]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={centre ? `Edit ${centre.code}` : 'Edit cost centre'}
      description="Changing a cost centre is audited."
    >
      {centre ? (
        <div className="flex flex-col gap-[var(--space-4)]">
          <Field label="Name">
            {({ inputId, describedBy, invalid }) => (
              <Input
                id={inputId}
                aria-describedby={describedBy}
                invalid={invalid}
                value={name}
                onChange={(event) => setName(event.target.value)}
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
          {update.isError ? (
            <p role="alert" className="m-0 text-[var(--color-danger-700)]">
              {errorMessage(update.error) ?? 'The cost centre could not be saved.'}
            </p>
          ) : null}
          <Button
            type="button"
            disabled={update.isPending || !name.trim() || reason.trim().length < 3}
            onClick={() =>
              update.mutate(
                {
                  id: centre.id,
                  body: {
                    name: name.trim(),
                    department: department.trim() || null,
                    reason: reason.trim(),
                  },
                },
                { onSuccess: () => onClose() },
              )
            }
          >
            {update.isPending ? 'Saving…' : 'Save cost centre'}
          </Button>
        </div>
      ) : null}
    </Modal>
  );
}

function CatalogueList({
  loading,
  error,
  emptyTitle,
  emptyExplanation,
  rows,
}: {
  loading: boolean;
  error: unknown;
  emptyTitle: string;
  emptyExplanation: string;
  rows: ReactNode;
}) {
  if (loading) return <SkeletonText lines={8} />;
  if (error) {
    return (
      <p role="alert" className="m-0 text-[var(--color-danger-700)]">
        {errorMessage(error) ?? 'The catalogue could not be loaded.'}
      </p>
    );
  }
  if (!rows) {
    return (
      <EmptyState
        icon={BookMarked}
        title={emptyTitle}
        explanation={emptyExplanation}
        nextStep="Use Add to create the first entry."
      />
    );
  }
  return (
    <Card className="surface-card overflow-hidden">
      <CardContent className="p-0">
        <ul className="m-0 list-none p-0">{rows}</ul>
      </CardContent>
    </Card>
  );
}

export function ReferenceDataPage() {
  const [tab, setTab] = useState<Catalogue>('vendors');
  const [includeInactive, setIncludeInactive] = useState(true);
  const [creating, setCreating] = useState(false);
  const [editingVendor, setEditingVendor] = useState<AdminVendorOut | null>(null);
  const [editingAccount, setEditingAccount] = useState<AdminGlAccountOut | null>(null);
  const [editingCentre, setEditingCentre] = useState<AdminCostCentreOut | null>(null);

  const vendors = useAdminVendors(includeInactive);
  const accounts = useAdminGlAccounts(includeInactive);
  const centres = useAdminCostCentres(includeInactive);
  const setVendorActive = useSetVendorActive();
  const setAccountActive = useSetGlAccountActive();
  const setCentreActive = useSetCostCentreActive();

  function selectTab(next: Catalogue) {
    setTab(next);
    setCreating(false);
  }

  const addLabel =
    tab === 'vendors'
      ? 'Add vendor'
      : tab === 'gl-accounts'
        ? 'Add GL account'
        : 'Add cost centre';

  return (
    <div className="flex flex-col gap-[var(--space-6)]">
      <PageHeader
        title="Reference data"
        purpose="Vendors, GL accounts and cost centres used on every coding form. Soft-deactivate rather than delete so historical documents still resolve."
        actions={
          <Button type="button" onClick={() => setCreating(true)}>
            <Plus aria-hidden="true" className="size-4" />
            {addLabel}
          </Button>
        }
      />

      <div
        role="tablist"
        aria-label="Reference catalogues"
        className="flex flex-wrap gap-[var(--space-2)]"
      >
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            className={cn(
              'rounded-[var(--radius-md)] px-[var(--space-3)] py-[var(--space-2)] text-[var(--text-body-sm)] font-semibold',
              tab === item.id
                ? 'bg-[var(--color-primary-700)] text-[var(--color-text-inverse)]'
                : 'bg-[var(--color-surface-subtle)] text-[var(--color-text-muted)] hover:text-[var(--color-text-strong)]',
            )}
            onClick={() => selectTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      <label className="flex cursor-pointer items-center gap-[var(--space-2)] text-[var(--text-body-sm)]">
        <input
          type="checkbox"
          className="size-4 accent-[var(--color-primary)]"
          checked={includeInactive}
          onChange={(event) => setIncludeInactive(event.target.checked)}
        />
        Show deactivated entries
      </label>

      {tab === 'vendors' ? (
        <CatalogueList
          loading={vendors.isLoading}
          error={vendors.isError ? vendors.error : null}
          emptyTitle="No vendors yet"
          emptyExplanation="Nobody has been added to the supplier catalogue."
          rows={
            (vendors.data ?? []).length === 0
              ? null
              : (vendors.data ?? []).map((row) => (
                  <li
                    key={row.id}
                    className="flex flex-col gap-[var(--space-3)] border-b border-[var(--color-divider)] px-[var(--space-5)] py-[var(--space-4)] last:border-b-0 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="min-w-0">
                      <p className="m-0 flex flex-wrap items-baseline gap-x-[var(--space-2)]">
                        <span className="font-semibold text-[var(--color-text-strong)]">
                          {row.code}
                        </span>
                        <span className="text-[var(--text-body-sm)] text-[var(--color-text-muted)]">
                          {row.name}
                        </span>
                        {!row.is_active ? (
                          <ToneBadge label="Deactivated" tone="neutral" />
                        ) : null}
                      </p>
                      <p className="m-0 truncate text-[var(--text-body-sm)] text-[var(--color-text-muted)]">
                        {row.email ?? 'No email'}
                        {' · '}
                        {row.default_currency}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-wrap gap-[var(--space-2)]">
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        onClick={() => setEditingVendor(row)}
                      >
                        Edit
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        disabled={setVendorActive.isPending}
                        className={cn(!row.is_active && 'text-[var(--color-success-700)]')}
                        onClick={() => {
                          const reason = window.prompt(
                            row.is_active
                              ? 'Why is this vendor being deactivated?'
                              : 'Why is this vendor being reactivated?',
                          );
                          if (!reason || reason.trim().length < 3) return;
                          setVendorActive.mutate({
                            id: row.id,
                            body: {
                              is_active: !row.is_active,
                              reason: reason.trim(),
                            },
                          });
                        }}
                      >
                        {row.is_active ? 'Deactivate' : 'Reactivate'}
                      </Button>
                    </div>
                  </li>
                ))
          }
        />
      ) : null}

      {tab === 'gl-accounts' ? (
        <CatalogueList
          loading={accounts.isLoading}
          error={accounts.isError ? accounts.error : null}
          emptyTitle="No GL accounts yet"
          emptyExplanation="The chart of accounts has not been started."
          rows={
            (accounts.data ?? []).length === 0
              ? null
              : (accounts.data ?? []).map((row) => (
                  <li
                    key={row.id}
                    className="flex flex-col gap-[var(--space-3)] border-b border-[var(--color-divider)] px-[var(--space-5)] py-[var(--space-4)] last:border-b-0 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="min-w-0">
                      <p className="m-0 flex flex-wrap items-baseline gap-x-[var(--space-2)]">
                        <span className="font-semibold text-[var(--color-text-strong)]">
                          {row.code}
                        </span>
                        <span className="text-[var(--text-body-sm)] text-[var(--color-text-muted)]">
                          {row.name}
                        </span>
                        {!row.is_active ? (
                          <ToneBadge label="Deactivated" tone="neutral" />
                        ) : null}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-wrap gap-[var(--space-2)]">
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        onClick={() => setEditingAccount(row)}
                      >
                        Edit
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        disabled={setAccountActive.isPending}
                        className={cn(!row.is_active && 'text-[var(--color-success-700)]')}
                        onClick={() => {
                          const reason = window.prompt(
                            row.is_active
                              ? 'Why is this GL account being deactivated?'
                              : 'Why is this GL account being reactivated?',
                          );
                          if (!reason || reason.trim().length < 3) return;
                          setAccountActive.mutate({
                            id: row.id,
                            body: {
                              is_active: !row.is_active,
                              reason: reason.trim(),
                            },
                          });
                        }}
                      >
                        {row.is_active ? 'Deactivate' : 'Reactivate'}
                      </Button>
                    </div>
                  </li>
                ))
          }
        />
      ) : null}

      {tab === 'cost-centres' ? (
        <CatalogueList
          loading={centres.isLoading}
          error={centres.isError ? centres.error : null}
          emptyTitle="No cost centres yet"
          emptyExplanation="No cost centres have been defined."
          rows={
            (centres.data ?? []).length === 0
              ? null
              : (centres.data ?? []).map((row) => (
                  <li
                    key={row.id}
                    className="flex flex-col gap-[var(--space-3)] border-b border-[var(--color-divider)] px-[var(--space-5)] py-[var(--space-4)] last:border-b-0 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="min-w-0">
                      <p className="m-0 flex flex-wrap items-baseline gap-x-[var(--space-2)]">
                        <span className="font-semibold text-[var(--color-text-strong)]">
                          {row.code}
                        </span>
                        <span className="text-[var(--text-body-sm)] text-[var(--color-text-muted)]">
                          {row.name}
                        </span>
                        {!row.is_active ? (
                          <ToneBadge label="Deactivated" tone="neutral" />
                        ) : null}
                      </p>
                      <p className="m-0 truncate text-[var(--text-body-sm)] text-[var(--color-text-muted)]">
                        {row.department ?? 'No department'}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-wrap gap-[var(--space-2)]">
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        onClick={() => setEditingCentre(row)}
                      >
                        Edit
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        disabled={setCentreActive.isPending}
                        className={cn(!row.is_active && 'text-[var(--color-success-700)]')}
                        onClick={() => {
                          const reason = window.prompt(
                            row.is_active
                              ? 'Why is this cost centre being deactivated?'
                              : 'Why is this cost centre being reactivated?',
                          );
                          if (!reason || reason.trim().length < 3) return;
                          setCentreActive.mutate({
                            id: row.id,
                            body: {
                              is_active: !row.is_active,
                              reason: reason.trim(),
                            },
                          });
                        }}
                      >
                        {row.is_active ? 'Deactivate' : 'Reactivate'}
                      </Button>
                    </div>
                  </li>
                ))
          }
        />
      ) : null}

      {tab === 'vendors' ? (
        <CreateVendorModal open={creating} onClose={() => setCreating(false)} />
      ) : null}
      {tab === 'gl-accounts' ? (
        <CreateGlAccountModal open={creating} onClose={() => setCreating(false)} />
      ) : null}
      {tab === 'cost-centres' ? (
        <CreateCostCentreModal open={creating} onClose={() => setCreating(false)} />
      ) : null}

      <EditVendorModal vendor={editingVendor} onClose={() => setEditingVendor(null)} />
      <EditGlAccountModal
        account={editingAccount}
        onClose={() => setEditingAccount(null)}
      />
      <EditCostCentreModal
        centre={editingCentre}
        onClose={() => setEditingCentre(null)}
      />
    </div>
  );
}
