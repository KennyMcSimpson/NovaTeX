import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CompileQueue,
  buildHardenedTexEnv,
  detectTexToolchain,
  recommendEngine,
  writeHardenedTexmfCnf,
  type SpawnRunRequest,
  type TexToolchainInfo,
} from '../src/sandbox-compiler.js';
import {
  loadSyncTeXFile,
  syncTeXForward,
  syncTeXInverse,
} from '../src/synctex.js';

const tempDirs: string[] = [];

function createTempDir(prefix = 'novatex-sandbox-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const MOCK_TOOLCHAIN: TexToolchainInfo = {
  available: true,
  engines: ['xelatex', 'pdflatex'],
  binaries: {
    xelatex: '/mock/bin/xelatex',
    pdflatex: '/mock/bin/pdflatex',
  },
  hasLatexmk: false,
  hasBibtex: false,
  hasBiber: false,
  hasQpdf: false,
  texBinDir: '/mock/bin',
};

describe('sandbox-compiler security & queue', () => {
  it('writes hardened texmf.cnf (shell_escape_commands = none) and strips secrets via strict env allowlist', () => {
    const confDir = createTempDir('novatex-cnf-');
    const jobTmpDir = createTempDir('novatex-job-tmp-');
    const cnfPath = writeHardenedTexmfCnf(confDir);

    const content = fs.readFileSync(cnfPath, 'utf8');
    expect(content).toContain('shell_escape = f');
    expect(content).toContain('shell_escape_commands = none');
    expect(content).toContain('openin_any = p');
    expect(content).toContain('openout_any = p');

    const env = buildHardenedTexEnv(
      confDir,
      '/mock/tex/bin',
      {
        PATH: '/usr/bin',
        LANG: 'en_US.UTF-8',
        SystemRoot: 'C:\\Windows',
        SESSION_SECRET: 'top-secret-session',
        AI_API_KEY: 'sk-secret-ai',
        DEEPSEEK_API_KEY: 'sk-secret-deepseek',
        COMPILER_SHARED_SECRET: 'shared-hmac-secret',
        ADMIN_PASSWORD: 'admin-password-123',
        ARBITRARY_CUSTOM_SECRET: 'should-not-leak',
      },
      jobTmpDir,
    );
    const expectedSep = process.platform === 'win32' ? ';' : ':';
    expect(env.TEXMFCNF?.endsWith(expectedSep)).toBe(true);
    expect(env.TEXMFCNF).toContain(confDir.replace(/\\/g, '/'));
    expect(env.shell_escape).toBe('f');
    expect(env.shell_escape_commands).toBe('none');
    expect(env.openin_any).toBe('p');
    expect(env.openout_any).toBe('p');
    expect(env.LANG).toBe('en_US.UTF-8');
    expect(env.SystemRoot).toBe('C:\\Windows');
    expect(env.TMP).toBe(jobTmpDir);
    expect(env.TEMP).toBe(jobTmpDir);

    // Strictly verify NO secrets or arbitrary env vars leak into child TeX process
    expect(env.SESSION_SECRET).toBeUndefined();
    expect(env.AI_API_KEY).toBeUndefined();
    expect(env.DEEPSEEK_API_KEY).toBeUndefined();
    expect(env.COMPILER_SHARED_SECRET).toBeUndefined();
    expect(env.ADMIN_PASSWORD).toBeUndefined();
    expect(env.ARBITRARY_CUSTOM_SECRET).toBeUndefined();
  });

  it('REAL kpsewhich check: shell_escape_commands resolves to none (never system allowlist)', async () => {
    const toolchain = await detectTexToolchain();
    if (!toolchain.texBinDir) {
      return;
    }
    const kpseName = process.platform === 'win32' ? 'kpsewhich.exe' : 'kpsewhich';
    const kpseBin = path.join(toolchain.texBinDir, kpseName);
    if (!fs.existsSync(kpseBin)) {
      return;
    }

    const confDir = createTempDir('novatex-kpse-cnf-');
    const jobTmpDir = createTempDir('novatex-kpse-tmp-');
    writeHardenedTexmfCnf(confDir);
    const env = buildHardenedTexEnv(confDir, toolchain.texBinDir, process.env, jobTmpDir);

    const commandsVal = execFileSync(kpseBin, ['-var-value=shell_escape_commands'], {
      env,
      encoding: 'utf8',
    }).trim();
    const escapeVal = execFileSync(kpseBin, ['-var-value=shell_escape'], {
      env,
      encoding: 'utf8',
    }).trim();
    const openinVal = execFileSync(kpseBin, ['-var-value=openin_any'], {
      env,
      encoding: 'utf8',
    }).trim();
    const openoutVal = execFileSync(kpseBin, ['-var-value=openout_any'], {
      env,
      encoding: 'utf8',
    }).trim();

    expect(commandsVal).toBe('none');
    expect(commandsVal).not.toContain('bibtex');
    expect(commandsVal).not.toContain('kpsewhich');
    expect(commandsVal).not.toContain('latexminted');
    expect(escapeVal).toBe('f');
    expect(openinVal).toBe('p');
    expect(openoutVal).toBe('p');
  });

  it('disables lualatex by default with LUALATEX_DISABLED and allows when explicitly enabled', async () => {
    const ws = createTempDir();
    const buildDir = createTempDir();
    fs.writeFileSync(
      path.join(ws, 'main.tex'),
      '\\documentclass{article}\\begin{document}Hi\\end{document}',
    );

    const toolchainWithLua: TexToolchainInfo = {
      ...MOCK_TOOLCHAIN,
      engines: ['xelatex', 'pdflatex', 'lualatex'],
      binaries: { ...MOCK_TOOLCHAIN.binaries, lualatex: '/mock/bin/lualatex' },
    };

    let spawnCalled = false;
    const defaultQueue = new CompileQueue({
      _detectOverride: async () => toolchainWithLua,
      _spawnOverride: async () => {
        spawnCalled = true;
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
      },
    });

    const blocked = await defaultQueue.compileProject({
      projectId: 'proj-lua-blocked',
      workspaceDir: ws,
      buildDir,
      mainFile: 'main.tex',
      engine: 'lualatex',
    });
    expect(spawnCalled).toBe(false);
    expect(blocked.ok).toBe(false);
    expect(blocked.diagnostics[0]?.code).toBe('LUALATEX_DISABLED');

    // Explicit opt-in succeeds
    const optInQueue = new CompileQueue({
      allowLuaLatex: true,
      _detectOverride: async () => toolchainWithLua,
      _spawnOverride: async (req) => {
        const outArg = req.args.find((a) => a.startsWith('-output-directory='));
        const outDir = path.resolve(req.cwd, outArg!.slice('-output-directory='.length));
        fs.writeFileSync(path.join(outDir, 'main.pdf'), Buffer.from('%PDF-1.4\n%lua\n'));
        return { exitCode: 0, stdout: 'ok', stderr: '', timedOut: false };
      },
    });
    const allowed = await optInQueue.compileProject({
      projectId: 'proj-lua-allowed',
      workspaceDir: ws,
      buildDir: createTempDir(),
      mainFile: 'main.tex',
      engine: 'lualatex',
    });
    expect(allowed.ok).toBe(true);
    expect(allowed.engine).toBe('lualatex');
  });

  it('rejects CLI-flag/format-injection mainFile names (-version, -shell-escape.tex, &plain.tex, README.md) and prefixes valid files with ./', async () => {
    const ws = createTempDir();
    fs.writeFileSync(path.join(ws, 'main.tex'), '\\documentclass{article}\\begin{document}Hi\\end{document}');
    fs.writeFileSync(path.join(ws, 'README.md'), '# hello');
    // Case-insensitive .GIT dir must never be staged
    fs.mkdirSync(path.join(ws, '.GIT'), { recursive: true });
    fs.writeFileSync(path.join(ws, '.GIT', 'config'), '[core]');

    const spawnedArgs: string[][] = [];
    let stageHadGit = false;
    const queue = new CompileQueue({
      _detectOverride: async () => ({
        ...MOCK_TOOLCHAIN,
        hasBiber: true,
        binaries: { ...MOCK_TOOLCHAIN.binaries, biber: '/mock/bin/biber' },
      }),
      _spawnOverride: async (req) => {
        spawnedArgs.push(req.args);
        if (fs.existsSync(path.join(req.cwd, '.GIT')) || fs.existsSync(path.join(req.cwd, '.git'))) {
          stageHadGit = true;
        }
        const outArg = req.args.find((a) => a.startsWith('-output-directory='));
        if (outArg) {
          const outDir = path.resolve(req.cwd, outArg.slice('-output-directory='.length));
          fs.writeFileSync(path.join(outDir, 'main.pdf'), Buffer.from('%PDF-1.4\n%ok\n'));
          fs.writeFileSync(path.join(outDir, 'main.bcf'), '<bcf/>');
        }
        return { exitCode: 0, stdout: 'ok', stderr: '', timedOut: false };
      },
    });

    for (const badMain of ['-version', '-shell-escape.tex', '&plain.tex', 'sub/-evil.tex', 'README.md']) {
      const res = await queue.compileProject({
        projectId: 'proj-arg-inj',
        workspaceDir: ws,
        buildDir: createTempDir(),
        mainFile: badMain,
      });
      expect(res.ok).toBe(false);
      expect(res.diagnostics[0]?.code).toBe('INVALID_MAIN_FILE');
    }
    expect(spawnedArgs).toHaveLength(0);

    // Valid main.tex receives explicit `./main.tex`, biber receives `--`, and `.GIT` is excluded from stage
    const okRes = await queue.compileProject({
      projectId: 'proj-valid-prefix',
      workspaceDir: ws,
      buildDir: createTempDir(),
      mainFile: 'main.tex',
    });
    expect(okRes.ok).toBe(true);
    expect(stageHadGit).toBe(false);
    expect(spawnedArgs[0]?.[spawnedArgs[0]!.length - 1]).toBe('./main.tex');
    const biberCall = spawnedArgs.find((a) => a.includes('--output-directory'));
    expect(biberCall).toEqual(['--output-directory', '_build', '--', 'main']);
  });

  it('recommends xelatex for CJK / ctex / fontspec and respects explicit engine', () => {
    expect(recommendEngine('\\documentclass{article}\nHello world')).toBe('pdflatex');
    expect(recommendEngine('\\documentclass{article}\n你好世界')).toBe('xelatex');
    expect(recommendEngine('\\usepackage{ctex}\nHello')).toBe('xelatex');
    expect(recommendEngine('\\usepackage{fontspec}\nHello')).toBe('xelatex');
    expect(recommendEngine('% \\usepackage{ctex}\nHello')).toBe('pdflatex');
    expect(recommendEngine('\\usepackage{ctex}\n你好', 'lualatex')).toBe('lualatex');
  });

  it('rejects workspaces containing .latexmkrc or nested latexmkrc without spawning compiler', async () => {
    const ws = createTempDir();
    const buildDir = createTempDir();
    fs.writeFileSync(path.join(ws, 'main.tex'), '\\documentclass{article}\\begin{document}Hi\\end{document}');
    fs.mkdirSync(path.join(ws, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'sub', '.latexmkrc'), 'system("calc");');

    let spawnCalled = false;
    const queue = new CompileQueue({
      _detectOverride: async () => MOCK_TOOLCHAIN,
      _spawnOverride: async () => {
        spawnCalled = true;
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
      },
    });

    const res = await queue.compileProject({
      projectId: 'proj-sec-1',
      workspaceDir: ws,
      buildDir,
      mainFile: 'main.tex',
    });

    expect(spawnCalled).toBe(false);
    expect(res.ok).toBe(false);
    expect(res.diagnostics[0]?.code).toBe('FORBIDDEN_LATEXMKRC');
  });

  it('rejects path traversal in mainFile without spawning compiler', async () => {
    const ws = createTempDir();
    const buildDir = createTempDir();

    let spawnCalled = false;
    const queue = new CompileQueue({
      _detectOverride: async () => MOCK_TOOLCHAIN,
      _spawnOverride: async () => {
        spawnCalled = true;
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
      },
    });

    const res = await queue.compileProject({
      projectId: 'proj-sec-2',
      workspaceDir: ws,
      buildDir,
      mainFile: '../secret.tex',
    });

    expect(spawnCalled).toBe(false);
    expect(res.ok).toBe(false);
    expect(res.diagnostics[0]?.code).toBe('PATH_TRAVERSAL');
  });

  it('handles missing TeX compiler gracefully without crashing', async () => {
    const ws = createTempDir();
    const buildDir = createTempDir();
    const emptyBinDir = createTempDir();
    fs.writeFileSync(path.join(ws, 'main.tex'), '\\documentclass{article}\\begin{document}Hi\\end{document}');

    const queue = new CompileQueue({
      texBinDir: emptyBinDir,
      includeSystemPath: false,
      includeLocalTools: false,
    });

    const res = await queue.compileProject({
      projectId: 'proj-no-tex',
      workspaceDir: ws,
      buildDir,
      mainFile: 'main.tex',
    });

    expect(res.ok).toBe(false);
    expect(res.compilerAvailable).toBe(false);
    expect(res.diagnostics[0]?.code).toBe('COMPILER_UNAVAILABLE');
    expect(res.compilerNote).toContain('TinyTeX');
  });

  it('enforces maxConcurrency = 1 and injects hardened TeX flags and temp texmf.cnf', async () => {
    const ws = createTempDir();
    fs.writeFileSync(path.join(ws, 'main.tex'), '\\documentclass{article}\\begin{document}Hi\\end{document}');

    let currentActive = 0;
    let peakActive = 0;
    const capturedRequests: SpawnRunRequest[] = [];
    const observedTexmfDirs: string[] = [];

    const queue = new CompileQueue({
      maxConcurrency: 1,
      timeoutMs: 10_000,
      _detectOverride: async () => MOCK_TOOLCHAIN,
      _spawnOverride: async (req) => {
        currentActive++;
        peakActive = Math.max(peakActive, currentActive);
        capturedRequests.push(req);

        // Verify per-job texmf.cnf exists on disk during spawn and cwd is ASCII-only
        expect(/^[\x20-\x7e]+$/.test(req.cwd)).toBe(true);
        const texmfEnv = req.env.TEXMFCNF ?? '';
        const confDir = texmfEnv.slice(0, -1);
        observedTexmfDirs.push(confDir);
        expect(fs.existsSync(path.join(confDir, 'texmf.cnf'))).toBe(true);

        await new Promise((r) => setTimeout(r, 60));

        // Emit mock PDF & synctex into relative output-directory (`_build`) inside stage cwd
        const outArg = req.args.find((a) => a.startsWith('-output-directory='));
        expect(outArg).toBe('-output-directory=_build');
        const outDir = path.resolve(req.cwd, outArg!.slice('-output-directory='.length));
        fs.writeFileSync(path.join(outDir, 'main.pdf'), Buffer.from('%PDF-1.4\n%mock\n'));
        fs.writeFileSync(path.join(outDir, 'main.synctex.gz'), Buffer.from('mock'));
        fs.writeFileSync(path.join(outDir, 'main.log'), 'Output written on main.pdf (1 page).');

        currentActive--;
        return { exitCode: 0, stdout: 'ok', stderr: '', timedOut: false };
      },
    });

    const builds = [createTempDir(), createTempDir(), createTempDir()];
    const results = await Promise.all(
      builds.map((buildDir, idx) =>
        queue.compileProject({
          projectId: `proj-q-${idx}`,
          workspaceDir: ws,
          buildDir,
          mainFile: 'main.tex',
        }),
      ),
    );

    expect(peakActive).toBe(1);
    expect(queue.getQueueStats().active).toBe(0);
    expect(queue.getQueueStats().queued).toBe(0);
    expect(results.every((r) => r.ok && r.pdfReady && r.synctexReady)).toBe(true);

    // Check hardened CLI flags
    for (const req of capturedRequests) {
      expect(req.args).toContain('-interaction=nonstopmode');
      expect(req.args).toContain('-file-line-error');
      expect(req.args).toContain('-no-shell-escape');
      expect(req.args).toContain('-synctex=1');
    }

    // Verify all temp texmf.cnf dirs were cleaned up after jobs completed
    for (const dir of observedTexmfDirs) {
      expect(fs.existsSync(dir)).toBe(false);
    }
  });

  it('runs multi-pass cross-ref stabilization, qpdf linearization, and reports timeouts cleanly', async () => {
    const ws = createTempDir();
    const buildDir = createTempDir();
    fs.writeFileSync(path.join(ws, 'main.tex'), '\\documentclass{article}\\begin{document}Hi\\end{document}');

    const toolchainWithQpdf: TexToolchainInfo = {
      ...MOCK_TOOLCHAIN,
      hasQpdf: true,
      binaries: { ...MOCK_TOOLCHAIN.binaries, qpdf: '/mock/bin/qpdf' },
    };

    let texPass = 0;
    let qpdfCalled = false;
    const queue = new CompileQueue({
      _detectOverride: async () => toolchainWithQpdf,
      _spawnOverride: async (req) => {
        if (req.command === '/mock/bin/qpdf') {
          qpdfCalled = true;
          expect(req.args[0]).toBe('--linearize');
          fs.writeFileSync(req.args[2]!, Buffer.from('%PDF-1.4\n%linearized\n'));
          return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
        }
        texPass++;
        const outArg = req.args.find((a) => a.startsWith('-output-directory='));
        const outDir = path.resolve(req.cwd, outArg!.slice('-output-directory='.length));
        fs.writeFileSync(path.join(outDir, 'main.pdf'), Buffer.from('%PDF-1.4\n%raw\n'));
        fs.writeFileSync(
          path.join(outDir, 'main.log'),
          texPass === 1
            ? 'LaTeX Warning: Label(s) may have changed. Rerun to get cross-references right.'
            : 'Output written on main.pdf (1 page).',
        );
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
      },
    });

    const res = await queue.compileProject({
      projectId: 'proj-multipass',
      workspaceDir: ws,
      buildDir,
      mainFile: 'main.tex',
    });

    expect(texPass).toBe(2);
    expect(qpdfCalled).toBe(true);
    expect(res.ok).toBe(true);
    expect(res.linearized).toBe(true);

    // Timeout case
    const timeoutQueue = new CompileQueue({
      timeoutMs: 2000,
      _detectOverride: async () => MOCK_TOOLCHAIN,
      _spawnOverride: async () => ({
        exitCode: -1,
        stdout: '',
        stderr: 'killed',
        timedOut: true,
      }),
    });
    const tRes = await timeoutQueue.compileProject({
      projectId: 'proj-timeout',
      workspaceDir: ws,
      buildDir: createTempDir(),
      mainFile: 'main.tex',
    });
    expect(tRes.ok).toBe(false);
    expect(tRes.exitCode).toBe(-1);
    expect(tRes.diagnostics[0]?.code).toBe('COMPILE_TIMEOUT');
  });

  it('REAL integration: compiles Chinese ctexart in non-ASCII path with real SyncTeX and syntax error diagnosis', async () => {
    const toolchain = await detectTexToolchain();
    if (!toolchain.available) {
      // Skip only when no local TeX binary is installed at all
      return;
    }

    const useXelatex = toolchain.engines.includes('xelatex');
    const baseTmp = createTempDir('novatex-real-');
    // Explicitly place workspace and buildDir inside a non-ASCII directory (`插件/中文路径`)
    const nonAsciiWorkspace = path.join(baseTmp, '插件', '中文路径', 'workspace');
    const nonAsciiBuildDir = path.join(baseTmp, '插件', '中文路径', 'build');
    fs.mkdirSync(nonAsciiWorkspace, { recursive: true });

    const okTex = useXelatex
      ? [
          '\\documentclass{ctexart}',
          '\\usepackage{amsmath}',
          '\\usepackage{booktabs}',
          '\\title{NovaTeX 实测中文论文}',
          '\\author{测试作者}',
          '\\begin{document}',
          '\\maketitle',
          '\\section{引言}',
          '这是一段用于验证正向与逆向 SyncTeX 的中文正文。',
          '\\begin{equation}',
          'E = mc^2 + \\sum_{i=1}^{n} x_i',
          '\\end{equation}',
          '\\begin{tabular}{lc}',
          '\\toprule',
          '模型 & 准确率 \\\\',
          '\\midrule',
          'NovaTeX & 99.9\\% \\\\',
          '\\bottomrule',
          '\\end{tabular}',
          '\\end{document}',
          '',
        ].join('\n')
      : [
          '\\documentclass{article}',
          '\\usepackage{amsmath}',
          '\\title{NovaTeX Real Smoke Test}',
          '\\begin{document}',
          '\\maketitle',
          '\\section{Introduction}',
          'This line tests forward and inverse SyncTeX.',
          '\\begin{equation}',
          'E = mc^2',
          '\\end{equation}',
          '\\end{document}',
          '',
        ].join('\n');

    fs.writeFileSync(path.join(nonAsciiWorkspace, 'main.tex'), okTex, 'utf8');

    const queue = new CompileQueue({
      maxConcurrency: 1,
      timeoutMs: 60_000,
    });

    // 1. Real compile in non-ASCII workspace -> succeeds with PDF + .synctex.gz
    const okRes = await queue.compileProject({
      projectId: 'proj-real-cjk',
      workspaceDir: nonAsciiWorkspace,
      buildDir: nonAsciiBuildDir,
      mainFile: 'main.tex',
      engine: useXelatex ? 'xelatex' : 'pdflatex',
    });

    expect(okRes.compilerAvailable).toBe(true);
    expect(okRes.exitCode).toBe(0);
    expect(okRes.ok).toBe(true);
    expect(okRes.pdfReady).toBe(true);
    expect(okRes.pdfSize).toBeGreaterThan(1000);
    expect(okRes.synctexReady).toBe(true);
    expect(fs.existsSync(path.join(nonAsciiBuildDir, 'main.pdf'))).toBe(true);
    expect(fs.existsSync(path.join(nonAsciiBuildDir, 'main.log'))).toBe(true);

    // 2. Real SyncTeX bidirectional search on the genuine generated `.synctex.gz`
    const gzPath = path.join(nonAsciiBuildDir, 'main.synctex.gz');
    const rawSyncPath = path.join(nonAsciiBuildDir, 'main.synctex');
    const synctexFile = fs.existsSync(gzPath) ? gzPath : rawSyncPath;
    const stIndex = loadSyncTeXFile(synctexFile);
    expect(stIndex).not.toBeNull();
    expect(stIndex!.pageCount).toBeGreaterThanOrEqual(1);

    // Forward search on the body text line (line 9 in ctexart, line 7 in article)
    const bodyLine = useXelatex ? 9 : 7;
    const fwd = syncTeXForward(stIndex!, 'main.tex', bodyLine);
    expect(fwd.found).toBe(true);
    expect(fwd.file).toBe('main.tex');
    expect(fwd.boxes.length).toBeGreaterThan(0);

    // Inverse search right inside the first returned box -> maps back to main.tex near bodyLine
    const firstBox = fwd.boxes[0]!;
    const inv = syncTeXInverse(
      stIndex!,
      firstBox.page,
      firstBox.x + firstBox.width / 2,
      firstBox.y + firstBox.height / 2,
    );
    expect(inv.found).toBe(true);
    expect(inv.file).toBe('main.tex');
    expect(Math.abs(inv.line - bodyLine)).toBeLessThanOrEqual(3);

    // 3. Real syntax error (`\undefinedcmd`) -> structured Chinese diagnostic pinpoints file & exact line
    const badWorkspace = path.join(baseTmp, '插件', '中文路径', 'workspace-err');
    const badBuildDir = path.join(baseTmp, '插件', '中文路径', 'build-err');
    fs.mkdirSync(badWorkspace, { recursive: true });
    const badTex = [
      useXelatex ? '\\documentclass{ctexart}' : '\\documentclass{article}',
      '\\begin{document}',
      '第一行正常文本。',
      '这里故意触发错误：\\undefinedcmd{test}',
      '\\end{document}',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(badWorkspace, 'main.tex'), badTex, 'utf8');

    const errRes = await queue.compileProject({
      projectId: 'proj-real-err',
      workspaceDir: badWorkspace,
      buildDir: badBuildDir,
      mainFile: 'main.tex',
      engine: useXelatex ? 'xelatex' : 'pdflatex',
    });

    expect(errRes.ok).toBe(false);
    expect(errRes.errorCount).toBeGreaterThanOrEqual(1);
    const undefDiag = errRes.diagnostics.find((d) => d.code === 'UNDEFINED_CONTROL_SEQUENCE');
    expect(undefDiag).toBeDefined();
    expect(undefDiag?.file).toBe('main.tex');
    expect(undefDiag?.line).toBe(4);
    expect(undefDiag?.titleZh).toContain('undefinedcmd');
    expect(undefDiag?.snippet).toContain('> 4 |');
  }, 60_000);
});
