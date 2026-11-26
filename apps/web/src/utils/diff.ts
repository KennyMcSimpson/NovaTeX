import type { DiffLine, DiffSummary } from '@novatex/shared';

interface RawOp {
  type: 'equal' | 'insert' | 'delete';
  line: string;
}

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
    for (const line of a) middle.push({ type: 'delete', line });
    for (const line of b) middle.push({ type: 'insert', line });
  }

  return [...prefix, ...middle, ...suffix];
}

export function computeLineDiff(
  oldText: string,
  newText: string,
  fileLabel = 'document.tex',
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

  const unifiedDiff = [
    `--- a/${fileLabel}`,
    `+++ b/${fileLabel}`,
    ...lines.map((l) => `${l.type === 'add' ? '+' : l.type === 'remove' ? '-' : ' '}${l.content}`),
  ].join('\n');

  return { additions, deletions, unifiedDiff, lines };
}

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
