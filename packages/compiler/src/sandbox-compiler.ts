import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PathSecurityError,
  normalizeProjectRelPath,
  resolveInsideWorkspace,
  type CompileDiagnostic,
  type CompileEngine,
  type CompileResult,
} from '@novatex/shared';
import { parseLatexLog } from './log-parser.js';

export interface TexToolchainInfo {
  available: boolean;
  engines: CompileEngine[];
  binaries: Partial<Record<CompileEngine | 'latexmk' | 'bibtex' | 'biber' | 'qpdf', string>>;
  hasLatexmk: boolean;
  hasBibtex: boolean;
  hasBiber: boolean;
  hasQpdf: boolean;
  texBinDir: string | null;
}

export interface DetectToolchainOptions {
  qpdfBin?: string;
  includeSystemPath?: boolean;
  includeLocalTools?: boolean;
}

export interface SpawnRunRequest {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}

export interface SpawnRunResponse {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type SpawnRunner = (req: SpawnRunRequest) => Promise<SpawnRunResponse>;

export interface CompileQueueOptions {
  maxConcurrency?: number;
  timeoutMs?: number;
  texBinDir?: string;
  qpdfBin?: string;
  includeSystemPath?: boolean;
  includeLocalTools?: boolean;
  /** Allow running lualatex (`\directlua` sandbox risk). Defaults to false unless ALLOW_LUALATEX=true. */
  allowLuaLatex?: boolean;
  /** Optional custom process runner for unit tests */
  _spawnOverride?: SpawnRunner;
  /** Optional custom toolchain detector for unit tests */
  _detectOverride?: () => Promise<TexToolchainInfo>;
}

export interface CompileProjectOptions {
  projectId: string;
  workspaceDir: string;
  buildDir: string;
  mainFile: string;
  engine?: CompileEngine;
  timeoutMs?: number;
}

const HARDENED_TEXMF_CNF = [
  '% NovaTeX hardened sandbox texmf.cnf (auto-generated per compile job)',
  'shell_escape = f',
  'shell_escape_commands = none',
  'openin_any = p',
  'openout_any = p',
  '',
].join('\n');

const SAFE_TEX_ENV_ALLOWLIST = new Set([
  'path',
  'pathext',
  'systemroot',
  'windir',
  'comspec',
  'lang',
  'lc_all',
  'lc_ctype',
  'tz',
  'home',
  'userprofile',
  'fontconfig_path',
  'fontconfig_file',
  'xdg_cache_home',
  'texmfvar',
  'tmp',
  'temp',
]);

const ALLOWED_MAIN_TEX_EXTENSIONS = new Set(['.tex', '.ltx']);

const LATEXMKRC_NAMES = new Set(['.latexmkrc', 'latexmkrc']);
const TEXMF_CNF_NAMES = new Set(['texmf.cnf', '.texmf.cnf']);

const RERUN_PATTERNS = [
  /Rerun to get cross-references right/i,
  /Rerun to get citations correct/i,
  /Rerun to get outlines right/i,
  /Rerun to get internal references right/i,
  /Label\(s\) may have changed/i,
  /Table widths have changed/i,
  /Please \(re\)run/i,
];

function isExecutableFile(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
    if (process.platform === 'win32') return true;
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findBinaryInDir(dir: string, toolName: string): string | null {
  if (!dir) return null;
  const candidates =
    process.platform === 'win32'
      ? [`${toolName}.exe`, `${toolName}.cmd`, `${toolName}.bat`, toolName]
      : [toolName];

  for (const name of candidates) {
    const full = path.join(dir, name);
    if (isExecutableFile(full)) {
      return full;
    }
  }
  return null;
}

function isAsciiPath(p: string): boolean {
  return /^[\x20-\x7e]+$/.test(p);
}

/**
 * Resolve a writable ASCII-only temp directory for staging TeX jobs.
 * TeX Live kpathsea on Windows fails when cwd, -output-directory, or TEXMFCNF contain non-ASCII characters.
 */
export function resolveAsciiTempRoot(): string {
  const candidates: string[] = [];
  if (process.env.NOVATEX_STAGE_TMP?.trim()) {
    candidates.push(process.env.NOVATEX_STAGE_TMP.trim());
  }
  candidates.push(os.tmpdir());
  if (process.platform === 'win32') {
    candidates.push('D:\\Temp', 'C:\\Temp', 'C:\\Windows\\Temp');
  } else {
    candidates.push('/tmp');
  }

  for (const raw of candidates) {
    const resolved = path.resolve(raw);
    if (!isAsciiPath(resolved)) continue;
    try {
      fs.mkdirSync(resolved, { recursive: true });
      fs.accessSync(resolved, fs.constants.W_OK);
      return resolved;
    } catch {
      // try next ASCII candidate
    }
  }

  return os.tmpdir();
}

function stageWorkspaceFiles(
  workspaceDir: string,
  stageWorkspaceDir: string,
  callerBuildDir?: string,
): void {
  const resolvedRoot = path.resolve(workspaceDir);
  const resolvedCallerBuild = callerBuildDir ? path.resolve(callerBuildDir) : null;
  fs.mkdirSync(stageWorkspaceDir, { recursive: true });

  const walk = (srcDir: string, dstDir: string) => {
    const entries = fs.readdirSync(srcDir, { withFileTypes: true });
    for (const entry of entries) {
      const lowerName = entry.name.toLowerCase();
      if (
        lowerName === '.git' ||
        lowerName === '.gitmodules' ||
        /^git~[0-9]+$/i.test(entry.name) ||
        lowerName === 'node_modules' ||
        lowerName === '_build' ||
        entry.isSymbolicLink()
      ) {
        continue;
      }

      const srcPath = path.join(srcDir, entry.name);
      if (resolvedCallerBuild && path.resolve(srcPath) === resolvedCallerBuild) {
        continue;
      }

      const dstPath = path.join(dstDir, entry.name);
      if (entry.isDirectory()) {
        fs.mkdirSync(dstPath, { recursive: true });
        walk(srcPath, dstPath);
      } else if (entry.isFile()) {
        fs.copyFileSync(srcPath, dstPath);
      }
    }
  };

  walk(resolvedRoot, stageWorkspaceDir);
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sanitizeStagePathsInLog(rawLog: string, stageWorkspaceDir: string): string {
  if (!rawLog) return rawLog;
  const variants = new Set<string>();
  const addVariant = (dir: string) => {
    const fwd = dir.replace(/\\/g, '/').replace(/\/+$/, '');
    const bwd = dir.replace(/\//g, '\\').replace(/\\+$/, '');
    if (fwd) variants.add(fwd);
    if (bwd) variants.add(bwd);
  };

  addVariant(path.resolve(stageWorkspaceDir));
  try {
    if (fs.existsSync(stageWorkspaceDir)) {
      addVariant(fs.realpathSync(stageWorkspaceDir));
    }
  } catch {
    // ignore
  }

  let out = rawLog;
  const flags = process.platform === 'win32' ? 'gi' : 'g';
  for (const variant of variants) {
    const re = new RegExp(escapeRegExp(variant), flags);
    out = out.replace(re, '.');
  }
  return out;
}

function findLocalToolsDirs(): string[] {
  const results: string[] = [];
  const startDirs = new Set<string>();

  try {
    startDirs.add(path.dirname(fileURLToPath(import.meta.url)));
  } catch {
    // ignore
  }
  startDirs.add(process.cwd());

  const subPaths = [
    path.join('.local-tools', 'TinyTeX', 'bin', 'windows'),
    path.join('.local-tools', 'TinyTeX', 'bin', 'win32'),
    path.join('.local-tools', 'TinyTeX', 'bin', 'x86_64-linux'),
    path.join('.local-tools', 'TinyTeX', 'bin', 'aarch64-linux'),
    path.join('.local-tools', 'TinyTeX', 'bin', 'universal-darwin'),
    path.join('.local-tools', 'qpdf', 'bin'),
  ];

  const seenRoots = new Set<string>();
  for (const start of startDirs) {
    let cursor = path.resolve(start);
    for (let depth = 0; depth < 6; depth++) {
      if (!seenRoots.has(cursor)) {
        seenRoots.add(cursor);
        for (const rel of subPaths) {
          const candidate = path.join(cursor, rel);
          if (fs.existsSync(candidate) && !results.includes(candidate)) {
            results.push(candidate);
          }
        }
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
  }

  // ASCII-safe TinyTeX candidate directories on Windows (avoids non-ASCII repo path failures in kpathsea)
  if (process.platform === 'win32') {
    const winAsciiCandidates = [
      'C:\\TinyTeX\\bin\\windows',
      'D:\\TinyTeX\\bin\\windows',
      'E:\\TinyTeX\\bin\\windows',
      path.join(os.homedir(), 'AppData', 'Roaming', 'TinyTeX', 'bin', 'windows'),
    ];
    for (const candidate of winAsciiCandidates) {
      if (isAsciiPath(candidate) && fs.existsSync(candidate) && !results.includes(candidate)) {
        results.push(candidate);
      }
    }
  }

  return results;
}

/**
 * Detect available TeX engines (`xelatex`, `pdflatex`, `lualatex`), `latexmk`,
 * `bibtex`, `biber`, and `qpdf` across explicit bin dirs, `TEX_BIN_DIR`,
 * `.local-tools/TinyTeX`, ASCII Windows TinyTeX locations, and system `PATH`.
 */
export async function detectTexToolchain(
  explicitBinDir?: string,
  options?: DetectToolchainOptions,
): Promise<TexToolchainInfo> {
  const includeSystemPath = options?.includeSystemPath ?? true;
  const includeLocalTools = options?.includeLocalTools ?? true;

  const searchDirs: string[] = [];
  if (explicitBinDir && fs.existsSync(explicitBinDir)) {
    searchDirs.push(path.resolve(explicitBinDir));
  }
  if (
    process.env.TEX_BIN_DIR &&
    (includeSystemPath || includeLocalTools || !explicitBinDir) &&
    fs.existsSync(process.env.TEX_BIN_DIR)
  ) {
    const envTexDir = path.resolve(process.env.TEX_BIN_DIR);
    if (!searchDirs.includes(envTexDir)) {
      searchDirs.push(envTexDir);
    }
  }
  if (includeLocalTools) {
    for (const d of findLocalToolsDirs()) {
      if (!searchDirs.includes(d)) {
        searchDirs.push(d);
      }
    }
  }
  if (includeSystemPath && process.env.PATH) {
    for (const entry of process.env.PATH.split(path.delimiter)) {
      const trimmed = entry.trim().replace(/^"|"$/g, '');
      if (trimmed && !searchDirs.includes(trimmed)) {
        searchDirs.push(trimmed);
      }
    }
  }

  const findTool = (name: string): string | undefined => {
    for (const dir of searchDirs) {
      const found = findBinaryInDir(dir, name);
      if (found) return found;
    }
    return undefined;
  };

  const binaries: TexToolchainInfo['binaries'] = {};
  const engineNames: CompileEngine[] = ['xelatex', 'pdflatex', 'lualatex'];
  const engines: CompileEngine[] = [];

  for (const eng of engineNames) {
    const bin = findTool(eng);
    if (bin) {
      binaries[eng] = bin;
      engines.push(eng);
    }
  }

  const latexmk = findTool('latexmk');
  if (latexmk) binaries.latexmk = latexmk;

  const bibtex = findTool('bibtex');
  if (bibtex) binaries.bibtex = bibtex;

  const biber = findTool('biber');
  if (biber) binaries.biber = biber;

  // Check explicit qpdf binary path first
  const explicitQpdf = options?.qpdfBin || (includeSystemPath ? process.env.QPDF_BIN : undefined);
  if (explicitQpdf && isExecutableFile(explicitQpdf)) {
    binaries.qpdf = path.resolve(explicitQpdf);
  } else {
    const qpdf = findTool('qpdf');
    if (qpdf) binaries.qpdf = qpdf;
  }

  const firstEngineBin = engines.length > 0 ? binaries[engines[0]!] : undefined;
  const texBinDir = firstEngineBin ? path.dirname(firstEngineBin) : null;

  return {
    available: engines.length > 0,
    engines,
    binaries,
    hasLatexmk: Boolean(binaries.latexmk),
    hasBibtex: Boolean(binaries.bibtex),
    hasBiber: Boolean(binaries.biber),
    hasQpdf: Boolean(binaries.qpdf),
    texBinDir,
  };
}

function stripTexComments(content: string): string {
  return content
    .split(/\r?\n/)
    .map((line) => {
      let out = '';
      for (let i = 0; i < line.length; i++) {
        if (line[i] === '%' && (i === 0 || line[i - 1] !== '\\')) {
          break;
        }
        out += line[i];
      }
      return out;
    })
    .join('\n');
}

/**
 * Recommend a LaTeX engine based on `.tex` source content unless caller explicitly requested one.
 * Automatically picks `xelatex` when CJK characters or `ctex`/`xeCJK`/`fontspec` are present.
 */
export function recommendEngine(
  mainTexContent: string,
  requestedEngine?: CompileEngine,
): CompileEngine {
  if (requestedEngine) {
    return requestedEngine;
  }

  const active = stripTexComments(mainTexContent);

  if (
    /\\documentclass(?:\[[^\]]*\])?\{ctex(?:art|book|rep|beamer)\}/i.test(active) ||
    /\\usepackage(?:\[[^\]]*\])?\{[^}]*\b(?:ctex|xeCJK|fontspec|zhnumber)\b[^}]*\}/.test(active) ||
    /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/.test(active)
  ) {
    return 'xelatex';
  }

  if (/\\usepackage(?:\[[^\]]*\])?\{[^}]*\b(?:luacode|luatexbase|luatexja)\b[^}]*\}/.test(active)) {
    return 'lualatex';
  }

  return 'pdflatex';
}

/**
 * Write a hardened per-job `texmf.cnf` inside `confDir` disabling shell-escape and
 * enforcing paranoid file I/O (`openin_any = p`, `openout_any = p`).
 */
export function writeHardenedTexmfCnf(confDir: string): string {
  fs.mkdirSync(confDir, { recursive: true });
  const cnfPath = path.join(confDir, 'texmf.cnf');
  fs.writeFileSync(cnfPath, HARDENED_TEXMF_CNF, 'utf8');
  return cnfPath;
}

/**
 * Build a hardened process environment using a STRICT allowlist of safe OS runtime variables,
 * pointing `TEXMFCNF` at our per-job `confDir` with a trailing platform path separator so
 * system TeX defaults load AFTER our overrides, and never forwarding application secrets.
 */
export function buildHardenedTexEnv(
  confDir: string,
  texBinDir?: string | null,
  baseEnv: NodeJS.ProcessEnv = process.env,
  jobTmpDir?: string,
): NodeJS.ProcessEnv {
  const sep = process.platform === 'win32' ? ';' : ':';
  const normalizedConfDir = confDir.replace(/\\/g, '/').replace(/\/+$/, '');
  const env: NodeJS.ProcessEnv = {};

  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    if (SAFE_TEX_ENV_ALLOWLIST.has(key.toLowerCase())) {
      env[key] = value;
    }
  }

  // Override TMP/TEMP to an isolated ASCII per-job temp directory when provided
  if (jobTmpDir) {
    for (const key of Object.keys(env)) {
      const lower = key.toLowerCase();
      if (lower === 'tmp' || lower === 'temp') {
        delete env[key];
      }
    }
    env.TMP = jobTmpDir;
    env.TEMP = jobTmpDir;
  }

  // Trailing separator preserves built-in system texmf.cnf defaults AFTER our overrides
  env.TEXMFCNF = `${normalizedConfDir}${sep}`;
  // Defense-in-depth env vars honored directly by kpathsea (non-empty `none` avoids empty-value fallback!)
  env.shell_escape = 'f';
  env.shell_escape_commands = 'none';
  env.openin_any = 'p';
  env.openout_any = 'p';

  if (texBinDir) {
    const existingPath = env.PATH ?? env.Path ?? '';
    const updatedPath = existingPath ? `${texBinDir}${path.delimiter}${existingPath}` : texBinDir;
    env.PATH = updatedPath;
    if (process.platform === 'win32' && 'Path' in env) {
      env.Path = updatedPath;
    }
  }

  return env;
}

interface ForbiddenScanResult {
  latexmkrcFiles: string[];
  texmfCnfFiles: string[];
}

/**
 * Recursively scan a workspace for forbidden `.latexmkrc` / `latexmkrc` / `texmf.cnf` files.
 */
export function scanForbiddenWorkspaceFiles(
  workspaceDir: string,
  buildDir?: string,
): ForbiddenScanResult {
  const latexmkrcFiles: string[] = [];
  const texmfCnfFiles: string[] = [];

  if (!fs.existsSync(workspaceDir)) {
    return { latexmkrcFiles, texmfCnfFiles };
  }

  const resolvedRoot = path.resolve(workspaceDir);
  const resolvedBuild = buildDir ? path.resolve(buildDir) : null;

  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (resolvedBuild && path.resolve(fullPath) === resolvedBuild) {
        continue;
      }
      const lower = entry.name.toLowerCase();
      if (lower === '.git' || lower === 'node_modules') {
        continue;
      }

      const rel = path.relative(resolvedRoot, fullPath).replace(/\\/g, '/');

      if (LATEXMKRC_NAMES.has(lower)) {
        latexmkrcFiles.push(rel);
      } else if (TEXMF_CNF_NAMES.has(lower)) {
        texmfCnfFiles.push(rel);
      }

      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        walk(fullPath);
      }
    }
  };

  walk(resolvedRoot);
  return { latexmkrcFiles, texmfCnfFiles };
}

function killProcessTree(pid: number | undefined): void {
  if (!pid || pid <= 0) return;
  if (process.platform === 'win32') {
    try {
      execFile(
        'taskkill',
        ['/pid', String(pid), '/T', '/F'],
        { windowsHide: true },
        () => {
          // best-effort cleanup
        },
      );
    } catch {
      // ignore
    }
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // ignore
      }
    }
  }
}

function defaultSpawnRunner(req: SpawnRunRequest): Promise<SpawnRunResponse> {
  return new Promise((resolve) => {
    const child = spawn(req.command, req.args, {
      cwd: req.cwd,
      env: req.env,
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    let settled = false;

    const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;
    let stdoutLen = 0;
    let stderrLen = 0;

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdoutLen < MAX_CAPTURE_BYTES) {
        stdoutChunks.push(chunk);
        stdoutLen += chunk.length;
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderrLen < MAX_CAPTURE_BYTES) {
        stderrChunks.push(chunk);
        stderrLen += chunk.length;
      }
    });

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child.pid);
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
    }, Math.max(500, req.timeoutMs));

    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode: code,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        timedOut,
      });
    };

    child.on('error', (err) => {
      stderrChunks.push(Buffer.from(`\nProcess spawn error: ${err.message}\n`, 'utf8'));
      finish(-1);
    });

    child.on('close', (code) => {
      finish(typeof code === 'number' ? code : -1);
    });
  });
}

function hashFileIfExists(filePath: string): string | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const data = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(data).digest('hex');
  } catch {
    return null;
  }
}

function copyFileAtomic(srcPath: string, destPath: string): void {
  const dir = path.dirname(destPath);
  const base = path.basename(destPath);
  const tmpPath = path.join(
    dir,
    `${base}.tmp.${process.pid}.${crypto.randomBytes(6).toString('hex')}`,
  );
  try {
    fs.copyFileSync(srcPath, tmpPath);
    fs.renameSync(tmpPath, destPath);
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) {
        fs.rmSync(tmpPath, { force: true });
      }
    } catch {
      // ignore temp cleanup failure
    }
    throw err;
  }
}

function makeErrorResult(params: {
  jobId: string;
  projectId: string;
  engine: CompileEngine;
  mainFile: string;
  startTime: number;
  compilerAvailable: boolean;
  compilerNote?: string;
  diagnostics: CompileDiagnostic[];
  rawLog?: string;
}): CompileResult {
  const errorCount = params.diagnostics.filter((d) => d.severity === 'error').length;
  const warningCount = params.diagnostics.filter((d) => d.severity === 'warning').length;
  return {
    jobId: params.jobId,
    projectId: params.projectId,
    ok: false,
    engine: params.engine,
    mainFile: params.mainFile,
    durationMs: Math.max(0, Date.now() - params.startTime),
    exitCode: -1,
    pdfReady: false,
    pdfSize: 0,
    synctexReady: false,
    linearized: false,
    diagnostics: params.diagnostics,
    errorCount,
    warningCount,
    rawLog: params.rawLog ?? '',
    compilerAvailable: params.compilerAvailable,
    ...(params.compilerNote ? { compilerNote: params.compilerNote } : {}),
    finishedAt: new Date().toISOString(),
  };
}

/**
 * Concurrency-limited, security-hardened LaTeX compile queue.
 */
export class CompileQueue {
  private readonly maxConcurrency: number;
  private readonly defaultTimeoutMs: number;
  private readonly texBinDir?: string;
  private readonly qpdfBin?: string;
  private readonly includeSystemPath: boolean;
  private readonly includeLocalTools: boolean;
  private readonly allowLuaLatex: boolean;
  private readonly spawnRunner: SpawnRunner;
  private readonly detectOverride?: () => Promise<TexToolchainInfo>;

  private activeCount = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(options: CompileQueueOptions = {}) {
    this.maxConcurrency = Math.max(1, Math.trunc(options.maxConcurrency ?? 1));
    this.defaultTimeoutMs = Math.max(1000, Math.trunc(options.timeoutMs ?? 60_000));
    this.texBinDir = options.texBinDir;
    this.qpdfBin = options.qpdfBin;
    this.includeSystemPath = options.includeSystemPath ?? true;
    this.includeLocalTools = options.includeLocalTools ?? true;
    this.allowLuaLatex = options.allowLuaLatex ?? process.env.ALLOW_LUALATEX === 'true';
    this.spawnRunner = options._spawnOverride ?? defaultSpawnRunner;
    this.detectOverride = options._detectOverride;
  }

  getQueueStats(): { active: number; queued: number; maxConcurrency: number } {
    return {
      active: this.activeCount,
      queued: this.waiters.length,
      maxConcurrency: this.maxConcurrency,
    };
  }

  async detectToolchain(): Promise<TexToolchainInfo> {
    if (this.detectOverride) {
      return this.detectOverride();
    }
    return detectTexToolchain(this.texBinDir, {
      qpdfBin: this.qpdfBin,
      includeSystemPath: this.includeSystemPath,
      includeLocalTools: this.includeLocalTools,
    });
  }

  private acquire(): Promise<void> {
    if (this.activeCount < this.maxConcurrency) {
      this.activeCount++;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waiters.push(() => {
        this.activeCount++;
        resolve();
      });
    });
  }

  private release(): void {
    this.activeCount = Math.max(0, this.activeCount - 1);
    const next = this.waiters.shift();
    if (next) {
      next();
    }
  }

  async compileProject(opts: CompileProjectOptions): Promise<CompileResult> {
    const jobId = crypto.randomUUID();
    const startTime = Date.now();
    const requestedEngine = opts.engine;
    let effectiveEngine: CompileEngine = requestedEngine ?? 'pdflatex';

    // 1. Validate mainFile strictly inside workspaceDir (and guard against TeX CLI flag/format injection)
    let safeRelMain: string;
    let absMainPath: string;
    try {
      safeRelMain = normalizeProjectRelPath(opts.mainFile);
      const resolved = resolveInsideWorkspace(opts.workspaceDir, safeRelMain);
      safeRelMain = resolved.relPath;
      absMainPath = resolved.absPath;
    } catch (err) {
      const rawCode = err instanceof PathSecurityError ? err.code : 'INVALID_MAIN_FILE';
      const code = rawCode === 'INVALID_PREFIX' ? 'INVALID_MAIN_FILE' : rawCode;
      const msg = err instanceof Error ? err.message : String(err);
      return makeErrorResult({
        jobId,
        projectId: opts.projectId,
        engine: effectiveEngine,
        mainFile: opts.mainFile,
        startTime,
        compilerAvailable: true,
        diagnostics: [
          {
            id: 'diag-1',
            file: opts.mainFile,
            line: 0,
            severity: 'error',
            code,
            titleZh: '主文件路径不合法',
            explanationZh: `拒绝编译：${msg}`,
            quickFixHintZh: '请指定项目工作区内的合法相对路径 .tex / .ltx 文件（禁止越界、绝对路径或以 -/& 开头）。',
            rawMessage: msg,
          },
        ],
      });
    }

    const mainBaseName = path.posix.basename(safeRelMain);
    const mainExt = path.posix.extname(mainBaseName).toLowerCase();
    if (
      mainBaseName.startsWith('-') ||
      mainBaseName.startsWith('&') ||
      mainBaseName.startsWith('\\') ||
      !ALLOWED_MAIN_TEX_EXTENSIONS.has(mainExt)
    ) {
      return makeErrorResult({
        jobId,
        projectId: opts.projectId,
        engine: effectiveEngine,
        mainFile: safeRelMain,
        startTime,
        compilerAvailable: true,
        diagnostics: [
          {
            id: 'diag-1',
            file: safeRelMain,
            line: 0,
            severity: 'error',
            code: 'INVALID_MAIN_FILE',
            titleZh: '主文件名或扩展名不合法',
            explanationZh: `拒绝编译：主文件 "${mainBaseName}" 不能以 "-"/"&"/"\\" 开头，且必须为 .tex 或 .ltx 文件。`,
            quickFixHintZh: '请指定合法的 .tex 或 .ltx 主编译文件（例如 main.tex）。',
            rawMessage: `Invalid mainFile basename or extension: ${safeRelMain}`,
          },
        ],
      });
    }

    // 2. Security scan: refuse workspace containing `.latexmkrc` / `latexmkrc` / `texmf.cnf`
    const forbidden = scanForbiddenWorkspaceFiles(opts.workspaceDir, opts.buildDir);
    if (forbidden.latexmkrcFiles.length > 0) {
      const foundList = forbidden.latexmkrcFiles.join(', ');
      return makeErrorResult({
        jobId,
        projectId: opts.projectId,
        engine: effectiveEngine,
        mainFile: safeRelMain,
        startTime,
        compilerAvailable: true,
        diagnostics: [
          {
            id: 'diag-1',
            file: forbidden.latexmkrcFiles[0]!,
            line: 0,
            severity: 'error',
            code: 'FORBIDDEN_LATEXMKRC',
            titleZh: '安全策略拦截：检测到禁止的 latexmkrc 文件',
            explanationZh: `工作区中存在 ${foundList}。为防止任意命令执行（RCE），NovaTeX 严禁编译包含 .latexmkrc / latexmkrc 的项目。`,
            quickFixHintZh: `请删除 ${foundList} 后重新编译。`,
            rawMessage: `Forbidden latexmkrc detected in workspace: ${foundList}`,
          },
        ],
      });
    }

    if (forbidden.texmfCnfFiles.length > 0) {
      const foundList = forbidden.texmfCnfFiles.join(', ');
      return makeErrorResult({
        jobId,
        projectId: opts.projectId,
        engine: effectiveEngine,
        mainFile: safeRelMain,
        startTime,
        compilerAvailable: true,
        diagnostics: [
          {
            id: 'diag-1',
            file: forbidden.texmfCnfFiles[0]!,
            line: 0,
            severity: 'error',
            code: 'FORBIDDEN_TEXMF_CNF',
            titleZh: '安全策略拦截：检测到禁止的 texmf.cnf 文件',
            explanationZh: `工作区中存在 ${foundList}，可能绕过沙箱安全配置，编译已被拒绝。`,
            quickFixHintZh: `请删除 ${foundList} 后重新编译。`,
            rawMessage: `Forbidden texmf.cnf detected in workspace: ${foundList}`,
          },
        ],
      });
    }

    // 3. Check mainFile exists & recommend engine
    if (!fs.existsSync(absMainPath) || !fs.statSync(absMainPath).isFile()) {
      return makeErrorResult({
        jobId,
        projectId: opts.projectId,
        engine: effectiveEngine,
        mainFile: safeRelMain,
        startTime,
        compilerAvailable: true,
        diagnostics: [
          {
            id: 'diag-1',
            file: safeRelMain,
            line: 0,
            severity: 'error',
            code: 'MAIN_FILE_NOT_FOUND',
            titleZh: `找不到主文件：${safeRelMain}`,
            explanationZh: `项目工作区中不存在主编译文件 ${safeRelMain}。`,
            quickFixHintZh: '请检查项目设置中的主文件名是否正确，或先创建该 .tex 文件。',
            rawMessage: `Main TeX file not found: ${safeRelMain}`,
          },
        ],
      });
    }

    let mainContent = '';
    try {
      mainContent = fs.readFileSync(absMainPath, 'utf8');
    } catch {
      mainContent = '';
    }
    effectiveEngine = recommendEngine(mainContent, requestedEngine);

    // 3.5 Security policy: lualatex is disabled by default due to `\directlua` sandbox escape risk
    if (effectiveEngine === 'lualatex' && !this.allowLuaLatex) {
      return makeErrorResult({
        jobId,
        projectId: opts.projectId,
        engine: effectiveEngine,
        mainFile: safeRelMain,
        startTime,
        compilerAvailable: true,
        diagnostics: [
          {
            id: 'diag-1',
            file: safeRelMain,
            line: 0,
            severity: 'error',
            code: 'LUALATEX_DISABLED',
            titleZh: '安全策略已禁用 LuaLaTeX 引擎',
            explanationZh:
              'LuaLaTeX 允许通过 \\directlua 执行 Lua 脚本，存在绕过编译沙箱的风险，默认处于关闭状态。',
            quickFixHintZh:
              '请改用 XeLaTeX（中文与现代字体推荐）或 pdfLaTeX 编译；如在受控隔离环境中确需启用，请由管理员配置 ALLOW_LUALATEX=true。',
            rawMessage: 'Engine "lualatex" is disabled by default security policy (set ALLOW_LUALATEX=true to enable).',
          },
        ],
      });
    }

    // 4. Detect TeX toolchain gracefully
    const toolchain = await this.detectToolchain();
    if (!toolchain.available) {
      const note =
        '当前环境尚未检测到可用的 TeX 编译引擎（xelatex / pdflatex / lualatex）。可将 TinyTeX 安装到项目 .local-tools/TinyTeX 目录、配置 TEX_BIN_DIR 环境变量，或切换 COMPILER_MODE=remote 连接远端 worker-1 编译节点。';
      return makeErrorResult({
        jobId,
        projectId: opts.projectId,
        engine: effectiveEngine,
        mainFile: safeRelMain,
        startTime,
        compilerAvailable: false,
        compilerNote: note,
        diagnostics: [
          {
            id: 'diag-1',
            file: safeRelMain,
            line: 0,
            severity: 'error',
            code: 'COMPILER_UNAVAILABLE',
            titleZh: '未检测到本地 LaTeX 编译器',
            explanationZh: note,
            quickFixHintZh:
              '安装 TinyTeX 到 .local-tools/TinyTeX，或在 .env 中设置 TEX_BIN_DIR / COMPILER_MODE=remote（配置 worker-1）。',
            rawMessage: 'No TeX compiler binary (xelatex/pdflatex/lualatex) found in toolchain.',
          },
        ],
      });
    }

    let compilerNote: string | undefined;
    let engineBin = toolchain.binaries[effectiveEngine];
    if (!engineBin) {
      const eligibleEngines = this.allowLuaLatex
        ? toolchain.engines
        : toolchain.engines.filter((e) => e !== 'lualatex');
      const fallback = eligibleEngines[0];
      if (!fallback) {
        return makeErrorResult({
          jobId,
          projectId: opts.projectId,
          engine: effectiveEngine,
          mainFile: safeRelMain,
          startTime,
          compilerAvailable: false,
          diagnostics: [
            {
              id: 'diag-1',
              file: safeRelMain,
              line: 0,
              severity: 'error',
              code: 'LUALATEX_DISABLED',
              titleZh: '无可用安全引擎（仅检测到默认禁用的 LuaLaTeX）',
              explanationZh:
                '当前环境仅检测到 lualatex，但其因 \\directlua 沙箱风险默认禁用，未检测到 xelatex 或 pdflatex。',
              quickFixHintZh: '请安装 XeLaTeX/pdfLaTeX，或在受控环境中配置 ALLOW_LUALATEX=true。',
              rawMessage: 'Only lualatex is installed and ALLOW_LUALATEX is disabled.',
            },
          ],
        });
      }
      compilerNote = `未找到 ${effectiveEngine}，已自动回退为已安装的 ${fallback}。`;
      effectiveEngine = fallback;
      engineBin = toolchain.binaries[fallback]!;
    }

    // 5. Enter concurrency-limited execution slot (staged in an ASCII-only temp dir)
    await this.acquire();
    let jobStageRoot: string | null = null;
    try {
      const asciiTmpRoot = resolveAsciiTempRoot();
      jobStageRoot = fs.mkdtempSync(path.join(asciiTmpRoot, 'novatex-job-'));

      const stageWorkspaceDir = path.join(jobStageRoot, 'src');
      const stageBuildRel = '_build';
      const stageBuildDir = path.join(stageWorkspaceDir, stageBuildRel);
      const stageConfDir = path.join(jobStageRoot, 'conf');
      const stageTmpDir = path.join(jobStageRoot, 'tmp');

      stageWorkspaceFiles(opts.workspaceDir, stageWorkspaceDir, opts.buildDir);
      fs.mkdirSync(stageBuildDir, { recursive: true });
      fs.mkdirSync(stageTmpDir, { recursive: true });
      writeHardenedTexmfCnf(stageConfDir);

      const hardenedEnv = buildHardenedTexEnv(
        stageConfDir,
        toolchain.texBinDir,
        process.env,
        stageTmpDir,
      );
      const totalTimeoutMs = Math.max(1000, opts.timeoutMs ?? this.defaultTimeoutMs);
      const deadline = Date.now() + totalTimeoutMs;
      const remainingMs = () => Math.max(0, deadline - Date.now());

      const stem = path.basename(safeRelMain, path.extname(safeRelMain));
      const stageLogPath = path.join(stageBuildDir, `${stem}.log`);
      const stageAuxPath = path.join(stageBuildDir, `${stem}.aux`);
      const stageBcfPath = path.join(stageBuildDir, `${stem}.bcf`);
      const stagePdfPath = path.join(stageBuildDir, `${stem}.pdf`);
      const stageSynctexGzPath = path.join(stageBuildDir, `${stem}.synctex.gz`);
      const stageSynctexRawPath = path.join(stageBuildDir, `${stem}.synctex`);

      // Explicit `./` prefix prevents TeX CLI argument/format/macro injection (`-`, `&`, `\`).
      // Relative `-output-directory=_build` satisfies `openout_any = p` AND stays strictly ASCII.
      const texArgs = [
        '-interaction=nonstopmode',
        '-file-line-error',
        '-no-shell-escape',
        '-synctex=1',
        `-output-directory=${stageBuildRel}`,
        `./${safeRelMain}`,
      ];

      const runEnginePass = async (): Promise<SpawnRunResponse> => {
        const budget = remainingMs();
        if (budget <= 0) {
          return { exitCode: -1, stdout: '', stderr: 'Compile timeout exceeded.', timedOut: true };
        }
        return this.spawnRunner({
          command: engineBin,
          args: texArgs,
          cwd: stageWorkspaceDir,
          env: hardenedEnv,
          timeoutMs: budget,
        });
      };

      const extraLogs: string[] = [];

      // Pass 1
      let lastRun = await runEnginePass();
      let timedOut = lastRun.timedOut;
      let prevAuxHash = hashFileIfExists(stageAuxPath);

      // Bibliography step (biber or bibtex) if needed and time remains
      let bibRan = false;
      if (!timedOut && remainingMs() > 1000 && stem.length > 0 && !stem.startsWith('-')) {
        if (fs.existsSync(stageBcfPath) && toolchain.binaries.biber) {
          const bibRun = await this.spawnRunner({
            command: toolchain.binaries.biber,
            args: ['--output-directory', stageBuildRel, '--', stem],
            cwd: stageWorkspaceDir,
            env: hardenedEnv,
            timeoutMs: remainingMs(),
          });
          bibRan = true;
          if (bibRun.timedOut) timedOut = true;
          if (bibRun.exitCode !== 0 && (bibRun.stdout || bibRun.stderr)) {
            extraLogs.push(`--- biber output ---\n${bibRun.stdout}\n${bibRun.stderr}`);
          }
        } else if (fs.existsSync(stageAuxPath) && toolchain.binaries.bibtex) {
          let auxText = '';
          try {
            auxText = fs.readFileSync(stageAuxPath, 'utf8');
          } catch {
            auxText = '';
          }
          if (/\\bibdata\{/.test(auxText) && /\\citation\{/.test(auxText)) {
            const bibRun = await this.spawnRunner({
              command: toolchain.binaries.bibtex,
              args: [`${stageBuildRel}/${stem}`],
              cwd: stageWorkspaceDir,
              env: hardenedEnv,
              timeoutMs: remainingMs(),
            });
            bibRan = true;
            if (bibRun.timedOut) timedOut = true;
            if (bibRun.exitCode !== 0 && (bibRun.stdout || bibRun.stderr)) {
              extraLogs.push(`--- bibtex output ---\n${bibRun.stdout}\n${bibRun.stderr}`);
            }
          }
        }
      }

      // Additional stabilization passes (up to 2 more passes = max 3 TeX passes)
      const needsRerun = (runRes: SpawnRunResponse): boolean => {
        let combined = `${runRes.stdout}\n${runRes.stderr}`;
        if (fs.existsSync(stageLogPath)) {
          try {
            combined = fs.readFileSync(stageLogPath, 'utf8');
          } catch {
            // keep stdout/stderr
          }
        }
        return RERUN_PATTERNS.some((re) => re.test(combined));
      };

      let shouldRunNext = !timedOut && (bibRan || (lastRun.exitCode === 0 && needsRerun(lastRun)));
      for (let extraPass = 0; extraPass < 2 && shouldRunNext && !timedOut && remainingMs() > 1000; extraPass++) {
        lastRun = await runEnginePass();
        if (lastRun.timedOut) {
          timedOut = true;
          break;
        }
        const nextAuxHash = hashFileIfExists(stageAuxPath);
        const auxChanged = nextAuxHash !== null && nextAuxHash !== prevAuxHash;
        prevAuxHash = nextAuxHash;
        shouldRunNext = lastRun.exitCode === 0 && (auxChanged || needsRerun(lastRun));
      }

      // Collect raw log (prefer full TeX `.log` file over truncated console output)
      let rawLog = '';
      if (fs.existsSync(stageLogPath)) {
        try {
          rawLog = fs.readFileSync(stageLogPath, 'utf8');
        } catch {
          rawLog = `${lastRun.stdout}\n${lastRun.stderr}`.trim();
        }
      } else {
        rawLog = `${lastRun.stdout}\n${lastRun.stderr}`.trim();
      }
      if (extraLogs.length > 0) {
        rawLog = `${rawLog}\n${extraLogs.join('\n')}`.trim();
      }

      // Normalize temp stage paths back to clean project-relative paths before parsing diagnostics
      rawLog = sanitizeStagePathsInLog(rawLog, stageWorkspaceDir);

      const diagnostics = parseLatexLog(rawLog, opts.workspaceDir);
      if (timedOut) {
        diagnostics.unshift({
          id: 'diag-timeout',
          file: safeRelMain,
          line: 0,
          severity: 'error',
          code: 'COMPILE_TIMEOUT',
          titleZh: `编译超时（超过 ${Math.round(totalTimeoutMs / 1000)} 秒）`,
          explanationZh:
            '编译进程超出时限已被强制终止，常见原因为宏定义死循环、复杂 TikZ/PGF 绘图耗时过长或系统负载过高。',
          quickFixHintZh: '请检查是否存在递归宏展开或死循环，或简化复杂绘图后重试。',
          rawMessage: `Compilation exceeded timeout of ${totalTimeoutMs}ms and was terminated.`,
        });
      }

      let stagePdfReady = false;
      if (fs.existsSync(stagePdfPath)) {
        const st = fs.statSync(stagePdfPath);
        if (st.isFile() && st.size > 0) {
          stagePdfReady = true;
        }
      }

      // Optional qpdf linearization inside ASCII stageBuildDir for fast byte-range streaming
      let linearized = false;
      if (stagePdfReady && !timedOut && toolchain.binaries.qpdf && remainingMs() > 500) {
        const tmpLinPath = path.join(stageBuildDir, `${stem}.linearized.tmp.pdf`);
        try {
          const qpdfRes = await this.spawnRunner({
            command: toolchain.binaries.qpdf,
            args: ['--linearize', stagePdfPath, tmpLinPath],
            cwd: stageBuildDir,
            env: hardenedEnv,
            timeoutMs: Math.min(15_000, Math.max(2000, remainingMs())),
          });
          // qpdf returns 0 on success, 3 on success with warnings
          if (
            !qpdfRes.timedOut &&
            (qpdfRes.exitCode === 0 || qpdfRes.exitCode === 3) &&
            fs.existsSync(tmpLinPath) &&
            fs.statSync(tmpLinPath).size > 0
          ) {
            fs.renameSync(tmpLinPath, stagePdfPath);
            linearized = true;
          }
        } catch {
          // Non-fatal: keep original PDF
        } finally {
          if (fs.existsSync(tmpLinPath)) {
            try {
              fs.rmSync(tmpLinPath, { force: true });
            } catch {
              // ignore
            }
          }
        }
      }

      // Atomically copy generated artifacts (.pdf, .synctex.gz / .synctex, .log) back to caller's buildDir
      // so concurrent PDF.js byte-range readers never observe a torn/truncated file.
      fs.mkdirSync(opts.buildDir, { recursive: true });
      const outPdfPath = path.join(opts.buildDir, `${stem}.pdf`);
      const outSynctexGzPath = path.join(opts.buildDir, `${stem}.synctex.gz`);
      const outSynctexRawPath = path.join(opts.buildDir, `${stem}.synctex`);
      const outLogPath = path.join(opts.buildDir, `${stem}.log`);

      let pdfReady = false;
      let pdfSize = 0;
      if (stagePdfReady && fs.existsSync(stagePdfPath)) {
        copyFileAtomic(stagePdfPath, outPdfPath);
        const st = fs.statSync(outPdfPath);
        pdfReady = st.isFile() && st.size > 0;
        pdfSize = pdfReady ? st.size : 0;
      }

      let synctexReady = false;
      if (fs.existsSync(stageSynctexGzPath)) {
        copyFileAtomic(stageSynctexGzPath, outSynctexGzPath);
        synctexReady = true;
      } else if (fs.existsSync(stageSynctexRawPath)) {
        copyFileAtomic(stageSynctexRawPath, outSynctexRawPath);
        synctexReady = true;
      }

      if (fs.existsSync(stageLogPath)) {
        copyFileAtomic(stageLogPath, outLogPath);
      }

      const errorCount = diagnostics.filter((d) => d.severity === 'error').length;
      const warningCount = diagnostics.filter((d) => d.severity === 'warning').length;
      const ok = !timedOut && lastRun.exitCode === 0 && pdfReady;

      return {
        jobId,
        projectId: opts.projectId,
        ok,
        engine: effectiveEngine,
        mainFile: safeRelMain,
        durationMs: Math.max(0, Date.now() - startTime),
        exitCode: timedOut ? -1 : lastRun.exitCode,
        pdfReady,
        pdfSize,
        synctexReady,
        linearized,
        diagnostics,
        errorCount,
        warningCount,
        rawLog,
        compilerAvailable: true,
        ...(compilerNote ? { compilerNote } : {}),
        finishedAt: new Date().toISOString(),
      };
    } finally {
      if (jobStageRoot) {
        try {
          fs.rmSync(jobStageRoot, { recursive: true, force: true });
        } catch {
          // best-effort cleanup
        }
      }
      this.release();
    }
  }
}
