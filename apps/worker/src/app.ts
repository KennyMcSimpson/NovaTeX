import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { CompileQueue } from '@novatex/compiler';
import {
  PathSecurityError,
  normalizeProjectRelPath,
  type CompileEngine,
} from '@novatex/shared';
import {
  HmacReplayCache,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  validateHmacHeadersPreBody,
  verifyHmacSignature,
} from './auth.js';
import { ArchiveSecurityError, extractArchiveSafely } from './archive.js';

export interface WorkerAppOptions {
  sharedSecret?: string;
  compileTimeoutMs?: number;
  maxConcurrency?: number;
  texBinDir?: string;
  qpdfBin?: string;
  tmpDir?: string;
  includeSystemPath?: boolean;
  includeLocalTools?: boolean;
  allowLuaLatex?: boolean;
  maxUncompressedBytes?: number;
  maxFiles?: number;
  /** Optional custom queue instance (useful for testing) */
  queue?: CompileQueue;
}

interface RequestWithRawBody extends Request {
  rawBody?: Buffer;
}

interface CompileRequestBody {
  projectId?: unknown;
  mainFile?: unknown;
  engine?: unknown;
  archiveBase64?: unknown;
}

const VALID_ENGINES = new Set<CompileEngine>(['xelatex', 'pdflatex', 'lualatex']);

function readHeaderString(req: Request, name: string): string | undefined {
  const val = req.headers[name.toLowerCase()];
  if (typeof val === 'string') return val;
  if (Array.isArray(val) && val.length > 0) return val[0];
  return undefined;
}

/**
 * Create the standalone NovaTeX compilation worker Express application.
 */
export function createWorkerApp(opts: WorkerAppOptions = {}): Express {
  const app = express();
  app.disable('x-powered-by');

  const sharedSecret = opts.sharedSecret?.trim() || '';
  const tmpRoot = opts.tmpDir ? path.resolve(opts.tmpDir) : os.tmpdir();
  const replayCache = new HmacReplayCache();
  const queue =
    opts.queue ??
    new CompileQueue({
      maxConcurrency: opts.maxConcurrency ?? 1,
      timeoutMs: opts.compileTimeoutMs ?? 60_000,
      texBinDir: opts.texBinDir,
      qpdfBin: opts.qpdfBin,
      includeSystemPath: opts.includeSystemPath,
      includeLocalTools: opts.includeLocalTools,
      allowLuaLatex: opts.allowLuaLatex,
    });

  // Health & toolchain discovery endpoint (no JSON body parsing needed)
  app.get('/health', async (_req: Request, res: Response) => {
    try {
      const toolchain = await queue.detectToolchain();
      const queueStats = queue.getQueueStats();
      res.status(200).json({
        ok: true,
        service: 'novatex-worker',
        authRequired: sharedSecret.length > 0,
        toolchain: {
          available: toolchain.available,
          engines: toolchain.engines,
          hasLatexmk: toolchain.hasLatexmk,
          hasBibtex: toolchain.hasBibtex,
          hasBiber: toolchain.hasBiber,
          hasQpdf: toolchain.hasQpdf,
          texBinDir: toolchain.texBinDir,
        },
        queue: queueStats,
      });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: 'HEALTH_CHECK_FAILED',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // Pre-body auth header validator: runs BEFORE express.json({ limit: '55mb' })
  // so unauthenticated / malformed / expired / replayed requests are rejected before buffering 55MB.
  const preBodyHmacHeaderGuard = (req: Request, res: Response, next: NextFunction): void => {
    if (!sharedSecret) {
      next();
      return;
    }

    const headerCheck = validateHmacHeadersPreBody({
      timestampHeader: readHeaderString(req, TIMESTAMP_HEADER),
      signatureHeader: readHeaderString(req, SIGNATURE_HEADER),
      replayCache,
    });

    if (!headerCheck.ok) {
      res.status(401).json({
        error: 'UNAUTHORIZED',
        message: headerCheck.reason ?? 'HMAC header validation failed',
      });
      return;
    }

    next();
  };

  // Capture exact raw request body buffer without cloning up to 55MB twice
  const compileJsonParser = express.json({
    limit: '55mb',
    verify: (req, _res, buf) => {
      (req as RequestWithRawBody).rawBody = buf;
    },
  });

  // Full HMAC-SHA256 verification + replay cache recording after rawBody is captured
  const hmacAuthMiddleware = (req: Request, res: Response, next: NextFunction): void => {
    if (!sharedSecret) {
      next();
      return;
    }

    const rawBody = (req as RequestWithRawBody).rawBody ?? Buffer.alloc(0);
    const verification = verifyHmacSignature({
      secret: sharedSecret,
      timestampHeader: readHeaderString(req, TIMESTAMP_HEADER),
      signatureHeader: readHeaderString(req, SIGNATURE_HEADER),
      rawBody,
      replayCache,
    });

    if (!verification.ok) {
      res.status(401).json({
        error: 'UNAUTHORIZED',
        message: verification.reason ?? 'HMAC authentication failed',
      });
      return;
    }

    next();
  };

  // Remote compile endpoint: pre-body header guard -> JSON parser -> full HMAC + replay check -> compile
  app.post(
    '/compile',
    preBodyHmacHeaderGuard,
    compileJsonParser,
    hmacAuthMiddleware,
    async (req: Request, res: Response) => {
      const body = (req.body ?? {}) as CompileRequestBody;

      if (typeof body.projectId !== 'string' || !body.projectId.trim()) {
        res.status(400).json({ error: 'INVALID_REQUEST', message: 'projectId 不能为空' });
        return;
      }
      if (typeof body.mainFile !== 'string' || !body.mainFile.trim()) {
        res.status(400).json({ error: 'INVALID_REQUEST', message: 'mainFile 不能为空' });
        return;
      }
      if (typeof body.archiveBase64 !== 'string' || !body.archiveBase64.trim()) {
        res.status(400).json({ error: 'INVALID_REQUEST', message: 'archiveBase64 不能为空' });
        return;
      }

      let engine: CompileEngine | undefined;
      if (body.engine !== undefined && body.engine !== null && body.engine !== '') {
        if (typeof body.engine !== 'string' || !VALID_ENGINES.has(body.engine as CompileEngine)) {
          res.status(400).json({
            error: 'INVALID_ENGINE',
            message: `不支持的编译引擎: ${String(body.engine)}`,
          });
          return;
        }
        engine = body.engine as CompileEngine;
      }

      let safeMainFile: string;
      try {
        safeMainFile = normalizeProjectRelPath(body.mainFile);
      } catch (err) {
        const code = err instanceof PathSecurityError ? err.code : 'INVALID_MAIN_FILE';
        res.status(400).json({
          error: code,
          message: err instanceof Error ? err.message : String(err),
        });
        return;
      }

      fs.mkdirSync(tmpRoot, { recursive: true });
      const jobRoot = fs.mkdtempSync(path.join(tmpRoot, 'novatex-worker-job-'));
      const workspaceDir = path.join(jobRoot, 'src');
      const buildDir = path.join(jobRoot, 'build');

      try {
        extractArchiveSafely(body.archiveBase64, workspaceDir, {
          maxUncompressedBytes: opts.maxUncompressedBytes,
          maxFiles: opts.maxFiles,
        });

        const result = await queue.compileProject({
          projectId: body.projectId.trim(),
          workspaceDir,
          buildDir,
          mainFile: safeMainFile,
          engine,
        });

        const stem = path.basename(safeMainFile, path.extname(safeMainFile));
        let pdfBase64: string | undefined;
        let synctexBase64: string | undefined;

        if (result.pdfReady) {
          const pdfPath = path.join(buildDir, `${stem}.pdf`);
          if (fs.existsSync(pdfPath)) {
            pdfBase64 = fs.readFileSync(pdfPath).toString('base64');
          }
        }

        if (result.synctexReady) {
          const gzPath = path.join(buildDir, `${stem}.synctex.gz`);
          const rawPath = path.join(buildDir, `${stem}.synctex`);
          if (fs.existsSync(gzPath)) {
            synctexBase64 = fs.readFileSync(gzPath).toString('base64');
          } else if (fs.existsSync(rawPath)) {
            synctexBase64 = fs.readFileSync(rawPath).toString('base64');
          }
        }

        res.status(200).json({
          result,
          ...(pdfBase64 !== undefined ? { pdfBase64 } : {}),
          ...(synctexBase64 !== undefined ? { synctexBase64 } : {}),
        });
      } catch (err) {
        if (err instanceof ArchiveSecurityError || err instanceof PathSecurityError) {
          res.status(400).json({
            error: err.code,
            message: err.message,
          });
          return;
        }
        res.status(500).json({
          error: 'WORKER_INTERNAL_ERROR',
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        try {
          fs.rmSync(jobRoot, { recursive: true, force: true });
        } catch {
          // best-effort cleanup
        }
      }
    },
  );

  // Handle JSON syntax errors / body size errors cleanly
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (!err) {
      next();
      return;
    }
    const status =
      typeof err === 'object' &&
      err !== null &&
      'status' in err &&
      typeof (err as { status?: unknown }).status === 'number'
        ? (err as { status: number }).status
        : 400;
    const message = err instanceof Error ? err.message : 'Malformed request payload';
    res.status(status).json({
      error: status === 413 ? 'PAYLOAD_TOO_LARGE' : 'BAD_REQUEST',
      message,
    });
  });

  return app;
}
