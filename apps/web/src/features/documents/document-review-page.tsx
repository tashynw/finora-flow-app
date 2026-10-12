import { Suspense, lazy, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Mail,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react';
import { Link, useParams } from '@/lib/app-link';

import type {
  DocumentDetail,
  DocumentKind,
  DocumentSignal,
  EvidenceOut,
  FieldName,
  FieldOut,
  SignalOut,
} from '@finora/shared-types';

import { ApiError } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Input, Select } from '@/components/ui/field';
import { SkeletonBlock, SkeletonText } from '@/components/ui/skeleton';
import { ToneBadge } from '@/components/workflow/status-badge';
import { PageHeader } from '@/features/shared/page-header';
import { formatBytes } from '@/features/intake/intake-vocabulary';
import { FieldCard } from '@/features/documents/field-card';
import {
  ASSIGNABLE_KINDS,
  CONFIDENCE_BAND,
  EXTRACTION_STATUS,
  formatConfidence,
  signalHeadline,
  signalTone,
} from '@/features/documents/document-vocabulary';
import { RaiseEstimatePanel } from '@/features/estimates/raise-from-document';
import {
  useAcceptDocument,
  useAcknowledgeSignal,
  useCorrectField,
  useDocument,
  useRereadDocument,
  useReviewField,
  useSetKind,
} from '@/features/documents/use-documents';

/**
 * The viewer, loaded when a document is actually opened.
 *
 * Split out because it carries the PDF renderer, which is larger than the rest of
 * the application put together. Everyone who signs in would otherwise download a
 * renderer for a screen most of them never visit.
 */
const DocumentViewer = lazy(async () => {
  const module = await import('@/features/documents/document-viewer');
  return { default: module.DocumentViewer };
});

/** The order fields are shown in: what the document is, then what it is worth. */
const FIELD_ORDER: FieldName[] = [
  'vendor_name',
  'vendor_tax_id',
  'document_number',
  'document_date',
  'due_date',
  'purchase_order_number',
  'estimate_reference',
  'currency',
  'subtotal',
  'tax_total',
  'total',
  'payment_terms',
];

function orderFields(fields: FieldOut[]): FieldOut[] {
  return [...fields].sort((left, right) => {
    const leftIndex = FIELD_ORDER.indexOf(left.name);
    const rightIndex = FIELD_ORDER.indexOf(right.name);
    // A field the interface has no opinion about goes last rather than first, so
    // a field added to the API does not displace the total.
    return (
      (leftIndex === -1 ? FIELD_ORDER.length : leftIndex) -
      (rightIndex === -1 ? FIELD_ORDER.length : rightIndex)
    );
  });
}

/**
 * Human review of one document.
 *
 * The screen is arranged around a single question: can this reading be trusted
 * enough to act on. The document is on the left, what was read from it on the
 * right, and everything standing between it and acceptance is listed at the top
 * rather than discovered by pressing Accept and being refused.
 *
 * Nothing here can make a value trustworthy on its own. Acceptance is the only
 * act that does, it is always a person's, and it is the one thing on this page
 * that cannot be undone from this page.
 */
export function DocumentReviewPage() {
  const { documentId } = useParams<{ documentId: string }>();
  const { data: document, isLoading, isError, error } = useDocument(documentId);

  const [selected, setSelected] = useState<FieldName | null>(null);
  const [note, setNote] = useState('');

  const correct = useCorrectField(documentId);
  const review = useReviewField(documentId);
  const setKind = useSetKind(documentId);
  const acknowledge = useAcknowledgeSignal(documentId);
  const accept = useAcceptDocument(documentId);
  const reread = useRereadDocument(documentId);

  const fields = useMemo(
    () => orderFields(document?.extraction?.fields ?? []),
    [document],
  );

  const highlight: EvidenceOut | null = useMemo(() => {
    if (!selected) return null;
    return fields.find((item) => item.name === selected)?.evidence ?? null;
  }, [fields, selected]);

  if (isLoading) {
    return (
      <>
        <PageHeader title="Document" purpose="Opening the document." />
        <Card>
          <CardContent>
            <SkeletonText lines={10} />
          </CardContent>
        </Card>
      </>
    );
  }

  if (isError || !document) {
    return (
      <>
        <PageHeader title="Document" purpose="This document could not be opened." />
        <Card className="border-[var(--color-danger-600)]">
          <CardContent>
            <p className="m-0 font-semibold text-[var(--color-danger-700)]">
              Could not load this document
            </p>
            <p className="mt-2 m-0 text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]">
              {error instanceof Error ? error.message : 'The document could not be found.'}
            </p>
            <div className="mt-[var(--space-4)]">
              <Button variant="secondary" asChild>
                <Link to="/documents">
                  <ArrowLeft aria-hidden="true" className="size-4" />
                  Back to documents
                </Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      </>
    );
  }

  const status = EXTRACTION_STATUS[document.status];
  const extraction = document.extraction;
  const isLocked = document.status === 'accepted';
  const isBeingRead = document.status === 'pending' || document.status === 'extracting';
  const canAccept = document.acceptance_blockers.length === 0 && !isLocked && !isBeingRead;
  const fieldError = correct.error instanceof ApiError ? correct.error.message : undefined;

  return (
    <>
      <PageHeader
        title={document.filename}
        purpose={status.description}
        actions={
          <>
            <Button variant="secondary" asChild>
              <Link to="/documents">
                <ArrowLeft aria-hidden="true" className="size-4" />
                Back to documents
              </Link>
            </Button>
            {!isLocked ? (
              <Button
                variant="secondary"
                onClick={() => reread.mutate()}
                isLoading={reread.isPending}
                loadingLabel="Reading"
              >
                <RefreshCw aria-hidden="true" className="size-4" />
                Read it again
              </Button>
            ) : null}
          </>
        }
        meta={
          <div className="flex flex-wrap items-center gap-[var(--space-3)]">
            <ToneBadge label={status.label} tone={status.tone} />
            <span className="text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]">
              {document.kind_label}
            </span>
            <span className="text-[length:var(--text-body-sm)] text-[var(--color-text-subtle)]">
              {document.content_type} · {formatBytes(document.size_bytes)}
            </span>
            <Button variant="link" size="sm" asChild>
              <Link to={`/intake/${document.message_id}`}>
                <Mail aria-hidden="true" className="size-4" />
                How it arrived
              </Link>
            </Button>
          </div>
        }
      />

      {reread.error ? (
        <Notice tone="danger" title="This document was not read again">
          {reread.error instanceof Error
            ? reread.error.message
            : 'The request did not complete.'}
        </Notice>
      ) : null}

      {isBeingRead ? (
        <Notice tone="info" title="This document is being read">
          Values will appear here when reading finishes. The page updates itself, so
          there is nothing to do but wait.
        </Notice>
      ) : null}

      {extraction ? (
        <>
          <SignalPanel
            signals={extraction.signals}
            isLocked={isLocked}
            onAcknowledge={(signal) => acknowledge.mutate({ signal })}
            isSaving={acknowledge.isPending}
            error={
              acknowledge.error instanceof Error ? acknowledge.error.message : undefined
            }
          />

          {document.kind === 'unknown' && !isLocked ? (
            <KindPanel
              onChoose={(kind) => setKind.mutate({ kind })}
              isSaving={setKind.isPending}
            />
          ) : null}

          <div className="grid items-start gap-[var(--space-6)] xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
            {/* Held in place while the values beside it are worked through. A
                reviewer reaches the tenth field with the page it came from
                still on screen, which is the difference between checking a
                value and scrolling back up to remember what it said. Sticky
                only where there are two columns; stacked on a narrow screen the
                document belongs above the values, not pinned over them. */}
            <Card
              data-visual-sticky
              className="flex max-h-[calc(100vh-var(--space-8))] min-h-[36rem] flex-col overflow-hidden xl:sticky xl:top-[var(--space-6)]"
            >
              <CardHeader>
                <CardTitle>The document</CardTitle>
              </CardHeader>
              <Suspense
                fallback={
                  <div className="p-[var(--space-5)]">
                    <SkeletonBlock
                      className="h-[32rem] w-full"
                      label="Loading the document viewer"
                    />
                  </div>
                }
              >
                <DocumentViewer
                  documentId={document.id}
                  filename={document.filename}
                  contentType={document.content_type}
                  highlight={highlight}
                  className="min-h-0 flex-1"
                />
              </Suspense>
            </Card>

            <div className="flex min-w-0 flex-col gap-[var(--space-6)]">
              {document.acceptance_blockers.length > 0 ? (
                <Card className="border-[color-mix(in_srgb,var(--color-warning-600)_38%,white)]">
                  <CardHeader>
                    <CardTitle>
                      <span className="inline-flex items-center gap-[var(--space-2)]">
                        <AlertTriangle
                          aria-hidden="true"
                          className="size-4 text-[var(--color-warning-600)]"
                        />
                        Before this can be accepted
                      </span>
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <ul className="m-0 flex list-disc flex-col gap-[var(--space-2)] pl-[var(--space-5)]">
                      {document.acceptance_blockers.map((blocker) => (
                        <li
                          key={blocker}
                          className="text-[length:var(--text-body-sm)] text-[var(--color-text)]"
                        >
                          {blocker}
                        </li>
                      ))}
                    </ul>
                  </CardContent>
                </Card>
              ) : null}

              <Card className="overflow-hidden">
                <CardHeader>
                  <CardTitle>What was read</CardTitle>
                  <p className="m-0 text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]">
                    Anything at or above {formatConfidence(extraction.review_threshold)} was
                    read clearly enough to stand without checking. Everything else is
                    marked.
                  </p>
                </CardHeader>
                <CardContent className="p-0">
                  {fields.length === 0 ? (
                    <p className="m-0 px-[var(--space-5)] py-[var(--space-6)] text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]">
                      Nothing was read from this document. Every value has to be typed in
                      from the page beside this.
                    </p>
                  ) : (
                    <ul className="m-0 list-none p-0">
                      {fields.map((field) => (
                        <FieldCard
                          key={field.name}
                          field={field}
                          isSelected={selected === field.name}
                          isLocked={isLocked}
                          isSaving={
                            (correct.isPending || review.isPending) &&
                            correct.variables?.name !== undefined &&
                            correct.variables.name === field.name
                          }
                          error={
                            correct.variables?.name === field.name ? fieldError : undefined
                          }
                          onSelect={() =>
                            setSelected((current) =>
                              current === field.name ? null : field.name,
                            )
                          }
                          onCorrect={async (text, reason) => {
                            await correct
                              .mutateAsync({
                                name: field.name,
                                text,
                                ...(reason !== undefined ? { reason } : {}),
                              })
                              // Swallowed here because the message is shown on the
                              // field itself; rethrowing would only produce an
                              // unhandled rejection in the console.
                              .catch(() => undefined);
                          }}
                          onConfirm={async () => {
                            await review
                              .mutateAsync({ name: field.name, review: 'confirmed' })
                              .catch(() => undefined);
                          }}
                          onClear={async () => {
                            await review
                              .mutateAsync({ name: field.name, review: 'cleared' })
                              .catch(() => undefined);
                          }}
                        />
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>

              <ProvenancePanel document={document} />

              {isLocked ? (
                <>
                  <Card className="border-[color-mix(in_srgb,var(--color-success-600)_38%,white)]">
                    <CardContent className="flex items-start gap-[var(--space-3)]">
                      <CheckCircle2
                        aria-hidden="true"
                        className="mt-0.5 size-5 shrink-0 text-[var(--color-success-600)]"
                      />
                      <div>
                        <p className="m-0 font-semibold text-[var(--color-text-strong)]">
                          This reading has been accepted
                        </p>
                        <p className="mt-1 m-0 text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]">
                          {extraction.accepted_note
                            ? extraction.accepted_note
                            : 'Its values are available to the rest of the platform. Ask an administrator to reopen it if something is wrong.'}
                        </p>
                      </div>
                    </CardContent>
                  </Card>

                  <RaiseEstimatePanel document={document} />
                </>
              ) : (
                <Card>
                  <CardHeader>
                    <CardTitle>Accept this reading</CardTitle>
                    <p className="m-0 text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]">
                      Accepting says these values are what the document says, and makes
                      them available to the rest of the platform. It is recorded against
                      your name.
                    </p>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-[var(--space-4)]">
                    <Field
                      label="Anything worth noting"
                      help="Kept with the record. Useful when a value needed judgement."
                    >
                      {({ inputId, describedBy }) => (
                        <Input
                          id={inputId}
                          aria-describedby={describedBy}
                          value={note}
                          onChange={(event) => setNote(event.target.value)}
                        />
                      )}
                    </Field>

                    {accept.error ? (
                      <p
                        role="alert"
                        className="m-0 text-[length:var(--text-body-sm)] text-[var(--color-danger-700)]"
                      >
                        {accept.error instanceof Error
                          ? accept.error.message
                          : 'This reading was not accepted.'}
                      </p>
                    ) : null}

                    <div>
                      <Button
                        variant="primary"
                        disabled={!canAccept}
                        isLoading={accept.isPending}
                        loadingLabel="Accepting"
                        onClick={() =>
                          accept.mutate(note.trim() ? { note: note.trim() } : {})
                        }
                      >
                        <ShieldCheck aria-hidden="true" className="size-4" />
                        Accept this reading
                      </Button>
                      {!canAccept ? (
                        <p className="mt-[var(--space-2)] m-0 text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]">
                          {isBeingRead
                            ? 'Wait for reading to finish.'
                            : 'Everything listed above has to be dealt with first.'}
                        </p>
                      ) : null}
                    </div>
                  </CardContent>
                </Card>
              )}
            </div>
          </div>
        </>
      ) : (
        <Card>
          <CardContent>
            <p className="m-0 text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]">
              This document has not been read yet, so there are no values to review. It is
              stored, and reading can be started from the document list.
            </p>
          </CardContent>
        </Card>
      )}
    </>
  );
}

// -------------------------------------------------------------------- panels

function Notice({
  tone,
  title,
  children,
}: {
  tone: 'info' | 'danger';
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Card
      className={cn(
        'mb-[var(--space-6)]',
        tone === 'danger'
          ? 'border-[var(--color-danger-600)]'
          : 'border-[var(--color-primary-200)]',
      )}
    >
      <CardContent>
        <p
          className={cn(
            'm-0 font-semibold',
            tone === 'danger'
              ? 'text-[var(--color-danger-700)]'
              : 'text-[var(--color-text-strong)]',
          )}
        >
          {title}
        </p>
        <p className="mt-2 m-0 text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]">
          {children}
        </p>
      </CardContent>
    </Card>
  );
}

/**
 * The warnings the reader raised.
 *
 * The two that ask for something outside this screen, bank details and text
 * written at an automated reader, carry their own button, and pressing it records
 * that a named person did the thing it asked for. Nothing on this page can clear
 * them on the reviewer's behalf, which is the entire point of them.
 */
function SignalPanel({
  signals,
  isLocked,
  onAcknowledge,
  isSaving,
  error,
}: {
  signals: SignalOut[];
  isLocked: boolean;
  onAcknowledge: (signal: DocumentSignal) => void;
  isSaving: boolean;
  error?: string | undefined;
}) {
  if (signals.length === 0) return null;

  return (
    <Card className="mb-[var(--space-6)]">
      <CardHeader>
        <CardTitle>What the reader noticed</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <ul className="m-0 list-none p-0">
          {signals.map((signal) => (
            <li
              key={signal.signal}
              className="flex flex-col gap-[var(--space-3)] border-b border-[var(--color-divider)] px-[var(--space-5)] py-[var(--space-4)] last:border-b-0 sm:flex-row sm:items-start sm:justify-between"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-[var(--space-2)]">
                  <ToneBadge
                    label={signalHeadline(signal.signal)}
                    tone={signalTone(signal.signal)}
                  />
                  {signal.acknowledged ? (
                    <ToneBadge label="Acknowledged" tone="success" />
                  ) : null}
                </div>
                <p className="mt-[var(--space-2)] m-0 max-w-prose text-[length:var(--text-body-sm)] text-[var(--color-text)]">
                  {signal.explanation}
                </p>
              </div>

              {signal.requires_acknowledgement && !signal.acknowledged && !isLocked ? (
                <Button
                  variant="secondary"
                  size="sm"
                  className="shrink-0"
                  // The name is typed as a plain string, because the API passes
                  // through a warning this version has no words for rather than
                  // dropping it. Only a warning the API recognises is ever marked
                  // as one to acknowledge, so this button never sends a name the
                  // API will refuse.
                  onClick={() => onAcknowledge(signal.signal as DocumentSignal)}
                  isLoading={isSaving}
                  loadingLabel="Recording"
                >
                  <ShieldCheck aria-hidden="true" className="size-4" />
                  I have done this
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
        {error ? (
          <p
            role="alert"
            className="m-0 px-[var(--space-5)] py-[var(--space-3)] text-[length:var(--text-body-sm)] text-[var(--color-danger-700)]"
          >
            {error}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

/**
 * Asks what the document is, when the reader could not tell.
 *
 * Answered before anything else, because the kind decides which values are
 * required at all. A reviewer who fills in fields first and sets the kind
 * afterwards would have the reading replaced underneath them, so this is put
 * above the fields rather than beside them.
 */
function KindPanel({
  onChoose,
  isSaving,
}: {
  onChoose: (kind: DocumentKind) => void;
  isSaving: boolean;
}) {
  const [choice, setChoice] = useState<DocumentKind | ''>('');

  return (
    <Card className="mb-[var(--space-6)] border-[color-mix(in_srgb,var(--color-warning-600)_38%,white)]">
      <CardHeader>
        <CardTitle>What kind of document is this?</CardTitle>
        <p className="m-0 text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]">
          Nothing on the page said clearly enough. Answering this decides which values
          are needed, so the document is read again once you have.
        </p>
      </CardHeader>
      <CardContent className="flex flex-wrap items-end gap-[var(--space-3)]">
        <Field label="This document is" className="min-w-[16rem] flex-1" required>
          {({ inputId }) => (
            <Select
              id={inputId}
              value={choice}
              onChange={(event) => setChoice(event.target.value as DocumentKind)}
            >
              <option value="">Choose one</option>
              {ASSIGNABLE_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {KIND_CHOICE_LABELS[kind]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Button
          variant="primary"
          disabled={choice === ''}
          isLoading={isSaving}
          loadingLabel="Reading again"
          onClick={() => {
            if (choice !== '') onChoose(choice);
          }}
        >
          Set the kind and read again
        </Button>
      </CardContent>
    </Card>
  );
}

/**
 * The labels for the kinds a person may choose.
 *
 * Held here rather than taken from the API, because the API sends a label for the
 * kind a document has, not a list of the kinds one may be given.
 */
const KIND_CHOICE_LABELS: Record<(typeof ASSIGNABLE_KINDS)[number], string> = {
  invoice: 'Invoice',
  estimate: 'Estimate or quotation',
  credit_note: 'Credit note',
  receipt: 'Receipt',
  purchase_order: 'Purchase order',
  statement: 'Statement',
  remittance_advice: 'Remittance advice',
};

/**
 * How this reading was produced.
 *
 * Shown in full, including which model was asked and which prompt version, so
 * that a reading can be explained a year later when neither is still in use.
 */
function ProvenancePanel({ document }: { document: DocumentDetail }) {
  const extraction = document.extraction;
  if (!extraction) return null;

  const band = CONFIDENCE_BAND[extraction.kind_confidence >= 0.85 ? 'high' : 'medium'];

  return (
    <Card>
      <CardHeader>
        <CardTitle>How this reading was produced</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="m-0 grid gap-[var(--space-3)] sm:grid-cols-2">
          <Definition term="Attempt">
            {extraction.attempt}
            {document.history.length > 0
              ? ` (${document.history.length} earlier ${
                  document.history.length === 1 ? 'attempt' : 'attempts'
                })`
              : ''}
          </Definition>
          <Definition term="Text came from">
            {extraction.text_source === 'plain_text'
              ? 'The file itself, as text'
              : extraction.text_source === 'pdf_text_layer'
                ? "The document's own text layer"
                : extraction.text_source}
          </Definition>
          <Definition term="Pages read">{extraction.page_count}</Definition>
          <Definition term="Kind decided with">
            {extraction.kind_label} · {formatConfidence(extraction.kind_confidence)}{' '}
            {band.label.toLowerCase()}
          </Definition>
          <Definition term="Assistive reader">
            {extraction.model_name ? (
              <>
                {extraction.model_name}
                {extraction.prompt_id ? (
                  <span className="block text-[var(--color-text-muted)]">
                    Prompt {extraction.prompt_id} version {extraction.prompt_version}
                  </span>
                ) : null}
              </>
            ) : (
              'Not used. Every value came from fixed rules or from a person.'
            )}
          </Definition>
          {extraction.suggestions_discarded > 0 ? (
            <Definition term="Proposals refused">
              {extraction.suggestions_discarded}
              <span className="block text-[var(--color-text-muted)]">
                Values the assistive reader proposed that could not be found on the page,
                so they were discarded rather than shown.
              </span>
            </Definition>
          ) : null}
          <Definition term="Document hash">
            <span className="font-mono break-all">{document.sha256}</span>
          </Definition>
        </dl>

        {extraction.notes.length > 0 ? (
          <ul className="mt-[var(--space-4)] mb-0 flex list-disc flex-col gap-1 pl-[var(--space-5)]">
            {extraction.notes.map((note) => (
              <li key={note} className="text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]">
                {note}
              </li>
            ))}
          </ul>
        ) : null}
      </CardContent>
    </Card>
  );
}

function Definition({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="m-0 text-[length:var(--text-body-sm)] text-[var(--color-text-subtle)]">{term}</dt>
      <dd className="m-0 min-w-0 break-words text-[length:var(--text-body-sm)] text-[var(--color-text-strong)]">
        {children}
      </dd>
    </div>
  );
}
