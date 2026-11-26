import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Request, Response } from 'express';
import {
  CompileQueue,
  loadSyncTeXFile,
  syncTeXForward,
  syncTeXInverse,
  type SyncTeXIndex,
} from '@novatex/compiler';
import type {
  CompileEngine,
  CompileResult,
  SyncTeXForwardResult,
  SyncTeXInverseResult,
  SystemCapabilities,
} from '@novatex/shared';
import { exportProjectZip } from './workspace.js';

const SIGNATURE_HEADER = 'x-novatex-signature';
const TIMESTAMP_HEADER = 'x-novatex-timestamp';

export interface CompileCoordinatorOptions {
  mode: 'local' | 'remote';
  compilerUrl: string;
  sharedSecret: string;
  timeoutMs: number;
  maxConcurrency: number;
  texBinDir?: string;
  qpdfBin?: string;
  allowLuaLatex?: boolean;
}

interface CachedSyncTeX {
  cacheKey: string;
  index: SyncTeXIndex;
}

function computeWorkerHmac(secret: string, timestamp: string, rawBody: Buffer): string {
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(`${timestamp}.`, 'utf8');
  hmac.update(rawBody);
  return hmac.digest('hex');
}

function getMainStem(mainFile: string): string {
  const base = path.posix.basename(mainFile.replace(/\\/g, '/'));
  const ext = path.posix.extname(base);
  return ext ? base.slice(0, -ext.length) : base;
}

/**
 * Coordinates LaTeX compilation (local embedded `CompileQueue` OR HMAC-signed remote worker),
 * SyncTeX forward/inverse queries, and RFC 7233 HTTP Range PDF streaming.
 */
export class CompileCoordinator {
  private readonly mode: 'local' | 'remote';
  private readonly compilerUrl: string;
  private readonly sharedSecret: string;
  private readonly timeoutMs: number;
  private readonly localQueue: CompileQueue;
  private readonly synctexCache = new Map<string, CachedSyncTeX>();

  constructor(opts: CompileCoordinatorOptions) {
    this.mode = opts.mode;
    this.compilerUrl = opts.compilerUrl.replace(/\/+$/, '');
    this.sharedSecret = opts.sharedSecret.trim();
    this.timeoutMs = opts.timeoutMs;
    this.localQueue = new CompileQueue({
      maxConcurrency: opts.maxConcurrency,
      timeoutMs: opts.timeoutMs,
      texBinDir: opts.texBinDir,
      qpdfBin: opts.qpdfBin,
      allowLuaLatex: opts.allowLuaLatex,
    });
  }

  async getCapabilities(): Promise<SystemCapabilities['compiler']> {
    if (this.mode === 'remote') {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 3500);
        try {
          const res = await fetch(`${this.compilerUrl}/health`, { signal: controller.signal });
          if (res.ok) {
            const data = (await res.json()) as {
              toolchain?: {
                available?: boolean;
                engines?: CompileEngine[];
                hasLatexmk?: boolean;
                hasBibtex?: boolean;
                hasBiber?: boolean;
                hasQpdf?: boolean;
                texBinDir?: string | null;
              };
            };
            const tc = data.toolchain;
            if (tc) {
              return {
                mode: 'remote',
                available: Boolean(tc.available),
                engines: Array.isArray(tc.engines) ? tc.engines : [],
                hasLatexmk: Boolean(tc.hasLatexmk),
                hasBibtex: Boolean(tc.hasBibtex),
                hasBiber: Boolean(tc.hasBiber),
                hasQpdf: Boolean(tc.hasQpdf),
                texBinDir: tc.texBinDir ?? null,
              };
            }
          }
        } finally {
          clearTimeout(timer);
        }
      } catch {
        // Remote worker unreachable
      }
      return {
        mode: 'remote',
        available: false,
        engines: [],
        hasLatexmk: false,
        hasBibtex: false,
        hasBiber: false,
        hasQpdf: false,
        texBinDir: null,
      };
    }

    const tc = await this.localQueue.detectToolchain();
    return {
      mode: 'local',
      available: tc.available,
      engines: tc.engines,
      hasLatexmk: tc.hasLatexmk,
      hasBibtex: tc.hasBibtex,
      hasBiber: tc.hasBiber,
      hasQpdf: tc.hasQpdf,
      texBinDir: tc.texBinDir,
    };
  }

  async compile(params: {
    projectId: string;
    workspaceDir: string;
    buildDir: string;
    mainFile: string;
    engine?: CompileEngine;
  }): Promise<CompileResult> {
    fs.mkdirSync(params.buildDir, { recursive: true });

    if (this.mode === 'remote') {
      return this.compileRemote(params);
    }

    const result = await this.localQueue.compileProject({
      projectId: params.projectId,
      workspaceDir: params.workspaceDir,
      buildDir: params.buildDir,
      mainFile: params.mainFile,
      engine: params.engine,
      timeoutMs: this.timeoutMs,
    });
    this.synctexCache.delete(params.buildDir);
    return result;
  }

  private async compileRemote(params: {
    projectId: string;
    workspaceDir: string;
    buildDir: string;
    mainFile: string;
    engine?: CompileEngine;
  }): Promise<CompileResult> {
    const startedAt = Date.now();
    const archiveBuf = exportProjectZip(params.workspaceDir);
    const payloadObj = {
      projectId: params.projectId,
      mainFile: params.mainFile,
      ...(params.engine ? { engine: params.engine } : {}),
      archiveBase64: archiveBuf.toString('base64'),
    };
    const rawBody = Buffer.from(JSON.stringify(payloadObj), 'utf8');
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.sharedSecret) {
      const timestamp = String(Date.now());
      headers[TIMESTAMP_HEADER] = timestamp;
      headers[SIGNATURE_HEADER] = computeWorkerHmac(this.sharedSecret, timestamp, rawBody);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(10_000, this.timeoutMs + 15_000));

    try {
      const response = await fetch(`${this.compilerUrl}/compile`, {
        method: 'POST',
        headers,
        body: rawBody,
        signal: controller.signal,
      });

      const responseText = await response.text();
      if (!response.ok) {
        let msg = responseText.slice(0, 300);
        try {
          const parsed = JSON.parse(responseText) as { message?: string; error?: string };
          msg = parsed.message || parsed.error || msg;
        } catch {
          // non-JSON
        }
        return {
          jobId: crypto.randomUUID(),
          projectId: params.projectId,
          ok: false,
          engine: params.engine ?? 'xelatex',
          mainFile: params.mainFile,
          durationMs: Math.max(0, Date.now() - startedAt),
          exitCode: -1,
          pdfReady: false,
          pdfSize: 0,
          synctexReady: false,
          linearized: false,
          diagnostics: [
            {
              id: 'diag-1',
              file: params.mainFile,
              line: 0,
              severity: 'error',
              code: 'REMOTE_WORKER_ERROR',
              titleZh: `远端编译节点返回错误 (HTTP ${response.status})`,
              explanationZh: msg,
              quickFixHintZh: '请检查远端 Worker 状态及 COMPILER_SHARED_SECRET 配置。',
              rawMessage: msg,
            },
          ],
          errorCount: 1,
          warningCount: 0,
          rawLog: msg,
          compilerAvailable: false,
          compilerNote: `远端编译节点请求失败 (HTTP ${response.status}): ${msg}`,
          finishedAt: new Date().toISOString(),
        };
      }

      const data = JSON.parse(responseText) as {
        result: CompileResult;
        pdfBase64?: string;
        synctexBase64?: string;
      };
      const stem = getMainStem(params.mainFile);
      const writeBufferAtomic = (targetPath: string, buf: Buffer): void => {
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        const tmpPath = `${targetPath}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
        try {
          fs.writeFileSync(tmpPath, buf);
          fs.renameSync(tmpPath, targetPath);
        } catch (writeErr) {
          try {
            if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
          } catch {
            // ignore cleanup failure
          }
          throw writeErr;
        }
      };

      if (data.pdfBase64) {
        const pdfBuf = Buffer.from(data.pdfBase64, 'base64');
        writeBufferAtomic(path.join(params.buildDir, `${stem}.pdf`), pdfBuf);
      }
      if (data.synctexBase64) {
        const stBuf = Buffer.from(data.synctexBase64, 'base64');
        const isGzip = stBuf.length >= 2 && stBuf[0] === 0x1f && stBuf[1] === 0x8b;
        const target = path.join(
          params.buildDir,
          isGzip ? `${stem}.synctex.gz` : `${stem}.synctex`,
        );
        writeBufferAtomic(target, stBuf);
      }

      this.synctexCache.delete(params.buildDir);
      return { ...data.result, projectId: params.projectId };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        jobId: crypto.randomUUID(),
        projectId: params.projectId,
        ok: false,
        engine: params.engine ?? 'xelatex',
        mainFile: params.mainFile,
        durationMs: Math.max(0, Date.now() - startedAt),
        exitCode: -1,
        pdfReady: false,
        pdfSize: 0,
        synctexReady: false,
        linearized: false,
        diagnostics: [
          {
            id: 'diag-1',
            file: params.mainFile,
            line: 0,
            severity: 'error',
            code: 'REMOTE_WORKER_UNREACHABLE',
            titleZh: '无法连接远端编译节点',
            explanationZh: `连接 ${this.compilerUrl} 失败：${msg}`,
            quickFixHintZh: '请确认编译 Worker 服务正在运行且网络可达。',
            rawMessage: msg,
          },
        ],
        errorCount: 1,
        warningCount: 0,
        rawLog: msg,
        compilerAvailable: false,
        compilerNote: `无法连接远端编译节点: ${msg}`,
        finishedAt: new Date().toISOString(),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  findPdfPath(buildDir: string, mainFile: string): string | null {
    const stem = getMainStem(mainFile);
    const candidate = path.join(buildDir, `${stem}.pdf`);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
    return null;
  }

  findSyncTeXPath(buildDir: string, mainFile: string): string | null {
    const stem = getMainStem(mainFile);
    const gz = path.join(buildDir, `${stem}.synctex.gz`);
    if (fs.existsSync(gz) && fs.statSync(gz).isFile()) return gz;
    const raw = path.join(buildDir, `${stem}.synctex`);
    if (fs.existsSync(raw) && fs.statSync(raw).isFile()) return raw;
    return null;
  }

  private getSyncTeXIndex(buildDir: string, mainFile: string): SyncTeXIndex | null {
    const filePath = this.findSyncTeXPath(buildDir, mainFile);
    if (!filePath) return null;

    const stat = fs.statSync(filePath);
    const cacheKey = `${filePath}:${stat.mtimeMs}:${stat.size}`;
    const cached = this.synctexCache.get(buildDir);
    if (cached && cached.cacheKey === cacheKey) {
      return cached.index;
    }

    const index = loadSyncTeXFile(filePath);
    if (!index) return null;
    this.synctexCache.set(buildDir, { cacheKey, index });
    return index;
  }

  synctexForward(
    buildDir: string,
    mainFile: string,
    file: string,
    line: number,
  ): SyncTeXForwardResult {
    const index = this.getSyncTeXIndex(buildDir, mainFile);
    if (!index) {
      return { found: false, file, line, boxes: [] };
    }
    return syncTeXForward(index, file, line);
  }

  synctexInverse(
    buildDir: string,
    mainFile: string,
    page: number,
    x: number,
    y: number,
  ): SyncTeXInverseResult {
    const index = this.getSyncTeXIndex(buildDir, mainFile);
    if (!index) {
      return { found: false, file: '', line: 0, column: 0 };
    }
    return syncTeXInverse(index, page, x, y);
  }
}

/**
 * RFC 7233 HTTP Range streaming for PDF files (supports PDF.js chunked progressive loading).
 * - Full request -> 200 OK
 * - Valid single `Range: bytes=start-end` -> 206 Partial Content + Content-Range
 * - Invalid / unsatisfiable range -> 416 Range Not Satisfiable + `Content-Range: bytes * / total`
 */
export function streamPdfWithRanges(req: Request, res: Response, pdfPath: string): void {
  if (!fs.existsSync(pdfPath)) {
    res.status(404).json({ error: '尚未生成 PDF 文件，请先编译项目' });
    return;
  }

  const stat = fs.statSync(pdfPath);
  const totalSize = stat.size;
  const fileName = path.basename(pdfPath).replace(/[\r\n]/g, '_');
  const asciiName =
    fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\;]/g, '_') || 'document.pdf';
  const encodedName = encodeURIComponent(fileName);

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'private, no-cache');
  res.setHeader('ETag', `W/"${totalSize}-${Math.trunc(stat.mtimeMs)}"`);
  res.setHeader(
    'Content-Disposition',
    `inline; filename="${asciiName}"; filename*=UTF-8''${encodedName}`,
  );

  const rangeHeader = req.headers.range;
  if (!rangeHeader) {
    res.status(200);
    res.setHeader('Content-Length', String(totalSize));
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const stream = fs.createReadStream(pdfPath);
    stream.on('error', () => {
      if (!res.headersSent) res.status(500).end();
      else res.destroy();
    });
    stream.pipe(res);
    return;
  }

  const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim());
  if (!match || totalSize === 0) {
    res.status(416);
    res.setHeader('Content-Range', `bytes */${totalSize}`);
    res.end();
    return;
  }

  const rawStart = match[1]!;
  const rawEnd = match[2]!;
  if (!rawStart && !rawEnd) {
    res.status(416);
    res.setHeader('Content-Range', `bytes */${totalSize}`);
    res.end();
    return;
  }

  let start: number;
  let end: number;

  if (!rawStart) {
    // Suffix byte range: `bytes=-N`
    const suffixLen = Number.parseInt(rawEnd, 10);
    if (!Number.isFinite(suffixLen) || suffixLen <= 0) {
      res.status(416);
      res.setHeader('Content-Range', `bytes */${totalSize}`);
      res.end();
      return;
    }
    start = Math.max(0, totalSize - suffixLen);
    end = totalSize - 1;
  } else {
    start = Number.parseInt(rawStart, 10);
    end = rawEnd ? Number.parseInt(rawEnd, 10) : totalSize - 1;
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      res.status(416);
      res.setHeader('Content-Range', `bytes */${totalSize}`);
      res.end();
      return;
    }
    if (end >= totalSize) {
      end = totalSize - 1;
    }
  }

  if (start < 0 || start >= totalSize || end < start) {
    res.status(416);
    res.setHeader('Content-Range', `bytes */${totalSize}`);
    res.end();
    return;
  }

  const chunkSize = end - start + 1;
  res.status(206);
  res.setHeader('Content-Range', `bytes ${start}-${end}/${totalSize}`);
  res.setHeader('Content-Length', String(chunkSize));

  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  const stream = fs.createReadStream(pdfPath, { start, end });
  stream.on('error', () => {
    if (!res.headersSent) res.status(500).end();
    else res.destroy();
  });
  stream.pipe(res);
}
