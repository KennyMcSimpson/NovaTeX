import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { isBinaryFilePath, type GitCommitInfo, type GitDiffResult } from '@novatex/shared';

const GIT_REF_RE = /^(?:HEAD(?:~\d{1,4})?|[0-9a-f]{7,40})$/i;
const DISABLED_HOOKS_PATH = process.platform === 'win32' ? 'NUL' : '/dev/null';

function isGitInternalEntryName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === '.git' || lower === '.gitmodules' || /^git~[0-9]+$/i.test(name);
}

export class GitOperationError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'GitOperationError';
    this.status = status;
  }
}

export function isValidGitRef(ref: string): boolean {
  return typeof ref === 'string' && GIT_REF_RE.test(ref.trim());
}

function runGit(
  cwd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [
        '-c',
        'core.quotepath=false',
        '-c',
        'core.fsmonitor=false',
        '-c',
        `core.hooksPath=${DISABLED_HOOKS_PATH}`,
        ...args,
      ],
      {
        cwd,
        shell: false,
        windowsHide: true,
        maxBuffer: 20 * 1024 * 1024,
        encoding: 'utf8',
      },
      (err, stdout, stderr) => {
        if (err) {
          const code = typeof err.code === 'number' ? err.code : 1;
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            reject(new GitOperationError('服务器未安装 Git 可执行文件', 500));
            return;
          }
          resolve({ stdout: stdout ?? '', stderr: stderr ?? err.message, exitCode: code });
          return;
        }
        resolve({ stdout: stdout ?? '', stderr: stderr ?? '', exitCode: 0 });
      },
    );
  });
}

function sanitizeAuthorName(name: string): string {
  const cleaned = name.replace(/[\r\n<>"]/g, ' ').trim();
  return cleaned.slice(0, 64) || 'NovaTeX User';
}

function parseCommitLine(line: string): GitCommitInfo | null {
  const parts = line.split('\x1f');
  if (parts.length < 5) return null;
  const [hash, shortHash, message, author, date] = parts;
  if (!hash) return null;
  return {
    hash: hash.trim(),
    shortHash: (shortHash ?? hash.slice(0, 7)).trim(),
    message: (message ?? '').trim(),
    author: (author ?? 'NovaTeX').trim(),
    date: (date ?? new Date().toISOString()).trim(),
  };
}

function listWorkspaceFilesFlat(workspaceDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, relPrefix: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (isGitInternalEntryName(entry.name) || entry.isSymbolicLink()) continue;
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, rel);
      } else if (entry.isFile()) {
        out.push(rel);
      }
    }
  };
  walk(workspaceDir, '');
  return out;
}

/**
 * Initialize a Git repository inside a project's `src` workspace and create the initial checkpoint.
 */
export async function initProjectRepo(
  workspaceDir: string,
  authorName = 'NovaTeX',
  initialMessage = '初始化 NovaTeX 项目',
): Promise<GitCommitInfo> {
  fs.mkdirSync(workspaceDir, { recursive: true });

  const initRes = await runGit(workspaceDir, ['init', '-b', 'main']);
  if (initRes.exitCode !== 0) {
    // Fallback for older Git versions without `-b`
    const fallback = await runGit(workspaceDir, ['init']);
    if (fallback.exitCode !== 0) {
      throw new GitOperationError(`Git 初始化失败: ${fallback.stderr.trim()}`, 500);
    }
  }

  await runGit(workspaceDir, ['config', 'user.name', 'NovaTeX']);
  await runGit(workspaceDir, ['config', 'user.email', 'novatex@local']);
  await runGit(workspaceDir, ['config', 'core.autocrlf', 'false']);

  // Keep exclude rules inside `.git/info/exclude` so no `.gitignore` clutters the user file tree
  const excludePath = path.join(workspaceDir, '.git', 'info', 'exclude');
  try {
    fs.mkdirSync(path.dirname(excludePath), { recursive: true });
    fs.writeFileSync(
      excludePath,
      ['*.aux', '*.log', '*.synctex.gz', '*.fls', '*.fdb_latexmk', '.DS_Store', 'Thumbs.db', ''].join(
        '\n',
      ),
      'utf8',
    );
  } catch {
    // non-fatal
  }

  return commitAll(workspaceDir, initialMessage, authorName, true);
}

/**
 * Stage all workspace files and commit a checkpoint with explicit author attribution.
 */
export async function commitAll(
  workspaceDir: string,
  message: string,
  authorName: string,
  allowEmpty = true,
): Promise<GitCommitInfo> {
  const cleanMsg = message.trim().slice(0, 500);
  if (!cleanMsg) {
    throw new GitOperationError('提交备注不能为空', 400);
  }

  const addRes = await runGit(workspaceDir, ['add', '-A']);
  if (addRes.exitCode !== 0) {
    throw new GitOperationError(`Git add 失败: ${addRes.stderr.trim()}`, 500);
  }

  const author = sanitizeAuthorName(authorName);
  const commitArgs = [
    'commit',
    ...(allowEmpty ? ['--allow-empty'] : []),
    `--author=${author} <novatex@local>`,
    '-m',
    cleanMsg,
  ];
  const commitRes = await runGit(workspaceDir, commitArgs);
  if (commitRes.exitCode !== 0) {
    throw new GitOperationError(`Git commit 失败: ${commitRes.stderr.trim()}`, 500);
  }

  const log = await getLog(workspaceDir, 1);
  if (log.length === 0) {
    throw new GitOperationError('无法读取刚创建的 Git 提交记录', 500);
  }
  return log[0]!;
}

/**
 * List recent commits from the project repository.
 */
export async function getLog(workspaceDir: string, limit = 50): Promise<GitCommitInfo[]> {
  const safeLimit = Math.max(1, Math.min(200, Math.trunc(limit)));
  const res = await runGit(workspaceDir, [
    'log',
    '-n',
    String(safeLimit),
    '--format=%H%x1f%h%x1f%s%x1f%an%x1f%aI',
  ]);
  if (res.exitCode !== 0) {
    if (res.stderr.includes('does not have any commits')) {
      return [];
    }
    throw new GitOperationError(`读取 Git 历史失败: ${res.stderr.trim()}`, 500);
  }

  return res.stdout
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => parseCommitLine(line))
    .filter((item): item is GitCommitInfo => item !== null);
}

/**
 * Compute per-file unified diff between two strictly validated Git refs.
 */
export async function getDiff(
  workspaceDir: string,
  fromRef: string,
  toRef = 'HEAD',
): Promise<GitDiffResult> {
  const safeFrom = fromRef.trim();
  const safeTo = toRef.trim();

  if (!isValidGitRef(safeFrom)) {
    throw new GitOperationError(`非法的起始提交哈希: ${fromRef}`, 400);
  }
  if (!isValidGitRef(safeTo)) {
    throw new GitOperationError(`非法的目标提交哈希: ${toRef}`, 400);
  }

  // Verify both refs resolve to commits
  const verifyFrom = await runGit(workspaceDir, ['rev-parse', '--verify', `${safeFrom}^{commit}`]);
  if (verifyFrom.exitCode !== 0) {
    throw new GitOperationError(`找不到指定的历史版本: ${safeFrom}`, 404);
  }
  const verifyTo = await runGit(workspaceDir, ['rev-parse', '--verify', `${safeTo}^{commit}`]);
  if (verifyTo.exitCode !== 0) {
    throw new GitOperationError(`找不到指定的目标版本: ${safeTo}`, 404);
  }

  const nameStatusRes = await runGit(workspaceDir, [
    'diff',
    '--name-status',
    '--no-renames',
    safeFrom,
    safeTo,
  ]);
  if (nameStatusRes.exitCode !== 0) {
    throw new GitOperationError(`计算 Git Diff 失败: ${nameStatusRes.stderr.trim()}`, 500);
  }

  const statusLines = nameStatusRes.stdout
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  const files: GitDiffResult['files'] = [];
  for (const line of statusLines.slice(0, 60)) {
    const tabIdx = line.indexOf('\t');
    if (tabIdx <= 0) continue;
    const rawCode = line.slice(0, tabIdx).trim();
    const filePath = line.slice(tabIdx + 1).trim();
    if (!filePath) continue;

    const statusLabel =
      rawCode.startsWith('A')
        ? 'added'
        : rawCode.startsWith('D')
          ? 'deleted'
          : rawCode.startsWith('M')
            ? 'modified'
            : rawCode;

    const fileDiffRes = await runGit(workspaceDir, [
      'diff',
      '--no-ext-diff',
      '-U3',
      safeFrom,
      safeTo,
      '--',
      filePath,
    ]);

    files.push({
      path: filePath,
      status: statusLabel,
      unifiedDiff: fileDiffRes.stdout.replace(/\r\n/g, '\n').trimEnd(),
    });
  }

  return {
    fromRef: safeFrom,
    toRef: safeTo,
    files,
  };
}

export interface GitRestoreResult {
  commit: GitCommitInfo;
  restoredTextFiles: string[];
  deletedFiles: string[];
}

/**
 * Cleanly restore workspace files to the exact snapshot of `hash` WITHOUT rewriting Git history,
 * then record a new restore checkpoint commit. Returns modified/deleted paths so live Yjs docs
 * can be synchronized immediately.
 */
export async function restoreCommit(
  workspaceDir: string,
  hash: string,
  authorName: string,
): Promise<GitRestoreResult> {
  const safeHash = hash.trim();
  if (!isValidGitRef(safeHash)) {
    throw new GitOperationError(`非法的提交哈希: ${hash}`, 400);
  }

  const verify = await runGit(workspaceDir, ['rev-parse', '--verify', `${safeHash}^{commit}`]);
  if (verify.exitCode !== 0) {
    throw new GitOperationError(`找不到指定的历史提交: ${safeHash}`, 404);
  }
  const fullHash = verify.stdout.trim();
  const shortHash = fullHash.slice(0, 7);

  const beforeFiles = new Set(listWorkspaceFilesFlat(workspaceDir));

  // Clear working tree except `.git` (case-insensitive for Windows/macOS safety)
  for (const entry of fs.readdirSync(workspaceDir, { withFileTypes: true })) {
    if (entry.name.toLowerCase() === '.git') continue;
    fs.rmSync(path.join(workspaceDir, entry.name), { recursive: true, force: true });
  }

  // Restore exact snapshot of target commit into index and working tree
  const checkoutRes = await runGit(workspaceDir, ['checkout', fullHash, '--', '.']);
  if (checkoutRes.exitCode !== 0) {
    throw new GitOperationError(`恢复历史快照失败: ${checkoutRes.stderr.trim()}`, 500);
  }

  const afterFiles = listWorkspaceFilesFlat(workspaceDir);
  const afterSet = new Set(afterFiles);

  const deletedFiles: string[] = [];
  for (const prev of beforeFiles) {
    if (!afterSet.has(prev)) {
      deletedFiles.push(prev);
    }
  }

  const restoredTextFiles = afterFiles.filter((rel) => !isBinaryFilePath(rel));
  const commit = await commitAll(workspaceDir, `回滚至历史版本 ${shortHash}`, authorName, true);

  return {
    commit,
    restoredTextFiles,
    deletedFiles,
  };
}
