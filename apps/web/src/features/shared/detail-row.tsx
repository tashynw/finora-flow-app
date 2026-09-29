/**
 * One labelled line of a record laid out to be read.
 *
 * A description list rather than a disabled copy of the form it was typed into.
 * Disabled inputs look like something that failed to load, they are harder to
 * read than plain text, and they invite a reader to try to type into them.
 *
 * The label column is fixed rather than sized to its contents, so the values
 * line up down the page and a reader comparing two records can run their eye
 * down one column instead of hunting.
 */
export function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-[var(--space-1)] border-b border-[var(--color-divider)] py-[var(--space-3)] last:border-b-0 sm:flex-row sm:gap-[var(--space-5)]">
      <dt className="shrink-0 text-[length:var(--text-body-sm)] text-[var(--color-text-muted)] sm:w-52">
        {label}
      </dt>
      <dd className="m-0 min-w-0 text-[length:var(--text-body)] text-[var(--color-text-strong)]">
        {children}
      </dd>
    </div>
  );
}
