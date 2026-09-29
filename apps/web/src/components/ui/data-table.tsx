import { Link } from 'react-router-dom';

import { cn } from '@/lib/utils';

/**
 * DataTable.
 *
 * A dense register table: a header card over stacked row cards, money and
 * counts right-aligned, status pills in their own column. Rows may link to a
 * record; the link is a real, focusable anchor stretched across the row (so
 * keyboard and pointer both reach it) rather than a click handler on a div.
 */
export interface Column<T> {
  /** Stable identity for the column. */
  key: string;
  header: React.ReactNode;
  /** Horizontal alignment of the cell body. Money and counts are right. */
  align?: 'left' | 'right' | 'center';
  /** Optional fixed/max width utility classes, e.g. 'w-40'. */
  width?: string;
  /** Hide below this breakpoint, e.g. 'sm' → hidden on mobile. */
  hideBelow?: 'sm' | 'md' | 'lg' | 'xl';
  cell: (row: T) => React.ReactNode;
}

const ALIGN: Record<'left' | 'right' | 'center', string> = {
  left: 'text-left',
  right: 'text-right',
  center: 'text-center',
};

const HIDE: Record<'sm' | 'md' | 'lg' | 'xl', string> = {
  sm: 'hidden sm:table-cell',
  md: 'hidden md:table-cell',
  lg: 'hidden lg:table-cell',
  xl: 'hidden xl:table-cell',
};

/** Borders on each cell, with the outer cells closing the rounded card. */
const CELL_EDGE = cn(
  'border-y first:border-l last:border-r',
  'first:rounded-l-[var(--radius-lg)] last:rounded-r-[var(--radius-lg)]',
);

export function DataTable<T>({
  columns,
  rows,
  getRowKey,
  getRowHref,
  ariaLabel,
}: {
  columns: Column<T>[];
  rows: T[];
  getRowKey: (row: T) => string;
  /** When provided, the whole row becomes a link to this path. */
  getRowHref?: (row: T) => string;
  ariaLabel: string;
}) {
  return (
    <div className="w-full overflow-x-auto pb-2">
      {/* The floor keeps a phone scrolling the table sideways rather than
          wrapping references and emails a character at a time. */}
      <table
        className="w-full min-w-[640px] border-separate border-spacing-0 text-[12px] [filter:drop-shadow(0_8px_20px_rgb(82_118_184_/_0.1))]"
        aria-label={ariaLabel}
      >
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className={cn(
                  CELL_EDGE,
                  'h-[46px] whitespace-nowrap border-[var(--color-border)] bg-[var(--color-surface-raised)]',
                  'px-[18px] text-[10px] font-semibold uppercase tracking-wide',
                  'text-[var(--color-text-muted)]',
                  ALIGN[column.align ?? 'left'],
                  column.width,
                  column.hideBelow && HIDE[column.hideBelow],
                )}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const href = getRowHref?.(row);
            return (
              <tr
                key={getRowKey(row)}
                className={cn('group', href && 'relative')}
              >
                {columns.map((column, columnIndex) => {
                  const content = column.cell(row);
                  const isFirst = columnIndex === 0;
                  return (
                    <td
                      key={column.key}
                      className={cn(
                        CELL_EDGE,
                        'h-16 border-[var(--color-divider)] bg-[var(--color-surface-raised)]',
                        'px-[18px] py-2 align-middle text-[var(--color-text)]',
                        href &&
                          'transition-colors duration-[var(--duration-fast)] group-hover:bg-[var(--color-surface)]',
                        ALIGN[column.align ?? 'left'],
                        column.width,
                        column.hideBelow && HIDE[column.hideBelow],
                      )}
                    >
                      {href && isFirst ? (
                        <Link
                          to={href}
                          className={cn(
                            'text-inherit no-underline outline-none',
                            // Stretched link: covers the whole row so pointer
                            // clicks anywhere navigate, while remaining a
                            // single real, focusable anchor for the keyboard.
                            'after:absolute after:inset-0 after:rounded-[var(--radius-lg)] after:content-[""]',
                            'focus-visible:after:outline-2 focus-visible:after:outline-offset-[-2px] focus-visible:after:outline-[var(--color-primary-600)]',
                          )}
                        >
                          {content}
                        </Link>
                      ) : (
                        content
                      )}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
