import fs from 'node:fs';
import path from 'node:path';
import { unzipSync } from 'fflate';
import {
  PathSecurityError,
  normalizeProjectRelPath,
  resolveInsideWorkspace,
} from '@novatex/shared';

export const DEFAULT_MAX_UNCOMPRESSED_BYTES = 30 * 1024 * 1024; // 30 MB
export const DEFAULT_MAX_ARCHIVE_FILES = 500;
const MAX_COMPRESSED_BYTES = 40 * 1024 * 1024; // 40 MB safety cap on zip payload

const LATEXMKRC_BASENAMES = new Set(['.latexmkrc', 'latexmkrc']);

export class ArchiveSecurityError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ArchiveSecurityError';
    this.code = code;
  }
}

export interface ExtractArchiveLimits {
  maxUncompressedBytes?: number;
  maxFiles?: number;
}

export interface ExtractArchiveResult {
  fileCount: number;
  totalBytes: number;
  files: string[];
}

function validateEntryName(rawName: string, isDir: boolean): string {
  const normalizedSlashes = rawName.replace(/\\/g, '/');
  const trimmedName = isDir ? normalizedSlashes.replace(/\/+$/, '') : normalizedSlashes;
  if (!trimmedName) {
    throw new ArchiveSecurityError('INVALID_ARCHIVE_ENTRY', 'ZIP 条目路径不能为空');
  }

  const base = path.posix.basename(trimmedName).toLowerCase();
  if (LATEXMKRC_BASENAMES.has(base)) {
    throw new ArchiveSecurityError(
      'FORBIDDEN_LATEXMKRC',
      `出于安全策略禁止上传包含 ${path.posix.basename(trimmedName)} 的压缩包`,
    );
  }

  try {
    return normalizeProjectRelPath(trimmedName);
  } catch (err) {
    if (err instanceof PathSecurityError) {
      throw new ArchiveSecurityError(err.code, err.message);
    }
    throw err;
  }
}

/**
 * Safely decode a base64 ZIP archive and extract it into `destDir`.
 * Enforces strict zip-slip protection, `.latexmkrc` rejection, file count cap (500),
 * and uncompressed total size cap (30 MB) both pre- and post-decompression.
 */
export function extractArchiveSafely(
  archiveBase64: string,
  destDir: string,
  limits?: ExtractArchiveLimits,
): ExtractArchiveResult {
  if (typeof archiveBase64 !== 'string' || archiveBase64.trim().length === 0) {
    throw new ArchiveSecurityError('INVALID_ARCHIVE', '缺少有效的 archiveBase64 数据');
  }

  const maxUncompressedBytes = limits?.maxUncompressedBytes ?? DEFAULT_MAX_UNCOMPRESSED_BYTES;
  const maxFiles = limits?.maxFiles ?? DEFAULT_MAX_ARCHIVE_FILES;

  const cleanedBase64 = archiveBase64.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(cleanedBase64) || cleanedBase64.length % 4 !== 0) {
    throw new ArchiveSecurityError('INVALID_ARCHIVE', 'archiveBase64 编码格式无效');
  }

  const zipBuf = Buffer.from(cleanedBase64, 'base64');
  if (zipBuf.byteLength === 0 || zipBuf.byteLength > MAX_COMPRESSED_BYTES) {
    throw new ArchiveSecurityError(
      'ARCHIVE_TOO_LARGE',
      `压缩包大小超出允许范围（最大 ${Math.round(MAX_COMPRESSED_BYTES / (1024 * 1024))} MB）`,
    );
  }

  fs.mkdirSync(destDir, { recursive: true });

  let declaredFiles = 0;
  let declaredBytes = 0;

  let unzipped: Record<string, Uint8Array>;
  try {
    unzipped = unzipSync(new Uint8Array(zipBuf.buffer, zipBuf.byteOffset, zipBuf.byteLength), {
      filter(entry) {
        const isDir = entry.name.endsWith('/') || entry.name.endsWith('\\');
        validateEntryName(entry.name, isDir);
        if (isDir) {
          return false;
        }

        declaredFiles++;
        if (declaredFiles > maxFiles) {
          throw new ArchiveSecurityError(
            'TOO_MANY_FILES',
            `压缩包文件数超过上限（最多 ${maxFiles} 个文件）`,
          );
        }

        const entryDeclaredSize = Math.max(0, entry.originalSize || 0);
        declaredBytes += entryDeclaredSize;
        if (declaredBytes > maxUncompressedBytes) {
          throw new ArchiveSecurityError(
            'ARCHIVE_UNCOMPRESSED_TOO_LARGE',
            `压缩包解压后体积超过上限（最大 ${Math.round(maxUncompressedBytes / (1024 * 1024))} MB）`,
          );
        }

        return true;
      },
    });
  } catch (err) {
    if (err instanceof ArchiveSecurityError || err instanceof PathSecurityError) {
      throw err;
    }
    throw new ArchiveSecurityError(
      'INVALID_ARCHIVE',
      `无法解压 ZIP 压缩包：${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Re-verify actual decompressed file count and byte size (defends against forged ZIP headers)
  const entries = Object.entries(unzipped);
  if (entries.length > maxFiles) {
    throw new ArchiveSecurityError(
      'TOO_MANY_FILES',
      `压缩包文件数超过上限（最多 ${maxFiles} 个文件）`,
    );
  }

  let actualTotalBytes = 0;
  const extractedFiles: string[] = [];

  for (const [rawEntryName, content] of entries) {
    actualTotalBytes += content.byteLength;
    if (actualTotalBytes > maxUncompressedBytes) {
      throw new ArchiveSecurityError(
        'ARCHIVE_UNCOMPRESSED_TOO_LARGE',
        `压缩包解压后实际体积超过上限（最大 ${Math.round(maxUncompressedBytes / (1024 * 1024))} MB）`,
      );
    }

    const safeRel = validateEntryName(rawEntryName, false);
    const { absPath } = resolveInsideWorkspace(destDir, safeRel);

    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, content);
    extractedFiles.push(safeRel);
  }

  return {
    fileCount: extractedFiles.length,
    totalBytes: actualTotalBytes,
    files: extractedFiles,
  };
}
