import { useId, useMemo, useState } from 'react';
import { ChevronsUpDown } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/field';

export interface ComboboxItem {
  value: string;
  label: string;
}

/**
 * A filterable list. Typing narrows the options; choosing one sets the value.
 * An empty value means nothing is selected.
 */
export function Combobox({
  id,
  value,
  onChange,
  items,
  placeholder,
  emptyLabel = 'No matches',
  clearLabel = 'None',
  describedBy,
  invalid,
  disabled,
}: {
  id?: string | undefined;
  value: string;
  onChange: (value: string) => void;
  items: readonly ComboboxItem[];
  placeholder?: string | undefined;
  emptyLabel?: string | undefined;
  clearLabel?: string | undefined;
  describedBy?: string | undefined;
  invalid?: boolean | undefined;
  disabled?: boolean | undefined;
}) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const selected = items.find((item) => item.value === value) ?? null;

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return items;
    return items.filter((item) => item.label.toLowerCase().includes(needle));
  }, [items, query]);

  return (
    <div className="relative">
      <span className="relative block">
        <Input
          id={id}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-describedby={describedBy}
          disabled={disabled}
          {...(invalid ? { invalid: true } : {})}
          placeholder={placeholder}
          value={open ? query : (selected?.label ?? '')}
          onFocus={() => {
            setQuery('');
            setOpen(true);
          }}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          onBlur={() => {
            window.setTimeout(() => setOpen(false), 120);
          }}
          className="pr-10"
        />
        <ChevronsUpDown
          aria-hidden="true"
          className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-[var(--color-text-muted)]"
        />
      </span>
      {open ? (
        <ul
          id={listId}
          role="listbox"
          className={cn(
            'absolute z-50 mt-1 max-h-60 w-full overflow-auto rounded-[var(--radius-md)]',
            'border border-[var(--color-border)] bg-[var(--color-surface)] py-1 shadow-[var(--shadow-lg)]',
          )}
        >
          <li role="presentation">
            <button
              type="button"
              className="w-full px-3 py-2 text-left text-[length:var(--text-body-sm)] text-[var(--color-text-muted)] hover:bg-[var(--color-surface-subtle)]"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                onChange('');
                setQuery('');
                setOpen(false);
              }}
            >
              {clearLabel}
            </button>
          </li>
          {shown.length === 0 ? (
            <li className="px-3 py-2 text-[length:var(--text-body-sm)] text-[var(--color-text-subtle)]">
              {emptyLabel}
            </li>
          ) : (
            shown.map((item) => (
              <li key={item.value} role="presentation">
                <button
                  type="button"
                  role="option"
                  aria-selected={item.value === value}
                  className={cn(
                    'w-full px-3 py-2 text-left text-[length:var(--text-body-sm)]',
                    'hover:bg-[var(--color-surface-subtle)]',
                    item.value === value && 'bg-[var(--color-surface-subtle)] font-medium',
                  )}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    onChange(item.value);
                    setQuery('');
                    setOpen(false);
                  }}
                >
                  {item.label}
                </button>
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}
