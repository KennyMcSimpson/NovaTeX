import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import {
  loadSyncTeXFile,
  parseSyncTeX,
  syncTeXForward,
  syncTeXInverse,
} from '../src/synctex.js';

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novatex-synctex-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// 1 bp in scaled points ≈ 65781.76 sp
const SP = 65782;

function buildSampleSyncTeX(): string {
  return [
    'SyncTeX Version:1',
    'Input:1:/tmp/workspace/./main.tex',
    'Input:2:/tmp/workspace/./sections/method.tex',
    'Input:3:C:\\work\\proj\\.\\appendix\\proof.tex',
    'Output:main.pdf',
    'Magnification:1000',
    'Unit:1',
    'X Offset:0',
    'Y Offset:0',
    'Content:',
    '!120',
    '{1',
    // Outer enclosing vbox for paragraph on page 1 (x=72..472, y=88..180)
    `[1,10:${72 * SP},${180 * SP}:${400 * SP},${92 * SP},0`,
    // Line 10 of main.tex: hbox at x=72, baseline v=100, W=300, H=12, D=3 => y=88, h=15
    `(1,10:${72 * SP},${100 * SP}:${300 * SP},${12 * SP},${3 * SP}`,
    `x1,10:${72 * SP},${100 * SP}`,
    ')',
    // Line 12 of main.tex using `=` shorthand for h (=72), W (=300), H (=12), D (=3)
    `(1,12:=,${120 * SP}:=,=,=`,
    ')',
    // Line 18 of sections/method.tex on page 1 at x=72, baseline v=150
    `h2,18,5:=,${150 * SP}:${250 * SP},${10 * SP},${2 * SP}`,
    ']',
    '}1',
    '{2',
    // Page 2: appendix/proof.tex line 7 using Windows input path
    `(3,7:${80 * SP},${200 * SP}:${320 * SP},${14 * SP},${4 * SP}`,
    `k3,7:${100 * SP},${200 * SP}:${10 * SP}`,
    `g3,7:${110 * SP},${200 * SP}`,
    `$3,7:${120 * SP},${200 * SP}`,
    ')',
    '}2',
    'Postamble:',
    'Count:10',
    'SyncTeX Version:1',
  ].join('\n');
}

describe('SyncTeX pure TypeScript parser', () => {
  it('parses gzipped .synctex.gz files from disk and directly from Buffer', () => {
    const raw = buildSampleSyncTeX();
    const gz = gzipSync(Buffer.from(raw, 'utf8'));

    const dir = createTempDir();
    const gzPath = path.join(dir, 'main.synctex.gz');
    fs.writeFileSync(gzPath, gz);

    const fromFile = loadSyncTeXFile(gzPath);
    expect(fromFile).not.toBeNull();
    expect(fromFile?.version).toBe(1);
    expect(fromFile?.pageCount).toBe(2);
    expect(fromFile?.inputs.get(1)?.normalizedPath).toBe('main.tex');
    expect(fromFile?.inputs.get(2)?.normalizedPath).toBe('sections/method.tex');
    expect(fromFile?.inputs.get(3)?.normalizedPath).toBe('appendix/proof.tex');

    const fromBuf = parseSyncTeX(gz);
    expect(fromBuf.pageCount).toBe(2);
    expect(fromBuf.recordsByPage.get(1)?.length).toBeGreaterThan(0);

    // Non-existent path returns null cleanly
    expect(loadSyncTeXFile(path.join(dir, 'missing.synctex.gz'))).toBeNull();
  });

  it('performs accurate forward search across multi-file inputs and = shorthand coordinates', () => {
    const index = parseSyncTeX(buildSampleSyncTeX());

    // Exact line on main.tex line 10 (prefers hbox over outer vbox)
    const fwd10 = syncTeXForward(index, './main.tex', 10);
    expect(fwd10.found).toBe(true);
    expect(fwd10.file).toBe('main.tex');
    expect(fwd10.line).toBe(10);
    expect(fwd10.boxes).toHaveLength(1);
    expect(fwd10.boxes[0]?.page).toBe(1);
    expect(fwd10.boxes[0]?.x).toBeCloseTo(72, 0);
    expect(fwd10.boxes[0]?.y).toBeCloseTo(88, 0);
    expect(fwd10.boxes[0]?.width).toBeCloseTo(300, 0);
    expect(fwd10.boxes[0]?.height).toBeCloseTo(15, 0);

    // Line 12 inherited h=72, W=300, H=12, D=3 via `=` shorthand
    const fwd12 = syncTeXForward(index, 'main.tex', 12);
    expect(fwd12.found).toBe(true);
    expect(fwd12.boxes[0]?.x).toBeCloseTo(72, 0);
    expect(fwd12.boxes[0]?.y).toBeCloseTo(108, 0);
    expect(fwd12.boxes[0]?.width).toBeCloseTo(300, 0);
    expect(fwd12.boxes[0]?.height).toBeCloseTo(15, 0);

    // Nearest line fallback within ±5 lines (line 11 -> matches 12 or 10)
    const fwdNear = syncTeXForward(index, 'main.tex', 14);
    expect(fwdNear.found).toBe(true);
    expect(fwdNear.line).toBe(12);

    // Out of ±5 line window returns found: false
    const fwdFar = syncTeXForward(index, 'main.tex', 50);
    expect(fwdFar.found).toBe(false);
    expect(fwdFar.boxes).toEqual([]);

    // Multi-file lookup with Windows backslash path and basename fallback
    const fwdSub = syncTeXForward(index, 'sections\\method.tex', 18);
    expect(fwdSub.found).toBe(true);
    expect(fwdSub.file).toBe('sections/method.tex');
    expect(fwdSub.boxes[0]?.page).toBe(1);

    const fwdBase = syncTeXForward(index, 'proof.tex', 7);
    expect(fwdBase.found).toBe(true);
    expect(fwdBase.file).toBe('appendix/proof.tex');
    expect(fwdBase.boxes[0]?.page).toBe(2);
  });

  it('performs inverse search selecting tightest containing box and nearest fallback', () => {
    const index = parseSyncTeX(buildSampleSyncTeX());

    // Click inside line 18 of sections/method.tex (which is ALSO inside outer vbox of line 10)
    // Tightest containing box MUST win -> sections/method.tex:18 col 5
    const invTight = syncTeXInverse(index, 1, 100, 145);
    expect(invTight).toEqual({
      found: true,
      file: 'sections/method.tex',
      line: 18,
      column: 5,
    });

    // Click inside line 12 of main.tex
    const invLine12 = syncTeXInverse(index, 1, 120, 115);
    expect(invLine12).toEqual({
      found: true,
      file: 'main.tex',
      line: 12,
      column: 0,
    });

    // Click slightly outside all boxes on page 2 -> Euclidean nearest fallback
    const invNear = syncTeXInverse(index, 2, 70, 190);
    expect(invNear).toEqual({
      found: true,
      file: 'appendix/proof.tex',
      line: 7,
      column: 0,
    });

    // Unknown page returns found: false
    const invMissing = syncTeXInverse(index, 99, 100, 100);
    expect(invMissing.found).toBe(false);
  });
});
