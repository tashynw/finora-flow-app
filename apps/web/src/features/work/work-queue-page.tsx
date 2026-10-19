import { useEffect, useState } from 'react';
import { BookmarkPlus, CheckCheck, Trash2 } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';

import { cn } from '@/lib/utils';
import { errorMessage } from '@/lib/api-client';
import { formatMoment } from '@/lib/dates';
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
import { waitedFor } from '@/features/approvals/approval-vocabulary';
import { PageHeader } from '@/features/shared/page-header';
import {
  useCreateSavedView,
  useDeleteSavedView,
  useSavedViews,
  type SavedViewOut,
} from '@/features/saved-views/use-saved-views';
import {
  PAGE_SIZE,
  useWorkQueue,
  type WorkItemOut,
} from '@/features/work/use-work';

/**
 * One queue for everything waiting on this person.
 *
 * Oldest first, and not reorderable. Approvals, receipt confirmations, document
 * reviews and vendor conclusions share one list so nothing hides behind a
 * register somebody visits less often. Named views keep a kind filter without
 * re-toggling every visit.
 */

const KINDS = [
  { id: 'approval', label: 'Approvals' },
  { id: 'sign_off', label: 'Receipt confirmations' },
  { id: 'document_review', label: 'Document reviews' },
  { id: 'vendor_review', label: 'Vendor confirmations' },
] as const;

const ALL_KIND_IDS = KINDS.map((kind) => kind.id);

/** A toggle in the same visual language as `ViewTabs`, for filters that are not single-choice. */
const PILL = cn(
  'inline-flex h-9 items-center gap-1 rounded-[var(--radius-md)] px-3.5',
  'text-[12px] font-medium whitespace-nowrap',
  'transition-colors duration-[var(--duration-fast)]',
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary-600)]',
);
const PILL_ON = 'bg-[var(--color-text-strong)] text-[var(--color-text-inverse)]';
const PILL_OFF =
  'text-[var(--color-text-muted)] hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-text-strong)]';
/** An included kind: quieter than a chosen view, because several are on at once. */
const PILL_INCLUDED =
  'border border-[var(--color-border)] bg-[var(--color-surface-raised)] text-[var(--color-text-strong)] hover:border-[var(--color-border-strong)]';

const workColumns: Column<WorkItemOut>[] = [
  {
    key: 'reference',
    header: 'Reference',
    width: 'w-40',
    cell: (item) => (
      <span className="tabular font-medium text-[var(--color-text-strong)]">
        {item.reference}
      </span>
    ),
  },
  {
    key: 'counterparty',
    header: 'Counterparty',
    cell: (item) => (
      <span className="flex min-w-0 flex-col">
        <span className="truncate">{item.title}</span>
        <span className="truncate text-[11px] text-[var(--color-text-subtle)]">
          {item.subtitle}
          {item.detail ? ` · ${item.detail}` : ''}
        </span>
      </span>
    ),
  },
  {
    key: 'amount',
    header: 'Amount',
    width: 'w-36',
    cell: (item) => <span className="tabular">{item.amount_formatted ?? '—'}</span>,
  },
  {
    key: 'waiting',
    header: 'Waiting',
    width: 'w-40',
    hideBelow: 'md',
    cell: (item) => {
      const waited = waitedFor(item.waiting_hours);
      return (
        <span
          // Counted from now, so the same row reads differently tomorrow.
          data-visual-volatile
          title={`Waiting since ${formatMoment(item.waiting_since)}`}
          className={cn(
            waited.tone === 'danger'
              ? 'font-medium text-[var(--color-danger-700)]'
              : waited.tone === 'warning'
                ? 'font-medium text-[var(--color-warning-700)]'
                : undefined,
          )}
        >
          {waited.label}
        </span>
      );
    },
  },
  {
    key: 'kind',
    header: 'Asking for',
    width: 'w-52',
    cell: (item) => <ToneBadge label={item.kind_label} tone="progress" />,
  },
];

function kindsFromView(view: SavedViewOut): string[] {
  const raw = view.definition.kinds;
  if (!Array.isArray(raw)) return [...ALL_KIND_IDS];
  return raw.filter((item): item is string => typeof item === 'string');
}

const saveViewSchema = z.object({
  name: requiredText('A name is required.'),
});

type SaveViewForm = z.infer<typeof saveViewSchema>;

function SaveViewModal({
  open,
  onClose,
  kinds,
}: {
  open: boolean;
  onClose: () => void;
  kinds: string[];
}) {
  const create = useCreateSavedView();
  const { control, handleSubmit, reset } = useForm<SaveViewForm>({
    resolver: zodResolver(saveViewSchema),
    defaultValues: { name: '' },
  });

  useEffect(() => {
    if (!open) return;
    reset({ name: '' });
    create.reset();
  }, [open, reset, create]);

  const onSubmit = handleSubmit((values) => {
    create.mutate(
      { scope: 'work', name: values.name, definition: { kinds } },
      { onSuccess: () => onClose() },
    );
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Save this view"
      description="Keeps the kinds you have turned on. Only you can see it."
      busy={create.isPending}
    >
      <form className="flex flex-col gap-[var(--space-4)]" onSubmit={onSubmit} noValidate>
        <HookField control={control} name="name" label="Name" required>
          {({ inputId, describedBy, invalid }, field) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              invalid={invalid}
              placeholder="Approvals only"
              {...field}
            />
          )}
        </HookField>
        {create.isError ? (
          <p role="alert" className="m-0 text-[var(--color-danger-700)]">
            {errorMessage(create.error) ?? 'The view could not be saved.'}
          </p>
        ) : null}
        <Button type="submit" isLoading={create.isPending} loadingLabel="Saving">
          Save view
        </Button>
      </form>
    </Modal>
  );
}

export function WorkQueuePage() {
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(new Set());
  const [page, setPage] = useState(1);
  const [activeViewId, setActiveViewId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [defaultApplied, setDefaultApplied] = useState(false);

  const views = useSavedViews('work');
  const removeView = useDeleteSavedView('work');

  const included = KINDS.filter((kind) => !excluded.has(kind.id)).map((kind) => kind.id);
  const filtering = excluded.size > 0;

  const { data, isLoading, isError, error } = useWorkQueue(
    filtering ? included : [],
    page,
  );

  useEffect(() => {
    if (defaultApplied || !views.data) return;
    const preferred = views.data.find((view) => view.is_default) ?? null;
    if (preferred) {
      applyView(preferred);
    }
    setDefaultApplied(true);
  }, [views.data, defaultApplied]);

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const counts = data?.counts_by_kind ?? {};
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const hidden = [...excluded].reduce((sum, id) => sum + (counts[id] ?? 0), 0);

  function applyView(view: SavedViewOut) {
    const kinds = new Set(kindsFromView(view));
    setPage(1);
    setActiveViewId(view.id);
    setExcluded(new Set(ALL_KIND_IDS.filter((id) => !kinds.has(id))));
  }

  function toggle(id: string) {
    setPage(1);
    setActiveViewId(null);
    setExcluded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function clearFilters() {
    setPage(1);
    setActiveViewId(null);
    setExcluded(new Set());
  }

  return (
    <>
      <PageHeader
        title="My work"
        purpose="Everything waiting on you, oldest first."
        toolbar={
          <div className="flex flex-wrap items-center gap-x-[var(--space-4)] gap-y-[var(--space-2)]">
            <div role="group" aria-label="Saved views" className="flex flex-wrap items-center gap-1">
              <button
                type="button"
                aria-pressed={activeViewId === null && !filtering}
                onClick={clearFilters}
                className={cn(PILL, activeViewId === null && !filtering ? PILL_ON : PILL_OFF)}
              >
                Everything
              </button>
              {(views.data ?? []).map((view) => (
                <span key={view.id} className="inline-flex items-center">
                  <button
                    type="button"
                    aria-pressed={activeViewId === view.id}
                    onClick={() => applyView(view)}
                    className={cn(PILL, activeViewId === view.id ? PILL_ON : PILL_OFF)}
                  >
                    {view.name}
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete ${view.name}`}
                    onClick={() => {
                      removeView.mutate(view.id, {
                        onSuccess: () => {
                          if (activeViewId === view.id) clearFilters();
                        },
                      });
                    }}
                    className={cn(PILL, PILL_OFF, 'px-2')}
                  >
                    <Trash2 aria-hidden="true" className="size-3.5" />
                  </button>
                </span>
              ))}
            </div>

            <span aria-hidden="true" className="h-5 w-px bg-[var(--color-border)]" />

            <div
              role="group"
              aria-label="Filter by kind of work"
              className="flex flex-wrap items-center gap-1"
            >
              {KINDS.map((kind) => {
                const pressed = !excluded.has(kind.id);
                const count = counts[kind.id] ?? 0;
                return (
                  <button
                    key={kind.id}
                    type="button"
                    aria-pressed={pressed}
                    onClick={() => toggle(kind.id)}
                    className={cn(PILL, pressed ? PILL_INCLUDED : PILL_OFF)}
                  >
                    {/* Struck through when excluded, so what the list is
                        leaving out does not rest on colour alone. */}
                    <span className={pressed ? undefined : 'line-through'}>{kind.label}</span>
                    {count > 0 ? <span className="tabular opacity-70">{count}</span> : null}
                  </button>
                );
              })}
            </div>

            {hidden > 0 ? (
              <p
                aria-live="polite"
                className="m-0 text-[12px] text-[var(--color-text-muted)]"
              >
                {hidden} {hidden === 1 ? 'item is' : 'items are'} hidden by the filter.
              </p>
            ) : null}
          </div>
        }
        actions={
          filtering ? (
            <Button type="button" variant="secondary" size="sm" onClick={() => setSaving(true)}>
              <BookmarkPlus aria-hidden="true" className="size-4" />
              Save view
            </Button>
          ) : undefined
        }
      />

      {isError ? (
        <Card className="mb-[var(--space-6)] border-[var(--color-danger-600)]">
          <CardContent>
            <p className="m-0 font-semibold text-[var(--color-danger-700)]">
              Could not load your work
            </p>
            <p
              role="alert"
              className="mt-2 m-0 text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]"
            >
              {errorMessage(error) ?? 'The work queue could not be loaded.'}
            </p>
          </CardContent>
        </Card>
      ) : isLoading ? (
        <Card>
          <CardContent>
            <SkeletonText lines={6} />
          </CardContent>
        </Card>
      ) : items.length === 0 ? (
        <Card>
          <CardContent className="p-0">
            <EmptyState
              icon={CheckCheck}
              title="Nothing needs your attention"
              explanation={
                filtering
                  ? 'Nothing in the kinds you left on is waiting on you. Turn a filter back on to see the rest.'
                  : 'When something is routed to you — an approval, a receipt to confirm, a document to check or a vendor answer to weigh — it will appear here first, oldest at the top.'
              }
              nextStep={
                filtering
                  ? 'Show every kind again to see the full queue.'
                  : 'Suggestions from automation never approve, submit or pay on your behalf.'
              }
              {...(filtering
                ? { action: { label: 'Show everything', onClick: clearFilters } }
                : {})}
            />
          </CardContent>
        </Card>
      ) : (
        <DataTable
          ariaLabel="My work"
          columns={workColumns}
          rows={items}
          getRowKey={(item) => `${item.kind}:${item.record_id}`}
          getRowHref={(item) => item.record_path}
        />
      )}

      {total > PAGE_SIZE ? (
        <nav
          aria-label="Pagination"
          className="mt-[var(--space-4)] flex items-center justify-between gap-[var(--space-4)]"
        >
          <p
            aria-live="polite"
            className="m-0 text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]"
          >
            {total} waiting · page {page} of {pages}
          </p>
          <div className="flex gap-[var(--space-2)]">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage((current) => current - 1)}
            >
              Previous
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={page >= pages}
              onClick={() => setPage((current) => current + 1)}
            >
              Next
            </Button>
          </div>
        </nav>
      ) : null}

      <SaveViewModal
        open={saving}
        onClose={() => setSaving(false)}
        kinds={included}
      />
    </>
  );
}
