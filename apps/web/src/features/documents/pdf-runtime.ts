/**
 * The PDF renderer, configured once for untrusted input.
 *
 * Every document reaching this viewer arrived from outside the organisation, and
 * a PDF is a program rather than a picture. The settings below are the whole
 * reason this module exists instead of the viewer calling `getDocument` itself.
 *
 * Annotations are disabled at render time, so nothing in the file becomes a link
 * or a form control the reviewer can activate. Embedded JavaScript is never
 * enabled, because the sandbox build that would run it is never loaded. XFA is
 * off, so a form definition inside the file cannot drive the renderer. Parsing
 * happens in a worker, off the main thread, so a file crafted to hang the parser
 * costs the reviewer a page that never loads rather than a browser tab that
 * stops responding. This version of the renderer compiles nothing at runtime, so
 * the application can be served under a policy that forbids `unsafe-eval`.
 *
 * The font and character-map assets are served from this application's own
 * origin, so rendering a document makes no request to any third party. A
 * document viewer that phoned out per page would leak which invoices are being
 * looked at, and when.
 */

import { AnnotationMode, GlobalWorkerOptions, getDocument } from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';

// Vite rewrites this to a hashed asset URL and does not bundle the worker into
// the main chunk, which is what keeps parsing off the main thread.
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

GlobalWorkerOptions.workerSrc = workerUrl;

/** Where `vite.config.ts` publishes the renderer's own support files. */
const ASSET_BASE = '/pdfjs/';

/** Annotations are never drawn, so a crafted link cannot be presented to a reviewer. */
export const RENDER_ANNOTATION_MODE = AnnotationMode.DISABLE;

export interface LoadedDocument {
  document: PDFDocumentProxy;
  /** Cancels the load, for a viewer unmounted before it finished. */
  destroy: () => Promise<void>;
}

/**
 * Open a document for rendering.
 *
 * `withCredentials` is deliberately false. The URL is signed and carries its own
 * authority, and sending the session cookie to the object store would put it
 * somewhere it has no business being.
 */
export async function loadPdf(url: string): Promise<LoadedDocument> {
  const task = getDocument({
    url,
    withCredentials: false,
    enableXfa: false,
    cMapUrl: `${ASSET_BASE}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${ASSET_BASE}standard_fonts/`,
    wasmUrl: `${ASSET_BASE}wasm/`,
    iccUrl: `${ASSET_BASE}iccs/`,
  });

  const document = await task.promise;
  return { document, destroy: () => task.destroy() };
}
