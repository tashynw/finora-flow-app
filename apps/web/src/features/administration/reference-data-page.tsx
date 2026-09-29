/** Reference data administration — vendors, GL accounts and cost centres. */

import { useEffect, useState } from 'react';
import { BookMarked, Plus } from 'lucide-react';

import { cn } from '@/lib/utils';
import { errorMessage } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { DataTable, type Column } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input, Textarea } from '@/components/ui/field';
import { Modal } from '@/components/ui/modal';
import { SkeletonText } from '@/components/ui/skeleton';
import { ViewTabs } from '@/components/ui/view-tabs';
import { ToneBadge } from '@/components/workflow/status-badge';
import { EmailText } from '@/features/shared/email-text';
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

interface CatalogueRow {
  id: string;
  code: string;
  name: string;
  is_active: boolean;
}

/** Code, name and status are shared; each catalogue adds its own middle columns. */
function catalogueColumns<T extends CatalogueRow>({
  noun,
  extra,
  onEdit,
  onToggle,
  toggling,
}: {
  noun: string;
  extra: Column<T>[];
  onEdit: (row: T) => void;
  onToggle: (row: T, reason: string) => void;
  toggling: boolean;
}): Column<T>[] {
  return [
    {
      key: 'code',
      header: 'Code',
      width: 'w-32',
      cell: (row) => (
        <span className="tabular whitespace-nowrap font-semibold text-[var(--color-text-strong)]">
          {row.code}
        </span>
      ),
    },
    {
      key: 'name',
      header: 'Name',
      cell: (row) => (
        <span className={row.is_active ? undefined : 'text-[var(--color-text-muted)]'}>
          {row.name}
        </span>
      ),
    },
    ...extra,
    {
      key: 'status',
      header: 'Status',
      width: 'w-32',
      cell: (row) =>
        row.is_active ? (
          <ToneBadge label="Active" tone="success" />
        ) : (
          <ToneBadge label="Deactivated" tone="neutral" />
        ),
    },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      width: 'w-48',
      align: 'right',
      cell: (row) => (
        <span className="inline-flex flex-wrap justify-end gap-1">
          <Button type="button" size="sm" variant="ghost" onClick={() => onEdit(row)}>
            Edit
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={toggling}
            className={cn(!row.is_active && 'text-[var(--color-success-700)]')}
            onClick={() => {
              const reason = window.prompt(
                row.is_active
                  ? `Why is this ${noun} being deactivated?`
                  : `Why is this ${noun} being reactivated?`,
              );
              if (!reason || reason.trim().length < 3) return;
              onToggle(row, reason.trim());
            }}
          >
            {row.is_active ? 'Deactivate' : 'Reactivate'}
          </Button>
        </span>
      ),
    },
  ];
}

function CatalogueTable<T extends CatalogueRow>({
  label,
  loading,
  error,
  emptyTitle,
  emptyExplanation,
  rows,
  columns,
}: {
  label: string;
  loading: boolean;
  error: unknown;
  emptyTitle: string;
  emptyExplanation: string;
  rows: T[];
  columns: Column<T>[];
}) {
  if (loading) {
    return (
      <Card>
        <CardContent>
          <SkeletonText lines={8} />
        </CardContent>
      </Card>
    );
  }
  if (error) {
    return (
      <Card className="border-[var(--color-danger-600)]">
        <CardContent>
          <p role="alert" className="m-0 text-[var(--color-danger-700)]">
            {errorMessage(error) ?? 'The catalogue could not be loaded.'}
          </p>
        </CardContent>
      </Card>
    );
  }
  if (rows.length === 0) {
    return (
      <Card>
        <CardContent className="p-0">
          <EmptyState
            icon={BookMarked}
            title={emptyTitle}
            explanation={emptyExplanation}
            nextStep="Use Add to create the first entry."
          />
        </CardContent>
      </Card>
    );
  }
  return (
    <DataTable ariaLabel={label} columns={columns} rows={rows} getRowKey={(row) => row.id} />
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

  const vendorColumns = catalogueColumns<AdminVendorOut>({
    noun: 'vendor',
    extra: [
      {
        key: 'email',
        header: 'Email',
        hideBelow: 'md',
        cell: (row) => (
          <span className={row.email ? undefined : 'text-[var(--color-text-subtle)]'}>
            {row.email ? <EmailText email={row.email} /> : 'No email'}
          </span>
        ),
      },
      {
        key: 'currency',
        header: 'Currency',
        width: 'w-24',
        cell: (row) => <span>{row.default_currency}</span>,
      },
    ],
    onEdit: setEditingVendor,
    onToggle: (row, reason) =>
      setVendorActive.mutate({ id: row.id, body: { is_active: !row.is_active, reason } }),
    toggling: setVendorActive.isPending,
  });

  const accountColumns = catalogueColumns<AdminGlAccountOut>({
    noun: 'GL account',
    extra: [],
    onEdit: setEditingAccount,
    onToggle: (row, reason) =>
      setAccountActive.mutate({ id: row.id, body: { is_active: !row.is_active, reason } }),
    toggling: setAccountActive.isPending,
  });

  const centreColumns = catalogueColumns<AdminCostCentreOut>({
    noun: 'cost centre',
    extra: [
      {
        key: 'department',
        header: 'Department',
        width: 'w-48',
        hideBelow: 'md',
        cell: (row) => (
          <span className={row.department ? undefined : 'text-[var(--color-text-subtle)]'}>
            {row.department ?? 'No department'}
          </span>
        ),
      },
    ],
    onEdit: setEditingCentre,
    onToggle: (row, reason) =>
      setCentreActive.mutate({ id: row.id, body: { is_active: !row.is_active, reason } }),
    toggling: setCentreActive.isPending,
  });

  return (
    <>
      <PageHeader
        title="Reference data"
        purpose="Vendors, GL accounts and cost centres. Deactivate rather than delete so historical documents still resolve."
        toolbar={
          <div className="flex flex-wrap items-center gap-[var(--space-3)]">
            <ViewTabs
              label="Reference catalogues"
              tabs={TABS}
              value={tab}
              onChange={(id) => selectTab(id as Catalogue)}
            />
            <span aria-hidden="true" className="h-5 w-px bg-[var(--color-border)]" />
            <Button
              variant="secondary"
              size="sm"
              aria-pressed={!includeInactive}
              onClick={() => setIncludeInactive(!includeInactive)}
              className="h-9 text-[12px]"
            >
              {includeInactive ? 'Hide deactivated' : 'Show deactivated'}
            </Button>
          </div>
        }
        actions={
          <Button type="button" variant="primary" size="sm" onClick={() => setCreating(true)}>
            <Plus aria-hidden="true" className="size-4" />
            {addLabel}
          </Button>
        }
      />

      {tab === 'vendors' ? (
        <CatalogueTable
          label="Vendors"
          loading={vendors.isLoading}
          error={vendors.isError ? vendors.error : null}
          emptyTitle="No vendors yet"
          emptyExplanation="Nobody has been added to the supplier catalogue."
          rows={vendors.data ?? []}
          columns={vendorColumns}
        />
      ) : null}

      {tab === 'gl-accounts' ? (
        <CatalogueTable
          label="GL accounts"
          loading={accounts.isLoading}
          error={accounts.isError ? accounts.error : null}
          emptyTitle="No GL accounts yet"
          emptyExplanation="The chart of accounts has not been started."
          rows={accounts.data ?? []}
          columns={accountColumns}
        />
      ) : null}

      {tab === 'cost-centres' ? (
        <CatalogueTable
          label="Cost centres"
          loading={centres.isLoading}
          error={centres.isError ? centres.error : null}
          emptyTitle="No cost centres yet"
          emptyExplanation="No cost centres have been defined."
          rows={centres.data ?? []}
          columns={centreColumns}
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
    </>
  );
}
