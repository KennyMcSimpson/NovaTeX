import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  AntiLoopTracker,
  applyMinimalTextToYText,
  getHelpText,
  isIgnoredLocalPath,
  LOCAL_FS_ORIGIN,
  NovaTeXSyncClient,
  parseCliArgs,
  runConvertCommand,
  sha256Text,
  toCollabWebSocketUrl,
  type ProviderFactoryParams,
  type SyncLogger,
  type SyncProviderLike,
} from '../src/index.js';

const tempDirs: string[] = [];

function createTempDir(prefix = 'novatex-sync-test-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

const silentLogger: SyncLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('applyMinimalTextToYText', () => {
  it('applies a minimal surgical splice preserving untouched Yjs relative cursor positions', () => {
    const ydoc = new Y.Doc();
    const ytext = ydoc.getText('content');
    const initial = [
      '\\section{Introduction}',
      'The baseline accuracy is 81.2\\%.',
      '\\section{Conclusion}',
      'Future work remains open.',
    ].join('\n');
    ytext.insert(0, initial);

    // Place one collaborator cursor before the edit and one after the edit
    const cursorBeforeIdx = initial.indexOf('Introduction');
    const cursorAfterIdx = initial.indexOf('Future work');
    const relBefore = Y.createRelativePositionFromTypeIndex(ytext, cursorBeforeIdx);
    const relAfter = Y.createRelativePositionFromTypeIndex(ytext, cursorAfterIdx);

    const observedOrigins: unknown[] = [];
    const observedDeltas: Array<Array<{ retain?: number; delete?: number; insert?: unknown }>> = [];
    ytext.observe((event, tx) => {
      observedOrigins.push(tx.origin);
      observedDeltas.push(event.delta);
    });

    const updated = initial.replace('81.2\\%', '94.7\\% with adaptive regularization');
    const changed = applyMinimalTextToYText(ytext, updated, LOCAL_FS_ORIGIN);

    expect(changed).toBe(true);
    expect(ytext.toString()).toBe(updated);
    expect(observedOrigins).toEqual([LOCAL_FS_ORIGIN]);

    // Verify surgical splice retained untouched prefix rather than replacing from index 0
    expect(observedDeltas).toHaveLength(1);
    const delta = observedDeltas[0]!;
    expect(delta[0]?.retain).toBeGreaterThan(20);

    // Both collaborator cursors must resolve to the exact logical tokens after the splice!
    const absBefore = Y.createAbsolutePositionFromRelativePosition(relBefore, ydoc);
    const absAfter = Y.createAbsolutePositionFromRelativePosition(relAfter, ydoc);
    expect(absBefore?.index).toBe(updated.indexOf('Introduction'));
    expect(absAfter?.index).toBe(updated.indexOf('Future work'));

    ydoc.destroy();
  });

  it('returns false and does not emit a transaction when text is unchanged', () => {
    const ydoc = new Y.Doc();
    const ytext = ydoc.getText('content');
    ytext.insert(0, 'Hello \\LaTeX');

    let txCount = 0;
    ydoc.on('afterTransaction', () => {
      txCount++;
    });

    const changed = applyMinimalTextToYText(ytext, 'Hello \\LaTeX', LOCAL_FS_ORIGIN);
    expect(changed).toBe(false);
    expect(txCount).toBe(0);

    ydoc.destroy();
  });
});

describe('AntiLoopTracker & bidirectional echo suppression', () => {
  it('suppresses matching remote echoes while propagating genuine local edits and respecting TTL', () => {
    let now = 1_000;
    const tracker = new AntiLoopTracker(3_000, () => now);

    const hash = tracker.record('main.tex', 'remote text v1');
    expect(hash).toBe(sha256Text('remote text v1'));

    // Immediate echo & duplicate OS echo with identical content are suppressed
    expect(tracker.shouldSuppress('main.tex', 'remote text v1')).toBe(true);
    now += 500;
    expect(tracker.shouldSuppress('main.tex', 'remote text v1')).toBe(true);

    // Genuine local edit with new content is NOT suppressed and clears the entry
    expect(tracker.shouldSuppress('main.tex', 'local agent edit v2')).toBe(false);
    expect(tracker.shouldSuppress('main.tex', 'remote text v1')).toBe(false);

    // Expired entry is no longer suppressed
    tracker.record('chapters/intro.tex', 'hello');
    now += 3_001;
    expect(tracker.shouldSuppress('chapters/intro.tex', 'hello')).toBe(false);
  });

  it('prevents remote -> disk -> watcher -> Yjs loop while syncing genuine local edits', async () => {
    const localDir = createTempDir('novatex-sync-loop-');
    const createdProviders: Array<{
      params: ProviderFactoryParams;
      awareness: Record<string, unknown>;
      destroyed: boolean;
    }> = [];

    const mockProviderFactory = (params: ProviderFactoryParams): SyncProviderLike => {
      const record = {
        params,
        awareness: {} as Record<string, unknown>,
        destroyed: false,
      };
      createdProviders.push(record);
      return {
        isSynced: true,
        setAwarenessField(key: string, value: unknown) {
          record.awareness[key] = value;
        },
        destroy() {
          record.destroyed = true;
        },
      };
    };

    const client = new NovaTeXSyncClient({
      serverUrl: 'http://127.0.0.1:4100',
      projectId: 'proj-42',
      token: 'secret-tok',
      localDir,
      agentName: 'Claude Code',
      logger: silentLogger,
      providerFactory: mockProviderFactory,
    });

    const room = client.openTextRoom('main.tex');
    expect(room.roomName).toBe('proj-42::main.tex');
    expect(createdProviders).toHaveLength(1);
    expect(createdProviders[0]!.params.url).toBe('ws://127.0.0.1:4100/collab');
    expect(createdProviders[0]!.awareness.user).toEqual({
      name: 'Claude Code',
      color: '#10b981',
    });

    const transactions: unknown[] = [];
    room.ydoc.on('afterTransaction', (tx) => {
      transactions.push(tx.origin);
    });

    // 1. Remote browser collaborator edits Y.Text (origin !== 'local-fs')
    const remoteText = '\\section{Method}\nRemote collaborator wrote this.\n';
    room.ydoc.transact(() => {
      room.ytext.insert(0, remoteText);
    }, 'remote-browser');

    const diskPath = path.join(localDir, 'main.tex');
    expect(fs.readFileSync(diskPath, 'utf8')).toBe(remoteText);
    expect(transactions).toEqual(['remote-browser']);

    // 2. Chokidar echo arrives for the same disk content -> MUST be suppressed (no Yjs transaction!)
    const echoOutcome = await client.handleLocalFileChange(diskPath);
    expect(echoOutcome).toBe('suppressed');
    expect(transactions).toEqual(['remote-browser']);

    // 3. Genuine local edit by local Agent -> MUST propagate to Yjs with minimal splice!
    const agentEdited = '\\section{Method}\nLocal Agent refined this equation: $a^2 + b^2 = c^2$.\n';
    fs.writeFileSync(diskPath, agentEdited, 'utf8');
    const localOutcome = await client.handleLocalFileChange(diskPath);
    expect(localOutcome).toBe('synced-text');
    expect(room.ytext.toString()).toBe(agentEdited);
    expect(transactions).toEqual(['remote-browser', LOCAL_FS_ORIGIN]);

    await client.stop();
    expect(createdProviders[0]!.destroyed).toBe(true);
  });

  it('runs start() with live Chokidar watching, pushes missing local files, syncs edits & binaries, and cleans up in stop()', async () => {
    const localDir = createTempDir('novatex-sync-watch-');
    // Seed a local file while remote starts empty
    const localIntroPath = path.join(localDir, 'main.tex');
    fs.writeFileSync(localIntroPath, '\\section{Local Seed}\nInitial line.\n', 'utf8');

    const putUploads: Array<{ path: string; content?: string; base64?: string; isBinary?: boolean }> = [];
    const mockFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/files') && (!init?.method || init.method === 'GET')) {
        return new Response(JSON.stringify({ files: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.endsWith('/file') && init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as {
          path: string;
          content?: string;
          base64?: string;
          isBinary?: boolean;
        };
        putUploads.push(body);
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('Not found', { status: 404 });
    };

    const destroyedProviders: string[] = [];
    const mockProviderFactory = (params: ProviderFactoryParams): SyncProviderLike => {
      // Simulate immediate sync handshake so room initializes cleanly
      queueMicrotask(() => params.onSynced({ state: true }));
      return {
        isSynced: true,
        setAwarenessField() {},
        destroy() {
          destroyedProviders.push(params.name);
        },
      };
    };

    const client = new NovaTeXSyncClient({
      serverUrl: 'http://127.0.0.1:4100',
      projectId: 'proj-live',
      token: 'tok-live',
      localDir,
      pollIntervalMs: 0,
      awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 20 },
      logger: silentLogger,
      fetchImpl: mockFetch,
      providerFactory: mockProviderFactory,
    });

    try {
      await client.start();

      // Local seed was pushed when remote was empty and opened in a Hocuspocus room
      expect(putUploads.some((u) => u.path === 'main.tex' && u.isBinary === false)).toBe(true);
      const room = client.getTrackedRooms().get('main.tex');
      expect(room).toBeDefined();

      // Wait briefly for microtask onSynced to seed Y.Text
      await new Promise((r) => setTimeout(r, 30));
      expect(room!.ytext.toString()).toBe('\\section{Local Seed}\nInitial line.\n');

      // Live edit on disk should flow through Chokidar -> minimal Yjs splice
      const updatedTex = '\\section{Local Seed}\nInitial line.\nAdded by local agent.\n';
      fs.writeFileSync(localIntroPath, updatedTex, 'utf8');

      // Also write a new binary figure on disk -> should upload via PUT /file with base64
      const figBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xde, 0xad, 0xbe, 0xef]);
      fs.mkdirSync(path.join(localDir, 'figures'), { recursive: true });
      fs.writeFileSync(path.join(localDir, 'figures', 'plot.png'), figBytes);

      const deadline = Date.now() + 4_000;
      while (
        Date.now() < deadline &&
        (room!.ytext.toString() !== updatedTex ||
          !putUploads.some((u) => u.path === 'figures/plot.png' && u.isBinary === true))
      ) {
        await new Promise((r) => setTimeout(r, 40));
      }

      expect(room!.ytext.toString()).toBe(updatedTex);
      const uploadedFig = putUploads.find((u) => u.path === 'figures/plot.png');
      expect(uploadedFig).toBeDefined();
      expect(uploadedFig!.isBinary).toBe(true);
      expect(Buffer.from(uploadedFig!.base64!, 'base64').equals(figBytes)).toBe(true);
    } finally {
      await client.stop();
    }

    expect(destroyedProviders).toContain('proj-live::main.tex');
    expect(client.getTrackedRooms().size).toBe(0);
  });
});

describe('novatex-sync convert (end-to-end with @novatex/format-hub)', () => {
  it('converts LaTeX -> Markdown -> LaTeX round-trip using real temp files', async () => {
    const workDir = createTempDir('novatex-sync-convert-');
    const srcTexPath = path.join(workDir, 'paper.tex');
    const mdPath = path.join(workDir, 'paper.md');
    const roundTripTexPath = path.join(workDir, 'paper-ctex.tex');
    const bodyOnlyTexPath = path.join(workDir, 'paper-body.tex');

    const sampleTex = [
      '\\documentclass{article}',
      '\\begin{document}',
      '\\section{Introduction}',
      'Energy satisfies $E = mc^2$ as noted by prior work \\cite{einstein1905}.',
      '\\end{document}',
      '',
    ].join('\n');
    fs.writeFileSync(srcTexPath, sampleTex, 'utf8');

    // Step 1: tex -> md
    const toMd = await runConvertCommand({
      from: 'tex',
      to: 'md',
      input: srcTexPath,
      output: mdPath,
    });

    expect(toMd.outputPath).toBe(mdPath);
    expect(fs.existsSync(mdPath)).toBe(true);
    const mdText = fs.readFileSync(mdPath, 'utf8');
    expect(mdText).toContain('Introduction');
    expect(mdText).toContain('E = mc^2');
    expect(mdText).toContain('@einstein1905');

    // Step 2: md -> tex (standalone with chinese-ctex template)
    const toTex = await runConvertCommand({
      from: 'md',
      to: 'tex',
      input: mdPath,
      output: roundTripTexPath,
      template: 'chinese-ctex',
      title: 'NovaTeX 测试论文',
    });

    expect(toTex.outputPath).toBe(roundTripTexPath);
    const roundTripTex = fs.readFileSync(roundTripTexPath, 'utf8');
    expect(roundTripTex).toContain('\\documentclass');
    expect(roundTripTex).toContain('ctexart');
    expect(roundTripTex).toContain('\\section{Introduction}');
    expect(roundTripTex).toContain('E = mc^2');
    expect(roundTripTex).toContain('\\cite{einstein1905}');

    // Step 3: md -> tex (--body-only)
    const toBodyTex = await runConvertCommand({
      from: 'md',
      to: 'tex',
      input: mdPath,
      output: bodyOnlyTexPath,
      bodyOnly: true,
    });

    expect(toBodyTex.outputPath).toBe(bodyOnlyTexPath);
    const bodyTex = fs.readFileSync(bodyOnlyTexPath, 'utf8');
    expect(bodyTex).not.toContain('\\documentclass');
    expect(bodyTex).toContain('\\section{Introduction}');
  });
});

describe('pullAll mocked HTTP & security boundary', () => {
  it('downloads safe text & binary files and rejects traversal, .latexmkrc, .git, and absolute paths', async () => {
    const parentDir = createTempDir('novatex-sync-pull-');
    const localDir = path.join(parentDir, 'workspace');
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);
    const requests: Array<{ url: string; auth: string | null }> = [];

    const mockFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const headers = new Headers(init?.headers);
      requests.push({ url, auth: headers.get('authorization') });

      if (url === 'https://tex.example.com/api/projects/demo-1/files') {
        return new Response(
          JSON.stringify({
            files: [
              // Safe inline text file
              {
                path: 'main.tex',
                kind: 'file',
                isBinary: false,
                content: '\\documentclass{article}\n\\begin{document}Hi\\end{document}\n',
              },
              // Safe nested text file requiring secondary GET /file?path=...
              {
                path: 'sections/intro.tex',
                kind: 'file',
                isBinary: false,
              },
              // Safe binary figure with inline base64
              {
                path: 'figures/diagram.png',
                kind: 'file',
                isBinary: true,
                base64: pngBytes.toString('base64'),
              },
              // Directory entry (ignored cleanly)
              {
                path: 'sections',
                kind: 'dir',
                isBinary: false,
              },
              // Malicious / forbidden entries from an untrusted server
              { path: '../escape.tex', kind: 'file', content: 'pwned' },
              { path: 'sections/../../escape2.tex', kind: 'file', content: 'pwned' },
              { path: '.latexmkrc', kind: 'file', content: 'system("evil");' },
              { path: 'sub/.latexmkrc', kind: 'file', content: 'system("evil");' },
              { path: '.git/config', kind: 'file', content: '[core]' },
              { path: '/etc/passwd', kind: 'file', content: 'root:x:0:0' },
              { path: 'C:\\Windows\\evil.tex', kind: 'file', content: 'evil' },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      if (url === 'https://tex.example.com/api/projects/demo-1/file?path=sections%2Fintro.tex') {
        return new Response(
          JSON.stringify({
            content: '\\section{Intro}\nFetched via single-file endpoint.\n',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      return new Response('Not found', { status: 404 });
    };

    const client = new NovaTeXSyncClient({
      serverUrl: 'https://tex.example.com/',
      projectId: 'demo-1',
      token: 'tok-abc-123',
      localDir,
      logger: silentLogger,
      fetchImpl: mockFetch,
    });

    const result = await client.pullAll();

    // Every request carried Bearer auth
    expect(requests.length).toBe(2);
    expect(requests.every((r) => r.auth === 'Bearer tok-abc-123')).toBe(true);

    // Safe files written accurately
    expect(result.downloaded).toEqual(['main.tex', 'sections/intro.tex', 'figures/diagram.png']);
    expect(fs.readFileSync(path.join(localDir, 'main.tex'), 'utf8')).toContain('\\documentclass{article}');
    expect(fs.readFileSync(path.join(localDir, 'sections', 'intro.tex'), 'utf8')).toContain(
      'Fetched via single-file endpoint.',
    );
    expect(fs.readFileSync(path.join(localDir, 'figures', 'diagram.png')).equals(pngBytes)).toBe(true);

    // Unsafe / malicious entries rejected and NEVER written
    const skippedPaths = result.skipped.map((s) => s.path);
    expect(skippedPaths).toEqual([
      '../escape.tex',
      'sections/../../escape2.tex',
      '.latexmkrc',
      'sub/.latexmkrc',
      '.git/config',
      '/etc/passwd',
      'C:\\Windows\\evil.tex',
    ]);
    expect(fs.existsSync(path.join(parentDir, 'escape.tex'))).toBe(false);
    expect(fs.existsSync(path.join(parentDir, 'escape2.tex'))).toBe(false);
    expect(fs.existsSync(path.join(localDir, '.latexmkrc'))).toBe(false);
    expect(fs.existsSync(path.join(localDir, 'sub', '.latexmkrc'))).toBe(false);
    expect(fs.existsSync(path.join(localDir, '.git', 'config'))).toBe(false);
  });
});

describe('CLI parser & helpers', () => {
  it('converts HTTP(S) URLs to /collab WebSocket endpoints and handles ignore rules safely', () => {
    expect(toCollabWebSocketUrl('http://localhost:4000')).toBe('ws://localhost:4000/collab');
    expect(toCollabWebSocketUrl('https://tex.example.com/app/')).toBe('wss://tex.example.com/app/collab');
    expect(toCollabWebSocketUrl('ws://127.0.0.1:4000/collab')).toBe('ws://127.0.0.1:4000/collab');

    // Dotfile in ancestor dir must NOT cause files inside localDir to be ignored!
    const rootWithDot = path.join(os.tmpdir(), '.hidden-parent', 'project');
    expect(isIgnoredLocalPath(rootWithDot, rootWithDot)).toBe(false);
    expect(isIgnoredLocalPath(rootWithDot, path.join(rootWithDot, 'main.tex'))).toBe(false);
    expect(isIgnoredLocalPath(rootWithDot, path.join(rootWithDot, '.git', 'HEAD'))).toBe(true);
    expect(isIgnoredLocalPath(rootWithDot, path.join(rootWithDot, 'node_modules', 'pkg', 'a.js'))).toBe(true);
    expect(isIgnoredLocalPath(rootWithDot, path.join(rootWithDot, '_build', 'main.aux'))).toBe(true);
  });

  it('parses pull, watch, convert, and help arguments cleanly', () => {
    expect(parseCliArgs(['--help'])).toEqual({ command: 'help' });
    expect(getHelpText()).toContain('novatex-sync convert');

    expect(
      parseCliArgs([
        'watch',
        '--url',
        'http://localhost:4000',
        '--project',
        'p1',
        '--token',
        't1',
        '--dir',
        './paper',
        '--name',
        'Antigravity',
      ]),
    ).toEqual({
      command: 'watch',
      url: 'http://localhost:4000',
      project: 'p1',
      token: 't1',
      dir: './paper',
      name: 'Antigravity',
      pollIntervalMs: undefined,
    });

    expect(
      parseCliArgs([
        'convert',
        '--from',
        'md',
        '--to',
        'tex',
        '--input',
        'draft.md',
        '--output',
        'draft.tex',
        '--template',
        'ieee-conf',
        '--body-only',
        '--bib',
        'refs.bib',
      ]),
    ).toEqual({
      command: 'convert',
      from: 'md',
      to: 'tex',
      input: 'draft.md',
      output: 'draft.tex',
      template: 'ieee-conf',
      bodyOnly: true,
      bib: 'refs.bib',
      title: undefined,
      mediaDir: undefined,
    });
  });
});
