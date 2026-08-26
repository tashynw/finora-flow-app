import { useEffect, useId, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search } from 'lucide-react';

import { cn } from '@/lib/utils';
import { errorMessage } from '@/lib/api-client';
import { SkeletonText } from '@/components/ui/skeleton';
import { useSearch, type SearchHitOut } from '@/features/search/use-search';

/**
 * Global search palette.
 *
 * Opens from the shell trigger or Ctrl/Cmd+K. Debounced query against the
 * federated search API; choosing a hit navigates and closes.
 */

const DEBOUNCE_MS = 250;

export function SearchPalette({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const titleId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);

  const { data, isFetching, isError, error } = useSearch(query, open);

  useEffect(() => {
    const handle = window.setTimeout(() => setQuery(draft.trim()), DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [draft]);

  useEffect(() => {
    const node = dialogRef.current;
    if (!node) return;
    if (open && !node.open) {
      node.showModal();
      setDraft('');
      setQuery('');
      setActiveIndex(0);
      window.setTimeout(() => inputRef.current?.focus(), 0);
    } else if (!open && node.open) {
      node.close();
    }
  }, [open]);

  useEffect(() => {
    setActiveIndex(0);
  }, [data?.items]);

  const items = data?.items ?? [];

  function choose(hit: SearchHitOut) {
    onClose();
    void navigate(hit.record_path);
  }

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      className={cn(
        'fixed inset-0 m-auto max-h-[min(32rem,calc(100vh-2rem))] w-[min(36rem,calc(100vw-2rem))]',
        'rounded-[var(--radius-md)] border border-[var(--color-border)]',
        'bg-[var(--color-surface)] p-0 text-[var(--color-text)] shadow-[var(--shadow-lg)]',
        'open:flex open:flex-col',
      )}
      onClose={onClose}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <h2 id={titleId} className="sr-only">
        Search records
      </h2>
      <div className="flex items-center gap-[var(--space-2)] border-b border-[var(--color-divider)] px-[var(--space-4)]">
        <Search aria-hidden="true" className="size-4 shrink-0 text-[var(--color-text-muted)]" />
        <input
          ref={inputRef}
          type="search"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Search by reference, vendor, description…"
          className={cn(
            'h-12 w-full border-0 bg-transparent text-[var(--text-body)]',
            'text-[var(--color-text-strong)] outline-none placeholder:text-[var(--color-text-subtle)]',
          )}
          aria-autocomplete="list"
          aria-controls="search-results"
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setActiveIndex((index) =>
                items.length === 0 ? 0 : Math.min(index + 1, items.length - 1),
              );
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              setActiveIndex((index) => Math.max(index - 1, 0));
            } else if (event.key === 'Enter' && items[activeIndex]) {
              event.preventDefault();
              choose(items[activeIndex]);
            }
          }}
        />
        <kbd className="hidden shrink-0 rounded border border-[var(--color-border)] px-1.5 py-0.5 text-[var(--text-caption)] text-[var(--color-text-subtle)] sm:inline">
          Esc
        </kbd>
      </div>

      <div
        id="search-results"
        role="listbox"
        className="min-h-0 flex-1 overflow-y-auto"
      >
        {draft.trim().length > 0 && draft.trim().length < 2 ? (
          <p className="m-0 px-[var(--space-4)] py-[var(--space-5)] text-[var(--text-body-sm)] text-[var(--color-text-muted)]">
            Type at least two characters.
          </p>
        ) : null}

        {draft.trim().length >= 2 && isFetching && !data ? (
          <div className="px-[var(--space-4)] py-[var(--space-5)]">
            <SkeletonText lines={4} />
          </div>
        ) : null}

        {isError ? (
          <p className="m-0 px-[var(--space-4)] py-[var(--space-5)] text-[var(--text-body-sm)] text-[var(--color-danger-700)]">
            {errorMessage(error)}
          </p>
        ) : null}

        {query.length >= 2 && !isFetching && !isError && items.length === 0 ? (
          <p className="m-0 px-[var(--space-4)] py-[var(--space-5)] text-[var(--text-body-sm)] text-[var(--color-text-muted)]">
            Nothing matched “{query}”.
          </p>
        ) : null}

        {items.length > 0 ? (
          <ul className="m-0 list-none p-0">
            {items.map((hit, index) => (
              <li key={`${hit.record_type}-${hit.record_id}`}>
                <button
                  type="button"
                  role="option"
                  aria-selected={index === activeIndex}
                  className={cn(
                    'flex w-full flex-col gap-0.5 px-[var(--space-4)] py-[var(--space-3)] text-left',
                    'hover:bg-[var(--color-surface-subtle)]',
                    index === activeIndex && 'bg-[var(--color-surface-subtle)]',
                  )}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => choose(hit)}
                >
                  <span className="flex flex-wrap items-baseline gap-x-[var(--space-2)]">
                    <span className="text-[var(--text-caption)] text-[var(--color-text-subtle)]">
                      {hit.type_label}
                    </span>
                    <span className="tabular text-[var(--text-caption)] text-[var(--color-text-subtle)]">
                      {hit.reference}
                    </span>
                    <span className="truncate font-semibold text-[var(--color-text-strong)]">
                      {hit.title}
                    </span>
                    {hit.amount_formatted ? (
                      <span className="ml-auto tabular text-[var(--text-body-sm)] text-[var(--color-text-muted)]">
                        {hit.amount_formatted}
                      </span>
                    ) : null}
                  </span>
                  <span className="truncate text-[var(--text-body-sm)] text-[var(--color-text-muted)]">
                    {hit.subtitle}
                    {hit.state ? ` · ${hit.state}` : ''}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </dialog>
  );
}

export function GlobalSearchTrigger() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen(true);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <>
      <button
        type="button"
        className={cn(
          'flex h-11 min-w-0 flex-1 items-center gap-[var(--space-2)] rounded-[var(--radius-sm)]',
          'border border-[var(--color-border)] bg-[var(--color-surface-subtle)]',
          'px-[var(--space-3)] text-left text-[var(--text-body-sm)]',
          'text-[var(--color-text-muted)] sm:max-w-md',
          'transition-colors duration-[var(--duration-fast)]',
          'hover:border-[var(--color-border-strong)]',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-focus-ring)]',
        )}
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <Search aria-hidden="true" className="size-4 shrink-0" />
        <span className="truncate">Search records…</span>
        <kbd className="ml-auto hidden shrink-0 rounded border border-[var(--color-border)] px-1.5 py-0.5 text-[var(--text-caption)] text-[var(--color-text-subtle)] sm:inline">
          Ctrl K
        </kbd>
      </button>
      <SearchPalette open={open} onClose={() => setOpen(false)} />
    </>
  );
}
