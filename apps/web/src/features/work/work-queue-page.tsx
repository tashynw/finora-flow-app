import { useEffect, useState } from 'react';
import { BookmarkPlus, CheckCheck, Trash2 } from 'lucide-react';
import { Link } from 'react-router-dom';

import { cn } from '@/lib/utils';
import { errorMessage } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input } from '@/components/ui/field';
import { Modal } from '@/components/ui/modal';
import { SkeletonText } from '@/components/ui/skeleton';
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

function WorkRow({ item }: { item: WorkItemOut }) {
  const waited = waitedFor(item.waiting_hours);

  return (
    <li className="border-b border-[var(--color-divider)] last:border-b-0">
      <Link
        to={item.record_path}
        className={cn(
          'motion-interactive flex flex-col gap-[var(--space-2)] px-[var(--space-5)] py-[var(--space-4)]',
          'no-underline hover:bg-[var(--color-surface-subtle)]',
          'focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--color-focus-ring)]',
          'sm:flex-row sm:items-center sm:gap-[var(--space-5)]',
        )}
      >
        <div className="min-w-0 flex-1">
          <p className="m-0 flex flex-wrap items-baseline gap-x-[var(--space-2)]">
            <span className="text-[var(--text-caption)] text-[var(--color-text-subtle)]">
              {item.kind_label}
            </span>
            <span className="tabular text-[var(--text-caption)] text-[var(--color-text-subtle)]">
              {item.reference}
            </span>
            <span className="truncate font-semibold text-[var(--color-text-strong)]">
              {item.title}
            </span>
          </p>
          <p className="m-0 truncate text-[var(--text-body-sm)] text-[var(--color-text-muted)]">
            {item.subtitle}
            {item.detail ? ` · ${item.detail}` : ''}
          </p>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-[var(--space-4)]">
          <span
            className={cn(
              'text-[var(--text-body-sm)]',
              waited.tone === 'danger'
                ? 'font-semibold text-[var(--color-danger-700)]'
                : waited.tone === 'warning'
                  ? 'font-semibold text-[var(--color-warning-700)]'
                  : 'text-[var(--color-text-subtle)]',
            )}
          >
            {waited.label}
          </span>

          {item.amount_formatted ? (
            <span className="tabular min-w-[8rem] text-right font-semibold text-[var(--color-text-strong)]">
              {item.amount_formatted}
            </span>
          ) : null}
        </div>
      </Link>
    </li>
  );
}

function kindsFromView(view: SavedViewOut): string[] {
  const raw = view.definition.kinds;
  if (!Array.isArray(raw)) return [...ALL_KIND_IDS];
  return raw.filter((item): item is string => typeof item === 'string');
}

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
  const [name, setName] = useState('');

  useEffect(() => {
    if (open) {
      setName('');
      create.reset();
    }
  }, [open, create]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Save this view"
      description="Keeps the kinds you have turned on. Only you can see it."
      busy={create.isPending}
    >
      <div className="flex flex-col gap-[var(--space-4)]">
        <Field label="Name">
          {({ inputId, describedBy, invalid }) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              invalid={invalid}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Approvals only"
            />
          )}
        </Field>
        {create.isError ? (
          <p role="alert" className="m-0 text-[var(--color-danger-700)]">
            {errorMessage(create.error) ?? 'The view could not be saved.'}
          </p>
        ) : null}
        <Button
          type="button"
          disabled={create.isPending || name.trim().length < 1}
          onClick={() =>
            create.mutate(
              {
                scope: 'work',
                name: name.trim(),
                definition: { kinds },
              },
              { onSuccess: () => onClose() },
            )
          }
        >
          {create.isPending ? 'Saving…' : 'Save view'}
        </Button>
      </div>
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
    <div className="flex flex-col gap-[var(--space-6)]">
      <PageHeader
        title="My work"
        purpose="Everything waiting on you, oldest first — approvals, receipt confirmations, document reviews and vendor conclusions."
        actions={
          filtering ? (
            <Button type="button" variant="secondary" onClick={() => setSaving(true)}>
              <BookmarkPlus aria-hidden="true" className="size-4" />
              Save view
            </Button>
          ) : undefined
        }
      />

      {views.data && views.data.length > 0 ? (
        <div
          role="group"
          aria-label="Saved views"
          className="flex flex-wrap items-center gap-[var(--space-2)]"
        >
          <Button
            type="button"
            size="sm"
            variant={activeViewId === null && !filtering ? 'secondary' : 'ghost'}
            onClick={clearFilters}
          >
            Everything
          </Button>
          {views.data.map((view) => (
            <span key={view.id} className="inline-flex items-center gap-1">
              <Button
                type="button"
                size="sm"
                variant={activeViewId === view.id ? 'secondary' : 'ghost'}
                onClick={() => applyView(view)}
              >
                {view.name}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                aria-label={`Delete ${view.name}`}
                onClick={() => {
                  removeView.mutate(view.id, {
                    onSuccess: () => {
                      if (activeViewId === view.id) clearFilters();
                    },
                  });
                }}
              >
                <Trash2 aria-hidden="true" className="size-3.5" />
              </Button>
            </span>
          ))}
        </div>
      ) : null}

      <div
        role="group"
        aria-label="Filter by kind of work"
        className="flex flex-wrap gap-[var(--space-2)]"
      >
        {KINDS.map((kind) => {
          const pressed = !excluded.has(kind.id);
          const count = counts[kind.id] ?? 0;
          return (
            <Button
              key={kind.id}
              type="button"
              size="sm"
              variant={pressed ? 'secondary' : 'ghost'}
              aria-pressed={pressed}
              onClick={() => toggle(kind.id)}
            >
              <span className={pressed ? undefined : 'line-through'}>{kind.label}</span>
              {count > 0 ? ` (${count})` : ''}
            </Button>
          );
        })}
      </div>

      {isLoading ? (
        <SkeletonText lines={6} />
      ) : isError ? (
        <p role="alert" className="m-0 text-[var(--color-danger-700)]">
          {errorMessage(error) ?? 'The work queue could not be loaded.'}
        </p>
      ) : items.length === 0 ? (
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
        />
      ) : (
        <Card className="surface-card overflow-hidden">
          <CardContent className="p-0">
            <ul className="m-0 list-none p-0">
              {items.map((item) => (
                <WorkRow key={`${item.kind}:${item.record_id}`} item={item} />
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {total > PAGE_SIZE ? (
        <div className="flex items-center justify-between gap-[var(--space-3)]">
          <p className="m-0 text-[var(--text-body-sm)] text-[var(--color-text-muted)]">
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
        </div>
      ) : null}

      <SaveViewModal
        open={saving}
        onClose={() => setSaving(false)}
        kinds={included}
      />
    </div>
  );
}
