import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { zipSync, unzipSync } from 'fflate';
import * as Y from 'yjs';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { createNovaTeXServer, type NovaTeXServerInstance } from '../src/app.js';
import { loadServerConfig } from '../src/config.js';

interface TestCookieClient {
  cookie: string;
  request<T = unknown>(
    method: string,
    pathname: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<{ status: number; data: T; headers: Headers; rawBuffer: Buffer }>;
}

function createHttpClient(baseUrl: string): TestCookieClient {
  let cookie = '';

  return {
    get cookie() {
      return cookie;
    },
    set cookie(val: string) {
      cookie = val;
    },
    async request<T = unknown>(
      method: string,
      pathname: string,
      body?: unknown,
      extraHeaders: Record<string, string> = {},
    ) {
      const headers: Record<string, string> = { ...extraHeaders };
      if (cookie && !headers.Cookie) {
        headers.Cookie = cookie;
      }
      let serializedBody: string | undefined;
      if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        serializedBody = JSON.stringify(body);
      }

      const res = await fetch(`${baseUrl}${pathname}`, {
        method,
        headers,
        body: serializedBody,
      });

      const setCookie = res.headers.get('set-cookie');
      if (setCookie) {
        const pair = setCookie.split(';')[0] ?? '';
        if (pair.includes('novatex_session=')) {
          const val = pair.split('=')[1] ?? '';
          cookie = val ? pair : '';
        }
      }

      const arrBuf = await res.arrayBuffer();
      const rawBuffer = Buffer.from(arrBuf);
      const ct = res.headers.get('content-type') ?? '';
      let data: unknown = null;
      if (ct.includes('application/json') && rawBuffer.byteLength > 0) {
        data = JSON.parse(rawBuffer.toString('utf8'));
      } else if (ct.startsWith('text/')) {
        data = rawBuffer.toString('utf8');
      }

      return { status: res.status, data: data as T, headers: res.headers, rawBuffer };
    },
  };
}

function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 8000,
  intervalMs = 30,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`Timed out after ${timeoutMs}ms waiting for condition`));
        return;
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

describe('NovaTeX Server End-to-End Integration Suite', () => {
  let tmpDir: string;
  let server: NovaTeXServerInstance;
  let baseUrl: string;
  let wsUrl: string;

  let ownerClient: TestCookieClient;
  let viewerClient: TestCookieClient;
  let mainProjectId: string;
  const capturedAiRequests: Array<{ url: string; method: string; auth: string }> = [];

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'novatex-server-test-'));
    const mockAiFetch: typeof fetch = async (input, init) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const method = (init?.method ?? 'GET').toUpperCase();
      const auth = new Headers(init?.headers).get('authorization') ?? '';
      capturedAiRequests.push({ url, method, auth });

      if (method === 'GET' && url.endsWith('/models')) {
        return new Response(
          JSON.stringify({
            object: 'list',
            data: [
              { id: 'gpt-4o' },
              { id: 'claude-3-7-sonnet' },
              { id: 'gemini-2.5-flash' },
              { id: 'trae-cn/volc/deepseek-v4-1-flash' },
              { id: 'deepseek-chat' },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      const reqBody = JSON.parse(String(init?.body ?? '{}')) as { model?: string; messages?: Array<{ content?: string }> };
      const lastMsg = reqBody.messages?.[reqBody.messages.length - 1]?.content ?? '';
      if (lastMsg === 'Reply with OK.') {
        return new Response(
          JSON.stringify({
            model: reqBody.model ?? 'deepseek-chat',
            choices: [{ message: { content: 'OK' } }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify({
          model: reqBody.model ?? 'deepseek-chat',
          choices: [
            {
              finish_reason: 'stop',
              message: {
                content: JSON.stringify({
                  summaryZh: '已修复未定义宏命令错误',
                  rootCauseZh: '源码中存在拼写错误的 \\textbfx 命令',
                  actionsTakenZh: ['将 \\textbfx 更正为 \\textbf'],
                  patchedCode: '\\section{Test}\nHello \\textbf{world}.\n',
                }),
              },
            },
          ],
          usage: { prompt_tokens: 40, completion_tokens: 30, total_tokens: 70 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    };

    server = await createNovaTeXServer({
      port: 0,
      host: '127.0.0.1',
      dataDir: tmpDir,
      allowPublicRegister: false,
      loadDotEnv: false,
      collabDebounceMs: 80,
      collabMaxDebounceMs: 250,
      aiFetchImpl: mockAiFetch,
    });
    const bound = await server.start();
    baseUrl = bound.url;
    wsUrl = `${baseUrl.replace(/^http/, 'ws')}/collab`;
    ownerClient = createHttpClient(baseUrl);
    viewerClient = createHttpClient(baseUrl);
  }, 30_000);

  afterAll(async () => {
    if (server) {
      await server.close();
    }
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 30_000);

  it('1. enforces setup gate, blocks duplicate setup, and closes public registration', async () => {
    const health = await ownerClient.request<{ ok: boolean; capabilities: { auth: { hasUsers: boolean; allowPublicRegister: boolean } } }>('GET', '/api/health');
    expect(health.status).toBe(200);
    expect(health.data.ok).toBe(true);
    expect(health.data.capabilities.auth.hasUsers).toBe(false);
    expect(health.data.capabilities.auth.allowPublicRegister).toBe(false);

    const meBefore = await ownerClient.request<{ authenticated: boolean; needsSetup: boolean; allowPublicRegister: boolean }>('GET', '/api/auth/me');
    expect(meBefore.status).toBe(200);
    expect(meBefore.data.authenticated).toBe(false);
    expect(meBefore.data.needsSetup).toBe(true);
    expect(meBefore.data.allowPublicRegister).toBe(false);

    // Setup initial admin
    const setupRes = await ownerClient.request<{ user: { id: string; username: string; role: string } }>('POST', '/api/auth/setup', {
      username: 'alice',
      displayName: 'Alice',
      password: 'password123',
    });
    expect(setupRes.status).toBe(201);
    expect(setupRes.data.user.username).toBe('alice');
    expect(setupRes.data.user.role).toBe('admin');

    // Duplicate setup must be blocked with 403
    const anon = createHttpClient(baseUrl);
    const dupSetup = await anon.request('POST', '/api/auth/setup', {
      username: 'hacker',
      displayName: 'Hacker',
      password: 'password123',
    });
    expect(dupSetup.status).toBe(403);

    // Public register without invite must be blocked with 403
    const pubReg = await anon.request('POST', '/api/auth/register', {
      username: 'stranger',
      displayName: 'Stranger',
      password: 'password123',
    });
    expect(pubReg.status).toBe(403);

    const meAfter = await ownerClient.request<{ authenticated: boolean; needsSetup: boolean; user: { username: string } }>('GET', '/api/auth/me');
    expect(meAfter.status).toBe(200);
    expect(meAfter.data.authenticated).toBe(true);
    expect(meAfter.data.needsSetup).toBe(false);
    expect(meAfter.data.user.username).toBe('alice');
  });

  it('2. creates chinese-ctex project, supports CRUD/outline/bib-keys, and blocks path traversal & .latexmkrc', async () => {
    const createRes = await ownerClient.request<{ project: { id: string; name: string; mainFile: string; engine: string } }>('POST', '/api/projects', {
      name: 'NovaTeX 中文论文测试',
      description: '端到端实测项目',
      engine: 'xelatex',
      template: 'chinese-ctex',
    });
    expect(createRes.status).toBe(201);
    mainProjectId = createRes.data.project.id;
    expect(createRes.data.project.mainFile).toBe('main.tex');
    expect(createRes.data.project.engine).toBe('xelatex');

    // List files
    const listRes = await ownerClient.request<{ files: Array<{ path: string; kind: string }> }>(
      'GET',
      `/api/projects/${mainProjectId}/files`,
    );
    expect(listRes.status).toBe(200);
    const filePaths = listRes.data.files.map((f) => f.path);
    expect(filePaths).toContain('main.tex');
    expect(filePaths).toContain('sections/intro.tex');
    expect(filePaths).toContain('refs.bib');

    // Read file
    const readRes = await ownerClient.request<{ path: string; content: string; isBinary: boolean }>(
      'GET',
      `/api/projects/${mainProjectId}/file?path=main.tex`,
    );
    expect(readRes.status).toBe(200);
    expect(readRes.data.isBinary).toBe(false);
    expect(readRes.data.content).toContain('\\documentclass{ctexart}');

    // Outline extraction across main.tex + \input{sections/intro}
    const outlineRes = await ownerClient.request<{ items: Array<{ title: string; file: string; line: number }> }>(
      'GET',
      `/api/projects/${mainProjectId}/outline`,
    );
    expect(outlineRes.status).toBe(200);
    expect(outlineRes.data.items.some((i) => i.title.includes('引言') && i.file === 'sections/intro.tex')).toBe(true);
    expect(outlineRes.data.items.some((i) => i.title.includes('方法设计') && i.file === 'main.tex')).toBe(true);

    // Bib keys & labels extraction
    const bibRes = await ownerClient.request<{
      citeKeys: Array<{ key: string; title?: string }>;
      labels: Array<{ label: string; file?: string }>;
    }>('GET', `/api/projects/${mainProjectId}/bib-keys`);
    expect(bibRes.status).toBe(200);
    expect(bibRes.data.citeKeys.some((c) => c.key === 'vaswani2017attention')).toBe(true);
    expect(bibRes.data.labels.some((l) => l.label === 'sec:method')).toBe(true);

    // Create, rename, and delete a temporary file
    const writeNew = await ownerClient.request('PUT', `/api/projects/${mainProjectId}/file`, {
      path: 'sections/temp.tex',
      content: '% temp section\n',
    });
    expect(writeNew.status).toBe(200);

    const renameRes = await ownerClient.request('POST', `/api/projects/${mainProjectId}/files/rename`, {
      fromPath: 'sections/temp.tex',
      toPath: 'sections/temp2.tex',
    });
    expect(renameRes.status).toBe(200);

    const delRes = await ownerClient.request(
      'DELETE',
      `/api/projects/${mainProjectId}/file?path=${encodeURIComponent('sections/temp2.tex')}`,
    );
    expect(delRes.status).toBe(200);

    // Security rejections: traversal (`../evil.tex`) and forbidden `.latexmkrc` -> 400
    const traversalRes = await ownerClient.request('PUT', `/api/projects/${mainProjectId}/file`, {
      path: '../evil.tex',
      content: 'pwned',
    });
    expect(traversalRes.status).toBe(400);

    const latexmkrcRes = await ownerClient.request('PUT', `/api/projects/${mainProjectId}/file`, {
      path: '.latexmkrc',
      content: 'system("id");',
    });
    expect(latexmkrcRes.status).toBe(400);
  });

  it('3. handles invite link registration and enforces viewer read-only 403 on file writes', async () => {
    const invRes = await ownerClient.request<{ invite: { token: string; role: string } }>(
      'POST',
      `/api/projects/${mainProjectId}/invites`,
      { role: 'viewer', expiresInHours: 24, maxUses: 5 },
    );
    expect(invRes.status).toBe(201);
    const inviteToken = invRes.data.invite.token;
    expect(inviteToken).toBeTruthy();

    // Viewer registers with invite token
    const regRes = await viewerClient.request<{ user: { username: string }; projectId?: string }>(
      'POST',
      '/api/auth/register',
      {
        username: 'reviewer1',
        displayName: 'Reviewer One',
        password: 'password123',
        inviteToken,
      },
    );
    expect(regRes.status).toBe(201);
    expect(regRes.data.user.username).toBe('reviewer1');

    // Idempotent acceptInvite call (mimics AuthScreen.tsx behavior)
    const acceptRes = await viewerClient.request<{ ok: boolean; projectId: string }>(
      'POST',
      `/api/invites/${encodeURIComponent(inviteToken)}/accept`,
    );
    expect(acceptRes.status).toBe(200);
    expect(acceptRes.data.ok).toBe(true);
    expect(acceptRes.data.projectId).toBe(mainProjectId);

    // Viewer CAN read files
    const readRes = await viewerClient.request(
      'GET',
      `/api/projects/${mainProjectId}/file?path=main.tex`,
    );
    expect(readRes.status).toBe(200);

    // Viewer CANNOT write files -> 403
    const writeRes = await viewerClient.request('PUT', `/api/projects/${mainProjectId}/file`, {
      path: 'main.tex',
      content: 'unauthorized edit',
    });
    expect(writeRes.status).toBe(403);
  });

  it('4. syncs live edits between 2 real Hocuspocus WebSocket clients and flushes to disk', async () => {
    const tokResA = await ownerClient.request<{ token: string }>('GET', '/api/auth/collab-token');
    expect(tokResA.status).toBe(200);
    const syncTokRes = await ownerClient.request<{ token: string }>('POST', '/api/auth/sync-token', {
      label: 'test-agent',
    });
    expect(syncTokRes.status).toBe(201);

    const docName = `${mainProjectId}::main.tex`;
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    let syncedA = false;
    let syncedB = false;

    const providerA = new HocuspocusProvider({
      url: wsUrl,
      name: docName,
      document: docA,
      token: tokResA.data.token,
      onSynced: ({ state }) => {
        if (state) syncedA = true;
      },
    });

    // Client B authenticates with personal sync token (verifies both token paths!)
    const providerB = new HocuspocusProvider({
      url: wsUrl,
      name: docName,
      document: docB,
      token: syncTokRes.data.token,
      onSynced: ({ state }) => {
        if (state) syncedB = true;
      },
    });

    try {
      await waitForCondition(() => syncedA && syncedB, 8000);
      expect(docA.getText('content').toString()).toContain('\\documentclass{ctexart}');
      expect(docB.getText('content').toString()).toContain('\\documentclass{ctexart}');

      // Client A appends a marker comment to main.tex
      const marker = '% COLLAB_LIVE_SYNC_MARKER_2026\n';
      docA.transact(() => {
        docA.getText('content').insert(0, marker);
      });

      // Verify Client B receives the edit in real time via Hocuspocus CRDT
      await waitForCondition(() => docB.getText('content').toString().includes(marker), 5000);
      expect(docB.getText('content').toString()).toContain(marker);

      // Verify debounced onStoreDocument flushes the edit to the workspace disk file
      const diskMainPath = path.join(tmpDir, 'projects', mainProjectId, 'src', 'main.tex');
      await waitForCondition(
        () => fs.readFileSync(diskMainPath, 'utf8').includes(marker),
        5000,
      );
      expect(fs.readFileSync(diskMainPath, 'utf8')).toContain(marker);
    } finally {
      providerA.destroy();
      providerB.destroy();
      docA.destroy();
      docB.destroy();
    }
  }, 20_000);

  it('5. compiles real XeLaTeX PDF, streams 206 Partial Content Range requests, and serves bidirectional SyncTeX', async () => {
    const compileRes = await ownerClient.request<{
      result: {
        ok: boolean;
        compilerAvailable: boolean;
        exitCode: number;
        pdfReady: boolean;
        pdfSize: number;
        synctexReady: boolean;
        diagnostics: unknown[];
        rawLog: string;
      };
    }>('POST', `/api/projects/${mainProjectId}/compile`, {
      engine: 'xelatex',
      mainFile: 'main.tex',
    });

    expect(compileRes.status).toBe(200);
    expect(compileRes.data.result.compilerAvailable).toBe(true);
    expect(compileRes.data.result.ok).toBe(true);
    expect(compileRes.data.result.exitCode).toBe(0);
    expect(compileRes.data.result.pdfReady).toBe(true);
    expect(compileRes.data.result.pdfSize).toBeGreaterThan(1000);
    expect(compileRes.data.result.synctexReady).toBe(true);

    // Latest compile endpoint
    const latestRes = await ownerClient.request<{ result: { ok: boolean; pdfReady: boolean } | null }>(
      'GET',
      `/api/projects/${mainProjectId}/compile/latest`,
    );
    expect(latestRes.status).toBe(200);
    expect(latestRes.data.result?.ok).toBe(true);
    expect(latestRes.data.result?.pdfReady).toBe(true);

    // Full PDF download (200)
    const fullPdf = await ownerClient.request('GET', `/api/projects/${mainProjectId}/pdf`);
    expect(fullPdf.status).toBe(200);
    expect(fullPdf.headers.get('accept-ranges')).toBe('bytes');
    expect(fullPdf.rawBuffer.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    const totalPdfLen = fullPdf.rawBuffer.byteLength;

    // RFC 7233 Partial Range request -> 206 Partial Content
    const partialPdf = await ownerClient.request(
      'GET',
      `/api/projects/${mainProjectId}/pdf`,
      undefined,
      { Range: 'bytes=0-1023' },
    );
    expect(partialPdf.status).toBe(206);
    expect(partialPdf.headers.get('content-range')).toBe(`bytes 0-1023/${totalPdfLen}`);
    expect(partialPdf.rawBuffer.byteLength).toBe(1024);
    expect(partialPdf.rawBuffer.equals(fullPdf.rawBuffer.subarray(0, 1024))).toBe(true);

    // Unsatisfiable range -> 416
    const badRange = await ownerClient.request(
      'GET',
      `/api/projects/${mainProjectId}/pdf`,
      undefined,
      { Range: `bytes=${totalPdfLen + 100}-${totalPdfLen + 200}` },
    );
    expect(badRange.status).toBe(416);

    // SyncTeX Forward on main.tex line inside body
    const mainContent = fs.readFileSync(
      path.join(tmpDir, 'projects', mainProjectId, 'src', 'main.tex'),
      'utf8',
    );
    const lines = mainContent.split('\n');
    const targetLine = lines.findIndex((l) => l.includes('我们定义联合优化目标如下')) + 1;
    expect(targetLine).toBeGreaterThan(0);

    const fwdRes = await ownerClient.request<{
      found: boolean;
      file: string;
      line: number;
      boxes: Array<{ page: number; x: number; y: number; width: number; height: number }>;
    }>(
      'GET',
      `/api/projects/${mainProjectId}/synctex/forward?file=main.tex&line=${targetLine}`,
    );
    expect(fwdRes.status).toBe(200);
    expect(fwdRes.data.found).toBe(true);
    expect(fwdRes.data.boxes.length).toBeGreaterThan(0);

    // SyncTeX Inverse using returned box center
    const box = fwdRes.data.boxes[0]!;
    const invRes = await ownerClient.request<{
      found: boolean;
      file: string;
      line: number;
    }>(
      'GET',
      `/api/projects/${mainProjectId}/synctex/inverse?page=${box.page}&x=${(box.x + box.width / 2).toFixed(2)}&y=${(box.y + box.height / 2).toFixed(2)}`,
    );
    expect(invRes.status).toBe(200);
    expect(invRes.data.found).toBe(true);
    expect(invRes.data.file).toBe('main.tex');
    expect(Math.abs(invRes.data.line - targetLine)).toBeLessThanOrEqual(4);
  }, 60_000);

  it('6. supports Format Hub export (md/docx/txt), merge-tex preview preserving preamble, and apply-import', async () => {
    const expMd = await ownerClient.request<{ artifact: { format: string; text?: string } }>(
      'POST',
      `/api/projects/${mainProjectId}/format/export`,
      { sourceScope: 'project', targetFormat: 'md' },
    );
    expect(expMd.status).toBe(200);
    expect(expMd.data.artifact.format).toBe('md');
    expect(expMd.data.artifact.text).toContain('[@vaswani2017attention]');

    const expDocx = await ownerClient.request<{ artifact: { format: string; base64?: string; byteLength: number } }>(
      'POST',
      `/api/projects/${mainProjectId}/format/export`,
      { sourceScope: 'project', targetFormat: 'docx' },
    );
    expect(expDocx.status).toBe(200);
    expect(expDocx.data.artifact.format).toBe('docx');
    expect(expDocx.data.artifact.base64).toBeTruthy();
    expect(expDocx.data.artifact.byteLength).toBeGreaterThan(1000);

    const expTxt = await ownerClient.request<{ artifact: { format: string; text?: string; wordCount?: { totalAcademicWords: number } } }>(
      'POST',
      `/api/projects/${mainProjectId}/format/export`,
      { sourceScope: 'project', targetFormat: 'txt' },
    );
    expect(expTxt.status).toBe(200);
    expect(expTxt.data.artifact.format).toBe('txt');
    expect(expTxt.data.artifact.wordCount?.totalAcademicWords).toBeGreaterThan(10);

    // Import preview (`merge-tex`) preserves existing preamble (\documentclass{ctexart}, \usepackage{booktabs}, \bibliography{refs})
    const previewRes = await ownerClient.request<{
      mergePreview?: { mergedCode: string; diff: { additions: number; deletions: number } };
      generatedCode: string;
      targetFile: string;
    }>('POST', `/api/projects/${mainProjectId}/format/import-preview`, {
      sourceFormat: 'md',
      fileName: 'revised.md',
      text: '# 新修订章节\n\n这是从 Markdown 回灌的正文，引用 [@knuth1984texbook] 并包含公式 $a^2 + b^2 = c^2$。\n',
      targetMode: 'merge-tex',
      targetFile: 'main.tex',
    });
    expect(previewRes.status).toBe(200);
    expect(previewRes.data.targetFile).toBe('main.tex');
    expect(previewRes.data.generatedCode).toContain('\\documentclass{ctexart}');
    expect(previewRes.data.generatedCode).toContain('\\usepackage{booktabs}');
    expect(previewRes.data.generatedCode).toContain('\\bibliography{refs}');
    expect(previewRes.data.generatedCode).toContain('新修订章节');
    expect(previewRes.data.generatedCode).toContain('\\cite{knuth1984texbook}');

    // Apply import to a separate target file so we also test writing + git checkpoint
    const applyRes = await ownerClient.request<{ ok: boolean; targetFile: string }>(
      'POST',
      `/api/projects/${mainProjectId}/format/apply-import`,
      {
        targetFile: 'sections/imported.tex',
        content: '\\section{导入章节}\n导入正文内容。\n',
        commitMessage: '导入 Markdown 章节测试',
      },
    );
    expect(applyRes.status).toBe(200);
    expect(applyRes.data.ok).toBe(true);
    const readImported = await ownerClient.request<{ content: string }>(
      'GET',
      `/api/projects/${mainProjectId}/file?path=sections/imported.tex`,
    );
    expect(readImported.status).toBe(200);
    expect(readImported.data.content).toContain('导入正文内容');
  }, 30_000);

  it('7. supports Git commit, log, diff, and non-destructive restore', async () => {
    // Write version 1 and commit
    await ownerClient.request('PUT', `/api/projects/${mainProjectId}/file`, {
      path: 'sections/versioned.tex',
      content: 'VERSION_ONE_TEXT\n',
    });
    const commit1 = await ownerClient.request<{ commit: { hash: string; message: string } }>(
      'POST',
      `/api/projects/${mainProjectId}/git/commit`,
      { message: '保存版本 V1' },
    );
    expect(commit1.status).toBe(201);
    const hashV1 = commit1.data.commit.hash;
    expect(hashV1).toMatch(/^[0-9a-f]{40}$/i);

    // Write version 2 and commit
    await ownerClient.request('PUT', `/api/projects/${mainProjectId}/file`, {
      path: 'sections/versioned.tex',
      content: 'VERSION_TWO_TEXT_MODIFIED\n',
    });
    const commit2 = await ownerClient.request<{ commit: { hash: string } }>(
      'POST',
      `/api/projects/${mainProjectId}/git/commit`,
      { message: '保存版本 V2' },
    );
    expect(commit2.status).toBe(201);

    // Log
    const logRes = await ownerClient.request<{ commits: Array<{ hash: string; message: string }> }>(
      'GET',
      `/api/projects/${mainProjectId}/git/log`,
    );
    expect(logRes.status).toBe(200);
    expect(logRes.data.commits.some((c) => c.message === '保存版本 V1')).toBe(true);
    expect(logRes.data.commits.some((c) => c.message === '保存版本 V2')).toBe(true);

    // Diff V1 -> HEAD
    const diffRes = await ownerClient.request<{
      fromRef: string;
      toRef: string;
      files: Array<{ path: string; status: string; unifiedDiff: string }>;
    }>('GET', `/api/projects/${mainProjectId}/git/diff?from=${hashV1}&to=HEAD`);
    expect(diffRes.status).toBe(200);
    const versionedDiff = diffRes.data.files.find((f) => f.path === 'sections/versioned.tex');
    expect(versionedDiff).toBeDefined();
    expect(versionedDiff?.unifiedDiff).toContain('-VERSION_ONE_TEXT');
    expect(versionedDiff?.unifiedDiff).toContain('+VERSION_TWO_TEXT_MODIFIED');

    // Restore back to V1
    const restoreRes = await ownerClient.request<{ ok: boolean }>(
      'POST',
      `/api/projects/${mainProjectId}/git/restore`,
      { hash: hashV1 },
    );
    expect(restoreRes.status).toBe(200);
    expect(restoreRes.data.ok).toBe(true);

    // Verify restored file content is back to VERSION_ONE_TEXT on disk AND via API
    const diskContent = fs.readFileSync(
      path.join(tmpDir, 'projects', mainProjectId, 'src', 'sections', 'versioned.tex'),
      'utf8',
    );
    expect(diskContent).toBe('VERSION_ONE_TEXT\n');
  });

  it('8. supports source comment threads: create, reply, and resolve', async () => {
    const createRes = await ownerClient.request<{
      thread: { id: string; resolved: boolean; messages: Array<{ body: string }> };
    }>('POST', `/api/projects/${mainProjectId}/comments`, {
      filePath: 'main.tex',
      lineNumber: 12,
      quote: '\\section{方法设计}',
      body: '建议补充消融实验公式推导。',
    });
    expect(createRes.status).toBe(201);
    const threadId = createRes.data.thread.id;
    expect(createRes.data.thread.resolved).toBe(false);
    expect(createRes.data.thread.messages).toHaveLength(1);

    const replyRes = await ownerClient.request<{
      thread: { id: string; messages: Array<{ body: string }> };
    }>('POST', `/api/projects/${mainProjectId}/comments/${threadId}/reply`, {
      body: '好的，已补充在附录中。',
    });
    expect(replyRes.status).toBe(201);
    expect(replyRes.data.thread.messages).toHaveLength(2);
    expect(replyRes.data.thread.messages[1]?.body).toBe('好的，已补充在附录中。');

    const resolveRes = await ownerClient.request<{ thread: { resolved: boolean } }>(
      'PATCH',
      `/api/projects/${mainProjectId}/comments/${threadId}`,
      { resolved: true },
    );
    expect(resolveRes.status).toBe(200);
    expect(resolveRes.data.thread.resolved).toBe(true);

    const listRes = await ownerClient.request<{ threads: Array<{ id: string; resolved: boolean }> }>(
      'GET',
      `/api/projects/${mainProjectId}/comments?file=main.tex`,
    );
    expect(listRes.status).toBe(200);
    expect(listRes.data.threads.find((t) => t.id === threadId)?.resolved).toBe(true);

    // Viewer cannot create comments -> 403
    const viewerComment = await viewerClient.request(
      'POST',
      `/api/projects/${mainProjectId}/comments`,
      { filePath: 'main.tex', lineNumber: 1, quote: '', body: 'viewer blocked' },
    );
    expect(viewerComment.status).toBe(403);
  });

  it('9. imports Overleaf .zip safely (strips sneaky .latexmkrc) and exports clean .zip', async () => {
    const enc = new TextEncoder();
    const zipBytes = zipSync({
      'overleaf-export/main.tex': enc.encode(
        '\\documentclass{article}\n\\begin{document}\nHello from Overleaf!\n\\end{document}\n',
      ),
      'overleaf-export/sections/ch1.tex': enc.encode('\\section{Chapter One}\nSafe content.\n'),
      'overleaf-export/.latexmkrc': enc.encode('system("echo PWNED");\n'),
      'overleaf-export/latexmkrc': enc.encode('system("echo PWNED2");\n'),
      '__MACOSX/._main.tex': enc.encode('mac junk'),
    });
    const zipBase64 = Buffer.from(zipBytes).toString('base64');

    const importRes = await ownerClient.request<{
      project: { id: string; name: string; mainFile: string };
      importedFiles: string[];
      skippedFiles: string[];
    }>('POST', '/api/projects/import-zip', {
      name: 'Overleaf 安全导入测试',
      fileName: 'overleaf-export.zip',
      base64: zipBase64,
    });

    expect(importRes.status).toBe(201);
    const importedProjectId = importRes.data.project.id;
    expect(importRes.data.project.mainFile).toBe('main.tex');
    expect(importRes.data.importedFiles).toContain('main.tex');
    expect(importRes.data.importedFiles).toContain('sections/ch1.tex');
    expect(importRes.data.importedFiles).not.toContain('.latexmkrc');
    expect(importRes.data.importedFiles).not.toContain('latexmkrc');

    // Double-check on disk that `.latexmkrc` does NOT exist
    const importedSrcDir = path.join(tmpDir, 'projects', importedProjectId, 'src');
    expect(fs.existsSync(path.join(importedSrcDir, '.latexmkrc'))).toBe(false);
    expect(fs.existsSync(path.join(importedSrcDir, 'latexmkrc'))).toBe(false);
    expect(fs.existsSync(path.join(importedSrcDir, 'main.tex'))).toBe(true);

    // Export zip and verify contents
    const exportRes = await ownerClient.request(
      'GET',
      `/api/projects/${importedProjectId}/export-zip`,
    );
    expect(exportRes.status).toBe(200);
    expect(exportRes.headers.get('content-type')).toContain('application/zip');
    const exportedEntries = unzipSync(
      new Uint8Array(
        exportRes.rawBuffer.buffer,
        exportRes.rawBuffer.byteOffset,
        exportRes.rawBuffer.byteLength,
      ),
    );
    expect(Object.keys(exportedEntries)).toContain('main.tex');
    expect(Object.keys(exportedEntries)).toContain('sections/ch1.tex');
    expect(Object.keys(exportedEntries)).not.toContain('.latexmkrc');

    // Malicious zip-slip archive MUST be rejected with 400
    const evilZipBytes = zipSync({
      '../../escape.tex': enc.encode('evil'),
    });
    const evilImport = await ownerClient.request('POST', '/api/projects/import-zip', {
      name: 'Evil Zip',
      fileName: 'evil.zip',
      base64: Buffer.from(evilZipBytes).toString('base64'),
    });
    expect(evilImport.status).toBe(400);
  });

  it('10. pushes live REST PUT patches to connected WebSocket clients, rejects bad tokens, and enforces viewer readOnly over WS', async () => {
    const ownerTok = await ownerClient.request<{ token: string }>('GET', '/api/auth/collab-token');
    const viewerTok = await viewerClient.request<{ token: string }>('GET', '/api/auth/collab-token');
    expect(ownerTok.status).toBe(200);
    expect(viewerTok.status).toBe(200);

    const docName = `${mainProjectId}::sections/intro.tex`;
    const ownerDoc = new Y.Doc();
    let ownerSynced = false;
    const ownerProvider = new HocuspocusProvider({
      url: wsUrl,
      name: docName,
      document: ownerDoc,
      token: ownerTok.data.token,
      onSynced: ({ state }) => {
        if (state) ownerSynced = true;
      },
    });

    const badDoc = new Y.Doc();
    let authFailedReason = '';
    const badProvider = new HocuspocusProvider({
      url: wsUrl,
      name: docName,
      document: badDoc,
      token: 'forged.invalid.token',
      onAuthenticationFailed: ({ reason }) => {
        authFailedReason = reason || 'failed';
      },
    });

    const viewerDoc = new Y.Doc();
    let viewerScope = '';
    let viewerSynced = false;
    const viewerProvider = new HocuspocusProvider({
      url: wsUrl,
      name: docName,
      document: viewerDoc,
      token: viewerTok.data.token,
      onAuthenticated: ({ scope }) => {
        viewerScope = scope;
      },
      onSynced: ({ state }) => {
        if (state) viewerSynced = true;
      },
    });

    try {
      await waitForCondition(() => ownerSynced && viewerSynced && Boolean(authFailedReason), 8000);
      expect(viewerScope).toBe('readonly');
      expect(authFailedReason).toBeTruthy();

      // REST PUT on an actively open document patches live Yjs room so ownerDoc receives it immediately!
      const patchedContent = `${ownerDoc.getText('content').toString()}\n% PATCHED_VIA_REST_LIVE\n`;
      const putRes = await ownerClient.request('PUT', `/api/projects/${mainProjectId}/file`, {
        path: 'sections/intro.tex',
        content: patchedContent,
      });
      expect(putRes.status).toBe(200);

      await waitForCondition(
        () => ownerDoc.getText('content').toString().includes('% PATCHED_VIA_REST_LIVE'),
        5000,
      );
      expect(ownerDoc.getText('content').toString()).toContain('% PATCHED_VIA_REST_LIVE');

      // Viewer tries to mutate its local Y.Doc; server MUST reject/ignore mutation on ownerDoc
      viewerDoc.transact(() => {
        viewerDoc.getText('content').insert(0, '% VIEWER_ILLEGAL_EDIT\n');
      });
      await new Promise((r) => setTimeout(r, 250));
      expect(ownerDoc.getText('content').toString()).not.toContain('% VIEWER_ILLEGAL_EDIT');
    } finally {
      ownerProvider.destroy();
      badProvider.destroy();
      viewerProvider.destroy();
      ownerDoc.destroy();
      badDoc.destroy();
      viewerDoc.destroy();
    }
  }, 15_000);

  it('11. enforces admin-only global AI config, hides apiKey, blocks SSRF, and runs AI fixer diff', async () => {
    // Non-admin viewer cannot save global AI config or test global scope -> 403
    const viewerPut = await viewerClient.request('PUT', '/api/ai/config', {
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'sk-hack',
    });
    expect(viewerPut.status).toBe(403);

    const beforeViewerTestCount = capturedAiRequests.length;
    const viewerGlobalTest = await viewerClient.request('POST', '/api/ai/test', {
      scope: 'global',
      baseUrl: 'https://evil.example/v1',
    });
    expect(viewerGlobalTest.status).toBe(403);

    // Non-admin viewer calling /api/ai/test without personal key gets ok:false and makes 0 outbound calls
    const viewerPersonalTest = await viewerClient.request<{ ok: boolean; error?: string }>(
      'POST',
      '/api/ai/test',
      {
        baseUrl: 'https://evil.example/v1',
      },
    );
    expect(viewerPersonalTest.status).toBe(200);
    expect(viewerPersonalTest.data.ok).toBe(false);
    expect(capturedAiRequests.length).toBe(beforeViewerTestCount);

    // Admin SSRF target blocked with 400
    const ssrfRes = await ownerClient.request('PUT', '/api/ai/config', {
      baseUrl: 'http://169.254.169.254/latest/meta-data',
    });
    expect(ssrfRes.status).toBe(400);

    // Admin saves valid config; raw apiKey is NEVER returned
    const saveRes = await ownerClient.request<{ config: Record<string, unknown> }>(
      'PUT',
      '/api/ai/config',
      {
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: 'sk-secret-test-key-9999',
        model: 'deepseek-chat',
        reasonerModel: 'deepseek-reasoner',
      },
    );
    expect(saveRes.status).toBe(200);
    expect(saveRes.data.config.hasApiKey).toBe(true);
    expect(saveRes.data.config.apiKey).toBeUndefined();
    expect(JSON.stringify(saveRes.data)).not.toContain('sk-secret-test-key-9999');

    const getRes = await ownerClient.request<{ config: Record<string, unknown> }>(
      'GET',
      '/api/ai/config',
    );
    expect(getRes.status).toBe(200);
    expect(getRes.data.config.hasApiKey).toBe(true);
    expect(getRes.data.config.apiKey).toBeUndefined();

    // Test AI connection (using injected mockAiFetch)
    const testRes = await ownerClient.request<{ ok: boolean; model?: string }>(
      'POST',
      '/api/ai/test',
      {},
    );
    expect(testRes.status).toBe(200);
    expect(testRes.data.ok).toBe(true);

    // Run AI fix on project
    const fixRes = await ownerClient.request<{
      ok: boolean;
      patchedCode: string;
      diff: { additions: number; deletions: number };
    }>('POST', `/api/projects/${mainProjectId}/ai/fix`, {
      mode: 'diagnose-and-fix',
      filePath: 'main.tex',
      sourceCode: '\\section{Test}\nHello \\textbfx{world}.\n',
    });
    expect(fixRes.status).toBe(200);
    expect(fixRes.data.ok).toBe(true);
    expect(fixRes.data.patchedCode).toContain('\\textbf{world}');
    expect(fixRes.data.diff.additions).toBeGreaterThan(0);
  });

  it('12. authenticates REST calls with Bearer sync token and invalidates sessions on logout', async () => {
    const syncRes = await ownerClient.request<{ token: string }>('POST', '/api/auth/sync-token', {
      label: 'cli-rest-check',
    });
    expect(syncRes.status).toBe(201);
    const bearerToken = syncRes.data.token;

    // Fresh cookie-less client using Authorization: Bearer <syncToken>
    const cliClient = createHttpClient(baseUrl);
    const cliFiles = await cliClient.request<{ files: Array<{ path: string }> }>(
      'GET',
      `/api/projects/${mainProjectId}/files`,
      undefined,
      { Authorization: `Bearer ${bearerToken}` },
    );
    expect(cliFiles.status).toBe(200);
    expect(cliFiles.data.files.some((f) => f.path === 'main.tex')).toBe(true);

    // Login & logout lifecycle on separate client
    const tempClient = createHttpClient(baseUrl);
    const badLogin = await tempClient.request('POST', '/api/auth/login', {
      username: 'alice',
      password: 'wrong-password',
    });
    expect(badLogin.status).toBe(401);

    const goodLogin = await tempClient.request<{ user: { username: string } }>('POST', '/api/auth/login', {
      username: 'alice',
      password: 'password123',
    });
    expect(goodLogin.status).toBe(200);
    expect(goodLogin.data.user.username).toBe('alice');

    const logoutRes = await tempClient.request('POST', '/api/auth/logout');
    expect(logoutRes.status).toBe(200);

    const afterLogout = await tempClient.request('GET', '/api/projects');
    expect(afterLogout.status).toBe(401);
  });

  it('13. [P0-3] blocks viewer from escalating to editor via exhausted or expired invite links (410)', async () => {
    // 1. Exhausted invite: maxUses=1, consumed by a new user first
    const oneUseInv = await ownerClient.request<{ invite: { token: string } }>(
      'POST',
      `/api/projects/${mainProjectId}/invites`,
      { role: 'editor', expiresInHours: 24, maxUses: 1 },
    );
    expect(oneUseInv.status).toBe(201);
    const exhaustedToken = oneUseInv.data.invite.token;

    const collaboratorClient = createHttpClient(baseUrl);
    const regCollab = await collaboratorClient.request<{ user: { username: string }; projectId?: string }>(
      'POST',
      '/api/auth/register',
      {
        username: 'editor_one',
        displayName: 'Editor One',
        password: 'password123',
        inviteToken: exhaustedToken,
      },
    );
    expect(regCollab.status).toBe(201);
    expect(regCollab.data.projectId).toBe(mainProjectId);

    // Viewer tries to use the now-exhausted editor invite to escalate privileges -> MUST return 410
    const escalateExhausted = await viewerClient.request(
      'POST',
      `/api/invites/${encodeURIComponent(exhaustedToken)}/accept`,
    );
    expect(escalateExhausted.status).toBe(410);

    // 2. Expired invite: expiresInHours = 0.00001 (~36ms), wait 80ms then attempt escalation -> MUST return 410
    const shortInv = await ownerClient.request<{ invite: { token: string } }>(
      'POST',
      `/api/projects/${mainProjectId}/invites`,
      { role: 'editor', expiresInHours: 0.00001, maxUses: 5 },
    );
    expect(shortInv.status).toBe(201);
    await new Promise((r) => setTimeout(r, 80));

    const escalateExpired = await viewerClient.request(
      'POST',
      `/api/invites/${encodeURIComponent(shortInv.data.invite.token)}/accept`,
    );
    expect(escalateExpired.status).toBe(410);

    // Confirm viewer STILL has role=viewer and CANNOT write files (403)
    const detail = await viewerClient.request<{ project: { role: string } }>(
      'GET',
      `/api/projects/${mainProjectId}`,
    );
    expect(detail.status).toBe(200);
    expect(detail.data.project.role).toBe('viewer');

    const writeCheck = await viewerClient.request('PUT', `/api/projects/${mainProjectId}/file`, {
      path: 'main.tex',
      content: 'escalated?',
    });
    expect(writeCheck.status).toBe(403);
  });

  it('14. [P1-2] blocks viewer from triggering compile via format/export PDF and serves existing compiled PDF read-only', async () => {
    // Create a brand-new uncompiled project and invite viewerClient
    const newProj = await ownerClient.request<{ project: { id: string } }>('POST', '/api/projects', {
      name: 'Uncompiled Viewer Test',
      engine: 'xelatex',
      template: 'chinese-ctex',
    });
    expect(newProj.status).toBe(201);
    const uncompiledId = newProj.data.project.id;

    const inv = await ownerClient.request<{ invite: { token: string } }>(
      'POST',
      `/api/projects/${uncompiledId}/invites`,
      { role: 'viewer', expiresInHours: 24, maxUses: 5 },
    );
    expect(inv.status).toBe(201);
    const acc = await viewerClient.request(
      'POST',
      `/api/invites/${encodeURIComponent(inv.data.invite.token)}/accept`,
    );
    expect(acc.status).toBe(200);

    // Uncompiled project: viewer requesting PDF export MUST fail with 404 and MUST NOT create any PDF in _build/
    const viewerPdfUncompiled = await viewerClient.request(
      'POST',
      `/api/projects/${uncompiledId}/format/export`,
      { sourceScope: 'project', targetFormat: 'pdf' },
    );
    expect(viewerPdfUncompiled.status).toBe(404);
    const buildDir = path.join(tmpDir, 'projects', uncompiledId, '_build');
    expect(fs.existsSync(path.join(buildDir, 'main.pdf'))).toBe(false);

    // Already-compiled mainProjectId: viewer can read existing PDF without triggering re-compilation
    const mainPdfPath = path.join(tmpDir, 'projects', mainProjectId, '_build', 'main.pdf');
    const mtimeBefore = fs.statSync(mainPdfPath).mtimeMs;
    const viewerPdfExisting = await viewerClient.request<{
      artifact: { format: string; base64?: string; byteLength: number };
    }>('POST', `/api/projects/${mainProjectId}/format/export`, {
      sourceScope: 'project',
      targetFormat: 'pdf',
    });
    expect(viewerPdfExisting.status).toBe(200);
    expect(viewerPdfExisting.data.artifact.format).toBe('pdf');
    expect(viewerPdfExisting.data.artifact.byteLength).toBeGreaterThan(1000);
    expect(fs.statSync(mainPdfPath).mtimeMs).toBe(mtimeBefore);
  });

  it('15. [P1-1] rejects collabToken on HTTP REST endpoints and revokes collabToken on logout', async () => {
    // Login on a fresh session so we can log it out without affecting ownerClient
    const sessClient = createHttpClient(baseUrl);
    const loginRes = await sessClient.request('POST', '/api/auth/login', {
      username: 'alice',
      password: 'password123',
    });
    expect(loginRes.status).toBe(200);

    const tokRes = await sessClient.request<{ token: string }>('GET', '/api/auth/collab-token');
    expect(tokRes.status).toBe(200);
    const collabToken = tokRes.data.token;

    // collabToken MUST NOT authenticate ANY HTTP REST API (all 401!)
    const anonClient = createHttpClient(baseUrl);
    const restProjects = await anonClient.request('GET', '/api/projects', undefined, {
      Authorization: `Bearer ${collabToken}`,
    });
    expect(restProjects.status).toBe(401);

    const restSyncTok = await anonClient.request(
      'POST',
      '/api/auth/sync-token',
      { label: 'stolen' },
      { Authorization: `Bearer ${collabToken}` },
    );
    expect(restSyncTok.status).toBe(401);

    const restAiCfg = await anonClient.request(
      'PUT',
      '/api/ai/config',
      { model: 'evil' },
      { Authorization: `Bearer ${collabToken}` },
    );
    expect(restAiCfg.status).toBe(401);

    // Verify collabToken works on WebSocket BEFORE logout
    const docBefore = new Y.Doc();
    let syncedBefore = false;
    const provBefore = new HocuspocusProvider({
      url: wsUrl,
      name: `${mainProjectId}::main.tex`,
      document: docBefore,
      token: collabToken,
      onSynced: ({ state }) => {
        if (state) syncedBefore = true;
      },
    });
    try {
      await waitForCondition(() => syncedBefore, 5000);
    } finally {
      provBefore.destroy();
      docBefore.destroy();
    }

    // Logout session -> previously issued collabToken MUST be immediately rejected on WebSocket /collab!
    const outRes = await sessClient.request('POST', '/api/auth/logout');
    expect(outRes.status).toBe(200);

    const docAfter = new Y.Doc();
    let failedAfterLogout = false;
    const provAfter = new HocuspocusProvider({
      url: wsUrl,
      name: `${mainProjectId}::main.tex`,
      document: docAfter,
      token: collabToken,
      onAuthenticationFailed: () => {
        failedAfterLogout = true;
      },
    });
    try {
      await waitForCondition(() => failedAfterLogout, 5000);
      expect(failedAfterLogout).toBe(true);
    } finally {
      provAfter.destroy();
      docAfter.destroy();
    }
  }, 15_000);

  it('16. [P1-1] supports sync-token listing & revocation and blocks sync-tokens on admin/token endpoints (403)', async () => {
    const createRes = await ownerClient.request<{ id: string; token: string; label: string }>(
      'POST',
      '/api/auth/sync-token',
      { label: 'revokable-cli' },
    );
    expect(createRes.status).toBe(201);
    const { id: tokenId, token: rawSyncToken } = createRes.data;
    expect(tokenId).toBeTruthy();

    // Sync token MUST be blocked (403) from admin AI config & creating/listing/revoking sync tokens
    const cli = createHttpClient(baseUrl);
    const bearer = { Authorization: `Bearer ${rawSyncToken}` };

    const aiGet = await cli.request('GET', '/api/ai/config', undefined, bearer);
    expect(aiGet.status).toBe(403);

    const aiPut = await cli.request('PUT', '/api/ai/config', { model: 'x' }, bearer);
    expect(aiPut.status).toBe(403);

    const aiTest = await cli.request('POST', '/api/ai/test', {}, bearer);
    expect(aiTest.status).toBe(403);

    const spawnToken = await cli.request('POST', '/api/auth/sync-token', { label: 'escalate' }, bearer);
    expect(spawnToken.status).toBe(403);

    // Cookie-authenticated user lists tokens (NO hashes/secrets exposed!)
    const listRes = await ownerClient.request<{
      tokens: Array<Record<string, unknown>>;
    }>('GET', '/api/auth/sync-tokens');
    expect(listRes.status).toBe(200);
    const found = listRes.data.tokens.find((t) => t.id === tokenId);
    expect(found).toBeDefined();
    expect(found?.label).toBe('revokable-cli');
    expect(found?.token_hash).toBeUndefined();
    expect(found?.token).toBeUndefined();

    // Revoke token -> Bearer auth MUST immediately fail with 401
    const delRes = await ownerClient.request<{ ok: boolean }>(
      'DELETE',
      `/api/auth/sync-tokens/${encodeURIComponent(tokenId)}`,
    );
    expect(delRes.status).toBe(200);
    expect(delRes.data.ok).toBe(true);

    const afterRevoke = await cli.request('GET', `/api/projects/${mainProjectId}/files`, undefined, bearer);
    expect(afterRevoke.status).toBe(401);
  });

  it('17. [P1-7] compiles Chinese main filename (中文论文.tex) and streams PDF + ZIP with RFC 5987 Content-Disposition', async () => {
    const createRes = await ownerClient.request<{ project: { id: string } }>('POST', '/api/projects', {
      name: '中文文件名测试项目',
      engine: 'xelatex',
      template: 'chinese-ctex',
    });
    expect(createRes.status).toBe(201);
    const cjkProjId = createRes.data.project.id;

    // Rename main.tex -> 中文论文.tex (also verifies mainFile auto-update!)
    const renameRes = await ownerClient.request('POST', `/api/projects/${cjkProjId}/files/rename`, {
      fromPath: 'main.tex',
      toPath: '中文论文.tex',
    });
    expect(renameRes.status).toBe(200);

    const compileRes = await ownerClient.request<{ result: { ok: boolean; pdfReady: boolean } }>(
      'POST',
      `/api/projects/${cjkProjId}/compile`,
      { engine: 'xelatex' },
    );
    expect(compileRes.status).toBe(200);
    expect(compileRes.data.result.ok).toBe(true);
    expect(compileRes.data.result.pdfReady).toBe(true);

    // Full PDF download MUST return 200 (NEVER 500 ERR_INVALID_CHAR!) with RFC 5987 Content-Disposition
    const pdfFull = await ownerClient.request('GET', `/api/projects/${cjkProjId}/pdf`);
    expect(pdfFull.status).toBe(200);
    const pdfCd = pdfFull.headers.get('content-disposition') ?? '';
    expect(pdfCd).toContain(`filename*=UTF-8''${encodeURIComponent('中文论文.pdf')}`);
    expect(pdfFull.rawBuffer.subarray(0, 5).toString('ascii')).toBe('%PDF-');

    // Range PDF request -> 206 Partial Content
    const pdfPartial = await ownerClient.request('GET', `/api/projects/${cjkProjId}/pdf`, undefined, {
      Range: 'bytes=0-255',
    });
    expect(pdfPartial.status).toBe(206);
    expect(pdfPartial.rawBuffer.byteLength).toBe(256);

    // ZIP export with Chinese project name also uses RFC 5987 Content-Disposition
    const zipExport = await ownerClient.request('GET', `/api/projects/${cjkProjId}/export-zip`);
    expect(zipExport.status).toBe(200);
    const zipCd = zipExport.headers.get('content-disposition') ?? '';
    expect(zipCd).toContain("filename*=UTF-8''");
  }, 60_000);

  it('18. [P0-2/P2-5/P2-6] blocks .GIT/config, dir-into-self rename, oversized passwords, CSRF Origin mismatch, and enforces auth rate limiting', async () => {
    // [P0-2] Case-insensitive .GIT/config and .gitmodules writes blocked with 400
    const gitUpperWrite = await ownerClient.request('PUT', `/api/projects/${mainProjectId}/file`, {
      path: '.GIT/config',
      content: '[core]\nfsmonitor = evil\n',
    });
    expect(gitUpperWrite.status).toBe(400);

    const gitModulesWrite = await ownerClient.request('PUT', `/api/projects/${mainProjectId}/file`, {
      path: '.gitmodules',
      content: '[submodule "x"]\n',
    });
    expect(gitModulesWrite.status).toBe(400);

    // [P0-2] Zip containing uppercase .GIT/config strips it safely
    const enc = new TextEncoder();
    const sneakyGitZip = zipSync({
      'main.tex': enc.encode('\\documentclass{article}\\begin{document}Hi\\end{document}\n'),
      '.GIT/config': enc.encode('[core]\nhooksPath = /tmp\n'),
      '.gitmodules': enc.encode('evil\n'),
    });
    const gitZipImport = await ownerClient.request<{ project: { id: string }; importedFiles: string[] }>(
      'POST',
      '/api/projects/import-zip',
      { name: 'Git Zip Clean', fileName: 'git-test.zip', base64: Buffer.from(sneakyGitZip).toString('base64') },
    );
    expect(gitZipImport.status).toBe(201);
    expect(gitZipImport.data.importedFiles).toEqual(['main.tex']);

    // [P2-5] Block moving directory into itself / descendant (sections -> sections/sub)
    const dirIntoSelf = await ownerClient.request(
      'POST',
      `/api/projects/${mainProjectId}/files/rename`,
      { fromPath: 'sections', toPath: 'sections/sub' },
    );
    expect(dirIntoSelf.status).toBe(400);

    // [P2-5] Base64 upload overwriting open text file patches live Yjs room cleanly
    const tok = await ownerClient.request<{ token: string }>('GET', '/api/auth/collab-token');
    const liveDoc = new Y.Doc();
    let liveSynced = false;
    const liveProv = new HocuspocusProvider({
      url: wsUrl,
      name: `${mainProjectId}::sections/imported.tex`,
      document: liveDoc,
      token: tok.data.token,
      onSynced: ({ state }) => {
        if (state) liveSynced = true;
      },
    });
    try {
      await waitForCondition(() => liveSynced, 5000);
      const b64Text = Buffer.from('\\section{Base64 Live Sync}\nUpdated via base64!\n', 'utf8').toString('base64');
      const b64Put = await ownerClient.request('PUT', `/api/projects/${mainProjectId}/file`, {
        path: 'sections/imported.tex',
        base64: b64Text,
      });
      expect(b64Put.status).toBe(200);
      await waitForCondition(
        () => liveDoc.getText('content').toString().includes('Updated via base64!'),
        5000,
      );
      expect(liveDoc.getText('content').toString()).toContain('Updated via base64!');
    } finally {
      liveProv.destroy();
      liveDoc.destroy();
    }

    // [P2-6] Password > 128 chars rejected with 400 on login & register
    const hugePassword = 'a'.repeat(129);
    const longLogin = await createHttpClient(baseUrl).request('POST', '/api/auth/login', {
      username: 'alice',
      password: hugePassword,
    });
    expect(longLogin.status).toBe(400);

    // [P2-6] CSRF Origin mismatch on Cookie-authenticated mutation -> 403
    const csrfRes = await ownerClient.request(
      'PUT',
      `/api/projects/${mainProjectId}/file`,
      { path: 'sections/csrf.tex', content: 'blocked' },
      { Origin: 'https://evil-attacker.example' },
    );
    expect(csrfRes.status).toBe(403);

    // [P2-6] Sliding-window auth rate limiter returns 429 after max attempts
    const rlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'novatex-rl-test-'));
    const rlServer = await createNovaTeXServer({
      port: 0,
      host: '127.0.0.1',
      dataDir: rlDir,
      loadDotEnv: false,
      authRateLimitMax: 3,
      authRateLimitWindowMs: 60_000,
    });
    try {
      const rlBound = await rlServer.start();
      const rlClient = createHttpClient(rlBound.url);
      for (let i = 0; i < 3; i++) {
        const r = await rlClient.request('POST', '/api/auth/login', {
          username: 'nobody',
          password: 'wrongpassword',
        });
        expect(r.status).toBe(401);
      }
      const throttled = await rlClient.request('POST', '/api/auth/login', {
        username: 'nobody',
        password: 'wrongpassword',
      });
      expect(throttled.status).toBe(429);
      expect(throttled.headers.get('retry-after')).toBeTruthy();
    } finally {
      await rlServer.close();
      fs.rmSync(rlDir, { recursive: true, force: true });
    }
  }, 20_000);

  it('19. [P1-R2-1] prevents zombie file/SQLite resurrection after renaming or deleting active Yjs rooms', async () => {
    const zProjRes = await ownerClient.request<{ project: { id: string } }>('POST', '/api/projects', {
      name: 'Zombie Guard Paper',
      template: 'clean-article',
      engine: 'pdflatex',
    });
    expect(zProjRes.status).toBe(201);
    const zProjId = zProjRes.data.project.id;

    // Seed tempdel.tex
    const seedDel = await ownerClient.request('PUT', `/api/projects/${zProjId}/file`, {
      path: 'tempdel.tex',
      content: 'Initial delete target\n',
    });
    expect(seedDel.status).toBe(200);

    const tokRes = await ownerClient.request<{ token: string }>('GET', '/api/auth/collab-token');
    expect(tokRes.status).toBe(200);
    const tok = tokRes.data.token;

    const introDoc = new Y.Doc();
    const delDoc = new Y.Doc();
    let introSynced = false;
    let delSynced = false;

    const introProv = new HocuspocusProvider({
      url: wsUrl,
      name: `${zProjId}::sections/intro.tex`,
      document: introDoc,
      token: tok,
      onSynced: ({ state }) => {
        if (state) introSynced = true;
      },
    });
    const delProv = new HocuspocusProvider({
      url: wsUrl,
      name: `${zProjId}::tempdel.tex`,
      document: delDoc,
      token: tok,
      onSynced: ({ state }) => {
        if (state) delSynced = true;
      },
    });

    try {
      await waitForCondition(() => introSynced && delSynced, 5000);

      // Edit BOTH active rooms to trigger pending Hocuspocus debounce timers
      introDoc.transact(() => {
        introDoc.getText('content').insert(introDoc.getText('content').length, '\n% LIVE_RENAME_EDIT\n');
      });
      delDoc.transact(() => {
        delDoc.getText('content').insert(delDoc.getText('content').length, '\n% LIVE_DELETE_EDIT\n');
      });
      await new Promise((r) => setTimeout(r, 80));

      // Immediately rename sections -> chapters and delete tempdel.tex within debounce window
      const renRes = await ownerClient.request('POST', `/api/projects/${zProjId}/files/rename`, {
        fromPath: 'sections',
        toPath: 'chapters',
      });
      expect(renRes.status).toBe(200);

      const delRes = await ownerClient.request(
        'DELETE',
        `/api/projects/${zProjId}/file?path=${encodeURIComponent('tempdel.tex')}`,
      );
      expect(delRes.status).toBe(200);

      // Wait well past debounce + maxDebounce to verify zero resurrection
      await new Promise((r) => setTimeout(r, 900));

      const srcDir = path.join(server.config.dataDir, 'projects', zProjId, 'src');
      expect(fs.existsSync(path.join(srcDir, 'sections'))).toBe(false);
      expect(fs.existsSync(path.join(srcDir, 'sections', 'intro.tex'))).toBe(false);
      expect(fs.existsSync(path.join(srcDir, 'tempdel.tex'))).toBe(false);
      expect(server.db.getYjsState(`${zProjId}::sections/intro.tex`)).toBeNull();
      expect(server.db.getYjsState(`${zProjId}::tempdel.tex`)).toBeNull();

      // New renamed file MUST exist and preserve the latest live edit
      const newIntroPath = path.join(srcDir, 'chapters', 'intro.tex');
      expect(fs.existsSync(newIntroPath)).toBe(true);
      expect(fs.readFileSync(newIntroPath, 'utf8')).toContain('% LIVE_RENAME_EDIT');
    } finally {
      introProv.destroy();
      delProv.destroy();
      introDoc.destroy();
      delDoc.destroy();
    }
  }, 15_000);

  it('20. [P1-R2-2] blocks admin sync-token and cross-origin providerOverride from exfiltrating stored DeepSeek apiKey', async () => {
    const syncRes = await ownerClient.request<{ token: string }>('POST', '/api/auth/sync-token', {
      label: 'admin-exfil-check',
    });
    expect(syncRes.status).toBe(201);
    const adminSyncToken = syncRes.data.token;

    // 1. Admin sync-token attempting providerOverride.baseUrl -> stripped, uses saved DeepSeek endpoint instead
    const capturedUrls: string[] = [];
    const exfilDir = fs.mkdtempSync(path.join(os.tmpdir(), 'novatex-exfil-test-'));
    const exfilServer = await createNovaTeXServer({
      port: 0,
      host: '127.0.0.1',
      dataDir: exfilDir,
      loadDotEnv: false,
      aiFetchImpl: async (input, init) => {
        const u = String(input);
        capturedUrls.push(u);
        const auth = new Headers(init?.headers).get('authorization') ?? '';
        if (u.includes('attacker-exfil.example')) {
          throw new Error(`EXFILTRATED_TO_ATTACKER auth=${auth}`);
        }
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    summaryZh: '已修复',
                    rootCauseZh: '测试',
                    actionsTakenZh: ['ok'],
                    patchedCode: '\\section{Safe}\n',
                  }),
                },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      },
    });
    try {
      const bound = await exfilServer.start();
      const adm = createHttpClient(bound.url);
      await adm.request('POST', '/api/auth/setup', {
        username: 'admin2',
        displayName: 'Admin2',
        password: 'password123',
      });
      await adm.request('PUT', '/api/ai/config', {
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: 'sk-SUPER-SECRET-ADMIN-KEY',
      });
      const pr = await adm.request<{ project: { id: string } }>('POST', '/api/projects', {
        name: 'Exfil Check',
        template: 'clean-article',
      });
      const st = await adm.request<{ token: string }>('POST', '/api/auth/sync-token', {
        label: 'test-token',
      });

      // Attempt via Bearer sync-token with attacker baseUrl -> MUST strip providerOverride and hit DeepSeek only
      const syncFix = await createHttpClient(bound.url).request(
        'POST',
        `/api/projects/${pr.data.project.id}/ai/fix`,
        {
          mode: 'diagnose-and-fix',
          filePath: 'main.tex',
          sourceCode: '\\section{Test}\n',
          providerOverride: { baseUrl: 'https://attacker-exfil.example/v1' },
        },
        { Authorization: `Bearer ${st.data.token}` },
      );
      expect(syncFix.status).toBe(200);
      expect(capturedUrls.every((u) => u.startsWith('https://api.deepseek.com/v1'))).toBe(true);
      expect(capturedUrls.some((u) => u.includes('attacker-exfil.example'))).toBe(false);

      // Even via Cookie admin, overriding baseUrl to a different origin without apiKey MUST NOT inherit saved apiKey
      const crossOriginFix = await adm.request(
        'POST',
        `/api/projects/${pr.data.project.id}/ai/fix`,
        {
          mode: 'diagnose-and-fix',
          filePath: 'main.tex',
          sourceCode: '\\section{Test}\n',
          providerOverride: { baseUrl: 'https://attacker-exfil.example/v1' },
        },
      );
      expect(crossOriginFix.status).toBeGreaterThanOrEqual(400);
      expect(capturedUrls.some((u) => u.includes('attacker-exfil.example'))).toBe(false);
    } finally {
      await exfilServer.close();
      fs.rmSync(exfilDir, { recursive: true, force: true });
    }
    expect(adminSyncToken.length).toBeGreaterThan(10);
  });

  it('21. [P2-R2-1] writes remote-compiled PDF and SyncTeX atomically without leaving .tmp artifacts', async () => {
    const http = await import('node:http');
    const mockWorker = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/compile') {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          const parsedBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
            projectId?: string;
          };
          const fakePdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\n%%EOF\n', 'utf8');
          const fakeSync = Buffer.from('SyncTeX Version:1\n', 'utf8');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              result: {
                jobId: 'remote-atomic-1',
                projectId: parsedBody.projectId ?? 'p',
                ok: true,
                engine: 'pdflatex',
                mainFile: 'main.tex',
                durationMs: 12,
                exitCode: 0,
                pdfReady: true,
                pdfSize: fakePdf.byteLength,
                synctexReady: true,
                linearized: false,
                diagnostics: [],
                errorCount: 0,
                warningCount: 0,
                rawLog: 'Output written on main.pdf',
                compilerAvailable: true,
                finishedAt: new Date().toISOString(),
              },
              pdfBase64: fakePdf.toString('base64'),
              synctexBase64: fakeSync.toString('base64'),
            }),
          );
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => mockWorker.listen(0, '127.0.0.1', resolve));
    const workerAddr = mockWorker.address();
    const workerPort = typeof workerAddr === 'object' && workerAddr ? workerAddr.port : 0;

    const remDir = fs.mkdtempSync(path.join(os.tmpdir(), 'novatex-remote-atomic-'));
    const remServer = await createNovaTeXServer({
      port: 0,
      host: '127.0.0.1',
      dataDir: remDir,
      loadDotEnv: false,
      compilerMode: 'remote',
      compilerUrl: `http://127.0.0.1:${workerPort}`,
      compilerSharedSecret: 'test-shared-secret',
    });
    try {
      const bound = await remServer.start();
      const cli = createHttpClient(bound.url);
      await cli.request('POST', '/api/auth/setup', {
        username: 'remuser',
        displayName: 'Remote',
        password: 'password123',
      });
      const pr = await cli.request<{ project: { id: string } }>('POST', '/api/projects', {
        name: 'Remote Atomic',
        template: 'clean-article',
      });
      const pid = pr.data.project.id;

      const comp = await cli.request<{ result: { ok: boolean; pdfReady: boolean } }>(
        'POST',
        `/api/projects/${pid}/compile`,
        { engine: 'pdflatex' },
      );
      expect(comp.status).toBe(200);
      expect(comp.data.result.ok).toBe(true);
      expect(comp.data.result.pdfReady).toBe(true);

      const buildDir = path.join(remDir, 'projects', pid, '_build');
      const entries = fs.readdirSync(buildDir);
      expect(entries).toContain('main.pdf');
      expect(entries).toContain('main.synctex');
      expect(entries.some((f) => f.includes('.tmp.'))).toBe(false);
    } finally {
      await remServer.close();
      await new Promise<void>((resolve) => mockWorker.close(() => resolve()));
      fs.rmSync(remDir, { recursive: true, force: true });
    }
  });

  it('22. changes user password securely, revokes other sessions, and blocks sync-token access', async () => {
    // Second active session for alice that should be invalidated on password change
    const otherSession = createHttpClient(baseUrl);
    const otherLogin = await otherSession.request('POST', '/api/auth/login', {
      username: 'alice',
      password: 'password123',
    });
    expect(otherLogin.status).toBe(200);

    // Sync token cannot change password -> 403
    const stRes = await ownerClient.request<{ token: string }>('POST', '/api/auth/sync-token', {
      label: 'pwd-check',
    });
    const syncChange = await createHttpClient(baseUrl).request(
      'POST',
      '/api/auth/change-password',
      { currentPassword: 'password123', newPassword: 'NewStrong!Password2026' },
      { Authorization: `Bearer ${stRes.data.token}` },
    );
    expect(syncChange.status).toBe(403);

    // Wrong current password -> 401
    const wrongCur = await ownerClient.request('POST', '/api/auth/change-password', {
      currentPassword: 'wrong-password',
      newPassword: 'NewStrong!Password2026',
    });
    expect(wrongCur.status).toBe(401);

    // Valid password change -> 200, keeps current session, revokes otherSession
    const okChange = await ownerClient.request('POST', '/api/auth/change-password', {
      currentPassword: 'password123',
      newPassword: 'NewStrong!Password2026',
    });
    expect(okChange.status).toBe(200);

    // Current session stays valid
    const selfStillOk = await ownerClient.request('GET', '/api/projects');
    expect(selfStillOk.status).toBe(200);

    // Other session is revoked immediately
    const otherRevoked = await otherSession.request('GET', '/api/projects');
    expect(otherRevoked.status).toBe(401);

    // Old password rejected, new password succeeds
    const oldPwdLogin = await createHttpClient(baseUrl).request('POST', '/api/auth/login', {
      username: 'alice',
      password: 'password123',
    });
    expect(oldPwdLogin.status).toBe(401);

    const newPwdLogin = await createHttpClient(baseUrl).request('POST', '/api/auth/login', {
      username: 'alice',
      password: 'NewStrong!Password2026',
    });
    expect(newPwdLogin.status).toBe(200);
  });

  it('23. fetches mocked /v1/models via POST /api/ai/models with BYOK isolation, blocks global scope & sync-token (403), and prevents cross-origin apiKey leakage', async () => {
    // 1. Admin Cookie passes bare origin (https://api.deepseek.com) -> auto-appends /v1, reuses same-origin saved apiKey, returns sorted models
    const beforeAdminCount = capturedAiRequests.length;
    const adminModelsRes = await ownerClient.request<{
      ok: boolean;
      models: string[];
      normalizedBaseUrl: string;
      latencyMs: number;
      message: string;
    }>('POST', '/api/ai/models', {
      baseUrl: 'https://api.deepseek.com',
    });
    expect(adminModelsRes.status).toBe(200);
    expect(adminModelsRes.data.ok).toBe(true);
    expect(adminModelsRes.data.normalizedBaseUrl).toBe('https://api.deepseek.com/v1');
    expect(adminModelsRes.data.models).toEqual([
      'deepseek-chat',
      'trae-cn/volc/deepseek-v4-1-flash',
      'gemini-2.5-flash',
      'claude-3-7-sonnet',
      'gpt-4o',
    ]);
    expect(capturedAiRequests.length).toBe(beforeAdminCount + 1);
    const adminFetchCall = capturedAiRequests[capturedAiRequests.length - 1]!;
    expect(adminFetchCall.method).toBe('GET');
    expect(adminFetchCall.url).toBe('https://api.deepseek.com/v1/models');
    expect(adminFetchCall.auth).toBe('Bearer sk-secret-test-key-9999');

    // 2a. Non-admin viewer requesting scope:'global' returns 403 and triggers ZERO outbound AI calls
    const beforeViewerCount = capturedAiRequests.length;
    const viewerGlobalModelsRes = await viewerClient.request('POST', '/api/ai/models', {
      scope: 'global',
      baseUrl: 'https://api.deepseek.com',
    });
    expect(viewerGlobalModelsRes.status).toBe(403);
    expect(capturedAiRequests.length).toBe(beforeViewerCount);

    // 2b. Non-admin viewer WITHOUT personal key calling without scope NEVER leaks admin's global key (ok:false, 0 outbound calls!)
    const viewerNoKeyRes = await viewerClient.request<{
      ok: boolean;
      models: string[];
      error?: string;
    }>('POST', '/api/ai/models', {
      baseUrl: 'https://api.deepseek.com',
    });
    expect(viewerNoKeyRes.status).toBe(200);
    expect(viewerNoKeyRes.data.ok).toBe(false);
    expect(viewerNoKeyRes.data.models).toEqual([]);
    expect(viewerNoKeyRes.data.error).toContain('API Key');
    expect(capturedAiRequests.length).toBe(beforeViewerCount);

    // 2c. Non-admin viewer WITH their own explicit key succeeds and hits ONLY their own endpoint/key
    const viewerOwnKeyRes = await viewerClient.request<{
      ok: boolean;
      models: string[];
      normalizedBaseUrl: string;
    }>('POST', '/api/ai/models', {
      scope: 'personal',
      baseUrl: 'https://viewer-own-models.example',
      apiKey: 'sk-viewer-explicit-key',
    });
    expect(viewerOwnKeyRes.status).toBe(200);
    expect(viewerOwnKeyRes.data.ok).toBe(true);
    expect(viewerOwnKeyRes.data.normalizedBaseUrl).toBe('https://viewer-own-models.example/v1');
    const viewerOwnCall = capturedAiRequests[capturedAiRequests.length - 1]!;
    expect(viewerOwnCall.url).toBe('https://viewer-own-models.example/v1/models');
    expect(viewerOwnCall.auth).toBe('Bearer sk-viewer-explicit-key');

    // 3. Admin Bearer sync-token returns 403 and triggers ZERO outbound AI calls
    const syncTokenRes = await ownerClient.request<{ token: string }>('POST', '/api/auth/sync-token', {
      label: 'models-sync-check',
    });
    expect(syncTokenRes.status).toBe(201);
    const beforeSyncCount = capturedAiRequests.length;
    const syncModelsRes = await createHttpClient(baseUrl).request(
      'POST',
      '/api/ai/models',
      { baseUrl: 'https://api.deepseek.com' },
      { Authorization: `Bearer ${syncTokenRes.data.token}` },
    );
    expect(syncModelsRes.status).toBe(403);
    expect(capturedAiRequests.length).toBe(beforeSyncCount);

    // 4. Admin Cookie passing cross-origin baseUrl WITHOUT apiKey MUST NOT leak stored apiKey
    const beforeCrossCount = capturedAiRequests.length;
    const crossOriginNoKeyRes = await ownerClient.request<{
      ok: boolean;
      models: string[];
      normalizedBaseUrl: string;
      error?: string;
    }>('POST', '/api/ai/models', {
      baseUrl: 'https://attacker-models.example',
    });
    expect(crossOriginNoKeyRes.status).toBe(200);
    expect(crossOriginNoKeyRes.data.ok).toBe(false);
    expect(crossOriginNoKeyRes.data.models).toEqual([]);
    expect(crossOriginNoKeyRes.data.normalizedBaseUrl).toBe('https://attacker-models.example/v1');
    expect(crossOriginNoKeyRes.data.error).toContain('API Key');
    expect(capturedAiRequests.length).toBe(beforeCrossCount);
    expect(capturedAiRequests.some((r) => r.url.includes('attacker-models.example'))).toBe(false);

    // 5. Admin Cookie passing cross-origin relay WITH explicit apiKey uses ONLY the explicit key (not saved DeepSeek key)
    const crossOriginWithKeyRes = await ownerClient.request<{
      ok: boolean;
      models: string[];
      normalizedBaseUrl: string;
    }>('POST', '/api/ai/models', {
      baseUrl: 'https://relay.example.com',
      apiKey: 'sk-relay-explicit-key',
    });
    expect(crossOriginWithKeyRes.status).toBe(200);
    expect(crossOriginWithKeyRes.data.ok).toBe(true);
    expect(crossOriginWithKeyRes.data.normalizedBaseUrl).toBe('https://relay.example.com/v1');
    const relayCall = capturedAiRequests[capturedAiRequests.length - 1]!;
    expect(relayCall.url).toBe('https://relay.example.com/v1/models');
    expect(relayCall.auth).toBe('Bearer sk-relay-explicit-key');

    // 6. SSRF metadata target rejected with 400 and triggers ZERO outbound calls
    const beforeSsrfCount = capturedAiRequests.length;
    const ssrfModelsRes = await ownerClient.request('POST', '/api/ai/models', {
      baseUrl: 'http://169.254.169.254/latest/meta-data',
    });
    expect(ssrfModelsRes.status).toBe(400);
    expect(capturedAiRequests.length).toBe(beforeSsrfCount);
  });

  it('24. supports full Per-User BYOK AI lifecycle with strict global-key isolation and fallback', async () => {
    // Invite a dedicated editor member to mainProjectId
    const invRes = await ownerClient.request<{ invite: { token: string } }>(
      'POST',
      `/api/projects/${mainProjectId}/invites`,
      { role: 'editor', expiresInHours: 24, maxUses: 5 },
    );
    expect(invRes.status).toBe(201);

    const memberClient = createHttpClient(baseUrl);
    const regRes = await memberClient.request<{ user: { id: string; username: string; role: string } }>(
      'POST',
      '/api/auth/register',
      {
        username: 'byok_member',
        displayName: 'BYOK Member',
        password: 'password123',
        inviteToken: invRes.data.invite.token,
      },
    );
    expect(regRes.status).toBe(201);
    expect(regRes.data.user.role).toBe('member');

    // 1. Before saving personal key: effectiveSource === 'global', personal.hasApiKey === false, zero secret leak
    const initOverview = await memberClient.request<{
      config: Record<string, unknown>;
      personal: Record<string, unknown>;
      global: Record<string, unknown>;
      effectiveSource: string;
      allowPublicRegister: boolean;
    }>('GET', '/api/ai/config');
    expect(initOverview.status).toBe(200);
    expect(initOverview.data.effectiveSource).toBe('global');
    expect(initOverview.data.personal.hasApiKey).toBe(false);
    expect(initOverview.data.global.hasApiKey).toBe(true);
    expect(initOverview.data.config.hasApiKey).toBe(true);
    expect(JSON.stringify(initOverview.data)).not.toContain('sk-secret-test-key-9999');

    // 2. Member trying scope:'global' on test/models gets 403 and triggers 0 outbound calls
    const beforeBlocked = capturedAiRequests.length;
    const globalTest403 = await memberClient.request('POST', '/api/ai/test', { scope: 'global' });
    expect(globalTest403.status).toBe(403);
    const globalModels403 = await memberClient.request('POST', '/api/ai/models', { scope: 'global' });
    expect(globalModels403.status).toBe(403);
    expect(capturedAiRequests.length).toBe(beforeBlocked);

    // 3. Member on global fallback attempting cross-origin providerOverride CANNOT exfiltrate admin's global key
    const beforeExfilFix = capturedAiRequests.length;
    const fallbackOverrideFix = await memberClient.request<{ ok: boolean }>(
      'POST',
      `/api/projects/${mainProjectId}/ai/fix`,
      {
        mode: 'diagnose-and-fix',
        filePath: 'main.tex',
        sourceCode: '\\section{Test}\nHello \\textbfx{world}.\n',
        providerOverride: { baseUrl: 'https://evil-member-exfil.example/v1' },
      },
    );
    expect(fallbackOverrideFix.status).toBe(200);
    expect(fallbackOverrideFix.data.ok).toBe(true);
    expect(capturedAiRequests.length).toBe(beforeExfilFix + 1);
    const fallbackCall = capturedAiRequests[capturedAiRequests.length - 1]!;
    expect(fallbackCall.url).toBe('https://api.deepseek.com/v1/chat/completions');
    expect(fallbackCall.auth).toBe('Bearer sk-secret-test-key-9999');
    expect(capturedAiRequests.some((r) => r.url.includes('evil-member-exfil.example'))).toBe(false);

    // 4. SSRF blocked on PUT /api/ai/config/me -> 400
    const memberSsrf = await memberClient.request('PUT', '/api/ai/config/me', {
      baseUrl: 'http://169.254.169.254/latest/meta-data',
      apiKey: 'sk-member-ssrf',
    });
    expect(memberSsrf.status).toBe(400);

    // 5. Member saves personal BYOK config via PUT /api/ai/config/me
    const savePersonal = await memberClient.request<{
      config: Record<string, unknown>;
      personal: Record<string, unknown>;
      global: Record<string, unknown>;
      effectiveSource: string;
    }>('PUT', '/api/ai/config/me', {
      baseUrl: 'https://member-byok.example',
      apiKey: 'sk-member-personal-key-777',
      model: 'member-chat-model',
      reasonerModel: 'member-reasoner-model',
    });
    expect(savePersonal.status).toBe(200);
    expect(savePersonal.data.effectiveSource).toBe('personal');
    expect(savePersonal.data.personal.hasApiKey).toBe(true);
    expect(savePersonal.data.personal.baseUrl).toBe('https://member-byok.example/v1');
    expect(savePersonal.data.personal.model).toBe('member-chat-model');
    expect(savePersonal.data.config.baseUrl).toBe('https://member-byok.example/v1');
    expect(savePersonal.data.global.baseUrl).toBe('https://api.deepseek.com/v1');
    expect(JSON.stringify(savePersonal.data)).not.toContain('sk-member-personal-key-777');
    expect(JSON.stringify(savePersonal.data)).not.toContain('sk-secret-test-key-9999');

    // Admin's view stays completely isolated from member's personal key
    const adminCheck = await ownerClient.request<{
      effectiveSource: string;
      personal: { hasApiKey: boolean };
      config: { baseUrl: string };
    }>('GET', '/api/ai/config');
    expect(adminCheck.status).toBe(200);
    expect(adminCheck.data.effectiveSource).toBe('global');
    expect(adminCheck.data.personal.hasApiKey).toBe(false);
    expect(adminCheck.data.config.baseUrl).toBe('https://api.deepseek.com/v1');

    // 6. Member tests connection & fetches models using own saved personal key
    const memberTest = await memberClient.request<{ ok: boolean; model: string }>(
      'POST',
      '/api/ai/test',
      { scope: 'personal' },
    );
    expect(memberTest.status).toBe(200);
    expect(memberTest.data.ok).toBe(true);
    expect(memberTest.data.model).toBe('member-chat-model');
    const testCall = capturedAiRequests[capturedAiRequests.length - 1]!;
    expect(testCall.url).toBe('https://member-byok.example/v1/chat/completions');
    expect(testCall.auth).toBe('Bearer sk-member-personal-key-777');

    const memberModels = await memberClient.request<{ ok: boolean; models: string[] }>(
      'POST',
      '/api/ai/models',
      { scope: 'personal' },
    );
    expect(memberModels.status).toBe(200);
    expect(memberModels.data.ok).toBe(true);
    expect(memberModels.data.models.length).toBeGreaterThan(0);
    const modelsCall = capturedAiRequests[capturedAiRequests.length - 1]!;
    expect(modelsCall.url).toBe('https://member-byok.example/v1/models');
    expect(modelsCall.auth).toBe('Bearer sk-member-personal-key-777');

    // 7. Member runs ai/fix -> hits member's personal endpoint & key, NOT admin's DeepSeek key
    const memberFix = await memberClient.request<{ ok: boolean; patchedCode: string }>(
      'POST',
      `/api/projects/${mainProjectId}/ai/fix`,
      {
        mode: 'diagnose-and-fix',
        filePath: 'main.tex',
        sourceCode: '\\section{Test}\nHello \\textbfx{world}.\n',
      },
    );
    expect(memberFix.status).toBe(200);
    expect(memberFix.data.ok).toBe(true);
    const memberFixCall = capturedAiRequests[capturedAiRequests.length - 1]!;
    expect(memberFixCall.url).toBe('https://member-byok.example/v1/chat/completions');
    expect(memberFixCall.auth).toBe('Bearer sk-member-personal-key-777');

    // 8. Member's sync token cannot mutate personal AI config -> 403
    const memberSyncTok = await memberClient.request<{ token: string }>('POST', '/api/auth/sync-token', {
      label: 'member-cli',
    });
    expect(memberSyncTok.status).toBe(201);
    const syncPutMe = await createHttpClient(baseUrl).request(
      'PUT',
      '/api/ai/config/me',
      { model: 'hacked' },
      { Authorization: `Bearer ${memberSyncTok.data.token}` },
    );
    expect(syncPutMe.status).toBe(403);
    const syncDelMe = await createHttpClient(baseUrl).request(
      'DELETE',
      '/api/ai/config/me',
      undefined,
      { Authorization: `Bearer ${memberSyncTok.data.token}` },
    );
    expect(syncDelMe.status).toBe(403);

    // 9. Member deletes own personal key -> falls back cleanly to global config
    const delPersonal = await memberClient.request<{
      ok: boolean;
      effectiveSource: string;
      personal: { hasApiKey: boolean };
      global: { hasApiKey: boolean };
      config: { baseUrl: string };
    }>('DELETE', '/api/ai/config/me');
    expect(delPersonal.status).toBe(200);
    expect(delPersonal.data.ok).toBe(true);
    expect(delPersonal.data.effectiveSource).toBe('global');
    expect(delPersonal.data.personal.hasApiKey).toBe(false);
    expect(delPersonal.data.global.hasApiKey).toBe(true);
    expect(delPersonal.data.config.baseUrl).toBe('https://api.deepseek.com/v1');

    // Verify subsequent ai/fix hits admin's global endpoint again
    const afterDelFix = await memberClient.request<{ ok: boolean }>(
      'POST',
      `/api/projects/${mainProjectId}/ai/fix`,
      {
        mode: 'diagnose-and-fix',
        filePath: 'main.tex',
        sourceCode: '\\section{Test}\nHello \\textbfx{world}.\n',
      },
    );
    expect(afterDelFix.status).toBe(200);
    expect(afterDelFix.data.ok).toBe(true);
    const afterDelCall = capturedAiRequests[capturedAiRequests.length - 1]!;
    expect(afterDelCall.url).toBe('https://api.deepseek.com/v1/chat/completions');
    expect(afterDelCall.auth).toBe('Bearer sk-secret-test-key-9999');
  });

  it('25. keeps allowPublicRegister strictly governed by server .env (no web toggle endpoint)', async () => {
    // PUT /api/admin/settings is intentionally not exposed so registration cannot be opened from web UI
    const adminAttempt = await ownerClient.request('PUT', '/api/admin/settings', {
      allowPublicRegister: true,
    });
    expect(adminAttempt.status).toBe(404);

    const viewerAttempt = await viewerClient.request('PUT', '/api/admin/settings', {
      allowPublicRegister: true,
    });
    expect(viewerAttempt.status).toBe(404);

    // /api/health, /api/auth/me, and /api/ai/config all stay strictly false (from server config)
    const health = await ownerClient.request<{
      capabilities: { auth: { allowPublicRegister: boolean } };
    }>('GET', '/api/health');
    expect(health.status).toBe(200);
    expect(health.data.capabilities.auth.allowPublicRegister).toBe(false);

    const me = await ownerClient.request<{ allowPublicRegister: boolean }>('GET', '/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.data.allowPublicRegister).toBe(false);

    const aiCfg = await ownerClient.request<{ allowPublicRegister: boolean }>(
      'GET',
      '/api/ai/config',
    );
    expect(aiCfg.status).toBe(200);
    expect(aiCfg.data.allowPublicRegister).toBe(false);

    // Uninvited public registration remains strictly blocked -> 403
    const blockedReg = await createHttpClient(baseUrl).request('POST', '/api/auth/register', {
      username: 'blocked_public_user',
      displayName: 'Blocked User',
      password: 'password123',
    });
    expect(blockedReg.status).toBe(403);
  });

  it('26. runs one-shot POST /api/projects/:id/format/md-compile preserving preamble, citations, live Yjs, and compiling real XeLaTeX PDF', async () => {
    // Create a dedicated chinese-ctex project for isolated one-shot MD -> LaTeX -> XeLaTeX compilation
    const projRes = await ownerClient.request<{ project: { id: string } }>('POST', '/api/projects', {
      name: 'MD一键编译端到端测试',
      engine: 'xelatex',
      template: 'chinese-ctex',
    });
    expect(projRes.status).toBe(201);
    const mdProjId = projRes.data.project.id;

    // Seed knuth1984 in refs.bib so BibTeX resolves \cite{knuth1984} cleanly without missing-entry warnings
    const bibRead = await ownerClient.request<{ content: string }>(
      'GET',
      `/api/projects/${mdProjId}/file?path=refs.bib`,
    );
    expect(bibRead.status).toBe(200);
    const bibUpdate = await ownerClient.request('PUT', `/api/projects/${mdProjId}/file`, {
      path: 'refs.bib',
      content: `${bibRead.data.content}\n@book{knuth1984,\n  title={The TeXbook},\n  author={Knuth, Donald E.},\n  publisher={Addison-Wesley},\n  year={1984}\n}\n`,
    });
    expect(bibUpdate.status).toBe(200);

    // Connect a live Hocuspocus Yjs WebSocket client to main.tex to verify real-time push
    const tokRes = await ownerClient.request<{ token: string }>('GET', '/api/auth/collab-token');
    expect(tokRes.status).toBe(200);
    const liveDoc = new Y.Doc();
    let liveSynced = false;
    const liveProvider = new HocuspocusProvider({
      url: wsUrl,
      name: `${mdProjId}::main.tex`,
      document: liveDoc,
      token: tokRes.data.token,
      onSynced: ({ state }) => {
        if (state) liveSynced = true;
      },
    });

    try {
      await waitForCondition(() => liveSynced, 8000);
      expect(liveDoc.getText('content').toString()).toContain('\\documentclass{ctexart}');

      const mdPayload = [
        '# 实验与能量分析',
        '',
        '根据经典质能关系 $E=mc^2$ 与排版理论 [@knuth1984]，系统能够自动保留导言区并生成可编译 PDF。',
        '',
      ].join('\n');

      const mdCompileRes = await ownerClient.request<{
        ok: boolean;
        targetFile: string;
        mergedCode: string;
        mergePreview: {
          targetFile: string;
          originalCode: string;
          mergedCode: string;
          diff: { additions: number; deletions: number };
        };
        warnings: string[];
        compileResult: {
          ok: boolean;
          compilerAvailable: boolean;
          exitCode: number;
          pdfReady: boolean;
          pdfSize: number;
        };
      }>('POST', `/api/projects/${mdProjId}/format/md-compile`, {
        markdown: mdPayload,
        targetFile: 'main.tex',
        engine: 'xelatex',
        commitMessage: 'MD一键编译快照',
      });

      expect(mdCompileRes.status).toBe(200);
      expect(mdCompileRes.data.ok).toBe(true);
      expect(mdCompileRes.data.targetFile).toBe('main.tex');
      // Preamble & trailing bibliography 100% preserved
      expect(mdCompileRes.data.mergedCode).toContain('\\documentclass{ctexart}');
      expect(mdCompileRes.data.mergedCode).toContain('\\usepackage{booktabs}');
      expect(mdCompileRes.data.mergedCode).toContain('\\bibliography{refs}');
      // Converted Markdown heading, math, and citation preserved
      expect(mdCompileRes.data.mergedCode).toContain('实验与能量分析');
      expect(mdCompileRes.data.mergedCode).toMatch(/E\s*=\s*mc\^2/);
      expect(mdCompileRes.data.mergedCode).toContain('\\cite{knuth1984}');
      expect(mdCompileRes.data.mergePreview.targetFile).toBe('main.tex');
      expect(mdCompileRes.data.mergePreview.diff.additions).toBeGreaterThan(0);
      // Real XeLaTeX compilation succeeded
      expect(mdCompileRes.data.compileResult.compilerAvailable).toBe(true);
      expect(mdCompileRes.data.compileResult.ok).toBe(true);
      expect(mdCompileRes.data.compileResult.exitCode).toBe(0);
      expect(mdCompileRes.data.compileResult.pdfReady).toBe(true);
      expect(mdCompileRes.data.compileResult.pdfSize).toBeGreaterThan(1000);

      // Connected live Yjs WebSocket client received the patched main.tex cleanly
      await waitForCondition(
        () => liveDoc.getText('content').toString().includes('\\cite{knuth1984}'),
        5000,
      );
      expect(liveDoc.getText('content').toString()).toContain('\\documentclass{ctexart}');
      expect(liveDoc.getText('content').toString()).toContain('实验与能量分析');

      // PDF endpoint streams real compiled PDF
      const pdfRes = await ownerClient.request('GET', `/api/projects/${mdProjId}/pdf`);
      expect(pdfRes.status).toBe(200);
      expect(pdfRes.rawBuffer.subarray(0, 5).toString('ascii')).toBe('%PDF-');

      // Git checkpoint was recorded
      const logRes = await ownerClient.request<{ commits: Array<{ message: string }> }>(
        'GET',
        `/api/projects/${mdProjId}/git/log`,
      );
      expect(logRes.status).toBe(200);
      expect(logRes.data.commits.some((c) => c.message === 'MD一键编译快照')).toBe(true);

      // Viewer role cannot invoke md-compile -> 403
      const invViewer = await ownerClient.request<{ invite: { token: string } }>(
        'POST',
        `/api/projects/${mdProjId}/invites`,
        { role: 'viewer', expiresInHours: 24, maxUses: 2 },
      );
      await viewerClient.request(
        'POST',
        `/api/invites/${encodeURIComponent(invViewer.data.invite.token)}/accept`,
      );
      const viewerMdCompile = await viewerClient.request(
        'POST',
        `/api/projects/${mdProjId}/format/md-compile`,
        { markdown: '# Forbidden\n' },
      );
      expect(viewerMdCompile.status).toBe(403);
    } finally {
      liveProvider.destroy();
      liveDoc.destroy();
    }
  }, 60_000);

  it('27. [P0-R3] blocks non-admin BYOK SSRF to loopback & private IPv4/IPv6 across config/me, test, models, and ai/fix with 0 outbound calls', async () => {
    const ssrfTargets = [
      'http://127.0.0.1:9999',
      'http://localhost:9999',
      'http://[::1]:9999',
      'http://10.0.0.1/v1',
      'http://192.168.1.1/v1',
      'http://[fc00::1]/v1',
    ];

    const beforeCount = capturedAiRequests.length;
    for (const target of ssrfTargets) {
      const putMe = await viewerClient.request('PUT', '/api/ai/config/me', {
        baseUrl: target,
        apiKey: 'sk-ssrf-probe-key',
      });
      expect(putMe.status, `PUT /api/ai/config/me should block ${target}`).toBe(400);

      const testMe = await viewerClient.request('POST', '/api/ai/test', {
        scope: 'personal',
        baseUrl: target,
        apiKey: 'sk-ssrf-probe-key',
      });
      expect(testMe.status, `POST /api/ai/test should block ${target}`).toBe(400);

      const modelsMe = await viewerClient.request('POST', '/api/ai/models', {
        scope: 'personal',
        baseUrl: target,
        apiKey: 'sk-ssrf-probe-key',
      });
      expect(modelsMe.status, `POST /api/ai/models should block ${target}`).toBe(400);
    }
    expect(capturedAiRequests.length).toBe(beforeCount);

    // Admin is ALSO blocked by default unless ALLOW_PRIVATE_AI_HOSTS === 'true'
    const adminPrivatePut = await ownerClient.request('PUT', '/api/ai/config', {
      baseUrl: 'http://127.0.0.1:9999',
    });
    expect(adminPrivatePut.status).toBe(400);
    const adminPrivateTest = await ownerClient.request('POST', '/api/ai/test', {
      scope: 'global',
      baseUrl: 'http://10.0.0.1/v1',
      apiKey: 'sk-admin-ssrf',
    });
    expect(adminPrivateTest.status).toBe(400);
    expect(capturedAiRequests.length).toBe(beforeCount);

    // Even when ALLOW_PRIVATE_AI_HOSTS=true is enabled for admin, non-admin users remain strictly blocked
    const prevEnv = process.env.ALLOW_PRIVATE_AI_HOSTS;
    process.env.ALLOW_PRIVATE_AI_HOSTS = 'true';
    try {
      const nonAdminStillBlockedPut = await viewerClient.request('PUT', '/api/ai/config/me', {
        baseUrl: 'http://127.0.0.1:9999',
        apiKey: 'sk-ssrf-probe-key',
      });
      expect(nonAdminStillBlockedPut.status).toBe(400);

      const nonAdminStillBlockedTest = await viewerClient.request('POST', '/api/ai/test', {
        scope: 'personal',
        baseUrl: 'http://localhost:9999',
        apiKey: 'sk-ssrf-probe-key',
      });
      expect(nonAdminStillBlockedTest.status).toBe(400);

      const nonAdminStillBlockedModels = await viewerClient.request('POST', '/api/ai/models', {
        scope: 'personal',
        baseUrl: 'http://[fc00::1]/v1',
        apiKey: 'sk-ssrf-probe-key',
      });
      expect(nonAdminStillBlockedModels.status).toBe(400);
      expect(capturedAiRequests.length).toBe(beforeCount);
    } finally {
      if (prevEnv === undefined) {
        delete process.env.ALLOW_PRIVATE_AI_HOSTS;
      } else {
        process.env.ALLOW_PRIVATE_AI_HOSTS = prevEnv;
      }
    }

    // Non-admin editor with personal key attempting private providerOverride on POST /ai/fix is blocked (400, 0 calls)
    const invEd = await ownerClient.request<{ invite: { token: string } }>(
      'POST',
      `/api/projects/${mainProjectId}/invites`,
      { role: 'editor', expiresInHours: 24, maxUses: 2 },
    );
    const ssrfEditor = createHttpClient(baseUrl);
    await ssrfEditor.request('POST', '/api/auth/register', {
      username: 'ssrf_editor',
      displayName: 'SSRF Editor',
      password: 'password123',
      inviteToken: invEd.data.invite.token,
    });
    const savePub = await ssrfEditor.request('PUT', '/api/ai/config/me', {
      baseUrl: 'https://public-editor.example/v1',
      apiKey: 'sk-editor-public-key',
    });
    expect(savePub.status).toBe(200);

    const beforeFixCount = capturedAiRequests.length;
    const fixSsrf = await ssrfEditor.request('POST', `/api/projects/${mainProjectId}/ai/fix`, {
      mode: 'diagnose-and-fix',
      filePath: 'main.tex',
      sourceCode: '\\section{Test}\n',
      providerOverride: { baseUrl: 'http://127.0.0.1:9999/v1', apiKey: 'sk-override' },
    });
    expect(fixSsrf.status).toBe(400);
    expect(capturedAiRequests.length).toBe(beforeFixCount);
  });

  it('28. [P1-R3] clears saved apiKey on cross-origin PUT /api/ai/config/me and PUT /api/ai/config when apiKey is omitted', async () => {
    // 1. Personal config: save DeepSeek key -> switch to new origin without apiKey -> key MUST be wiped
    const saveMe = await viewerClient.request<{
      personal: { hasApiKey: boolean; baseUrl: string };
    }>('PUT', '/api/ai/config/me', {
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'sk-personal-old-deepseek-key',
      model: 'deepseek-chat',
    });
    expect(saveMe.status).toBe(200);
    expect(saveMe.data.personal.hasApiKey).toBe(true);

    // Same-origin path update without apiKey preserves key
    const sameOriginMe = await viewerClient.request<{
      personal: { hasApiKey: boolean; baseUrl: string };
    }>('PUT', '/api/ai/config/me', {
      baseUrl: 'https://api.deepseek.com/beta',
    });
    expect(sameOriginMe.status).toBe(200);
    expect(sameOriginMe.data.personal.hasApiKey).toBe(true);

    // Cross-origin update without apiKey MUST clear hasApiKey to false
    const crossOriginMe = await viewerClient.request<{
      personal: { hasApiKey: boolean; baseUrl: string };
    }>('PUT', '/api/ai/config/me', {
      baseUrl: 'https://evil-personal-relay.example/v1',
    });
    expect(crossOriginMe.status).toBe(200);
    expect(crossOriginMe.data.personal.baseUrl).toBe('https://evil-personal-relay.example/v1');
    expect(crossOriginMe.data.personal.hasApiKey).toBe(false);

    const beforeMeTest = capturedAiRequests.length;
    const testAfterCrossMe = await viewerClient.request<{ ok: boolean; error?: string }>(
      'POST',
      '/api/ai/test',
      { scope: 'personal' },
    );
    expect(testAfterCrossMe.status).toBe(200);
    expect(testAfterCrossMe.data.ok).toBe(false);
    expect(capturedAiRequests.length).toBe(beforeMeTest);
    expect(
      capturedAiRequests.some((r) => r.url.includes('evil-personal-relay.example')),
    ).toBe(false);
    await viewerClient.request('DELETE', '/api/ai/config/me');

    // 2. Global config: save DeepSeek key -> switch to new origin without apiKey -> key MUST be wiped
    const saveGlobal = await ownerClient.request<{
      global: { hasApiKey: boolean; baseUrl: string };
    }>('PUT', '/api/ai/config', {
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'sk-global-old-deepseek-key',
      model: 'deepseek-chat',
    });
    expect(saveGlobal.status).toBe(200);
    expect(saveGlobal.data.global.hasApiKey).toBe(true);

    const crossOriginGlobal = await ownerClient.request<{
      config: { hasApiKey: boolean; baseUrl: string };
      global: { hasApiKey: boolean; baseUrl: string };
    }>('PUT', '/api/ai/config', {
      baseUrl: 'https://evil-global-relay.example/v1',
    });
    expect(crossOriginGlobal.status).toBe(200);
    expect(crossOriginGlobal.data.global.baseUrl).toBe('https://evil-global-relay.example/v1');
    expect(crossOriginGlobal.data.global.hasApiKey).toBe(false);
    expect(crossOriginGlobal.data.config.hasApiKey).toBe(false);

    const beforeGlobalTest = capturedAiRequests.length;
    const testAfterCrossGlobal = await ownerClient.request<{ ok: boolean; error?: string }>(
      'POST',
      '/api/ai/test',
      { scope: 'global' },
    );
    expect(testAfterCrossGlobal.status).toBe(200);
    expect(testAfterCrossGlobal.data.ok).toBe(false);
    expect(capturedAiRequests.length).toBe(beforeGlobalTest);
    expect(
      capturedAiRequests.some((r) => r.url.includes('evil-global-relay.example')),
    ).toBe(false);

    // Restore clean global config for subsequent tests
    const restoreGlobal = await ownerClient.request('PUT', '/api/ai/config', {
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'sk-secret-test-key-9999',
      model: 'deepseek-chat',
      reasonerModel: 'deepseek-reasoner',
    });
    expect(restoreGlobal.status).toBe(200);
  });

  it('29. [P2-R3] encrypts user_ai_configs and app_settings(ai_config) with AES-256-GCM (enc:v1:) at rest and decrypts transparently', async () => {
    const userPlainKey = 'sk-user-aes-gcm-secret-9999';
    const globalPlainKey = 'sk-global-aes-gcm-secret-8888';

    const saveUser = await viewerClient.request('PUT', '/api/ai/config/me', {
      baseUrl: 'https://enc-user.example/v1',
      apiKey: userPlainKey,
      model: 'deepseek-chat',
    });
    expect(saveUser.status).toBe(200);

    const saveGlobal = await ownerClient.request('PUT', '/api/ai/config', {
      baseUrl: 'https://enc-global.example/v1',
      apiKey: globalPlainKey,
      model: 'deepseek-chat',
    });
    expect(saveGlobal.status).toBe(200);

    // Inspect raw SQLite rows directly to guarantee NO plaintext API key exists on disk
    const rawDb = new DatabaseSync(path.join(tmpDir, 'novatex.db'));
    try {
      const viewerRow = rawDb
        .prepare(
          `SELECT c.config_json
           FROM user_ai_configs c
           JOIN users u ON u.id = c.user_id
           WHERE u.username = ?`,
        )
        .get('reviewer1') as { config_json?: string } | undefined;
      expect(viewerRow?.config_json).toBeTruthy();
      expect(viewerRow!.config_json).not.toContain(userPlainKey);
      const parsedUserRaw = JSON.parse(viewerRow!.config_json!) as { apiKey?: string };
      expect(parsedUserRaw.apiKey).toMatch(
        /^enc:v1:[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/,
      );

      const globalRow = rawDb
        .prepare("SELECT value FROM app_settings WHERE key = 'ai_config'")
        .get() as { value?: string } | undefined;
      expect(globalRow?.value).toBeTruthy();
      expect(globalRow!.value).not.toContain(globalPlainKey);
      const parsedGlobalRaw = JSON.parse(globalRow!.value!) as { apiKey?: string };
      expect(parsedGlobalRaw.apiKey).toMatch(
        /^enc:v1:[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/,
      );

      // Tampered ciphertext MUST fail authentication tag check
      expect(() => server.db.decryptSecret(`${parsedGlobalRaw.apiKey!}X`)).toThrow();
    } finally {
      rawDb.close();
    }

    // Verify transparent decryption for live personal & global calls
    const userLiveTest = await viewerClient.request<{ ok: boolean }>('POST', '/api/ai/test', {
      scope: 'personal',
    });
    expect(userLiveTest.status).toBe(200);
    expect(userLiveTest.data.ok).toBe(true);
    const lastUserCall = capturedAiRequests[capturedAiRequests.length - 1]!;
    expect(lastUserCall.url).toBe('https://enc-user.example/v1/chat/completions');
    expect(lastUserCall.auth).toBe(`Bearer ${userPlainKey}`);

    const globalLiveTest = await ownerClient.request<{ ok: boolean }>('POST', '/api/ai/test', {
      scope: 'global',
    });
    expect(globalLiveTest.status).toBe(200);
    expect(globalLiveTest.data.ok).toBe(true);
    const lastGlobalCall = capturedAiRequests[capturedAiRequests.length - 1]!;
    expect(lastGlobalCall.url).toBe('https://enc-global.example/v1/chat/completions');
    expect(lastGlobalCall.auth).toBe(`Bearer ${globalPlainKey}`);

    // Zero-downtime legacy plaintext row compatibility
    server.db.setSetting(
      'ai_config',
      JSON.stringify({
        baseUrl: 'https://legacy-plain.example/v1',
        apiKey: 'sk-legacy-plaintext-compat-777',
        model: 'deepseek-chat',
      }),
    );
    const legacyTest = await ownerClient.request<{ ok: boolean }>('POST', '/api/ai/test', {
      scope: 'global',
    });
    expect(legacyTest.status).toBe(200);
    expect(legacyTest.data.ok).toBe(true);
    const legacyCall = capturedAiRequests[capturedAiRequests.length - 1]!;
    expect(legacyCall.url).toBe('https://legacy-plain.example/v1/chat/completions');
    expect(legacyCall.auth).toBe('Bearer sk-legacy-plaintext-compat-777');

    // Cleanup & restore
    await viewerClient.request('DELETE', '/api/ai/config/me');
    await ownerClient.request('PUT', '/api/ai/config', {
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'sk-secret-test-key-9999',
      model: 'deepseek-chat',
      reasonerModel: 'deepseek-reasoner',
    });
  });

  it('30. [P2-R3] hardens md-compile against commenter RBAC (403), traversal/forbidden files (400), binary files with NUL bytes (400 without overwrite), and prototype template (no 500)', async () => {
    const projRes = await ownerClient.request<{ project: { id: string } }>('POST', '/api/projects', {
      name: 'MD Hardening Edge Cases',
      engine: 'pdflatex',
      template: 'clean-article',
    });
    expect(projRes.status).toBe(201);
    const hardProjId = projRes.data.project.id;

    // 1. Commenter role MUST receive 403 on md-compile
    const invCommenter = await ownerClient.request<{ invite: { token: string } }>(
      'POST',
      `/api/projects/${hardProjId}/invites`,
      { role: 'commenter', expiresInHours: 24, maxUses: 2 },
    );
    expect(invCommenter.status).toBe(201);

    const commenterClient = createHttpClient(baseUrl);
    const regCommenter = await commenterClient.request('POST', '/api/auth/register', {
      username: 'commenter_edge',
      displayName: 'Commenter Edge',
      password: 'password123',
      inviteToken: invCommenter.data.invite.token,
    });
    expect(regCommenter.status).toBe(201);

    const commenterMdRes = await commenterClient.request(
      'POST',
      `/api/projects/${hardProjId}/format/md-compile`,
      { markdown: '# Commenter must not write\n' },
    );
    expect(commenterMdRes.status).toBe(403);

    // 2. Path traversal and forbidden files MUST return 400
    for (const badTarget of ['../evil.tex', '.git/config', '.latexmkrc']) {
      const badRes = await ownerClient.request(
        'POST',
        `/api/projects/${hardProjId}/format/md-compile`,
        { markdown: '# Bad target\n', targetFile: badTarget },
      );
      expect(badRes.status, `md-compile should reject ${badTarget}`).toBe(400);
    }

    // 3. Existing data.bin with NUL bytes AND disguised .tex with NUL bytes MUST return 400 without overwriting
    const binaryBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xde, 0xad, 0xbe, 0xef]);
    const binPut = await ownerClient.request('PUT', `/api/projects/${hardProjId}/file`, {
      path: 'data.bin',
      base64: binaryBytes.toString('base64'),
      isBinary: true,
    });
    expect(binPut.status).toBe(200);

    const dataBinPath = path.join(tmpDir, 'projects', hardProjId, 'src', 'data.bin');
    const mdBinRes = await ownerClient.request(
      'POST',
      `/api/projects/${hardProjId}/format/md-compile`,
      { markdown: '# Must not overwrite binary\n', targetFile: 'data.bin' },
    );
    expect(mdBinRes.status).toBe(400);
    expect(fs.readFileSync(dataBinPath).equals(binaryBytes)).toBe(true);

    const disguisedTexPath = path.join(tmpDir, 'projects', hardProjId, 'src', 'binary_nul.tex');
    fs.writeFileSync(disguisedTexPath, binaryBytes);
    const mdDisguisedRes = await ownerClient.request(
      'POST',
      `/api/projects/${hardProjId}/format/md-compile`,
      { markdown: '# Must not overwrite binary tex\n', targetFile: 'binary_nul.tex' },
    );
    expect(mdDisguisedRes.status).toBe(400);
    expect(fs.readFileSync(disguisedTexPath).equals(binaryBytes)).toBe(true);

    // 4. Prototype-pollution template name `toString` MUST NOT return 500 (both md-compile and format-hub import-preview)
    const protoMdCompile = await ownerClient.request<{
      ok: boolean;
      targetFile: string;
      mergedCode: string;
    }>('POST', `/api/projects/${hardProjId}/format/md-compile`, {
      markdown: '# Prototype Safe Heading\n\nBody with math $a^2 + b^2 = c^2$.\n',
      targetFile: 'sections/proto_new.tex',
      options: { template: 'toString' },
    });
    expect(protoMdCompile.status).not.toBe(500);
    expect(protoMdCompile.status).toBe(200);
    expect(protoMdCompile.data.targetFile).toBe('sections/proto_new.tex');
    expect(protoMdCompile.data.mergedCode).toContain('\\documentclass');
    expect(protoMdCompile.data.mergedCode).toContain('Prototype Safe Heading');

    const protoPreview = await ownerClient.request<{ generatedCode: string }>(
      'POST',
      `/api/projects/${hardProjId}/format/import-preview`,
      {
        sourceFormat: 'md',
        text: '# Direct Template Safety Check\n\nBody paragraph verifying fallback template $x + y = z$.\n',
        targetMode: 'new-tex',
        targetFile: 'proto_preview.tex',
        options: { template: 'toString' },
      },
    );
    expect(protoPreview.status).toBe(200);
    expect(protoPreview.data.generatedCode).toContain('\\documentclass');
    expect(protoPreview.data.generatedCode).toContain('Direct Template Safety Check');
  }, 60_000);

  it('31. exposes features.collaboration=false by default, provisions all 4 practical starter templates, and compiles real PDFs cleanly', async () => {
    // 1. /api/health reports features.collaboration === false by default (local-first solo/AI studio)
    const health = await ownerClient.request<{
      ok: boolean;
      capabilities: { features?: { collaboration: boolean } };
    }>('GET', '/api/health');
    expect(health.status).toBe(200);
    expect(health.data.ok).toBe(true);
    expect(health.data.capabilities.features).toEqual({ collaboration: false });

    // Verify ENABLE_COLLAB env var & explicit option opt-in path
    const prevEnableCollab = process.env.ENABLE_COLLAB;
    try {
      delete process.env.ENABLE_COLLAB;
      expect(loadServerConfig({ dataDir: tmpDir, loadDotEnv: false }).enableCollab).toBe(false);
      expect(
        loadServerConfig({ dataDir: tmpDir, loadDotEnv: false, enableCollab: true }).enableCollab,
      ).toBe(true);
      process.env.ENABLE_COLLAB = 'true';
      expect(loadServerConfig({ dataDir: tmpDir, loadDotEnv: false }).enableCollab).toBe(true);
    } finally {
      if (prevEnableCollab === undefined) {
        delete process.env.ENABLE_COLLAB;
      } else {
        process.env.ENABLE_COLLAB = prevEnableCollab;
      }
    }

    // 2. Provision all 4 new practical templates and verify recommended engines + starter files
    const specs = [
      {
        template: 'lab-report-en',
        name: 'Signal Calibration Lab Report',
        expectedEngine: 'pdflatex',
        expectedFiles: ['main.tex', 'sections/setup.tex', 'refs.bib'],
        expectedMainSnippets: [
          '\\usepackage{listings}',
          '\\begin{lstlisting}[language=Python',
          '\\usepackage{booktabs',
          '\\input{sections/setup}',
          '\\toprule',
        ],
      },
      {
        template: 'lab-report-zh',
        name: '数字信号处理课程实验报告',
        expectedEngine: 'xelatex',
        expectedFiles: ['main.tex', 'sections/setup.tex', 'refs.bib'],
        expectedMainSnippets: [
          '\\documentclass[12pt,a4paper]{ctexart}',
          '\\begin{lstlisting}[language=Python',
          '\\usepackage{booktabs',
          '\\input{sections/setup}',
          '实验数据与结果对比',
        ],
      },
      {
        template: 'tech-report',
        name: 'Bounded Batch Scheduler Technical Report',
        expectedEngine: 'pdflatex',
        expectedFiles: ['main.tex', 'sections/architecture.tex', 'refs.bib'],
        expectedMainSnippets: [
          '\\tableofcontents',
          '\\begin{lstlisting}[language=Python',
          '\\usepackage{booktabs',
          '\\input{sections/architecture}',
          '\\toprule',
        ],
      },
      {
        template: 'beamer-slides',
        name: 'Lab Seminar Presentation',
        expectedEngine: 'pdflatex',
        expectedFiles: ['main.tex', 'refs.bib'],
        expectedMainSnippets: [
          '{beamer}',
          '\\usetheme{Madrid}',
          '\\titlepage',
          '\\tableofcontents',
          '\\toprule',
        ],
      },
    ] as const;

    const createdIds: Record<string, string> = {};

    for (const spec of specs) {
      const createRes = await ownerClient.request<{
        project: { id: string; mainFile: string; engine: string };
      }>('POST', '/api/projects', {
        name: spec.name,
        template: spec.template,
      });
      expect(createRes.status, `POST /api/projects (${spec.template})`).toBe(201);
      expect(createRes.data.project.mainFile).toBe('main.tex');
      expect(createRes.data.project.engine).toBe(spec.expectedEngine);
      const pid = createRes.data.project.id;
      createdIds[spec.template] = pid;

      const listRes = await ownerClient.request<{ files: Array<{ path: string; kind: string }> }>(
        'GET',
        `/api/projects/${pid}/files`,
      );
      expect(listRes.status).toBe(200);
      const paths = listRes.data.files.map((f) => f.path);
      for (const expectedFile of spec.expectedFiles) {
        expect(paths, `${spec.template} should contain ${expectedFile}`).toContain(expectedFile);
      }

      const mainRes = await ownerClient.request<{ content: string }>(
        'GET',
        `/api/projects/${pid}/file?path=main.tex`,
      );
      expect(mainRes.status).toBe(200);
      for (const snippet of spec.expectedMainSnippets) {
        expect(
          mainRes.data.content,
          `${spec.template} main.tex should contain ${snippet}`,
        ).toContain(snippet);
      }
    }

    // 3. Verify format/import-preview recognizes the new practical templates cleanly
    const labPreview = await ownerClient.request<{ generatedCode: string }>(
      'POST',
      `/api/projects/${createdIds['lab-report-en']}/format/import-preview`,
      {
        sourceFormat: 'md',
        text: '# Experiment Notes\n\nMeasured gain is $G = 2.4$.\n',
        targetMode: 'new-tex',
        targetFile: 'notes.tex',
        options: { template: 'lab-report-en', title: 'Lab Preview Check' },
      },
    );
    expect(labPreview.status).toBe(200);
    expect(labPreview.data.generatedCode).toContain('\\usepackage{listings}');
    expect(labPreview.data.generatedCode).toContain('Lab Preview Check');
    expect(labPreview.data.generatedCode).not.toContain('% NOVATEX_TITLE%');

    const beamerPreview = await ownerClient.request<{ generatedCode: string }>(
      'POST',
      `/api/projects/${createdIds['beamer-slides']}/format/import-preview`,
      {
        sourceFormat: 'md',
        text: '# Slide Overview\n\nKey bullet item.\n',
        targetMode: 'new-tex',
        targetFile: 'deck.tex',
        options: { template: 'beamer-slides', title: 'Beamer Preview Check' },
      },
    );
    expect(beamerPreview.status).toBe(200);
    expect(beamerPreview.data.generatedCode).toContain('\\usetheme{Madrid}');
    expect(beamerPreview.data.generatedCode).toContain('Beamer Preview Check');

    // 4. Compile ALL 4 new practical templates with real TinyTeX (pdflatex / xelatex) and verify valid %PDF- output
    for (const spec of specs) {
      const pid = createdIds[spec.template]!;
      const compileRes = await ownerClient.request<{
        result: {
          ok: boolean;
          compilerAvailable: boolean;
          exitCode: number;
          pdfReady: boolean;
          pdfSize: number;
          errorCount: number;
          rawLog: string;
        };
      }>('POST', `/api/projects/${pid}/compile`, {
        engine: spec.expectedEngine,
        mainFile: 'main.tex',
      });
      expect(compileRes.status, `compile HTTP status for ${spec.template}`).toBe(200);
      expect(compileRes.data.result.compilerAvailable).toBe(true);
      expect(
        compileRes.data.result.ok,
        `compile ok for ${spec.template} (log tail: ${compileRes.data.result.rawLog.slice(-600)})`,
      ).toBe(true);
      expect(compileRes.data.result.exitCode).toBe(0);
      expect(compileRes.data.result.pdfReady).toBe(true);
      expect(compileRes.data.result.pdfSize).toBeGreaterThan(1000);

      const pdfRes = await ownerClient.request('GET', `/api/projects/${pid}/pdf`);
      expect(pdfRes.status).toBe(200);
      expect(pdfRes.rawBuffer.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    }
  }, 120_000);
});
