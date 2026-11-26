import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { zipSync, strToU8 } from 'fflate';
import { afterEach, describe, expect, it } from 'vitest';
import { CompileQueue, type TexToolchainInfo } from '@novatex/compiler';
import {
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  assertSafeWorkerBind,
  computeHmacSignature,
  createWorkerApp,
} from '../src/index.js';

const servers: Server[] = [];
const tempDirs: string[] = [];

function createTempDir(prefix = 'novatex-worker-test-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function startTestServer(app: ReturnType<typeof createWorkerApp>): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      servers.push(server);
      const addr = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${addr.port}`);
    });
    server.on('error', reject);
  });
}

afterEach(async () => {
  while (servers.length > 0) {
    const s = servers.pop()!;
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeZipBase64(files: Record<string, string | Uint8Array>): string {
  const input: Record<string, Uint8Array> = {};
  for (const [name, content] of Object.entries(files)) {
    input[name] = typeof content === 'string' ? strToU8(content) : content;
  }
  return Buffer.from(zipSync(input)).toString('base64');
}

function makeMockQueue(): CompileQueue {
  const mockToolchain: TexToolchainInfo = {
    available: true,
    engines: ['xelatex', 'pdflatex'],
    binaries: { xelatex: '/mock/xelatex', pdflatex: '/mock/pdflatex' },
    hasLatexmk: false,
    hasBibtex: true,
    hasBiber: false,
    hasQpdf: false,
    texBinDir: '/mock',
  };

  return new CompileQueue({
    maxConcurrency: 1,
    _detectOverride: async () => mockToolchain,
    _spawnOverride: async (req) => {
      const outArg = req.args.find((a) => a.startsWith('-output-directory='));
      const outDir = path.resolve(req.cwd, outArg!.slice('-output-directory='.length));
      fs.writeFileSync(path.join(outDir, 'main.pdf'), Buffer.from('%PDF-1.4\n%worker-test\n'));
      fs.writeFileSync(path.join(outDir, 'main.synctex.gz'), Buffer.from('synctex-bytes'));
      fs.writeFileSync(path.join(outDir, 'main.log'), 'Output written on main.pdf (1 page).');
      return { exitCode: 0, stdout: 'ok', stderr: '', timedOut: false };
    },
  });
}

describe('apps/worker HTTP microservice', () => {
  it('exposes GET /health with toolchain capabilities and queue stats', async () => {
    const tmpDir = createTempDir();
    const app = createWorkerApp({
      sharedSecret: 'super-secret-key',
      tmpDir,
      queue: makeMockQueue(),
    });
    const baseUrl = await startTestServer(app);

    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      ok: boolean;
      service: string;
      authRequired: boolean;
      toolchain: { available: boolean; engines: string[]; hasBibtex: boolean };
      queue: { active: number; queued: number; maxConcurrency: number };
    };
    expect(data.ok).toBe(true);
    expect(data.service).toBe('novatex-worker');
    expect(data.authRequired).toBe(true);
    expect(data.toolchain.available).toBe(true);
    expect(data.toolchain.engines).toEqual(['xelatex', 'pdflatex']);
    expect(data.toolchain.hasBibtex).toBe(true);
    expect(data.queue).toEqual({ active: 0, queued: 0, maxConcurrency: 1 });
  });

  it('enforces HMAC-SHA256 authentication with 5-minute replay window', async () => {
    const secret = 'worker-hmac-secret-12345';
    const tmpDir = createTempDir();
    const app = createWorkerApp({
      sharedSecret: secret,
      tmpDir,
      queue: makeMockQueue(),
    });
    const baseUrl = await startTestServer(app);

    const payload = JSON.stringify({
      projectId: 'proj-auth',
      mainFile: 'main.tex',
      engine: 'pdflatex',
      archiveBase64: makeZipBase64({
        'main.tex': '\\documentclass{article}\\begin{document}Hi\\end{document}',
      }),
    });

    // 1. Missing headers with malformed JSON -> 401 BEFORE JSON parsing (not 400!)
    const resMissingMalformed = await fetch(`${baseUrl}/compile`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not-valid-json-body',
    });
    expect(resMissingMalformed.status).toBe(401);

    // 1b. Missing headers with valid JSON -> 401
    const resMissing = await fetch(`${baseUrl}/compile`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
    });
    expect(resMissing.status).toBe(401);

    // 2. Invalid signature -> 401
    const nowTs = String(Date.now());
    const resInvalid = await fetch(`${baseUrl}/compile`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [TIMESTAMP_HEADER]: nowTs,
        [SIGNATURE_HEADER]: '0'.repeat(64),
      },
      body: payload,
    });
    expect(resInvalid.status).toBe(401);

    // 3. Expired timestamp (6 minutes old) -> 401
    const expiredTs = String(Date.now() - 6 * 60 * 1000);
    const expiredSig = computeHmacSignature(secret, expiredTs, payload);
    const resExpired = await fetch(`${baseUrl}/compile`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [TIMESTAMP_HEADER]: expiredTs,
        [SIGNATURE_HEADER]: expiredSig,
      },
      body: payload,
    });
    expect(resExpired.status).toBe(401);

    // 4. Valid signature -> 200 with pdfBase64 & synctexBase64 and clean tmpDir
    const validTs = String(Date.now());
    const validSig = computeHmacSignature(secret, validTs, payload);
    const resValid = await fetch(`${baseUrl}/compile`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [TIMESTAMP_HEADER]: validTs,
        [SIGNATURE_HEADER]: `sha256=${validSig}`,
      },
      body: payload,
    });
    expect(resValid.status).toBe(200);
    const body = (await resValid.json()) as {
      result: { ok: boolean; pdfReady: boolean; synctexReady: boolean };
      pdfBase64?: string;
      synctexBase64?: string;
    };
    expect(body.result.ok).toBe(true);
    expect(body.result.pdfReady).toBe(true);
    expect(body.result.synctexReady).toBe(true);
    expect(Buffer.from(body.pdfBase64!, 'base64').toString('utf8')).toContain('%PDF-1.4');
    expect(Buffer.from(body.synctexBase64!, 'base64').toString('utf8')).toBe('synctex-bytes');

    // 5. Replaying the exact same valid signed request within the 5-min window -> 401
    const resReplay = await fetch(`${baseUrl}/compile`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [TIMESTAMP_HEADER]: validTs,
        [SIGNATURE_HEADER]: `sha256=${validSig}`,
      },
      body: payload,
    });
    expect(resReplay.status).toBe(401);
    const replayData = (await resReplay.json()) as { error: string; message: string };
    expect(replayData.error).toBe('UNAUTHORIZED');
    expect(replayData.message).toContain('Replayed');

    // Verify temp job dir was cleaned up in finally
    expect(fs.readdirSync(tmpDir)).toEqual([]);
  });

  it('enforces fail-closed startup guard for non-loopback bind without shared secret', () => {
    expect(() => assertSafeWorkerBind('0.0.0.0', '')).toThrow(/COMPILER_SHARED_SECRET/);
    expect(() => assertSafeWorkerBind('192.168.1.50', '   ')).toThrow(/COMPILER_SHARED_SECRET/);
    expect(() => assertSafeWorkerBind('::', '')).toThrow(/COMPILER_SHARED_SECRET/);

    expect(() => assertSafeWorkerBind('127.0.0.1', '')).not.toThrow();
    expect(() => assertSafeWorkerBind('::1', '')).not.toThrow();
    expect(() => assertSafeWorkerBind('localhost', '')).not.toThrow();
    expect(() => assertSafeWorkerBind('0.0.0.0', 'strong-secret')).not.toThrow();
  });

  it('rejects zip-slip traversal and .latexmkrc archives in POST /compile', async () => {
    const tmpDir = createTempDir();
    const app = createWorkerApp({
      tmpDir,
      queue: makeMockQueue(),
    });
    const baseUrl = await startTestServer(app);

    // 1. Zip-slip entry `../pwned.tex`
    const zipSlipRes = await fetch(`${baseUrl}/compile`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'proj-zipslip',
        mainFile: 'main.tex',
        archiveBase64: makeZipBase64({
          'main.tex': '\\documentclass{article}\\begin{document}Hi\\end{document}',
          '../pwned.tex': 'evil',
        }),
      }),
    });
    expect(zipSlipRes.status).toBe(400);
    const slipData = (await zipSlipRes.json()) as { error: string };
    expect(slipData.error).toBe('PATH_TRAVERSAL');
    expect(fs.existsSync(path.join(tmpDir, 'pwned.tex'))).toBe(false);

    // 2. Archive containing `.latexmkrc`
    const rcRes = await fetch(`${baseUrl}/compile`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'proj-rc',
        mainFile: 'main.tex',
        archiveBase64: makeZipBase64({
          'main.tex': '\\documentclass{article}\\begin{document}Hi\\end{document}',
          '.latexmkrc': 'system("whoami");',
        }),
      }),
    });
    expect(rcRes.status).toBe(400);
    const rcData = (await rcRes.json()) as { error: string };
    expect(rcData.error).toBe('FORBIDDEN_LATEXMKRC');

    // 3. Enforce max file count limit
    const smallLimitApp = createWorkerApp({
      tmpDir,
      maxFiles: 2,
      queue: makeMockQueue(),
    });
    const smallLimitUrl = await startTestServer(smallLimitApp);
    const tooManyRes = await fetch(`${smallLimitUrl}/compile`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'proj-limit',
        mainFile: 'main.tex',
        archiveBase64: makeZipBase64({
          'main.tex': 'a',
          'b.tex': 'b',
          'c.tex': 'c',
        }),
      }),
    });
    expect(tooManyRes.status).toBe(400);
    const tooManyData = (await tooManyRes.json()) as { error: string };
    expect(tooManyData.error).toBe('TOO_MANY_FILES');

    // 4. Enforce max uncompressed bytes limit (zip bomb protection)
    const smallBytesApp = createWorkerApp({
      tmpDir,
      maxUncompressedBytes: 1024,
      queue: makeMockQueue(),
    });
    const smallBytesUrl = await startTestServer(smallBytesApp);
    const bombRes = await fetch(`${smallBytesUrl}/compile`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'proj-bomb',
        mainFile: 'main.tex',
        archiveBase64: makeZipBase64({
          'main.tex': 'A'.repeat(4096),
        }),
      }),
    });
    expect(bombRes.status).toBe(400);
    const bombData = (await bombRes.json()) as { error: string };
    expect(bombData.error).toBe('ARCHIVE_UNCOMPRESSED_TOO_LARGE');

    // Verify zero leaked job directories
    expect(fs.readdirSync(tmpDir)).toEqual([]);
  });
});
