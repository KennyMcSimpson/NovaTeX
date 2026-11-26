import fs from 'node:fs';
import path from 'node:path';

const WINDOWS_RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

/** Files that must NEVER be written or uploaded inside a LaTeX workspace (RCE / Git integrity). */
const FORBIDDEN_BASENAMES = new Set([
  '.latexmkrc',
  'latexmkrc',
  '.texmf.cnf',
  'texmf.cnf',
  '.env',
]);

const BINARY_EXTENSIONS = new Set([
  '.pdf',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.svg',
  '.bmp',
  '.ico',
  '.eps',
  '.docx',
  '.doc',
  '.xlsx',
  '.pptx',
  '.zip',
  '.gz',
  '.tar',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
]);

export class PathSecurityError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'PathSecurityError';
    this.code = code;
  }
}

/**
 * Normalize and strictly validate a project-relative POSIX path.
 * Blocks absolute paths, Windows drive prefixes, traversal (`..`), null bytes,
 * `.git` internal files, Windows reserved device names, and `.latexmkrc` RCE files.
 */
export function normalizeProjectRelPath(rawInput: string): string {
  if (typeof rawInput !== 'string') {
    throw new PathSecurityError('INVALID_PATH', '路径必须为字符串');
  }
  const trimmed = rawInput.trim();
  if (!trimmed) {
    throw new PathSecurityError('EMPTY_PATH', '路径不能为空');
  }
  if (trimmed.includes('\0') || /[\x00-\x1f]/.test(trimmed)) {
    throw new PathSecurityError('CONTROL_CHAR', '路径包含非法控制字符');
  }
  if (/^[a-zA-Z]:/.test(trimmed) || trimmed.startsWith('\\\\') || trimmed.startsWith('/')) {
    throw new PathSecurityError('ABSOLUTE_PATH', `禁止使用绝对路径: ${rawInput}`);
  }

  const posix = trimmed.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '');
  if (!posix) {
    throw new PathSecurityError('EMPTY_PATH', '路径不能为空');
  }

  const segments = posix.split('/');
  const cleanSegments: string[] = [];
  for (const seg of segments) {
    if (!seg || seg === '.') {
      continue;
    }
    if (seg === '..') {
      throw new PathSecurityError('PATH_TRAVERSAL', `禁止越界访问上级目录: ${rawInput}`);
    }
    const lowerSeg = seg.toLowerCase();
    if (lowerSeg === '.git' || lowerSeg === '.gitmodules' || /^git~[0-9]+$/i.test(seg)) {
      throw new PathSecurityError('GIT_INTERNAL', '禁止直接读写 .git 内部目录或 Git 配置文件');
    }
    if (seg.startsWith('-') || seg.startsWith('&')) {
      throw new PathSecurityError('INVALID_PREFIX', `文件名不能以 '-' 或 '&' 开头: ${seg}`);
    }
    if (seg.endsWith(' ') || seg.endsWith('.')) {
      throw new PathSecurityError('INVALID_SEGMENT', `非法文件名结尾: ${seg}`);
    }
    if (/[<>:"|?*]/.test(seg)) {
      throw new PathSecurityError('INVALID_CHAR', `文件名包含非法字符: ${seg}`);
    }
    if (WINDOWS_RESERVED_RE.test(seg)) {
      throw new PathSecurityError('RESERVED_NAME', `禁止使用系统保留文件名: ${seg}`);
    }
    cleanSegments.push(seg);
  }

  if (cleanSegments.length === 0) {
    throw new PathSecurityError('EMPTY_PATH', '路径不能为空');
  }

  const last = cleanSegments[cleanSegments.length - 1]!.toLowerCase();
  if (FORBIDDEN_BASENAMES.has(last)) {
    throw new PathSecurityError(
      'FORBIDDEN_FILENAME',
      `出于安全策略禁止写入或上传受限文件: ${cleanSegments[cleanSegments.length - 1]}`,
    );
  }

  const normalized = cleanSegments.join('/');
  if (normalized.length > 200) {
    throw new PathSecurityError('PATH_TOO_LONG', '项目内相对路径长度不得超过 200 字符');
  }
  return normalized;
}

/**
 * Resolve a validated relative path inside a workspace root and verify containment
 * including realpath checks against symlink / junction escapes.
 */
export function resolveInsideWorkspace(workspaceRoot: string, relPath: string): {
  relPath: string;
  absPath: string;
} {
  const safeRel = normalizeProjectRelPath(relPath);
  const resolvedRoot = path.resolve(workspaceRoot);
  const absPath = path.resolve(resolvedRoot, safeRel);

  const relativeCheck = path.relative(resolvedRoot, absPath);
  if (
    relativeCheck === '' ||
    relativeCheck.startsWith('..') ||
    path.isAbsolute(relativeCheck)
  ) {
    throw new PathSecurityError('ESCAPE_ROOT', `路径逃逸工作区根目录: ${relPath}`);
  }

  // Symlink / junction escape check along EVERY path component (including dangling symlinks!)
  const lstatOrNull = (p: string): fs.Stats | null => {
    try {
      return fs.lstatSync(p);
    } catch {
      return null;
    }
  };

  if (lstatOrNull(resolvedRoot)) {
    const realRoot = fs.realpathSync(resolvedRoot);
    const parts = safeRel.split('/');
    let walk = resolvedRoot;
    for (const part of parts) {
      walk = path.join(walk, part);
      const st = lstatOrNull(walk);
      if (!st) {
        // Component does not exist yet — remaining descendants do not exist on disk either
        break;
      }
      if (st.isSymbolicLink()) {
        throw new PathSecurityError('SYMLINK_FORBIDDEN', `禁止通过符号链接访问或写入文件: ${relPath}`);
      }
      const realWalk = fs.realpathSync(walk);
      const realRel = path.relative(realRoot, realWalk);
      if (realRel.startsWith('..') || path.isAbsolute(realRel)) {
        throw new PathSecurityError('SYMLINK_ESCAPE', `路径解析后逃逸出工作区: ${relPath}`);
      }
    }
  }

  return { relPath: safeRel, absPath };
}

export function isBinaryFilePath(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

export function isForbiddenLaTeXFile(fileName: string): boolean {
  return FORBIDDEN_BASENAMES.has(path.basename(fileName).toLowerCase());
}
