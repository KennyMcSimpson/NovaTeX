import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorkerApp } from './app.js';

export { createWorkerApp, type WorkerAppOptions } from './app.js';
export {
  HmacReplayCache,
  computeHmacSignature,
  validateHmacHeadersPreBody,
  verifyHmacSignature,
  DEFAULT_REPLAY_WINDOW_MS,
  DEFAULT_REPLAY_CACHE_MAX_ENTRIES,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  type ValidateHmacHeadersOptions,
  type ValidateHmacHeadersResult,
  type VerifyHmacOptions,
  type VerifyHmacResult,
} from './auth.js';
export {
  ArchiveSecurityError,
  extractArchiveSafely,
  DEFAULT_MAX_ARCHIVE_FILES,
  DEFAULT_MAX_UNCOMPRESSED_BYTES,
  type ExtractArchiveLimits,
  type ExtractArchiveResult,
} from './archive.js';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

/**
 * Fail-closed startup guard: refuse exposing an unauthenticated compile worker
 * on a non-loopback network interface (e.g. 0.0.0.0).
 */
export function assertSafeWorkerBind(host: string, sharedSecret: string): void {
  const normalizedHost = host.trim().toLowerCase();
  if (!LOOPBACK_HOSTS.has(normalizedHost) && !sharedSecret.trim()) {
    throw new Error(
      `Refusing to bind unauthenticated NovaTeX worker on non-loopback host "${host}". ` +
        'Configure COMPILER_SHARED_SECRET or bind to 127.0.0.1 / ::1 / localhost.',
    );
  }
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isExecutedDirectly(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return path.resolve(fileURLToPath(import.meta.url)) === path.resolve(argv1);
  } catch {
    return false;
  }
}

if (isExecutedDirectly()) {
  const port = parsePositiveInt(process.env.WORKER_PORT, 3457);
  const host = process.env.WORKER_HOST?.trim() || '127.0.0.1';
  const sharedSecret = process.env.COMPILER_SHARED_SECRET?.trim() || '';
  const compileTimeoutMs = parsePositiveInt(process.env.COMPILE_TIMEOUT_MS, 60_000);
  const maxConcurrency = parsePositiveInt(process.env.COMPILE_MAX_CONCURRENCY, 1);
  const texBinDir = process.env.TEX_BIN_DIR?.trim() || undefined;
  const qpdfBin = process.env.QPDF_BIN?.trim() || undefined;
  const tmpDir = process.env.WORKER_TMP_DIR?.trim() || undefined;
  const allowLuaLatex = process.env.ALLOW_LUALATEX === 'true';

  try {
    assertSafeWorkerBind(host, sharedSecret);
  } catch (err) {
    console.error(`[novatex-worker] FATAL: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const app = createWorkerApp({
    sharedSecret,
    compileTimeoutMs,
    maxConcurrency,
    texBinDir,
    qpdfBin,
    tmpDir,
    allowLuaLatex,
  });

  const server = app.listen(port, host, () => {
    console.log(
      `[novatex-worker] listening on http://${host}:${port} (hmac=${sharedSecret ? 'enabled' : 'disabled'}, concurrency=${maxConcurrency}, timeoutMs=${compileTimeoutMs}, lualatex=${allowLuaLatex ? 'enabled' : 'disabled'})`,
    );
  });

  const shutdown = (signal: string) => {
    console.log(`[novatex-worker] received ${signal}, shutting down...`);
    server.close(() => {
      process.exit(0);
    });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
