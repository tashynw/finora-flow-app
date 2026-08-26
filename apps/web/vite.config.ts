import { defineConfig, type Plugin } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { createReadStream } from 'node:fs';
import { cp, mkdir, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';

// Keeps the browser same-origin against the API so the session cookie behaves
// exactly as it will in production behind one hostname.
const API_PROXY = {
  '/api': {
    // 127.0.0.1 rather than localhost: on Windows `localhost` resolves to ::1
    // first, but the API binds IPv4 only, so the proxy would refuse to connect.
    target: 'http://127.0.0.1:8000',
    changeOrigin: true,
  },
};

/** The renderer's support files, published under `/pdfjs/` on our own origin. */
const PDFJS_ASSET_DIRS = ['cmaps', 'standard_fonts', 'wasm', 'iccs'] as const;

const ASSET_CONTENT_TYPES: Record<string, string> = {
  '.wasm': 'application/wasm',
  '.bcmap': 'application/octet-stream',
  '.icc': 'application/octet-stream',
  '.pfb': 'application/x-font-type1',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
};

/**
 * A read-only file handler for one directory.
 *
 * Hand-rolled rather than pulled from a static-file package, because the whole
 * requirement is four fixed directories of read-only assets and a dependency for
 * that would be a dependency to keep patched. Paths are resolved and then
 * checked to still be inside the root, so a request with `..` in it cannot walk
 * out of the directory it was given.
 */
interface AssetRequest {
  url?: string | undefined;
}

interface AssetResponse {
  setHeader: (name: string, value: string) => void;
  statusCode: number;
  end: (body?: string) => void;
}

function serveDirectory(root: string) {
  const handle = async (
    request: AssetRequest,
    response: AssetResponse,
    next: () => void,
  ): Promise<void> => {
    const requested = decodeURIComponent((request.url ?? '/').split('?')[0] ?? '/');
    const target = path.join(root, requested);
    if (!target.startsWith(root)) {
      response.statusCode = 403;
      response.end('Forbidden');
      return;
    }

    try {
      const info = await stat(target);
      if (!info.isFile()) {
        next();
        return;
      }
      const type = ASSET_CONTENT_TYPES[path.extname(target).toLowerCase()];
      if (type) response.setHeader('content-type', type);
      response.setHeader('cache-control', 'public, max-age=3600');
      createReadStream(target).pipe(response as unknown as NodeJS.WritableStream);
    } catch {
      next();
    }
  };

  return (request: AssetRequest, response: AssetResponse, next: () => void): void => {
    void handle(request, response, next);
  };
}

/**
 * Serves the PDF renderer's character maps, standard fonts and wasm modules from
 * this application rather than from a public CDN.
 *
 * Written as a plugin instead of committing the files to `public/`, because they
 * belong to a version of the renderer that a dependency update changes, and a
 * stale copy of them renders glyphs wrongly with no error anywhere. Resolving
 * them out of the installed package means they cannot drift from it.
 *
 * The alternative, pointing the renderer at a CDN, would tell a third party
 * which documents this organisation is reading and when.
 */
function pdfjsAssets(): Plugin {
  const require = createRequire(import.meta.url);
  const packageRoot = path.dirname(require.resolve('pdfjs-dist/package.json'));

  return {
    name: 'finora:pdfjs-assets',
    configureServer(server) {
      for (const dir of PDFJS_ASSET_DIRS) {
        server.middlewares.use(`/pdfjs/${dir}`, serveDirectory(path.join(packageRoot, dir)));
      }
    },
    configurePreviewServer(server) {
      // The preview server serves the built bundle, where `writeBundle` has
      // already copied these directories, so this only matters when previewing
      // a build produced elsewhere.
      for (const dir of PDFJS_ASSET_DIRS) {
        server.middlewares.use(`/pdfjs/${dir}`, serveDirectory(path.join(packageRoot, dir)));
      }
    },
    async writeBundle(options) {
      const outDir = options.dir ?? 'dist';
      for (const dir of PDFJS_ASSET_DIRS) {
        const target = path.join(outDir, 'pdfjs', dir);
        await mkdir(target, { recursive: true });
        await cp(path.join(packageRoot, dir), target, { recursive: true });
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), pdfjsAssets()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: API_PROXY,
  },
  // The preview server serves the built bundle and is what the visual tests run
  // against, so it needs the same single-origin arrangement as development or the
  // session cookie behaves differently there than anywhere else.
  preview: {
    port: 4173,
    proxy: API_PROXY,
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    globals: true,
    css: true,
    // Scoped explicitly, because `tests/visual` holds Playwright specs that
    // would otherwise be collected here and fail on a missing browser rather
    // than on anything real.
    include: ['tests/unit/**/*.test.{ts,tsx}'],
  },
});
