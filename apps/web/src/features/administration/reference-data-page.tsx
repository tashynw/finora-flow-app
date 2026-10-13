/** Reference data administration — vendors, GL accounts, cost centres and departments. */

import { useEffect, useState } from 'react';
import { BookMarked, Plus } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';

import { cn } from '@/lib/utils';
import { errorMessage } from '@/lib/api-client';
import { auditReason, optionalEmail, requiredText } from '@/lib/form-schemas';
import { HookField } from '@/components/form/hook-field';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { DataTable, type Column } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { Input, Textarea } from '@/components/ui/field';
import { Modal } from '@/components/ui/modal';
import { SkeletonText } from '@/components/ui/skeleton';
import { ViewTabs } from '@/components/ui/view-tabs';
import { ToneBadge } from '@/components/workflow/status-badge';
import { EmailText } from '@/features/shared/email-text';
import { PageHeader } from '@/features/shared/page-header';
import { DepartmentsCatalogue } from '@/features/administration/departments-panel';
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

type Catalogue = 'vendors' | 'gl-accounts' | 'cost-centres' | 'departments';

const TABS: { id: Catalogue; label: string }[] = [
  { id: 'vendors', label: 'Vendors' },
  { id: 'gl-accounts', label: 'GL accounts' },
  { id: 'cost-centres', label: 'Cost centres' },
  { id: 'departments', label: 'Departments' },
];

const currencyCode = z.string().trim().length(3, 'Use a three-letter currency code.');

const createVendorSchema = z.object({
  code: requiredText('A code is required.'),
  name: requiredText('A name is required.'),
  email: optionalEmail,
  currency: currencyCode,
  reason: auditReason,
});

type CreateVendorForm = z.infer<typeof createVendorSchema>;

const emptyVendor: CreateVendorForm = {
  code: '',
  name: '',
  email: '',
  currency: 'JMD',
  reason: '',
};

function CreateVendorModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const create = useCreateVendor();
  const { control, handleSubmit, reset } = useForm<CreateVendorForm>({
    resolver: zodResolver(createVendorSchema),
    defaultValues: emptyVendor,
  });

  useEffect(() => {
    if (!open) return;
    reset(emptyVendor);
  }, [open, reset]);

  function close() {
    reset(emptyVendor);
    create.reset();
    onClose();
  }

  const onSubmit = handleSubmit((values) => {
    create.mutate(
      {
        code: values.code,
        name: values.name,
        email: values.email || null,
        phone: null,
        default_currency: values.currency.toUpperCase(),
        payment_terms_days: null,
        reason: values.reason,
      },
      { onSuccess: close },
    );
  });

  return (
    <Modal open={open} onClose={close} title="Add vendor" description="A reason is required. Codes cannot be reused once taken.">
      <form className="flex flex-col gap-[var(--space-4)]" onSubmit={onSubmit} noValidate>
        <HookField control={control} name="code" label="Code" required>
          {({ inputId, describedBy, invalid }, field) => (
            <Input id={inputId} aria-describedby={describedBy} invalid={invalid} {...field} />
          )}
        </HookField>
        <HookField control={control} name="name" label="Name" required>
          {({ inputId, describedBy, invalid }, field) => (
            <Input id={inputId} aria-describedby={describedBy} invalid={invalid} {...field} />
          )}
        </HookField>
        <HookField control={control} name="email" label="Email" help="Optional.">
          {({ inputId, describedBy, invalid }, field) => (
            <Input id={inputId} type="email" aria-describedby={describedBy} invalid={invalid} {...field} />
          )}
        </HookField>
        <HookField control={control} name="currency" label="Currency" required>
          {({ inputId, describedBy, invalid }, field) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              invalid={invalid}
              maxLength={3}
              name={field.name}
              ref={field.ref}
              value={field.value}
              onBlur={field.onBlur}
              onChange={(event) => field.onChange(event.target.value.toUpperCase())}
            />
          )}
        </HookField>
        <HookField control={control} name="reason" label="Why" required>
          {({ inputId, describedBy, invalid }, field) => (
            <Textarea id={inputId} aria-describedby={describedBy} invalid={invalid} rows={3} {...field} />
          )}
        </HookField>
        {create.isError ? (
          <p role="alert" className="m-0 text-[var(--color-danger-700)]">
            {errorMessage(create.error) ?? 'The vendor could not be created.'}
          </p>
        ) : null}
        <Button type="submit" isLoading={create.isPending} loadingLabel="Adding">
          Add vendor
        </Button>
      </form>
    </Modal>
  );
}

const editVendorSchema = z.object({
  name: requiredText('A name is required.'),
  email: optionalEmail,
  currency: currencyCode,
  reason: auditReason,
});

type EditVendorForm = z.infer<typeof editVendorSchema>;

function EditVendorModal({
  vendor,
  onClose,
}: {
  vendor: AdminVendorOut | null;
  onClose: () => void;
}) {
  const update = useUpdateVendor();
  const { control, handleSubmit, reset } = useForm<EditVendorForm>({
    resolver: zodResolver(editVendorSchema),
    defaultValues: { name: '', email: '', currency: 'JMD', reason: '' },
  });

  useEffect(() => {
    if (!vendor) return;
    reset({
      name: vendor.name,
      email: vendor.email ?? '',
      currency: vendor.default_currency,
      reason: '',
    });
    update.reset();
  }, [vendor, reset, update]);

  const onSubmit = handleSubmit((values) => {
    if (!vendor) return;
    update.mutate(
      {
        id: vendor.id,
        body: {
          name: values.name,
          email: values.email || null,
          default_currency: values.currency.toUpperCase(),
          reason: values.reason,
        },
      },
      { onSuccess: () => onClose() },
    );
  });

  return (
    <Modal
      open={vendor !== null}
      onClose={onClose}
      title={vendor ? `Edit ${vendor.code}` : 'Edit vendor'}
      description="Changing a vendor is audited. Bank details are not edited here."
    >
      {vendor ? (
        <form className="flex flex-col gap-[var(--space-4)]" onSubmit={onSubmit} noValidate>
          <HookField control={control} name="name" label="Name" required>
            {({ inputId, describedBy, invalid }, field) => (
              <Input id={inputId} aria-describedby={describedBy} invalid={invalid} {...field} />
            )}
          </HookField>
          <HookField control={control} name="email" label="Email" help="Optional.">
            {({ inputId, describedBy, invalid }, field) => (
              <Input id={inputId} type="email" aria-describedby={describedBy} invalid={invalid} {...field} />
            )}
          </HookField>
          <HookField control={control} name="currency" label="Currency" required>
            {({ inputId, describedBy, invalid }, field) => (
              <Input
                id={inputId}
                aria-describedby={describedBy}
                invalid={invalid}
                maxLength={3}
                name={field.name}
                ref={field.ref}
                value={field.value}
                onBlur={field.onBlur}
                onChange={(event) => field.onChange(event.target.value.toUpperCase())}
              />
            )}
          </HookField>
          <HookField control={control} name="reason" label="Why" required>
            {({ inputId, describedBy, invalid }, field) => (
              <Textarea id={inputId} aria-describedby={describedBy} invalid={invalid} rows={3} {...field} />
            )}
          </HookField>
          {update.isError ? (
            <p role="alert" className="m-0 text-[var(--color-danger-700)]">
              {errorMessage(update.error) ?? 'The vendor could not be saved.'}
            </p>
          ) : null}
          <Button type="submit" isLoading={update.isPending} loadingLabel="Saving">
            Save vendor
          </Button>
        </form>
      ) : null}
    </Modal>
  );
}

const codedRecordSchema = z.object({
  code: requiredText('A code is required.'),
  name: requiredText('A name is required.'),
  reason: auditReason,
});

type CodedRecordForm = z.infer<typeof codedRecordSchema>;

const emptyCodedRecord: CodedRecordForm = { code: '', name: '', reason: '' };

const namedRecordSchema = z.object({
  name: requiredText('A name is required.'),
  reason: auditReason,
});

type NamedRecordForm = z.infer<typeof namedRecordSchema>;

const costCentreSchema = z.object({
  code: requiredText('A code is required.'),
  name: requiredText('A name is required.'),
  department: z.string().trim(),
  reason: auditReason,
});

type CostCentreForm = z.infer<typeof costCentreSchema>;

const emptyCostCentre: CostCentreForm = { code: '', name: '', department: '', reason: '' };

const editCostCentreSchema = costCentreSchema.omit({ code: true });

type EditCostCentreForm = z.infer<typeof editCostCentreSchema>;

function CreateGlAccountModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const create = useCreateGlAccount();
  const { control, handleSubmit, reset } = useForm<CodedRecordForm>({
    resolver: zodResolver(codedRecordSchema),
    defaultValues: emptyCodedRecord,
  });

  useEffect(() => {
    if (!open) return;
    reset(emptyCodedRecord);
  }, [open, reset]);

  function close() {
    reset(emptyCodedRecord);
    create.reset();
    onClose();
  }

  const onSubmit = handleSubmit((values) => {
    create.mutate(values, { onSuccess: close });
  });

  return (
    <Modal open={open} onClose={close} title="Add GL account" description="A reason is required. Codes cannot be reused once taken.">
      <form className="flex flex-col gap-[var(--space-4)]" onSubmit={onSubmit} noValidate>
        <HookField control={control} name="code" label="Code" required>
          {({ inputId, describedBy, invalid }, field) => (
            <Input id={inputId} aria-describedby={describedBy} invalid={invalid} {...field} />
          )}
        </HookField>
        <HookField control={control} name="name" label="Name" required>
          {({ inputId, describedBy, invalid }, field) => (
            <Input id={inputId} aria-describedby={describedBy} invalid={invalid} {...field} />
          )}
        </HookField>
        <HookField control={control} name="reason" label="Why" required>
          {({ inputId, describedBy, invalid }, field) => (
            <Textarea id={inputId} aria-describedby={describedBy} invalid={invalid} rows={3} {...field} />
          )}
        </HookField>
        {create.isError ? (
          <p role="alert" className="m-0 text-[var(--color-danger-700)]">
            {errorMessage(create.error) ?? 'The GL account could not be created.'}
          </p>
        ) : null}
        <Button type="submit" isLoading={create.isPending} loadingLabel="Adding">
          Add GL account
        </Button>
      </form>
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
  const { control, handleSubmit, reset } = useForm<NamedRecordForm>({
    resolver: zodResolver(namedRecordSchema),
    defaultValues: { name: '', reason: '' },
  });

  useEffect(() => {
    if (!account) return;
    reset({ name: account.name, reason: '' });
    update.reset();
  }, [account, reset, update]);

  const onSubmit = handleSubmit((values) => {
    if (!account) return;
    update.mutate({ id: account.id, body: values }, { onSuccess: () => onClose() });
  });

  return (
    <Modal
      open={account !== null}
      onClose={onClose}
      title={account ? `Edit ${account.code}` : 'Edit GL account'}
      description="Changing a GL account is audited."
    >
      {account ? (
        <form className="flex flex-col gap-[var(--space-4)]" onSubmit={onSubmit} noValidate>
          <HookField control={control} name="name" label="Name" required>
            {({ inputId, describedBy, invalid }, field) => (
              <Input id={inputId} aria-describedby={describedBy} invalid={invalid} {...field} />
            )}
          </HookField>
          <HookField control={control} name="reason" label="Why" required>
            {({ inputId, describedBy, invalid }, field) => (
              <Textarea id={inputId} aria-describedby={describedBy} invalid={invalid} rows={3} {...field} />
            )}
          </HookField>
          {update.isError ? (
            <p role="alert" className="m-0 text-[var(--color-danger-700)]">
              {errorMessage(update.error) ?? 'The GL account could not be saved.'}
            </p>
          ) : null}
          <Button type="submit" isLoading={update.isPending} loadingLabel="Saving">
            Save GL account
          </Button>
        </form>
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
  const { control, handleSubmit, reset } = useForm<CostCentreForm>({
    resolver: zodResolver(costCentreSchema),
    defaultValues: emptyCostCentre,
  });

  useEffect(() => {
    if (!open) return;
    reset(emptyCostCentre);
  }, [open, reset]);

  function close() {
    reset(emptyCostCentre);
    create.reset();
    onClose();
  }

  const onSubmit = handleSubmit((values) => {
    create.mutate(
      {
        code: values.code,
        name: values.name,
        department: values.department || null,
        reason: values.reason,
      },
      { onSuccess: close },
    );
  });

  return (
    <Modal open={open} onClose={close} title="Add cost centre" description="A reason is required. Codes cannot be reused once taken.">
      <form className="flex flex-col gap-[var(--space-4)]" onSubmit={onSubmit} noValidate>
        <HookField control={control} name="code" label="Code" required>
          {({ inputId, describedBy, invalid }, field) => (
            <Input id={inputId} aria-describedby={describedBy} invalid={invalid} {...field} />
          )}
        </HookField>
        <HookField control={control} name="name" label="Name" required>
          {({ inputId, describedBy, invalid }, field) => (
            <Input id={inputId} aria-describedby={describedBy} invalid={invalid} {...field} />
          )}
        </HookField>
        <HookField control={control} name="department" label="Department" help="Optional.">
          {({ inputId, describedBy, invalid }, field) => (
            <Input id={inputId} aria-describedby={describedBy} invalid={invalid} {...field} />
          )}
        </HookField>
        <HookField control={control} name="reason" label="Why" required>
          {({ inputId, describedBy, invalid }, field) => (
            <Textarea id={inputId} aria-describedby={describedBy} invalid={invalid} rows={3} {...field} />
          )}
        </HookField>
        {create.isError ? (
          <p role="alert" className="m-0 text-[var(--color-danger-700)]">
            {errorMessage(create.error) ?? 'The cost centre could not be created.'}
          </p>
        ) : null}
        <Button type="submit" isLoading={create.isPending} loadingLabel="Adding">
          Add cost centre
        </Button>
      </form>
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
  const { control, handleSubmit, reset } = useForm<EditCostCentreForm>({
    resolver: zodResolver(editCostCentreSchema),
    defaultValues: { name: '', department: '', reason: '' },
  });

  useEffect(() => {
    if (!centre) return;
    reset({ name: centre.name, department: centre.department ?? '', reason: '' });
    update.reset();
  }, [centre, reset, update]);

  const onSubmit = handleSubmit((values) => {
    if (!centre) return;
    update.mutate(
      {
        id: centre.id,
        body: {
          name: values.name,
          department: values.department || null,
          reason: values.reason,
        },
      },
      { onSuccess: () => onClose() },
    );
  });

  return (
    <Modal
      open={centre !== null}
      onClose={onClose}
      title={centre ? `Edit ${centre.code}` : 'Edit cost centre'}
      description="Changing a cost centre is audited."
    >
      {centre ? (
        <form className="flex flex-col gap-[var(--space-4)]" onSubmit={onSubmit} noValidate>
          <HookField control={control} name="name" label="Name" required>
            {({ inputId, describedBy, invalid }, field) => (
              <Input id={inputId} aria-describedby={describedBy} invalid={invalid} {...field} />
            )}
          </HookField>
          <HookField control={control} name="department" label="Department" help="Optional.">
            {({ inputId, describedBy, invalid }, field) => (
              <Input id={inputId} aria-describedby={describedBy} invalid={invalid} {...field} />
            )}
          </HookField>
          <HookField control={control} name="reason" label="Why" required>
            {({ inputId, describedBy, invalid }, field) => (
              <Textarea id={inputId} aria-describedby={describedBy} invalid={invalid} rows={3} {...field} />
            )}
          </HookField>
          {update.isError ? (
            <p role="alert" className="m-0 text-[var(--color-danger-700)]">
              {errorMessage(update.error) ?? 'The cost centre could not be saved.'}
            </p>
          ) : null}
          <Button type="submit" isLoading={update.isPending} loadingLabel="Saving">
            Save cost centre
          </Button>
        </form>
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
        : tab === 'departments'
          ? 'Add department'
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
        purpose="Vendors, GL accounts, cost centres and departments. Deactivate rather than delete so historical documents still resolve."
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

      {tab === 'departments' ? (
        <DepartmentsCatalogue
          includeInactive={includeInactive}
          creating={creating}
          onCloseCreate={() => setCreating(false)}
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
