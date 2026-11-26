import crypto from 'node:crypto';
import type * as Y from 'yjs';
import { computeMinimalTextSplice } from '@novatex/shared';

export const LOCAL_FS_ORIGIN = 'local-fs';

export interface AntiLoopEntry {
  hash: string;
  expiresAt: number;
}

/**
 * Compute SHA-256 hex digest of a UTF-8 string.
 */
export function sha256Text(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Compute SHA-256 hex digest of binary content.
 */
export function sha256Buffer(buffer: Buffer | Uint8Array): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * Apply the minimal character-level splice required to transform `ytext` into `nextText`
 * inside a single Yjs transaction. Preserves untouched characters and collaborators'
 * relative cursor positions instead of replacing the entire document.
 *
 * Returns `false` when `ytext` already equals `nextText` (no-op).
 */
export function applyMinimalTextToYText(
  ytext: Y.Text,
  nextText: string,
  origin?: unknown,
): boolean {
  const currentText = ytext.toString();
  const splice = computeMinimalTextSplice(currentText, nextText);
  if (!splice) {
    return false;
  }

  const apply = () => {
    if (splice.deleteCount > 0) {
      ytext.delete(splice.index, splice.deleteCount);
    }
    if (splice.insertText.length > 0) {
      ytext.insert(splice.index, splice.insertText);
    }
  };

  if (ytext.doc) {
    ytext.doc.transact(apply, origin);
  } else {
    apply();
  }

  return true;
}

/**
 * Tracks recently written content hashes per project-relative path with a TTL
 * to suppress Chokidar echoes caused by our own remote -> local disk writes
 * without ever blocking genuine subsequent local edits.
 */
export class AntiLoopTracker {
  readonly entries = new Map<string, AntiLoopEntry>();
  private readonly defaultTtlMs: number;
  private readonly now: () => number;

  constructor(defaultTtlMs = 5_000, now: () => number = () => Date.now()) {
    this.defaultTtlMs = defaultTtlMs;
    this.now = now;
  }

  record(relPath: string, content: string | Buffer | Uint8Array, ttlMs?: number): string {
    const hash =
      typeof content === 'string' ? sha256Text(content) : sha256Buffer(content);
    const effectiveTtl = ttlMs ?? this.defaultTtlMs;
    this.entries.set(relPath, {
      hash,
      expiresAt: this.now() + effectiveTtl,
    });
    return hash;
  }

  shouldSuppress(relPath: string, content: string | Buffer | Uint8Array): boolean {
    const entry = this.entries.get(relPath);
    if (!entry) {
      return false;
    }

    if (this.now() > entry.expiresAt) {
      this.entries.delete(relPath);
      return false;
    }

    const hash =
      typeof content === 'string' ? sha256Text(content) : sha256Buffer(content);

    if (hash === entry.hash) {
      return true;
    }

    // Genuine local modification with different content: invalidate stale suppression entry immediately.
    this.entries.delete(relPath);
    return false;
  }

  prune(): void {
    const current = this.now();
    for (const [relPath, entry] of this.entries) {
      if (current > entry.expiresAt) {
        this.entries.delete(relPath);
      }
    }
  }

  clear(relPath?: string): void {
    if (relPath !== undefined) {
      this.entries.delete(relPath);
    } else {
      this.entries.clear();
    }
  }

  get size(): number {
    this.prune();
    return this.entries.size;
  }
}
