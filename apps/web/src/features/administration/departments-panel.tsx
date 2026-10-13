import { useEffect, useState } from 'react';
import { BookMarked } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';

import { cn } from '@/lib/utils';
import { errorMessage } from '@/lib/api-client';
import { requiredText } from '@/lib/form-schemas';
import { HookField } from '@/components/form/hook-field';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { DataTable, type Column } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/field';
import { Modal } from '@/components/ui/modal';
import { SkeletonText } from '@/components/ui/skeleton';
import { ToneBadge } from '@/components/workflow/status-badge';
import {
  useCreateDepartment,
  useDepartments,
  useSetDepartmentActive,
  useUpdateDepartment,
  type DepartmentOut,
} from '@/features/administration/use-departments';

const departmentSchema = z.object({
  name: requiredText('A name is required.'),
  costCentreNumber: requiredText('A cost centre number is required.'),
});

type DepartmentForm = z.infer<typeof departmentSchema>;

const emptyDepartment: DepartmentForm = { name: '', costCentreNumber: '' };

function DepartmentFields({ control }: { control: ReturnType<typeof useForm<DepartmentForm>>['control'] }) {
  return (
    <>
      <HookField control={control} name="name" label="Name" required>
        {({ inputId, describedBy, invalid }, field) => (
          <Input id={inputId} aria-describedby={describedBy} invalid={invalid} {...field} />
        )}
      </HookField>
      <HookField control={control} name="costCentreNumber" label="Cost centre number" required>
        {({ inputId, describedBy, invalid }, field) => (
          <Input id={inputId} aria-describedby={describedBy} invalid={invalid} {...field} />
        )}
      </HookField>
    </>
  );
}

function CreateDepartmentModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const create = useCreateDepartment();
  const { control, handleSubmit, reset } = useForm<DepartmentForm>({
    resolver: zodResolver(departmentSchema),
    defaultValues: emptyDepartment,
  });

  useEffect(() => {
    if (!open) return;
    reset(emptyDepartment);
  }, [open, reset]);

  function close() {
    reset(emptyDepartment);
    create.reset();
    onClose();
  }

  const onSubmit = handleSubmit((values) => {
    create.mutate(values, { onSuccess: close });
  });

  return (
    <Modal open={open} onClose={close} title="Add department" description="The cost centre number cannot be reused once taken.">
      <form className="flex flex-col gap-[var(--space-4)]" onSubmit={onSubmit} noValidate>
        <DepartmentFields control={control} />
        {create.isError ? (
          <p role="alert" className="m-0 text-[var(--color-danger-700)]">
            {errorMessage(create.error) ?? 'The department could not be created.'}
          </p>
        ) : null}
        <Button type="submit" isLoading={create.isPending} loadingLabel="Adding">
          Add department
        </Button>
      </form>
    </Modal>
  );
}

function EditDepartmentModal({
  department,
  onClose,
}: {
  department: DepartmentOut | null;
  onClose: () => void;
}) {
  const update = useUpdateDepartment();
  const { control, handleSubmit, reset } = useForm<DepartmentForm>({
    resolver: zodResolver(departmentSchema),
    defaultValues: emptyDepartment,
  });

  useEffect(() => {
    if (!department) return;
    reset({ name: department.name, costCentreNumber: department.costCentreNumber });
    update.reset();
  }, [department, reset, update]);

  const onSubmit = handleSubmit((values) => {
    if (!department) return;
    update.mutate({ id: department.id, body: values }, { onSuccess: () => onClose() });
  });

  return (
    <Modal
      open={department !== null}
      onClose={onClose}
      title={department ? `Edit ${department.name}` : 'Edit department'}
      description="Changing a department updates the name shown on accounts."
    >
      {department ? (
        <form className="flex flex-col gap-[var(--space-4)]" onSubmit={onSubmit} noValidate>
          <DepartmentFields control={control} />
          {update.isError ? (
            <p role="alert" className="m-0 text-[var(--color-danger-700)]">
              {errorMessage(update.error) ?? 'The department could not be saved.'}
            </p>
          ) : null}
          <Button type="submit" isLoading={update.isPending} loadingLabel="Saving">
            Save department
          </Button>
        </form>
      ) : null}
    </Modal>
  );
}

export function DepartmentsCatalogue({
  includeInactive,
  creating,
  onCloseCreate,
}: {
  includeInactive: boolean;
  creating: boolean;
  onCloseCreate: () => void;
}) {
  const departments = useDepartments(includeInactive);
  const setActive = useSetDepartmentActive();
  const [editing, setEditing] = useState<DepartmentOut | null>(null);

  const columns: Column<DepartmentOut>[] = [
    {
      key: 'number',
      header: 'Cost centre number',
      width: 'w-48',
      cell: (row) => <span className="font-semibold">{row.costCentreNumber}</span>,
    },
    {
      key: 'name',
      header: 'Name',
      cell: (row) => (
        <span className={row.isActive ? undefined : 'text-[var(--color-text-muted)]'}>
          {row.name}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      width: 'w-36',
      cell: (row) =>
        row.isActive ? (
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
          <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(row)}>
            Edit
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={setActive.isPending}
            className={cn(!row.isActive && 'text-[var(--color-success-700)]')}
            onClick={() =>
              setActive.mutate({ id: row.id, isActive: !row.isActive })
            }
          >
            {row.isActive ? 'Deactivate' : 'Reactivate'}
          </Button>
        </span>
      ),
    },
  ];

  const rows = departments.data ?? [];

  return (
    <>
      {departments.isLoading ? (
        <Card>
          <CardContent>
            <SkeletonText lines={8} />
          </CardContent>
        </Card>
      ) : departments.isError ? (
        <Card className="border-[var(--color-danger-600)]">
          <CardContent>
            <p role="alert" className="m-0 text-[var(--color-danger-700)]">
              {errorMessage(departments.error) ?? 'The departments could not be loaded.'}
            </p>
          </CardContent>
        </Card>
      ) : rows.length === 0 ? (
        <Card>
          <CardContent className="p-0">
            <EmptyState
              icon={BookMarked}
              title="No departments yet"
              explanation="No departments have been defined."
              nextStep="Use Add department to create the first one."
            />
          </CardContent>
        </Card>
      ) : (
        <DataTable
          ariaLabel="Departments"
          columns={columns}
          rows={rows}
          getRowKey={(row) => row.id}
        />
      )}
      <CreateDepartmentModal open={creating} onClose={onCloseCreate} />
      <EditDepartmentModal department={editing} onClose={() => setEditing(null)} />
    </>
  );
}
