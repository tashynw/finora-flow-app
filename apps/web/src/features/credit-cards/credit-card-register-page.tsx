import { useMemo, useState } from 'react';
import { CreditCard, Plus, Upload } from 'lucide-react';

import type { CreditCardPeriodSummary, CreditCardStanding } from '@finora/shared-types';

import { formatDate } from '@/lib/dates';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { DataTable, type Column } from '@/components/ui/data-table';
import { ViewTabs } from '@/components/ui/view-tabs';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input, Select } from '@/components/ui/field';
import { SkeletonText } from '@/components/ui/skeleton';
import { ToneBadge } from '@/components/workflow/status-badge';
import { useAuth } from '@/features/auth/auth-context';
import { PageHeader } from '@/features/shared/page-header';
import {
  PERIOD_PURPOSE,
  periodWaitingOn,
} from '@/features/credit-cards/credit-card-vocabulary';
import {
  useCreateCreditCard,
  useCreditCardPeriods,
  useCreditCards,
  useImportStatement,
} from '@/features/credit-cards/use-credit-cards';

interface RegisterView {
  id: string;
  label: string;
  standing?: CreditCardStanding;
  empty: string;
  emptyExplanation: string;
}

const VIEWS: RegisterView[] = [
  {
    id: 'open',
    label: 'Open',
    standing: 'open',
    empty: 'No open statement periods',
    emptyExplanation:
      'Every imported statement has been closed, or none has been imported yet. Coding each line and closing the period are what make the charges accountable.',
  },
  {
    id: 'closed',
    label: 'Closed',
    standing: 'closed',
    empty: 'Nothing has been closed yet',
    emptyExplanation:
      'A closed period freezes coding. The person who coded the lines cannot be the person who closes it.',
  },
  {
    id: 'all',
    label: 'Everything',
    empty: 'No credit-card statements yet',
    emptyExplanation: PERIOD_PURPOSE,
  },
];

const periodColumns: Column<CreditCardPeriodSummary>[] = [
  {
    key: 'reference',
    header: 'Reference',
    width: 'w-44',
    cell: (row) => (
      <span className="flex flex-col">
        <span className="tabular font-medium text-[var(--color-text-strong)]">
          {row.reference}
        </span>
        <span className="tabular text-[11px] text-[var(--color-text-subtle)]">
          {formatDate(row.period_start)} – {formatDate(row.period_end)}
        </span>
      </span>
    ),
  },
  {
    key: 'card',
    header: 'Card',
    cell: (row) => (
      <span className="flex min-w-0 flex-col">
        <span className="truncate">
          {row.card.label} ·••• {row.card.last_four}
        </span>
        <span className="truncate text-[11px] text-[var(--color-text-subtle)]">
          Statement {formatDate(row.statement_date)}
        </span>
      </span>
    ),
  },
  {
    key: 'lines',
    header: 'Lines',
    width: 'w-28',
    cell: (row) => (
      <span className="flex flex-col">
        <span className="tabular">{row.transaction_count}</span>
        <span className="text-[11px] text-[var(--color-text-subtle)]">{row.currency}</span>
      </span>
    ),
  },
  {
    key: 'waiting',
    header: 'Waiting on',
    hideBelow: 'md',
    cell: (row) => (
      <span>{periodWaitingOn(row.uncoded_count, row.missing_receipt_count, row.standing)}</span>
    ),
  },
  {
    key: 'status',
    header: 'Status',
    width: 'w-36',
    cell: (row) => (
      <ToneBadge
        tone={row.standing === 'closed' ? 'neutral' : 'warning'}
        label={row.standing_label}
      />
    ),
  },
  {
    key: 'cardholder',
    header: 'Cardholder',
    width: 'w-40',
    hideBelow: 'lg',
    cell: (row) => <span>{row.card.cardholder_name}</span>,
  },
];

export function CreditCardRegisterPage() {
  const { user } = useAuth();
  const canCode = user?.permissions.includes('credit_card:code') ?? false;
  const [viewId, setViewId] = useState('open');
  const view: RegisterView = VIEWS.find((item) => item.id === viewId) ?? VIEWS[0]!;
  const periods = useCreditCardPeriods(view.standing);
  const cards = useCreditCards();
  const createCard = useCreateCreditCard();
  const [selectedCardId, setSelectedCardId] = useState('');

  const activeCardId = selectedCardId || cards.data?.[0]?.id || '';
  const importForCard = useImportStatement(activeCardId || undefined);

  const [showImport, setShowImport] = useState(false);
  const [newCard, setNewCard] = useState({
    label: '',
    last_four: '',
    cardholder_name: '',
    currency: 'JMD',
  });

  const rows = periods.data ?? [];
  const cardOptions = useMemo(() => cards.data ?? [], [cards.data]);

  // Until a card exists the same form registers one first, so the action says so.
  const needsCard = !cards.isLoading && cardOptions.length === 0;

  return (
    <>
      <PageHeader
        title="Credit cards"
        purpose="Statement periods, coding progress and close controls."
        toolbar={<ViewTabs tabs={VIEWS} value={view.id} onChange={setViewId} />}
        actions={
          canCode ? (
            <Button
              type="button"
              variant="primary"
              size="sm"
              aria-expanded={showImport}
              onClick={() => setShowImport((open) => !open)}
            >
              {needsCard ? (
                <Plus className="size-4" aria-hidden />
              ) : (
                <Upload className="size-4" aria-hidden />
              )}
              {needsCard ? 'Register card' : 'Import statement'}
            </Button>
          ) : null
        }
      />

      {showImport && canCode ? (
        <Card className="surface-card mb-[var(--space-5)]">
          <CardContent className="flex flex-col gap-[var(--space-4)] p-[var(--space-5)]">
            <h2 className="m-0 text-[length:var(--text-title-sm)] text-[var(--color-text-strong)]">
              Import a statement
            </h2>
            <p className="m-0 text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]">
              CSV with columns date, merchant, amount and cardholder. The same file
              cannot be imported twice against the same card.
            </p>

            {cardOptions.length === 0 ? (
              <div className="grid gap-[var(--space-3)] sm:grid-cols-2">
                <Field label="Card label">
                  {({ inputId, describedBy, invalid }) => (
                    <Input
                      id={inputId}
                      aria-describedby={describedBy}
                      invalid={invalid}
                      value={newCard.label}
                      onChange={(event) =>
                        setNewCard((current) => ({ ...current, label: event.target.value }))
                      }
                    />
                  )}
                </Field>
                <Field label="Last four digits">
                  {({ inputId, describedBy, invalid }) => (
                    <Input
                      id={inputId}
                      aria-describedby={describedBy}
                      invalid={invalid}
                      value={newCard.last_four}
                      maxLength={4}
                      onChange={(event) =>
                        setNewCard((current) => ({
                          ...current,
                          last_four: event.target.value.replace(/\D/g, '').slice(0, 4),
                        }))
                      }
                    />
                  )}
                </Field>
                <Field label="Cardholder">
                  {({ inputId, describedBy, invalid }) => (
                    <Input
                      id={inputId}
                      aria-describedby={describedBy}
                      invalid={invalid}
                      value={newCard.cardholder_name}
                      onChange={(event) =>
                        setNewCard((current) => ({
                          ...current,
                          cardholder_name: event.target.value,
                        }))
                      }
                    />
                  )}
                </Field>
                <div className="flex items-end">
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={createCard.isPending}
                    onClick={() =>
                      createCard.mutate(newCard, {
                        onSuccess: (card) => setSelectedCardId(card.id),
                      })
                    }
                  >
                    Save card
                  </Button>
                </div>
              </div>
            ) : (
              <Field label="Card">
                {({ inputId, describedBy, invalid }) => (
                  <Select
                    id={inputId}
                    aria-describedby={describedBy}
                    invalid={invalid}
                    value={activeCardId}
                    onChange={(event) => setSelectedCardId(event.target.value)}
                  >
                    {cardOptions.map((card) => (
                      <option key={card.id} value={card.id}>
                        {card.label} ·••• {card.last_four} ({card.cardholder_name})
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            )}

            <form
              className="grid gap-[var(--space-3)] sm:grid-cols-3"
              onSubmit={(event) => {
                event.preventDefault();
                const form = event.currentTarget;
                const fileInput = form.elements.namedItem('file') as HTMLInputElement;
                const file = fileInput.files?.[0];
                if (!file || !activeCardId) return;
                importForCard.mutate(
                  {
                    file,
                    period_start: (form.elements.namedItem('period_start') as HTMLInputElement)
                      .value,
                    period_end: (form.elements.namedItem('period_end') as HTMLInputElement).value,
                    statement_date: (
                      form.elements.namedItem('statement_date') as HTMLInputElement
                    ).value,
                  },
                  {
                    onSuccess: () => {
                      setShowImport(false);
                      form.reset();
                    },
                  },
                );
              }}
            >
              <Field label="Period start">
                {({ inputId, describedBy, invalid }) => (
                  <Input
                    id={inputId}
                    name="period_start"
                    type="date"
                    required
                    aria-describedby={describedBy}
                    invalid={invalid}
                  />
                )}
              </Field>
              <Field label="Period end">
                {({ inputId, describedBy, invalid }) => (
                  <Input
                    id={inputId}
                    name="period_end"
                    type="date"
                    required
                    aria-describedby={describedBy}
                    invalid={invalid}
                  />
                )}
              </Field>
              <Field label="Statement date">
                {({ inputId, describedBy, invalid }) => (
                  <Input
                    id={inputId}
                    name="statement_date"
                    type="date"
                    required
                    aria-describedby={describedBy}
                    invalid={invalid}
                  />
                )}
              </Field>
              <Field label="Statement CSV" className="sm:col-span-3">
                {({ inputId, describedBy, invalid }) => (
                  <Input
                    id={inputId}
                    name="file"
                    type="file"
                    accept=".csv,text/csv"
                    required
                    aria-describedby={describedBy}
                    invalid={invalid}
                  />
                )}
              </Field>
              <div className="sm:col-span-3">
                <Button type="submit" disabled={!activeCardId || importForCard.isPending}>
                  Import
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      ) : null}

      {periods.isLoading ? (
        <Card>
          <CardContent>
            <SkeletonText lines={4} />
          </CardContent>
        </Card>
      ) : rows.length === 0 ? (
        <Card>
          <CardContent className="p-0">
            <EmptyState
              icon={CreditCard}
              title={view.empty}
              explanation={view.emptyExplanation}
              nextStep={
                canCode
                  ? 'Import a statement to open a period.'
                  : 'Statements are imported by the people who code charges. Nothing is needed from you here.'
              }
              {...(viewId === 'all'
                ? {}
                : {
                    secondaryAction: {
                      label: 'Show everything',
                      onClick: () => setViewId('all'),
                    },
                  })}
            />
          </CardContent>
        </Card>
      ) : (
        <DataTable
          ariaLabel="Credit-card statement periods"
          columns={periodColumns}
          rows={rows}
          getRowKey={(row) => row.id}
          getRowHref={(row) => `/credit-cards/${row.id}`}
        />
      )}
    </>
  );
}
