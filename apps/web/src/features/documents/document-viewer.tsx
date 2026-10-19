import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ExternalLink, FileWarning, ZoomIn, ZoomOut } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { PDFDocumentProxy } from 'pdfjs-dist';

import type { EvidenceOut } from '@finora/shared-types';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { SkeletonBlock } from '@/components/ui/skeleton';
import { RENDER_ANNOTATION_MODE, loadPdf } from '@/features/documents/pdf-runtime';
import { useViewerUrl } from '@/features/documents/use-documents';

const PDF_TYPES = new Set(['application/pdf', 'application/x-pdf']);

const IMAGE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'svg',
  'avif',
  'tif',
  'tiff',
  'heic',
  'heif',
]);

function mediaType(contentType: string): string {
  return contentType.split(';')[0]?.trim().toLowerCase() ?? '';
}

function fileExtension(filename: string): string {
  return filename.split('.').pop()?.trim().toLowerCase() ?? '';
}

function isImageDocument(contentType: string, filename: string): boolean {
  const type = mediaType(contentType);
  if (type.startsWith('image/')) return true;
  return IMAGE_EXTENSIONS.has(fileExtension(filename));
}

const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3] as const;

export interface DocumentViewerProps {
  documentId: string;
  filename: string;
  contentType: string;
  /** The evidence to highlight, or null when nothing is selected. */
  highlight: EvidenceOut | null;
  className?: string | undefined;
}

/**
 * The document as it actually looks, with the reader's evidence drawn on it.
 *
 * This pane exists so that no value has to be taken on trust. Selecting a field
 * moves the page to where that value was found and outlines it, which turns
 * "confirm this total" from an act of faith into a glance.
 *
 * The highlight is drawn in a layer above the page, never into it, so the
 * document image on screen is exactly the bytes that were stored and hashed.
 */
export function DocumentViewer({
  documentId,
  filename,
  contentType,
  highlight,
  className,
}: DocumentViewerProps) {
  const link = useViewerUrl(documentId);
  const isPdf = PDF_TYPES.has(mediaType(contentType));
  const isImage = isImageDocument(contentType, filename);

  if (link.isLoading) {
    return (
      <div className={cn('p-[var(--space-5)]', className)}>
        <SkeletonBlock className="h-[32rem] w-full" />
      </div>
    );
  }

  if (link.isError || !link.data) {
    return (
      <ViewerNotice
        icon={FileWarning}
        title="This document cannot be opened right now"
        detail={
          link.error instanceof Error
            ? link.error.message
            : 'A link to the stored document could not be created.'
        }
        nextStep="The document itself is unharmed. Try again, and if it keeps failing the document store is likely unavailable."
        className={className}
      />
    );
  }

  if (isImage) {
    return <ImagePane url={link.data.url} filename={filename} className={className} />;
  }

  return isPdf ? (
    <PdfPane url={link.data.url} highlight={highlight} className={className} />
  ) : (
    <TextPane
      url={link.data.url}
      filename={filename}
      highlight={highlight}
      className={className}
    />
  );
}

// ------------------------------------------------------------------ PDF pane

function PdfPane({
  url,
  highlight,
  className,
}: {
  url: string;
  highlight: EvidenceOut | null;
  className?: string | undefined;
}) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [pageNumber, setPageNumber] = useState(1);
  const [zoomIndex, setZoomIndex] = useState(2);
  const [failure, setFailure] = useState<string | null>(null);
  const [isRendering, setIsRendering] = useState(true);
  /** The rendered size, so the highlight layer can be laid over it exactly. */
  const [rendered, setRendered] = useState({ width: 0, height: 0, scale: 1 });

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const highlightRef = useRef<HTMLDivElement | null>(null);
  const zoom = ZOOM_STEPS[zoomIndex] ?? 1;

  useEffect(() => {
    let cancelled = false;
    let loaded: { destroy: () => Promise<void> } | null = null;

    setFailure(null);
    void loadPdf(url)
      .then((result) => {
        loaded = result;
        if (cancelled) {
          void result.destroy();
          return;
        }
        setPdf(result.document);
        setPageCount(result.document.numPages);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setIsRendering(false);
        setFailure(
          error instanceof Error
            ? error.message
            : 'The document could not be opened for viewing.',
        );
      });

    return () => {
      cancelled = true;
      void loaded?.destroy();
    };
  }, [url]);

  // The page the reader found the value on. Following the selection rather than
  // asking the reviewer to navigate is the point of the pane.
  useEffect(() => {
    if (highlight && highlight.page_number >= 1) {
      setPageNumber(highlight.page_number);
    }
  }, [highlight]);

  useEffect(() => {
    if (!pdf) return;
    let cancelled = false;
    let task: { cancel: () => void } | null = null;

    setIsRendering(true);
    void (async () => {
      try {
        const page = await pdf.getPage(Math.min(Math.max(pageNumber, 1), pdf.numPages));
        // Rendering at the device's own pixel density and scaling back down with
        // CSS. A canvas rendered at CSS pixels looks soft, and a soft rendering
        // of a total is exactly where a reviewer misreads an 8 as a 3.
        const ratio = Math.min(window.devicePixelRatio || 1, 2);
        const viewport = page.getViewport({ scale: zoom * ratio });
        const canvas = canvasRef.current;
        if (cancelled || !canvas) return;

        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        const context = canvas.getContext('2d');
        if (!context) return;

        const render = page.render({
          canvas,
          canvasContext: context,
          viewport,
          annotationMode: RENDER_ANNOTATION_MODE,
        });
        task = render;
        await render.promise;
        if (cancelled) return;
        setRendered({
          width: viewport.width / ratio,
          height: viewport.height / ratio,
          scale: zoom,
        });
        setIsRendering(false);
      } catch (error) {
        if (cancelled) return;
        // A cancelled render is the normal consequence of turning the page
        // quickly and is not a failure to report.
        const message = error instanceof Error ? error.message : '';
        if (message.includes('Rendering cancelled')) return;
        setIsRendering(false);
        setFailure(message || 'This page could not be drawn.');
      }
    })();

    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [pdf, pageNumber, zoom]);

  // Scrolled after layout rather than in the render effect, so the box is in its
  // final position when the browser is asked to bring it into view.
  useLayoutEffect(() => {
    if (!highlight || isRendering) return;
    highlightRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [highlight, isRendering, rendered]);

  if (failure) {
    return (
      <ViewerNotice
        icon={FileWarning}
        title="This document could not be displayed"
        detail={failure}
        nextStep="The stored file is unchanged and can still be downloaded. Values can be entered by hand from it."
        className={className}
        action={
          <Button variant="secondary" size="sm" asChild>
            <a href={url} target="_blank" rel="noopener noreferrer">
              <ExternalLink aria-hidden="true" className="size-4" />
              Open in a new tab
            </a>
          </Button>
        }
      />
    );
  }

  const boxes = highlight?.boxes ?? [];
  const onHighlightedPage = highlight?.page_number === pageNumber;

  return (
    <div className={cn('flex min-h-0 flex-col', className)}>
      <div className="flex flex-wrap items-center justify-between gap-[var(--space-3)] border-b border-[var(--color-divider)] px-[var(--space-4)] py-[var(--space-3)]">
        <div className="flex items-center gap-[var(--space-2)]">
          <Button
            variant="secondary"
            size="sm"
            disabled={pageNumber <= 1}
            onClick={() => setPageNumber((current) => Math.max(1, current - 1))}
          >
            Previous page
          </Button>
          <p
            aria-live="polite"
            className="m-0 min-w-[7rem] text-center text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]"
          >
            Page {pageNumber} of {pageCount || 1}
          </p>
          <Button
            variant="secondary"
            size="sm"
            disabled={pageCount === 0 || pageNumber >= pageCount}
            onClick={() => setPageNumber((current) => Math.min(pageCount, current + 1))}
          >
            Next page
          </Button>
        </div>

        <div className="flex items-center gap-[var(--space-2)]">
          <Button
            variant="ghost"
            size="sm"
            aria-label="Zoom out"
            disabled={zoomIndex === 0}
            onClick={() => setZoomIndex((index) => Math.max(0, index - 1))}
          >
            <ZoomOut aria-hidden="true" className="size-4" />
          </Button>
          <span className="tabular min-w-[3.5rem] text-center text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]">
            {Math.round(zoom * 100)}%
          </span>
          <Button
            variant="ghost"
            size="sm"
            aria-label="Zoom in"
            disabled={zoomIndex >= ZOOM_STEPS.length - 1}
            onClick={() =>
              setZoomIndex((index) => Math.min(ZOOM_STEPS.length - 1, index + 1))
            }
          >
            <ZoomIn aria-hidden="true" className="size-4" />
          </Button>
        </div>
      </div>

      {highlight && !onHighlightedPage ? (
        <p className="m-0 border-b border-[var(--color-divider)] bg-[var(--color-warning-50)] px-[var(--space-4)] py-[var(--space-2)] text-[length:var(--text-body-sm)] text-[var(--color-warning-700)]">
          The selected value was found on page {highlight.page_number}.
        </p>
      ) : null}

      <div className="min-h-0 flex-1 overflow-auto bg-[var(--color-surface-subtle)] p-[var(--space-4)]">
        <div
          // The label sits on the wrapper rather than on the canvas, so the page
          // is announced as one image. The drawing itself conveys nothing a
          // screen reader can use, and the values panel beside it carries in text
          // every value that was read from it.
          role="img"
          aria-label={`Page ${pageNumber} of the document`}
          className="relative mx-auto w-fit shadow-[var(--shadow-raised)]"
          style={
            rendered.width
              ? { width: `${rendered.width}px`, height: `${rendered.height}px` }
              : undefined
          }
        >
          <canvas ref={canvasRef} aria-hidden="true" className="block h-full w-full bg-white" />

          {onHighlightedPage
            ? boxes.map((box, index) => (
                <div
                  key={`${box.x}-${box.y}-${index}`}
                  ref={index === 0 ? highlightRef : undefined}
                  aria-hidden="true"
                  // The overlay carries no text and is hidden from assistive
                  // technology, so a test has nothing else to assert on. Whether
                  // evidence is actually drawn is worth a test: without it a
                  // reviewer is confirming values they cannot trace.
                  data-testid="evidence-highlight"
                  className={cn(
                    'motion-status pointer-events-none absolute rounded-[2px]',
                    'bg-[color-mix(in_srgb,var(--color-warning-600)_22%,transparent)]',
                    'outline-2 outline-offset-1 outline-[var(--color-warning-600)]',
                  )}
                  style={{
                    // The reader reports points from the top-left of the page
                    // with rotation already applied, which is the same space the
                    // renderer's viewport uses, so this is a plain multiply.
                    left: `${box.x * rendered.scale}px`,
                    top: `${box.y * rendered.scale}px`,
                    width: `${box.width * rendered.scale}px`,
                    height: `${box.height * rendered.scale}px`,
                  }}
                />
              ))
            : null}

          {isRendering ? (
            <div
              role="status"
              className="absolute inset-0 flex items-center justify-center bg-[color-mix(in_srgb,white_70%,transparent)] text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]"
            >
              Drawing page {pageNumber}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- image pane

function ImagePane({
  url,
  filename,
  className,
}: {
  url: string;
  filename: string;
  className?: string | undefined;
}) {
  const [failure, setFailure] = useState(false);

  if (failure) {
    return (
      <ViewerNotice
        icon={FileWarning}
        title="This image could not be displayed"
        detail="The stored file did not load as a picture."
        nextStep="The stored file is unchanged and can still be downloaded."
        className={className}
      />
    );
  }

  return (
    <div
      className={cn(
        'flex min-h-0 flex-1 items-center justify-center overflow-auto bg-[var(--color-surface-subtle)] p-[var(--space-5)]',
        className,
      )}
    >
      <img
        src={url}
        alt={filename}
        className="max-h-full max-w-full object-contain"
        onError={() => setFailure(true)}
      />
    </div>
  );
}

// ----------------------------------------------------------------- text pane

/**
 * A plain-text document.
 *
 * Rendered as text, never as markup. Document content is attacker-controlled and
 * is displayed, never interpreted. The evidence snippet is emphasised inline
 * because a text file has no geometry to draw a box on.
 */
function TextPane({
  url,
  filename,
  highlight,
  className,
}: {
  url: string;
  filename: string;
  highlight: EvidenceOut | null;
  className?: string | undefined;
}) {
  const [text, setText] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const markRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    setFailure(null);
    void fetch(url)
      .then((response) => {
        if (!response.ok) throw new Error(`The document store answered ${response.status}.`);
        return response.text();
      })
      .then((body) => {
        if (!cancelled) setText(body);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setFailure(
          error instanceof Error ? error.message : 'The document could not be read.',
        );
      });
    return () => {
      cancelled = true;
    };
  }, [url]);

  useEffect(() => {
    if (highlight) markRef.current?.scrollIntoView({ block: 'center' });
  }, [highlight, text]);

  if (failure) {
    return (
      <ViewerNotice
        icon={FileWarning}
        title="This document could not be displayed"
        detail={failure}
        nextStep="The stored file is unchanged and can still be downloaded."
        className={className}
      />
    );
  }

  if (text === null) {
    return (
      <div className={cn('p-[var(--space-5)]', className)}>
        <SkeletonBlock className="h-[32rem] w-full" />
      </div>
    );
  }

  const snippet = highlight?.snippet?.trim() ?? '';
  const at = snippet ? text.indexOf(snippet) : -1;

  return (
    <div className={cn('min-h-0 overflow-auto p-[var(--space-5)]', className)}>
      <p className="mt-0 mb-[var(--space-3)] text-[length:var(--text-caption)] text-[var(--color-text-subtle)]">
        {filename} shown as plain text.
      </p>
      <pre className="m-0 whitespace-pre-wrap break-words font-[var(--font-mono)] text-[length:var(--text-body-sm)] text-[var(--color-text)]">
        {at < 0 ? (
          text
        ) : (
          <>
            {text.slice(0, at)}
            <mark
              ref={markRef}
              className="rounded-[2px] bg-[color-mix(in_srgb,var(--color-warning-600)_28%,white)] px-0.5 text-[var(--color-text-strong)]"
            >
              {snippet}
            </mark>
            {text.slice(at + snippet.length)}
          </>
        )}
      </pre>
    </div>
  );
}

// -------------------------------------------------------------------- notices

function ViewerNotice({
  icon: Icon,
  title,
  detail,
  nextStep,
  action,
  className,
}: {
  icon: LucideIcon;
  title: string;
  detail: string;
  nextStep: string;
  action?: React.ReactNode;
  className?: string | undefined;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center gap-[var(--space-3)] p-[var(--space-8)] text-center',
        className,
      )}
    >
      <Icon aria-hidden="true" className="size-6 text-[var(--color-warning-600)]" />
      <p className="m-0 font-semibold text-[var(--color-text-strong)]">{title}</p>
      <p className="m-0 max-w-[36rem] text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]">
        {detail}
      </p>
      <p className="m-0 max-w-[36rem] text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]">
        {nextStep}
      </p>
      {action}
    </div>
  );
}

/** Exposed for the review page's own layout decisions. */
export function isViewablePdf(contentType: string): boolean {
  return PDF_TYPES.has(mediaType(contentType));
}
