import type { DiffLine, DiffSummary } from './types.js';

interface RawOp {
  type: 'equal' | 'insert' | 'delete';
  line: string;
}

/**
 * Pure TypeScript Myers-style / bounded LCS line diff.
 * Fast for typical LaTeX files (hundreds to several thousand lines),
 * with an automatic prefix/suffix trimmer so small edits on large files run in < 2ms.
 */
function computeLineOps(oldLines: string[], newLines: string[]): RawOp[] {
  let start = 0;
  while (
    start < oldLines.length &&
    start < newLines.length &&
    oldLines[start] === newLines[start]
  ) {
    start++;
  }

  let oldEnd = oldLines.length - 1;
  let newEnd = newLines.length - 1;
  while (oldEnd >= start && newEnd >= start && oldLines[oldEnd] === newLines[newEnd]) {
    oldEnd--;
    newEnd--;
  }

  const prefix: RawOp[] = [];
  for (let i = 0; i < start; i++) {
    prefix.push({ type: 'equal', line: oldLines[i]! });
  }

  const suffix: RawOp[] = [];
  for (let i = oldEnd + 1; i < oldLines.length; i++) {
    suffix.push({ type: 'equal', line: oldLines[i]! });
  }

  const a = oldLines.slice(start, oldEnd + 1);
  const b = newLines.slice(start, newEnd + 1);
  const n = a.length;
  const m = b.length;

  const middle: RawOp[] = [];
  if (n === 0) {
    for (const line of b) middle.push({ type: 'insert', line });
  } else if (m === 0) {
    for (const line of a) middle.push({ type: 'delete', line });
  } else if (n * m <= 2_500_000) {
    // Exact LCS DP table using compact Int32Array
    const cols = m + 1;
    const dp = new Int32Array((n + 1) * cols);
    for (let i = n - 1; i >= 0; i--) {
      const rowOffset = i * cols;
      const nextRowOffset = (i + 1) * cols;
      const ai = a[i];
      for (let j = m - 1; j >= 0; j--) {
        if (ai === b[j]) {
          dp[rowOffset + j] = dp[nextRowOffset + j + 1]! + 1;
        } else {
          const down = dp[nextRowOffset + j]!;
          const right = dp[rowOffset + j + 1]!;
          dp[rowOffset + j] = down >= right ? down : right;
        }
      }
    }

    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) {
        middle.push({ type: 'equal', line: a[i]! });
        i++;
        j++;
      } else if (dp[(i + 1) * cols + j]! >= dp[i * cols + (j + 1)]!) {
        middle.push({ type: 'delete', line: a[i]! });
        i++;
      } else {
        middle.push({ type: 'insert', line: b[j]! });
        j++;
      }
    }
    while (i < n) {
      middle.push({ type: 'delete', line: a[i]! });
      i++;
    }
    while (j < m) {
      middle.push({ type: 'insert', line: b[j]! });
      j++;
    }
  } else {
    // Very large divergent fallback: block replace
    for (const line of a) middle.push({ type: 'delete', line });
    for (const line of b) middle.push({ type: 'insert', line });
  }

  return [...prefix, ...middle, ...suffix];
}

export function computeLineDiff(
  oldText: string,
  newText: string,
  fileLabel = 'document.tex',
  contextRadius = 3,
): DiffSummary {
  const normOld = oldText.replace(/\r\n/g, '\n');
  const normNew = newText.replace(/\r\n/g, '\n');

  const oldLines = normOld.length === 0 ? [] : normOld.split('\n');
  const newLines = normNew.length === 0 ? [] : normNew.split('\n');
  const ops = computeLineOps(oldLines, newLines);

  const lines: DiffLine[] = [];
  let oldLineNo = 1;
  let newLineNo = 1;
  let additions = 0;
  let deletions = 0;

  for (const op of ops) {
    if (op.type === 'equal') {
      lines.push({
        type: 'context',
        oldLineNumber: oldLineNo++,
        newLineNumber: newLineNo++,
        content: op.line,
      });
    } else if (op.type === 'delete') {
      deletions++;
      lines.push({
        type: 'remove',
        oldLineNumber: oldLineNo++,
        newLineNumber: null,
        content: op.line,
      });
    } else {
      additions++;
      lines.push({
        type: 'add',
        oldLineNumber: null,
        newLineNumber: newLineNo++,
        content: op.line,
      });
    }
  }

  const unifiedDiff = formatUnifiedDiff(lines, fileLabel, contextRadius);
  return { additions, deletions, unifiedDiff, lines };
}

function formatUnifiedDiff(
  lines: DiffLine[],
  fileLabel: string,
  contextRadius: number,
): string {
  const changedIndices: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.type !== 'context') changedIndices.push(i);
  }
  if (changedIndices.length === 0) {
    return '';
  }

  const ranges: Array<[number, number]> = [];
  for (const idx of changedIndices) {
    const start = Math.max(0, idx - contextRadius);
    const end = Math.min(lines.length - 1, idx + contextRadius);
    const prev = ranges[ranges.length - 1];
    if (prev && start <= prev[1] + 1) {
      prev[1] = Math.max(prev[1], end);
    } else {
      ranges.push([start, end]);
    }
  }

  const out: string[] = [`--- a/${fileLabel}`, `+++ b/${fileLabel}`];
  for (const [start, end] of ranges) {
    const slice = lines.slice(start, end + 1);
    const firstOld = slice.find((l) => l.oldLineNumber !== null)?.oldLineNumber ?? 1;
    const firstNew = slice.find((l) => l.newLineNumber !== null)?.newLineNumber ?? 1;
    const oldCount = slice.filter((l) => l.type !== 'add').length;
    const newCount = slice.filter((l) => l.type !== 'remove').length;
    out.push(`@@ -${firstOld},${oldCount} +${firstNew},${newCount} @@`);
    for (const item of slice) {
      const prefix = item.type === 'add' ? '+' : item.type === 'remove' ? '-' : ' ';
      out.push(`${prefix}${item.content}`);
    }
  }
  return out.join('\n');
}

/**
 * Compute minimal character-level splice operations (start, deleteCount, insertText)
 * to transform oldText into newText — ideal for non-destructive Yjs Y.Text updates
 * without destroying collaborators' cursors.
 */
export function computeMinimalTextSplice(
  oldText: string,
  newText: string,
): { index: number; deleteCount: number; insertText: string } | null {
  if (oldText === newText) return null;

  let start = 0;
  const minLen = Math.min(oldText.length, newText.length);
  while (start < minLen && oldText.charCodeAt(start) === newText.charCodeAt(start)) {
    start++;
  }

  let oldEnd = oldText.length;
  let newEnd = newText.length;
  while (
    oldEnd > start &&
    newEnd > start &&
    oldText.charCodeAt(oldEnd - 1) === newText.charCodeAt(newEnd - 1)
  ) {
    oldEnd--;
    newEnd--;
  }

  return {
    index: start,
    deleteCount: oldEnd - start,
    insertText: newText.slice(start, newEnd),
  };
}
