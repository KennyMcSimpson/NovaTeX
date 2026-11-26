import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface PandocInfo {
  available: boolean;
  version: string | null;
  major: number;
  minor: number;
  binary: string | null;
}

export interface PandocRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const FILTERS_DIR = path.resolve(THIS_DIR, '../filters');

const VERSION_RE = /pandoc(?:\.exe)?\s+(\d+)\.(\d+)(?:\.(\d+(?:\.\d+)*))?/i;

function getCandidatePandocBinaries(explicitBin?: string): string[] {
  const candidates: string[] = [];
  const pushUnique = (value: string | undefined) => {
    const trimmed = value?.trim();
    if (trimmed && !candidates.includes(trimmed)) {
      candidates.push(trimmed);
    }
  };

  pushUnique(explicitBin);
  pushUnique(process.env['NOVATEX_PANDOC_BIN']);
  pushUnique(process.env['PANDOC_BIN']);
  pushUnique('pandoc');

  if (process.platform === 'win32') {
    pushUnique('C:\\ProgramData\\anaconda3\\Scripts\\pandoc.exe');
    pushUnique('C:\\Program Files\\Pandoc\\pandoc.exe');
    if (process.env['LOCALAPPDATA']) {
      pushUnique(path.join(process.env['LOCALAPPDATA'], 'Pandoc', 'pandoc.exe'));
    }
    if (process.env['USERPROFILE']) {
      pushUnique(path.join(process.env['USERPROFILE'], 'anaconda3', 'Scripts', 'pandoc.exe'));
      pushUnique(path.join(process.env['USERPROFILE'], 'miniconda3', 'Scripts', 'pandoc.exe'));
    }
  } else {
    pushUnique('/usr/bin/pandoc');
    pushUnique('/usr/local/bin/pandoc');
    pushUnique('/opt/homebrew/bin/pandoc');
  }

  return candidates;
}

function probeBinaryVersion(binary: string, timeoutMs = 5000): Promise<PandocInfo | null> {
  return new Promise((resolve) => {
    let stdout = '';
    let settled = false;

    const finish = (res: PandocInfo | null) => {
      if (!settled) {
        settled = true;
        resolve(res);
      }
    };

    let child;
    try {
      child = spawn(binary, ['--version'], {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      finish(null);
      return;
    }

    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
      finish(null);
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });

    child.on('error', () => {
      clearTimeout(timer);
      finish(null);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        finish(null);
        return;
      }
      const match = VERSION_RE.exec(stdout);
      if (!match) {
        finish(null);
        return;
      }
      const major = Number.parseInt(match[1]!, 10);
      const minor = Number.parseInt(match[2]!, 10);
      const patch = match[3] ? `.${match[3]}` : '';
      finish({
        available: true,
        version: `${major}.${minor}${patch}`,
        major,
        minor,
        binary,
      });
    });
  });
}

/**
 * Auto-detect Pandoc binary and parse its major.minor version.
 * Supports both Pandoc 2.12 (Windows Anaconda) and Pandoc 3.x (Linux/macOS/Windows).
 */
export async function detectPandoc(explicitBin?: string): Promise<PandocInfo> {
  const candidates = getCandidatePandocBinaries(explicitBin);
  for (const bin of candidates) {
    // If candidate is an explicit path (contains path separator), skip if non-existent
    if ((bin.includes('/') || bin.includes('\\')) && !fs.existsSync(bin)) {
      continue;
    }
    const found = await probeBinaryVersion(bin);
    if (found) {
      return found;
    }
  }
  return {
    available: false,
    version: null,
    major: 0,
    minor: 0,
    binary: null,
  };
}

/**
 * Resolve one of NovaTeX's bundled Lua filters (works identically from `src/` or compiled `dist/`).
 */
export function resolveLuaFilterPath(
  filterName: 'academic-latex.lua' | 'academic-md.lua',
): string {
  const candidate = path.join(FILTERS_DIR, filterName);
  if (!fs.existsSync(candidate)) {
    throw new Error(`找不到内置 Pandoc Lua Filter: ${candidate}`);
  }
  return candidate;
}

/**
 * Build version-adaptive citeproc flags for Pandoc 2.11+ (including 2.12 and 3.x) vs older 2.x.
 */
export function buildCiteprocArgs(info: PandocInfo, bibAbsPath: string): string[] {
  const supportsBuiltinCiteproc = info.major >= 3 || (info.major === 2 && info.minor >= 11);
  if (supportsBuiltinCiteproc) {
    return ['--citeproc', `--bibliography=${bibAbsPath}`];
  }
  return ['--filter=pandoc-citeproc', `--bibliography=${bibAbsPath}`];
}

/**
 * Clean Markdown output format string verified on BOTH Pandoc 2.12 and Pandoc 3.x.
 */
export function getCleanMarkdownTargetFormat(): string {
  return [
    'markdown',
    '+tex_math_dollars',
    '+citations',
    '+pipe_tables',
    '-raw_attribute',
    '-fenced_divs',
    '-native_divs',
    '-bracketed_spans',
    '-native_spans',
    '-simple_tables',
    '-multiline_tables',
    '-grid_tables',
  ].join('');
}

/**
 * Clean Markdown input format string verified on BOTH Pandoc 2.12 and Pandoc 3.x.
 */
export function getCleanMarkdownInputFormat(): string {
  return 'markdown+tex_math_dollars+citations-auto_identifiers';
}

/**
 * Execute Pandoc strictly with `shell: false` (never spawns a command shell).
 */
export function runPandoc(
  info: PandocInfo,
  args: string[],
  opts?: {
    input?: string | Buffer;
    cwd?: string;
    timeoutMs?: number;
  },
): Promise<PandocRunResult> {
  if (!info.available || !info.binary) {
    return Promise.reject(
      new Error('当前环境未检测到 Pandoc 可执行文件，无法执行格式转换。'),
    );
  }

  const binary = info.binary;
  const timeoutMs = opts?.timeoutMs ?? 60_000;

  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      shell: false,
      windowsHide: true,
      cwd: opts?.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try {
          child.kill('SIGTERM');
          setTimeout(() => {
            try {
              child.kill('SIGKILL');
            } catch {
              // ignore
            }
          }, 1500).unref();
        } catch {
          // ignore
        }
        reject(new Error(`Pandoc 转换超时 (${timeoutMs}ms)`));
      }
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    child.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`启动 Pandoc 失败: ${err.message}`));
      }
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      const exitCode = code ?? 1;

      if (exitCode !== 0) {
        reject(
          new Error(
            `Pandoc 执行失败 (exit ${exitCode}): ${stderr.trim() || '未知错误'}`,
          ),
        );
        return;
      }

      resolve({ stdout, stderr, exitCode });
    });

    if (opts?.input !== undefined) {
      child.stdin.on('error', () => {
        // Ignore EPIPE if pandoc exits early; close handler reports the real error
      });
      child.stdin.end(opts.input);
    } else {
      child.stdin.end();
    }
  });
}
