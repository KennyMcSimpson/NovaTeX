import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import type {
  SyncTeXBox,
  SyncTeXForwardResult,
  SyncTeXInverseResult,
} from '@novatex/shared';

export type SyncTeXRecordKind =
  | 'vbox'
  | 'hbox'
  | 'void-vbox'
  | 'void-hbox'
  | 'anchor'
  | 'kern'
  | 'glue'
  | 'math';

export interface SyncTeXInputFile {
  tag: number;
  rawPath: string;
  normalizedPath: string;
  basename: string;
}

export interface SyncTeXRecord {
  kind: SyncTeXRecordKind;
  tag: number;
  line: number;
  column: number;
  page: number;
  /** Top-left X in PDF points */
  x: number;
  /** Top-left Y in PDF points */
  y: number;
  /** Width in PDF points */
  width: number;
  /** Total height (H + D) in PDF points */
  height: number;
  /** Enclosing horizontal box (`(`) if this record is a child leaf node */
  parentHbox?: SyncTeXRecord;
  /** Child leaf records inside an enclosing `hbox` (`(`) */
  children?: SyncTeXRecord[];
  /** Whether a container `vbox` (`[`) wraps inner boxes (e.g. page/paragraph wrapper) */
  hasChildBoxes?: boolean;
}

export interface SyncTeXIndex {
  version: number;
  magnification: number;
  unit: number;
  xOffset: number;
  yOffset: number;
  /** Conversion multiplier from raw SyncTeX scaled points to PDF points (bp). */
  scale: number;
  inputs: Map<number, SyncTeXInputFile>;
  recordsByPage: Map<number, SyncTeXRecord[]>;
  recordsByTagLine: Map<string, SyncTeXRecord[]>;
  pageCount: number;
}

const GZIP_MAGIC_0 = 0x1f;
const GZIP_MAGIC_1 = 0x8b;
/** TeX scaled points per big point (PDF point): 65536 * (72.27 / 72) */
const SP_PER_BP = (65536 * 72.27) / 72;

function normalizeInputRawPath(raw: string, rootDirHint?: string): string {
  let p = raw.trim().replace(/\\/g, '/').replace(/\/+/g, '/');
  if (!p) return '';

  // TeX inserts `/./` right at the workspace root boundary
  const boundaryIdx = p.lastIndexOf('/./');
  if (boundaryIdx >= 0) {
    p = p.slice(boundaryIdx + 3);
  } else if (rootDirHint && p.toLowerCase().startsWith(rootDirHint.toLowerCase() + '/')) {
    p = p.slice(rootDirHint.length + 1);
  }

  p = p.replace(/^(?:\.\/)+/, '');
  return p;
}

function normalizeQueryPath(file: string): string {
  return file
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^(?:\.\/)+/, '');
}

interface ShorthandState {
  h: number;
  v: number;
  w: number;
  hgt: number;
  d: number;
}

function parseCoord(token: string | undefined, prev: number): number | null {
  if (token === undefined || token === '') return null;
  if (token === '=') return prev;
  const val = Number(token);
  return Number.isFinite(val) ? val : null;
}

function parseLinkPart(linkPart: string): { tag: number; line: number; column: number } | null {
  const parts = linkPart.split(',');
  if (parts.length < 2) return null;
  const tag = Number(parts[0]);
  const line = Number(parts[1]);
  const column = parts.length >= 3 && parts[2] !== '' ? Number(parts[2]) : 0;
  if (!Number.isInteger(tag) || !Number.isInteger(line) || !Number.isFinite(column)) {
    return null;
  }
  return { tag, line, column: Math.max(0, Math.trunc(column)) };
}

function isGzipBuffer(buf: Buffer): boolean {
  return buf.length >= 2 && buf[0] === GZIP_MAGIC_0 && buf[1] === GZIP_MAGIC_1;
}

/**
 * Pure TypeScript SyncTeX v1 parser (accepts raw text string, plain Buffer, or gzipped Buffer).
 * Zero external `synctex` binary dependency.
 */
export function parseSyncTeX(bufferOrString: Buffer | string): SyncTeXIndex {
  let text: string;
  if (Buffer.isBuffer(bufferOrString)) {
    const rawBuf = isGzipBuffer(bufferOrString) ? gunzipSync(bufferOrString) : bufferOrString;
    text = rawBuf.toString('utf8');
  } else {
    text = bufferOrString;
  }

  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

  let version = 1;
  let magnification = 1000;
  let unit = 1;
  let xOffset = 0;
  let yOffset = 0;

  const rawInputs: Array<{ tag: number; rawPath: string }> = [];
  const inputs = new Map<number, SyncTeXInputFile>();
  const recordsByPage = new Map<number, SyncTeXRecord[]>();
  const recordsByTagLine = new Map<string, SyncTeXRecord[]>();

  let inContent = false;
  let currentPage = 0;
  let formDepth = 0;
  let maxPage = 0;
  let scale = (unit * magnification) / (1000 * SP_PER_BP);
  let inputsFinalized = false;
  let rootDirHint: string | undefined;

  const prev: ShorthandState = { h: 0, v: 0, w: 0, hgt: 0, d: 0 };
  const boxStack: SyncTeXRecord[] = [];

  const getEnclosingHbox = (): SyncTeXRecord | undefined => {
    for (let idx = boxStack.length - 1; idx >= 0; idx--) {
      const candidate = boxStack[idx];
      if (candidate && candidate.kind === 'hbox') {
        return candidate;
      }
    }
    return undefined;
  };

  const finalizeInputsAndScale = () => {
    if (inputsFinalized) return;
    inputsFinalized = true;
    scale = (unit * magnification) / (1000 * SP_PER_BP);

    // Derive rootDirHint from the first input if it doesn't use `/./`
    if (rawInputs.length > 0) {
      const firstRaw = rawInputs[0]!.rawPath.replace(/\\/g, '/').replace(/\/+/g, '/');
      if (!firstRaw.includes('/./')) {
        const lastSlash = firstRaw.lastIndexOf('/');
        if (lastSlash > 0) {
          rootDirHint = firstRaw.slice(0, lastSlash);
        }
      }
    }

    for (const item of rawInputs) {
      const normalizedPath = normalizeInputRawPath(item.rawPath, rootDirHint);
      const basename = path.posix.basename(normalizedPath);
      inputs.set(item.tag, {
        tag: item.tag,
        rawPath: item.rawPath,
        normalizedPath,
        basename,
      });
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    if (!rawLine) continue;

    if (!inContent) {
      if (rawLine.startsWith('SyncTeX Version:')) {
        const parsed = Number(rawLine.slice('SyncTeX Version:'.length).trim());
        if (Number.isFinite(parsed)) version = parsed;
      } else if (rawLine.startsWith('Input:')) {
        const rest = rawLine.slice('Input:'.length);
        const colonIdx = rest.indexOf(':');
        if (colonIdx > 0) {
          const tag = Number(rest.slice(0, colonIdx));
          const rawPath = rest.slice(colonIdx + 1).trim();
          if (Number.isInteger(tag) && rawPath) {
            rawInputs.push({ tag, rawPath });
          }
        }
      } else if (rawLine.startsWith('Magnification:')) {
        const parsed = Number(rawLine.slice('Magnification:'.length).trim());
        if (Number.isFinite(parsed) && parsed > 0) magnification = parsed;
      } else if (rawLine.startsWith('Unit:')) {
        const parsed = Number(rawLine.slice('Unit:'.length).trim());
        if (Number.isFinite(parsed) && parsed > 0) unit = parsed;
      } else if (rawLine.startsWith('X Offset:')) {
        const parsed = Number(rawLine.slice('X Offset:'.length).trim());
        if (Number.isFinite(parsed)) xOffset = parsed;
      } else if (rawLine.startsWith('Y Offset:')) {
        const parsed = Number(rawLine.slice('Y Offset:'.length).trim());
        if (Number.isFinite(parsed)) yOffset = parsed;
      } else if (rawLine === 'Content:') {
        inContent = true;
        finalizeInputsAndScale();
      } else if (rawLine.startsWith('{')) {
        // Tolerate minimal SyncTeX payloads that omit the `Content:` marker
        inContent = true;
        finalizeInputsAndScale();
        i--; // reprocess this `{page` line in content mode
      }
      continue;
    }

    // Stop at Postamble
    if (rawLine.startsWith('Postamble:')) {
      break;
    }

    // Additional Input declarations can legally appear inside Content in SyncTeX
    if (rawLine.startsWith('Input:')) {
      const rest = rawLine.slice('Input:'.length);
      const colonIdx = rest.indexOf(':');
      if (colonIdx > 0) {
        const tag = Number(rest.slice(0, colonIdx));
        const rawPath = rest.slice(colonIdx + 1).trim();
        if (Number.isInteger(tag) && rawPath) {
          const normalizedPath = normalizeInputRawPath(rawPath, rootDirHint);
          inputs.set(tag, {
            tag,
            rawPath,
            normalizedPath,
            basename: path.posix.basename(normalizedPath),
          });
        }
      }
      continue;
    }

    const prefix = rawLine[0];
    if (!prefix || prefix === '!' || prefix === 'f') {
      continue;
    }

    // Close container boxes (`]` closes `[` vbox, `)` closes `(` hbox)
    if (prefix === ']' || prefix === ')') {
      if (formDepth === 0 && boxStack.length > 0) {
        const expectedKind = prefix === ']' ? 'vbox' : 'hbox';
        for (let idx = boxStack.length - 1; idx >= 0; idx--) {
          if (boxStack[idx]?.kind === expectedKind) {
            boxStack.length = idx;
            break;
          }
        }
      }
      continue;
    }

    // Form blocks (`<tag` ... `>`) in SyncTeX v1.18+
    if (prefix === '<') {
      formDepth++;
      continue;
    }
    if (prefix === '>') {
      if (formDepth > 0) formDepth--;
      continue;
    }
    if (formDepth > 0) {
      continue;
    }

    // Page block open `{pageNum`
    if (prefix === '{') {
      const pageNum = Number(rawLine.slice(1).trim());
      if (Number.isInteger(pageNum) && pageNum > 0) {
        currentPage = pageNum;
        boxStack.length = 0;
        if (pageNum > maxPage) maxPage = pageNum;
        if (!recordsByPage.has(pageNum)) {
          recordsByPage.set(pageNum, []);
        }
      }
      continue;
    }

    // Page block close `}` or `}pageNum`
    if (prefix === '}') {
      currentPage = 0;
      boxStack.length = 0;
      continue;
    }

    if (currentPage <= 0) {
      continue;
    }

    let kind: SyncTeXRecordKind | null = null;
    let hasSize = false;
    let hasWidthOnly = false;

    switch (prefix) {
      case '[':
        kind = 'vbox';
        hasSize = true;
        break;
      case '(':
        kind = 'hbox';
        hasSize = true;
        break;
      case 'v':
        kind = 'void-vbox';
        hasSize = true;
        break;
      case 'h':
        kind = 'void-hbox';
        hasSize = true;
        break;
      case 'k':
        kind = 'kern';
        hasWidthOnly = true;
        break;
      case 'x':
        kind = 'anchor';
        break;
      case 'g':
        kind = 'glue';
        break;
      case '$':
        kind = 'math';
        break;
      default:
        continue;
    }

    const body = rawLine.slice(1);
    const segments = body.split(':');
    if (segments.length < 2) continue;

    const link = parseLinkPart(segments[0] ?? '');
    if (!link) continue;

    const pointParts = (segments[1] ?? '').split(',');
    if (pointParts.length < 2) continue;

    const hVal = parseCoord(pointParts[0], prev.h);
    const vVal = parseCoord(pointParts[1], prev.v);
    if (hVal === null || vVal === null) continue;
    prev.h = hVal;
    prev.v = vVal;

    let wVal = 0;
    let hgtVal = 0;
    let dVal = 0;

    if (hasSize && segments.length >= 3) {
      const sizeParts = (segments[2] ?? '').split(',');
      const pw = parseCoord(sizeParts[0], prev.w);
      const ph = parseCoord(sizeParts[1], prev.hgt);
      const pd = parseCoord(sizeParts[2], prev.d);
      if (pw !== null) {
        wVal = pw;
        prev.w = pw;
      }
      if (ph !== null) {
        hgtVal = ph;
        prev.hgt = ph;
      }
      if (pd !== null) {
        dVal = pd;
        prev.d = pd;
      }
    } else if (hasWidthOnly && segments.length >= 3) {
      const pw = parseCoord(segments[2], prev.w);
      if (pw !== null) {
        wVal = pw;
        prev.w = pw;
      }
    }

    // In SyncTeX, `v` is the baseline Y (downward from page top), `H` is height above baseline,
    // `D` is depth below baseline. For kerns `k`, width extends leftward from `h`.
    const rawLeft = kind === 'kern' ? hVal - wVal : hVal;
    const xPt = (rawLeft + xOffset) * scale;
    let yPt = (vVal - hgtVal + yOffset) * scale;
    const widthPt = Math.max(0, wVal * scale);
    let heightPt = Math.max(0, (hgtVal + dVal) * scale);

    const enclosingHbox = getEnclosingHbox();
    const isLeafNode =
      kind === 'void-hbox' ||
      kind === 'void-vbox' ||
      kind === 'anchor' ||
      kind === 'kern' ||
      kind === 'glue' ||
      kind === 'math';

    // Child leaf nodes (e.g. CJK glue/kern/indent-hbox) often carry H=0, D=0;
    // inherit vertical line band from their enclosing `hbox` (`(`).
    if (isLeafNode && enclosingHbox && heightPt === 0 && enclosingHbox.height > 0) {
      yPt = enclosingHbox.y;
      heightPt = enclosingHbox.height;
    }

    const record: SyncTeXRecord = {
      kind,
      tag: link.tag,
      line: link.line,
      column: link.column,
      page: currentPage,
      x: xPt,
      y: yPt,
      width: widthPt,
      height: heightPt,
      ...(isLeafNode && enclosingHbox ? { parentHbox: enclosingHbox } : {}),
      ...(kind === 'hbox' ? { children: [] } : {}),
    };

    // Mark parent container vbox as wrapping inner boxes (e.g. page/paragraph wrapper)
    if (boxStack.length > 0 && (kind === 'hbox' || kind === 'vbox' || kind === 'void-hbox')) {
      const parentBox = boxStack[boxStack.length - 1];
      if (parentBox && parentBox.kind === 'vbox') {
        parentBox.hasChildBoxes = true;
      }
    }

    if (isLeafNode && enclosingHbox?.children) {
      enclosingHbox.children.push(record);
    }

    if (kind === 'vbox' || kind === 'hbox') {
      boxStack.push(record);
    }

    const pageList = recordsByPage.get(currentPage);
    if (pageList) {
      pageList.push(record);
    }

    const key = `${link.tag}:${link.line}`;
    let tagLineList = recordsByTagLine.get(key);
    if (!tagLineList) {
      tagLineList = [];
      recordsByTagLine.set(key, tagLineList);
    }
    tagLineList.push(record);
  }

  finalizeInputsAndScale();

  return {
    version,
    magnification,
    unit,
    xOffset,
    yOffset,
    scale,
    inputs,
    recordsByPage,
    recordsByTagLine,
    pageCount: maxPage,
  };
}

/**
 * Load and parse a `.synctex.gz` or uncompressed `.synctex` file from disk.
 * Returns `null` if the file does not exist or cannot be parsed.
 */
export function loadSyncTeXFile(synctexPath: string): SyncTeXIndex | null {
  try {
    if (!fs.existsSync(synctexPath)) {
      return null;
    }
    const stat = fs.statSync(synctexPath);
    if (!stat.isFile() || stat.size === 0) {
      return null;
    }
    const buf = fs.readFileSync(synctexPath);
    const raw =
      synctexPath.toLowerCase().endsWith('.gz') || isGzipBuffer(buf)
        ? gunzipSync(buf)
        : buf;
    return parseSyncTeX(raw);
  } catch {
    return null;
  }
}

function findMatchingInputs(index: SyncTeXIndex, queryFile: string): SyncTeXInputFile[] {
  const norm = normalizeQueryPath(queryFile);
  const normLower = norm.toLowerCase();
  const queryBase = path.posix.basename(normLower);

  const exact: SyncTeXInputFile[] = [];
  const suffix: SyncTeXInputFile[] = [];
  const baseMatches: SyncTeXInputFile[] = [];

  for (const input of index.inputs.values()) {
    const inpLower = input.normalizedPath.toLowerCase();
    if (inpLower === normLower) {
      exact.push(input);
    } else if (
      inpLower.endsWith('/' + normLower) ||
      normLower.endsWith('/' + inpLower)
    ) {
      suffix.push(input);
    } else if (input.basename.toLowerCase() === queryBase) {
      baseMatches.push(input);
    }
  }

  if (exact.length > 0) return exact;
  if (suffix.length > 0) return suffix;
  return baseMatches;
}

function recordToBox(rec: SyncTeXRecord): SyncTeXBox {
  // For zero-area anchors/math/glue records without parentHbox height, shift above baseline
  if (rec.height === 0) {
    return {
      page: rec.page,
      x: rec.x,
      y: Math.max(0, rec.y - 10),
      width: rec.width > 0 ? rec.width : 18,
      height: 12,
    };
  }
  return {
    page: rec.page,
    x: rec.x,
    y: rec.y,
    width: rec.width > 0 ? rec.width : 12,
    height: rec.height,
  };
}

function selectBestForwardBoxes(records: SyncTeXRecord[]): SyncTeXBox[] {
  // 1. Direct horizontal text boxes (`hbox` or `void-hbox`) with genuine own size
  const directHboxes = records.filter(
    (r) =>
      (r.kind === 'hbox' || (r.kind === 'void-hbox' && !r.parentHbox)) &&
      r.width > 0 &&
      r.height > 0,
  );
  if (directHboxes.length > 0) {
    return directHboxes.map(recordToBox);
  }

  // 2. Leaf nodes inside enclosing `hbox`es (common in XeTeX/CJK paragraphs):
  //    merge leaf spans per parentHbox so the entire text run becomes a clean highlight rectangle.
  const groupedByParent = new Map<SyncTeXRecord, SyncTeXRecord[]>();
  const orphanRecords: SyncTeXRecord[] = [];
  for (const r of records) {
    if (r.parentHbox && r.parentHbox.width > 0 && r.parentHbox.height > 0) {
      let grp = groupedByParent.get(r.parentHbox);
      if (!grp) {
        grp = [];
        groupedByParent.set(r.parentHbox, grp);
      }
      grp.push(r);
    } else {
      orphanRecords.push(r);
    }
  }

  if (groupedByParent.size > 0) {
    const mergedBoxes: SyncTeXBox[] = [];
    for (const [parent, leaves] of groupedByParent) {
      let minX = Number.POSITIVE_INFINITY;
      let maxX = Number.NEGATIVE_INFINITY;
      for (const leaf of leaves) {
        minX = Math.min(minX, leaf.x);
        maxX = Math.max(maxX, leaf.x + leaf.width);
      }
      const clampedLeft = Math.max(parent.x, minX);
      const clampedRight = Math.min(parent.x + parent.width, Math.max(maxX, clampedLeft + 16));
      mergedBoxes.push({
        page: parent.page,
        x: clampedLeft,
        y: parent.y,
        width: Math.max(12, clampedRight - clampedLeft),
        height: parent.height,
      });
    }
    return mergedBoxes;
  }

  // 3. Fallback to non-zero-area boxes (e.g. `vbox`) or synthesized point boxes
  const sized = orphanRecords.filter((r) => r.width > 0 && r.height > 0);
  const chosen = sized.length > 0 ? sized : orphanRecords;
  return chosen.map(recordToBox);
}

/**
 * Forward SyncTeX search: map a LaTeX source `(file, line)` to PDF bounding boxes.
 * Matches exact line first, otherwise searches nearest line within ±5 lines.
 */
export function syncTeXForward(
  index: SyncTeXIndex,
  file: string,
  line: number,
): SyncTeXForwardResult {
  const normQuery = normalizeQueryPath(file);
  const targetLine = Math.max(1, Math.trunc(line));
  const candidates = findMatchingInputs(index, normQuery);

  if (candidates.length === 0) {
    return { found: false, file: normQuery, line: targetLine, boxes: [] };
  }

  // Search exact line first (delta = 0), then ±1 .. ±5
  const deltas = [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5];
  for (const delta of deltas) {
    const probeLine = targetLine + delta;
    if (probeLine <= 0) continue;

    for (const input of candidates) {
      const records = index.recordsByTagLine.get(`${input.tag}:${probeLine}`);
      if (records && records.length > 0) {
        return {
          found: true,
          file: input.normalizedPath,
          line: probeLine,
          boxes: selectBestForwardBoxes(records),
        };
      }
    }
  }

  return {
    found: false,
    file: candidates[0]!.normalizedPath,
    line: targetLine,
    boxes: [],
  };
}

function kindSpecificityRank(kind: SyncTeXRecordKind): number {
  switch (kind) {
    case 'hbox':
    case 'void-hbox':
      return 0;
    case 'kern':
    case 'anchor':
    case 'math':
    case 'glue':
      return 1;
    case 'vbox':
    case 'void-vbox':
      return 2;
  }
}

function refineHboxToClosestChild(
  index: SyncTeXIndex,
  hbox: SyncTeXRecord,
  xPt: number,
): SyncTeXRecord {
  const children = hbox.children;
  if (!children || children.length === 0) {
    return hbox;
  }

  let bestChild: SyncTeXRecord | null = null;
  let bestDx = Number.POSITIVE_INFINITY;

  for (const child of children) {
    if (child.line <= 0 || !index.inputs.has(child.tag)) continue;
    const dx =
      xPt < child.x
        ? child.x - xPt
        : xPt > child.x + child.width
          ? xPt - (child.x + child.width)
          : 0;
    if (dx < bestDx - 1e-6) {
      bestDx = dx;
      bestChild = child;
    }
  }

  return bestChild ?? hbox;
}

/**
 * Inverse SyncTeX search: map a PDF click `(page, xPt, yPt)` in top-left point coordinates
 * back to the tightest containing horizontal text box (refined to its closest leaf node)
 * or nearest text box on that page.
 */
export function syncTeXInverse(
  index: SyncTeXIndex,
  page: number,
  xPt: number,
  yPt: number,
): SyncTeXInverseResult {
  const pageRecords = index.recordsByPage.get(page);
  if (!pageRecords || pageRecords.length === 0) {
    return { found: false, file: '', line: 0, column: 0 };
  }

  let bestContainingHbox: { rec: SyncTeXRecord; area: number; rank: number } | null = null;
  let bestContainingLeafVbox: { rec: SyncTeXRecord; area: number; rank: number } | null = null;
  let bestNearestText: { rec: SyncTeXRecord; dist: number; area: number; rank: number } | null = null;
  let bestNearestAny: { rec: SyncTeXRecord; dist: number; area: number; rank: number } | null = null;

  for (const rec of pageRecords) {
    if (rec.line <= 0) continue;
    if (!index.inputs.has(rec.tag)) continue;

    const area = rec.width * rec.height;
    const rank = kindSpecificityRank(rec.kind);
    const isHbox = rec.kind === 'hbox' || rec.kind === 'void-hbox';
    const isContainerVbox = rec.kind === 'vbox' && rec.hasChildBoxes === true;

    if (rec.width > 0 && rec.height > 0) {
      const inside =
        xPt >= rec.x &&
        xPt <= rec.x + rec.width &&
        yPt >= rec.y &&
        yPt <= rec.y + rec.height;

      if (inside) {
        if (isHbox) {
          if (
            !bestContainingHbox ||
            area < bestContainingHbox.area - 1e-6 ||
            (Math.abs(area - bestContainingHbox.area) <= 1e-6 && rank < bestContainingHbox.rank)
          ) {
            bestContainingHbox = { rec, area, rank };
          }
          continue;
        }
        if (!isContainerVbox) {
          if (
            !bestContainingLeafVbox ||
            area < bestContainingLeafVbox.area - 1e-6 ||
            (Math.abs(area - bestContainingLeafVbox.area) <= 1e-6 &&
              rank < bestContainingLeafVbox.rank)
          ) {
            bestContainingLeafVbox = { rec, area, rank };
          }
          continue;
        }
      }
    }

    // Distance from (xPt, yPt) to box rectangle (or point if zero-sized)
    const dx =
      xPt < rec.x
        ? rec.x - xPt
        : xPt > rec.x + rec.width
          ? xPt - (rec.x + rec.width)
          : 0;
    const dy =
      yPt < rec.y
        ? rec.y - yPt
        : yPt > rec.y + rec.height
          ? yPt - (rec.y + rec.height)
          : 0;
    const dist = Math.hypot(dx, dy);

    if (!isContainerVbox) {
      if (
        !bestNearestText ||
        dist < bestNearestText.dist - 1e-6 ||
        (Math.abs(dist - bestNearestText.dist) <= 1e-6 &&
          (area < bestNearestText.area - 1e-6 ||
            (Math.abs(area - bestNearestText.area) <= 1e-6 && rank < bestNearestText.rank)))
      ) {
        bestNearestText = { rec, dist, area, rank };
      }
    }

    if (
      !bestNearestAny ||
      dist < bestNearestAny.dist - 1e-6 ||
      (Math.abs(dist - bestNearestAny.dist) <= 1e-6 &&
        (area < bestNearestAny.area - 1e-6 ||
          (Math.abs(area - bestNearestAny.area) <= 1e-6 && rank < bestNearestAny.rank)))
    ) {
      bestNearestAny = { rec, dist, area, rank };
    }
  }

  let chosen =
    bestContainingHbox?.rec ??
    bestContainingLeafVbox?.rec ??
    bestNearestText?.rec ??
    bestNearestAny?.rec;

  if (!chosen) {
    return { found: false, file: '', line: 0, column: 0 };
  }

  // Refine enclosing hbox (`(`) to its horizontally closest child leaf node (crucial for real TeX paragraphs)
  if (chosen.kind === 'hbox') {
    chosen = refineHboxToClosestChild(index, chosen, xPt);
  }

  const input = index.inputs.get(chosen.tag);
  return {
    found: true,
    file: input?.normalizedPath ?? '',
    line: chosen.line,
    column: chosen.column,
  };
}
