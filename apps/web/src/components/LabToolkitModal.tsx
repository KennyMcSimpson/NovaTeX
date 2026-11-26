import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ProjectFileEntry } from '@novatex/shared';
import {
  AlertTriangle,
  Check,
  Code2,
  Columns2,
  Copy,
  CornerDownLeft,
  Eraser,
  FileCode2,
  FlaskConical,
  Image as ImageIcon,
  Info,
  Loader2,
  Sparkles,
  Square,
  Table2,
  UploadCloud,
  X,
} from 'lucide-react';
import { api, fileToBase64 } from '../api.ts';
import { useLocale } from '../i18n.ts';

export interface LabToolkitModalProps {
  projectId: string;
  files: ProjectFileEntry[];
  readOnly: boolean;
  onInsertSnippet: (latex: string, label: string) => void;
  onRefreshFiles: () => Promise<void> | void;
  onClose: () => void;
  onNotify: (kind: 'success' | 'error' | 'info', message: string) => void;
}

type ToolkitTab = 'table' | 'code' | 'figure';
type HighlightMode = 'none' | 'max' | 'min';
type AlignmentMode = 'auto' | 'left' | 'center' | 'right';
type FigureLayout = 'single' | 'side-by-side';
type PanelSlot = 'left' | 'right';
type ListingLanguageId =
  | 'Python'
  | 'C++'
  | 'C'
  | 'Java'
  | 'JavaScript'
  | 'Bash'
  | 'MATLAB'
  | 'SQL'
  | 'Plain';

interface ListingLanguageOption {
  id: ListingLanguageId;
  label: string;
  latexOption: string | null;
}

const LISTING_LANGUAGES: ListingLanguageOption[] = [
  { id: 'Python', label: 'Python', latexOption: 'Python' },
  { id: 'C++', label: 'C++', latexOption: 'C++' },
  { id: 'C', label: 'C', latexOption: 'C' },
  { id: 'Java', label: 'Java', latexOption: 'Java' },
  { id: 'JavaScript', label: 'JavaScript', latexOption: 'JavaScript' },
  { id: 'Bash', label: 'Bash', latexOption: 'bash' },
  { id: 'MATLAB', label: 'MATLAB', latexOption: 'Matlab' },
  { id: 'SQL', label: 'SQL', latexOption: 'SQL' },
  { id: 'Plain', label: 'Plain', latexOption: null },
];

const SAMPLE_TABLE_TSV = [
  'Model\tLatency (ms)\tAccuracy (%)\tMemory (MB)',
  'Baseline CNN\t18.4 ± 0.5\t89.2%\t412',
  'ResNet-18\t12.7 ± 0.3\t92.8%\t536',
  'MobileNetV3\t6.9 ± 0.2\t91.4%\t198',
  'Ours (NovaNet)\t7.4 ± 0.2\t95.6%\t245',
].join('\n');

const SAMPLE_PYTHON_CODE = `import numpy as np

def evaluate_predictions(y_true: np.ndarray, y_pred: np.ndarray) -> dict[str, float]:
    """Compute accuracy and macro-F1 for lab benchmark evaluation."""
    correct = float(np.mean(y_true == y_pred))
    tp = float(np.sum((y_true == 1) & (y_pred == 1)))
    fp = float(np.sum((y_true == 0) & (y_pred == 1)))
    fn = float(np.sum((y_true == 1) & (y_pred == 0)))
    precision = tp / max(tp + fp, 1e-12)
    recall = tp / max(tp + fn, 1e-12)
    f1 = 2.0 * precision * recall / max(precision + recall, 1e-12)
    return {"accuracy": correct * 100.0, "f1": f1 * 100.0}`;

const ALLOWED_IMAGE_EXT_RE = /\.(png|jpe?g|pdf|eps|svg)$/i;
const WINDOWS_RESERVED_STEM_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024; // 20 MB guard

const LATEX_ESCAPE_MAP: Record<string, string> = {
  '\\': '\\textbackslash{}',
  '{': '\\{',
  '}': '\\}',
  '%': '\\%',
  '_': '\\_',
  '#': '\\#',
  '&': '\\&',
  '$': '\\$',
  '^': '\\textasciicircum{}',
  '~': '\\textasciitilde{}',
  '±': '$\\pm$',
};

function escapeLatexText(input: string): string {
  return input.replace(/[\\{}%_#&$^~±]/g, (ch) => LATEX_ESCAPE_MAP[ch] ?? ch);
}

type DetectedTableFormat = 'tsv' | 'csv' | 'markdown';

interface ParsedTable {
  format: DetectedTableFormat;
  headers: string[];
  rows: string[][];
  colCount: number;
}

const MD_SEPARATOR_CELL_RE = /^:?-{2,}:?$/;

function isMarkdownSeparatorRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every((c) => MD_SEPARATOR_CELL_RE.test(c.trim()));
}

function splitMarkdownPipeRow(line: string): string[] {
  let working = line.trim();
  if (working.startsWith('|')) {
    working = working.slice(1);
  }
  if (working.endsWith('|') && !working.endsWith('\\|')) {
    working = working.slice(0, -1);
  }
  const cells: string[] = [];
  let current = '';
  for (let i = 0; i < working.length; i++) {
    const ch = working[i];
    const next = working[i + 1];
    if (ch === '\\' && next === '|') {
      current += '|';
      i++;
      continue;
    }
    if (ch === '|') {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += ch ?? '';
  }
  cells.push(current.trim());
  return cells;
}

function parseDelimitedText(text: string, delimiter: ',' | '\t'): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else if (ch === '\n') {
        field += ' ';
      } else {
        field += ch ?? '';
      }
      continue;
    }

    if (ch === '"' && field.trim().length === 0) {
      field = '';
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(field.trim());
      field = '';
    } else if (ch === '\n') {
      row.push(field.trim());
      if (row.some((cell) => cell.length > 0)) {
        rows.push(row);
      }
      row = [];
      field = '';
    } else {
      field += ch ?? '';
    }
  }

  row.push(field.trim());
  if (row.some((cell) => cell.length > 0)) {
    rows.push(row);
  }
  return rows;
}

function parseTabularData(raw: string): ParsedTable | null {
  const normalized = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  if (!normalized) return null;

  const nonEmptyLines = normalized
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0);
  if (nonEmptyLines.length === 0) return null;

  // Detect Markdown pipe table first
  const hasPipes = nonEmptyLines.every((l) => l.includes('|'));
  const secondLine = nonEmptyLines[1];
  const looksLikeMarkdown =
    hasPipes &&
    (nonEmptyLines[0]?.trim().startsWith('|') ||
      (secondLine !== undefined && isMarkdownSeparatorRow(splitMarkdownPipeRow(secondLine))));

  let format: DetectedTableFormat;
  let allRows: string[][];

  if (looksLikeMarkdown) {
    format = 'markdown';
    const splitRows = nonEmptyLines.map((line) => splitMarkdownPipeRow(line));
    allRows = splitRows.filter((cells, idx) => !(idx === 1 && isMarkdownSeparatorRow(cells)));
  } else if (normalized.includes('\t')) {
    format = 'tsv';
    allRows = parseDelimitedText(normalized, '\t');
  } else {
    format = 'csv';
    allRows = parseDelimitedText(normalized, ',');
  }

  if (allRows.length === 0) return null;

  let colCount = 0;
  for (const r of allRows) {
    if (r.length > colCount) colCount = r.length;
  }
  if (colCount === 0) return null;

  const padded = allRows.map((r) => {
    const out = r.slice(0, colCount);
    while (out.length < colCount) out.push('');
    return out;
  });

  const headers = padded[0] ?? [];
  const rows = padded.slice(1);
  return { format, headers, rows, colCount };
}

/**
 * Extracts a numeric metric from common lab table cell strings:
 * supports leading `%` / `±` / `+/-` / `~` / `≈`, thousands separators,
 * signed decimals & scientific notation, trailing `%`, `± std`, and common units.
 * Returns null for non-numeric text labels (e.g. "ResNet-18", "N/A").
 */
const METRIC_CELL_RE =
  /^(?:[±~≈%]|\+\/-|\+-)?\s*([+-−]?(?:\d+(?:,\d{3})*(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?)\s*%?(?:\s*(?:±|\+\/-|\+-|\\pm|\$\\pm\$)\s*[+-−]?(?:\d+(?:\.\d+)?|\.\d+)\s*%?|\s*\(\s*[±+-]?\s*\d+(?:\.\d+)?\s*%?\s*\))?\s*(?:ms|s|ns|us|µs|μs|kb|mb|gb|tb|hz|khz|mhz|ghz|px|pt|mm|cm|m|km|kg|g|mg|db|w|mw|v|mv|a|ma|k|°c|℃|x|×|fps|mb\/s|gb\/s|%)?$/i;

function parseMetricNumber(rawCell: string): number | null {
  const trimmed = rawCell.trim();
  if (!trimmed) return null;
  const match = METRIC_CELL_RE.exec(trimmed);
  const numPart = match?.[1];
  if (!numPart) return null;
  const cleaned = numPart.replace(/,/g, '').replace(/−/g, '-');
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildColumnSpec(colCount: number, mode: AlignmentMode): string {
  if (colCount <= 0) return 'l';
  if (mode === 'left') return 'l'.repeat(colCount);
  if (mode === 'center') return 'c'.repeat(colCount);
  if (mode === 'right') return 'r'.repeat(colCount);
  // Auto: first column left-aligned, remaining columns right-aligned
  return colCount === 1 ? 'l' : `l${'r'.repeat(colCount - 1)}`;
}

function formatLatexCell(raw: string, autoEscape: boolean): string {
  return autoEscape ? escapeLatexText(raw) : raw;
}

function sanitizeImageFileName(originalName: string): { safeName: string; validExt: boolean } {
  const baseName = originalName.replace(/\\/g, '/').split('/').pop() ?? '';
  const dotIdx = baseName.lastIndexOf('.');
  const rawStem = dotIdx > 0 ? baseName.slice(0, dotIdx) : baseName;
  const rawExt = dotIdx > 0 ? baseName.slice(dotIdx).toLowerCase() : '';

  if (!ALLOWED_IMAGE_EXT_RE.test(rawExt)) {
    return { safeName: '', validExt: false };
  }

  let stem = rawStem
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[-&._]+/, '')
    .replace(/[._-]+$/, '');

  if (!stem || WINDOWS_RESERVED_STEM_RE.test(stem)) {
    stem = `img_${stem || Date.now().toString(36)}`;
  }
  if (stem.length > 64) {
    stem = stem.slice(0, 64).replace(/[._-]+$/, '') || 'figure';
  }

  return { safeName: `${stem}${rawExt}`, validExt: true };
}

function formatLinewidth(ratio: number): string {
  const clamped = Math.min(1, Math.max(0.4, ratio));
  return clamped.toFixed(2).replace(/(\.\d)0$/, '$1');
}

async function copyTextSafe(text: string): Promise<boolean> {
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fallback below for non-HTTPS LAN deployments
    }
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    ta.style.top = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

export const LabToolkitModal: React.FC<LabToolkitModalProps> = ({
  projectId,
  files,
  readOnly,
  onInsertSnippet,
  onRefreshFiles,
  onClose,
  onNotify,
}) => {
  const { tr } = useLocale();

  const [activeTab, setActiveTab] = useState<ToolkitTab>('table');
  const [copiedFlag, setCopiedFlag] = useState<boolean>(false);
  const copyTimerRef = useRef<number | null>(null);

  // Tab 1: Booktabs Table state
  const [tableInput, setTableInput] = useState<string>(SAMPLE_TABLE_TSV);
  const [tableCaption, setTableCaption] = useState<string>('Experimental benchmark results');
  const [tableLabel, setTableLabel] = useState<string>('tab:results');
  const [highlightMode, setHighlightMode] = useState<HighlightMode>('max');
  const [alignmentMode, setAlignmentMode] = useState<AlignmentMode>('auto');
  const [autoEscape, setAutoEscape] = useState<boolean>(true);

  // Tab 2: Code Listing state
  const [codeLanguage, setCodeLanguage] = useState<ListingLanguageId>('Python');
  const [codeCaption, setCodeCaption] = useState<string>('Core algorithm implementation');
  const [codeLabel, setCodeLabel] = useState<string>('lst:impl');
  const [showLineNumbers, setShowLineNumbers] = useState<boolean>(true);
  const [codeContent, setCodeContent] = useState<string>(SAMPLE_PYTHON_CODE);

  // Tab 3: Figure / Subfigures state
  const [figureLayout, setFigureLayout] = useState<FigureLayout>('single');
  const [singleImage, setSingleImage] = useState<string>('');
  const [leftImage, setLeftImage] = useState<string>('');
  const [rightImage, setRightImage] = useState<string>('');
  const [figureWidth, setFigureWidth] = useState<number>(0.8);
  const [figureCaption, setFigureCaption] = useState<string>('Experimental results overview.');
  const [leftCaption, setLeftCaption] = useState<string>('Training loss curve');
  const [rightCaption, setRightCaption] = useState<string>('Validation accuracy');
  const [figureLabel, setFigureLabel] = useState<string>('fig:result');
  const [uploadTargetSlot, setUploadTargetSlot] = useState<PanelSlot>('left');

  const [uploadedPaths, setUploadedPaths] = useState<string[]>([]);
  const [uploading, setUploading] = useState<boolean>(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [isDraggingImage, setIsDraggingImage] = useState<boolean>(false);

  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const mountedRef = useRef<boolean>(true);
  const projectIdRef = useRef<string>(projectId);
  projectIdRef.current = projectId;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  // Reset per-project ephemeral upload cache when switching projects
  useEffect(() => {
    setUploadedPaths([]);
    setUploadError(null);
  }, [projectId]);

  // Escape key closes ONLY when not uploading or composing IME (no backdrop click dismissal)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.isComposing && !uploading) {
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [uploading, onClose]);

  // Available image files from project tree + freshly uploaded paths (prioritizing figures/)
  const imageFiles = useMemo(() => {
    const seen = new Set<string>();
    const list: string[] = [];
    for (const f of files) {
      if (f.kind === 'file' && ALLOWED_IMAGE_EXT_RE.test(f.path)) {
        if (!seen.has(f.path)) {
          seen.add(f.path);
          list.push(f.path);
        }
      }
    }
    for (const p of uploadedPaths) {
      if (!seen.has(p)) {
        seen.add(p);
        list.push(p);
      }
    }
    list.sort((a, b) => {
      const aInFig = a.startsWith('figures/') ? 0 : 1;
      const bInFig = b.startsWith('figures/') ? 0 : 1;
      if (aInFig !== bInFig) return aInFig - bInFig;
      return a.localeCompare(b);
    });
    return list;
  }, [files, uploadedPaths]);

  // Keep image selectors initialized cleanly when project files arrive
  useEffect(() => {
    const first = imageFiles[0] ?? '';
    const second = imageFiles[1] ?? first;
    if (first && (!singleImage || !imageFiles.includes(singleImage))) {
      setSingleImage(first);
    }
    if (first && (!leftImage || !imageFiles.includes(leftImage))) {
      setLeftImage(first);
    }
    if (second && (!rightImage || !imageFiles.includes(rightImage))) {
      setRightImage(second);
    }
  }, [imageFiles, singleImage, leftImage, rightImage]);

  // Tab 1: Parsed table & Booktabs LaTeX generation
  const tableBuild = useMemo(() => {
    const parsed = parseTabularData(tableInput);
    if (!parsed) {
      return { parsed: null, latex: '', highlightedCount: 0 };
    }

    const { headers, rows, colCount } = parsed;
    const colSpec = buildColumnSpec(colCount, alignmentMode);

    // Compute per-column best numeric value (skipping col 0 labels)
    const bestByCol = new Map<number, number>();
    if (highlightMode !== 'none' && rows.length > 0) {
      for (let col = 1; col < colCount; col++) {
        let best: number | null = null;
        for (const r of rows) {
          const val = parseMetricNumber(r[col] ?? '');
          if (val === null) continue;
          if (best === null) {
            best = val;
          } else if (highlightMode === 'max' && val > best) {
            best = val;
          } else if (highlightMode === 'min' && val < best) {
            best = val;
          }
        }
        if (best !== null) {
          bestByCol.set(col, best);
        }
      }
    }

    let highlightedCount = 0;
    const headerLine = headers
      .map((cell) => formatLatexCell(cell, autoEscape))
      .join(' & ');

    const bodyLines = rows.map((r) => {
      const cells = r.map((cell, colIdx) => {
        const formatted = formatLatexCell(cell, autoEscape);
        const bestVal = bestByCol.get(colIdx);
        if (bestVal !== undefined && colIdx >= 1) {
          const parsedVal = parseMetricNumber(cell);
          if (parsedVal !== null && Math.abs(parsedVal - bestVal) <= 1e-12) {
            highlightedCount += 1;
            const trimmedFmt = formatted.trim();
            if (trimmedFmt.startsWith('\\textbf{') && trimmedFmt.endsWith('}')) {
              return formatted;
            }
            return `\\textbf{${formatted}}`;
          }
        }
        return formatted;
      });
      return `    ${cells.join(' & ')} \\\\`;
    });

    const lines: string[] = ['\\begin{table}[ht]', '  \\centering'];
    const trimmedCaption = tableCaption.trim();
    if (trimmedCaption) {
      lines.push(`  \\caption{${formatLatexCell(trimmedCaption, autoEscape)}}`);
    }
    const trimmedLabel = tableLabel.trim();
    if (trimmedLabel) {
      lines.push(`  \\label{${trimmedLabel}}`);
    }
    lines.push(`  \\begin{tabular}{${colSpec}}`);
    lines.push('    \\toprule');
    lines.push(`    ${headerLine} \\\\`);
    if (bodyLines.length > 0) {
      lines.push('    \\midrule');
      lines.push(...bodyLines);
    }
    lines.push('    \\bottomrule');
    lines.push('  \\end{tabular}');
    lines.push('\\end{table}');

    return { parsed, latex: lines.join('\n'), highlightedCount };
  }, [tableInput, tableCaption, tableLabel, highlightMode, alignmentMode, autoEscape]);

  // Tab 2: Code Listing LaTeX generation
  const codeBuild = useMemo(() => {
    const normalizedCode = codeContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const trimmedRight = normalizedCode.replace(/\n+$/, '');
    if (!trimmedRight.trim()) {
      return { latex: '', lineCount: 0, hasEndListingConflict: false };
    }

    const langMeta = LISTING_LANGUAGES.find((item) => item.id === codeLanguage);
    const options: string[] = [];
    if (langMeta?.latexOption) {
      options.push(`language=${langMeta.latexOption}`);
    }
    const trimmedCaption = codeCaption.trim();
    if (trimmedCaption) {
      options.push(`caption={${trimmedCaption}}`);
    }
    const trimmedLabel = codeLabel.trim();
    if (trimmedLabel) {
      options.push(`label={${trimmedLabel}}`);
    }
    options.push(showLineNumbers ? 'numbers=left' : 'numbers=none');

    const header =
      options.length > 0 ? `\\begin{lstlisting}[${options.join(', ')}]` : '\\begin{lstlisting}';
    const latex = `${header}\n${trimmedRight}\n\\end{lstlisting}`;
    const lineCount = trimmedRight.split('\n').length;
    const hasEndListingConflict = /\\end\{lstlisting\}/.test(trimmedRight);

    return { latex, lineCount, hasEndListingConflict };
  }, [codeContent, codeLanguage, codeCaption, codeLabel, showLineNumbers]);

  // Tab 3: Figure / Subfigures LaTeX generation
  const figureBuild = useMemo(() => {
    const widthStr = formatLinewidth(figureWidth);
    const trimmedCaption = figureCaption.trim();
    const trimmedLabel = figureLabel.trim();

    if (figureLayout === 'single') {
      const imgPath = singleImage || 'figures/result.png';
      const lines: string[] = [
        '\\begin{figure}[ht]',
        '  \\centering',
        `  \\includegraphics[width=${widthStr}\\linewidth]{${imgPath}}`,
      ];
      if (trimmedCaption) {
        lines.push(`  \\caption{${trimmedCaption}}`);
      }
      if (trimmedLabel) {
        lines.push(`  \\label{${trimmedLabel}}`);
      }
      lines.push('\\end{figure}');
      return {
        latex: lines.join('\n'),
        hasSvgWarning: /\.svg$/i.test(imgPath),
        usesPlaceholder: !singleImage,
      };
    }

    // Side-by-side 2 panels using pure minipage (compiles everywhere even without subcaption)
    const imgLeft = leftImage || 'figures/panel-a.png';
    const imgRight = rightImage || 'figures/panel-b.png';
    const capLeft = leftCaption.trim();
    const capRight = rightCaption.trim();
    const innerWidth = `${widthStr}\\linewidth`;

    const lines: string[] = [
      '\\begin{figure}[ht]',
      '  \\centering',
      '  \\begin{minipage}[b]{0.48\\linewidth}',
      '    \\centering',
      `    \\includegraphics[width=${innerWidth}]{${imgLeft}}`,
    ];
    if (capLeft) {
      lines.push('    \\par\\smallskip');
      lines.push(`    {\\small (a) ${capLeft}}`);
    }
    lines.push('  \\end{minipage}%');
    lines.push('  \\hfill');
    lines.push('  \\begin{minipage}[b]{0.48\\linewidth}');
    lines.push('    \\centering');
    lines.push(`    \\includegraphics[width=${innerWidth}]{${imgRight}}`);
    if (capRight) {
      lines.push('    \\par\\smallskip');
      lines.push(`    {\\small (b) ${capRight}}`);
    }
    lines.push('  \\end{minipage}');
    if (trimmedCaption) {
      lines.push(`  \\caption{${trimmedCaption}}`);
    }
    if (trimmedLabel) {
      lines.push(`  \\label{${trimmedLabel}}`);
    }
    lines.push('\\end{figure}');

    return {
      latex: lines.join('\n'),
      hasSvgWarning: /\.svg$/i.test(imgLeft) || /\.svg$/i.test(imgRight),
      usesPlaceholder: !leftImage || !rightImage,
    };
  }, [
    figureLayout,
    singleImage,
    leftImage,
    rightImage,
    figureWidth,
    figureCaption,
    leftCaption,
    rightCaption,
    figureLabel,
  ]);

  const activeLatex =
    activeTab === 'table'
      ? tableBuild.latex
      : activeTab === 'code'
        ? codeBuild.latex
        : figureBuild.latex;

  const activeSnippetLabel =
    activeTab === 'table'
      ? tr('Booktabs table', '三线表')
      : activeTab === 'code'
        ? tr('Code listing', '代码块')
        : figureLayout === 'single'
          ? tr('Figure', '插图')
          : tr('Side-by-side figures', '双图并排');

  const handleCopyLatex = useCallback(async () => {
    if (!activeLatex) return;
    const ok = await copyTextSafe(activeLatex);
    if (ok) {
      setCopiedFlag(true);
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
      copyTimerRef.current = window.setTimeout(() => {
        setCopiedFlag(false);
      }, 1800);
      onNotify('success', tr('Copied LaTeX snippet to clipboard', '已复制 LaTeX 代码到剪贴板'));
    } else {
      onNotify(
        'error',
        tr('Copy failed — please select and copy manually', '复制失败，请手动选中预览代码复制'),
      );
    }
  }, [activeLatex, onNotify, tr]);

  const handleInsert = useCallback(() => {
    if (readOnly || !activeLatex) return;
    onInsertSnippet(activeLatex, activeSnippetLabel);
    onClose();
  }, [readOnly, activeLatex, activeSnippetLabel, onInsertSnippet, onClose]);

  const handleUploadImages = useCallback(
    async (fileList: FileList | File[]) => {
      if (readOnly || uploading) return;
      const incoming = Array.from(fileList);
      if (incoming.length === 0) return;

      // In single mode, upload 1 file; in side-by-side mode, allow up to 2 files at once
      const batch = figureLayout === 'side-by-side' ? incoming.slice(0, 2) : incoming.slice(0, 1);

      setUploading(true);
      setUploadError(null);
      const reqProjectId = projectId;
      const savedPaths: string[] = [];

      try {
        for (const file of batch) {
          const { safeName, validExt } = sanitizeImageFileName(file.name);
          if (!validExt || !safeName) {
            throw new Error(
              tr(
                `Unsupported image format "${file.name}". Allowed: .png, .jpg, .jpeg, .pdf, .eps, .svg.`,
                `不支持的图片格式「${file.name}」，仅支持 .png / .jpg / .jpeg / .pdf / .eps / .svg。`,
              ),
            );
          }
          if (file.size > MAX_UPLOAD_BYTES) {
            throw new Error(
              tr(
                `File "${file.name}" exceeds the 20 MB limit.`,
                `文件「${file.name}」超过 20 MB 大小限制。`,
              ),
            );
          }

          const base64 = await fileToBase64(file);
          if (!mountedRef.current || projectIdRef.current !== reqProjectId) return;

          const targetPath = `figures/${safeName}`;
          await api.writeFile(reqProjectId, {
            path: targetPath,
            base64,
            isBinary: true,
          });
          if (!mountedRef.current || projectIdRef.current !== reqProjectId) return;
          savedPaths.push(targetPath);
        }

        if (savedPaths.length > 0) {
          setUploadedPaths((prev) => {
            const next = [...prev];
            for (const p of savedPaths) {
              if (!next.includes(p)) next.push(p);
            }
            return next;
          });

          const firstSaved = savedPaths[0];
          const secondSaved = savedPaths[1];

          if (figureLayout === 'single' && firstSaved) {
            setSingleImage(firstSaved);
          } else if (figureLayout === 'side-by-side') {
            if (firstSaved && secondSaved) {
              setLeftImage(firstSaved);
              setRightImage(secondSaved);
            } else if (firstSaved) {
              if (uploadTargetSlot === 'left') {
                setLeftImage(firstSaved);
                setUploadTargetSlot('right');
              } else {
                setRightImage(firstSaved);
              }
            }
          }

          await Promise.resolve(onRefreshFiles());
          if (!mountedRef.current || projectIdRef.current !== reqProjectId) return;

          onNotify(
            'success',
            savedPaths.length === 1
              ? tr(
                  `Uploaded ${savedPaths[0]} and selected it`,
                  `已上传 ${savedPaths[0]} 并自动选中`,
                )
              : tr(
                  `Uploaded ${savedPaths.length} images to figures/ and assigned both panels`,
                  `已上传 ${savedPaths.length} 张图片到 figures/ 并自动填入左右双图`,
                ),
          );
        }
      } catch (err: unknown) {
        if (!mountedRef.current || projectIdRef.current !== reqProjectId) return;
        const msg =
          err instanceof Error
            ? err.message
            : tr('Failed to upload image', '图片上传失败');
        setUploadError(msg);
        onNotify('error', msg);
      } finally {
        if (mountedRef.current && projectIdRef.current === reqProjectId) {
          setUploading(false);
        }
      }
    },
    [readOnly, uploading, figureLayout, projectId, uploadTargetSlot, onRefreshFiles, onNotify, tr],
  );

  const detectedFormatBadge = useMemo(() => {
    if (!tableBuild.parsed) return null;
    const { format, rows, colCount } = tableBuild.parsed;
    const fmtLabel =
      format === 'tsv'
        ? tr('TSV (Excel / Sheets)', 'TSV（Excel / 表格）')
        : format === 'markdown'
          ? 'Markdown'
          : 'CSV';
    return `${fmtLabel} · ${rows.length + 1} × ${colCount}`;
  }, [tableBuild.parsed, tr]);

  const panelSectionStyle: React.CSSProperties = {
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-md)',
    padding: '14px 16px',
    background: 'var(--bg-subtle)',
    marginBottom: 14,
  };

  const previewPreStyle: React.CSSProperties = {
    margin: 0,
    padding: '12px 14px',
    borderRadius: 'var(--radius-md)',
    background: 'var(--bg-shell)',
    border: '1px solid var(--border)',
    fontFamily: 'var(--font-mono)',
    fontSize: 12,
    lineHeight: 1.6,
    color: 'var(--text-primary)',
    overflow: 'auto',
    maxHeight: 240,
    whiteSpace: 'pre',
    tabSize: 2,
  };

  return (
    <div className="modal-backdrop">
      <div
        className="modal-card modal-xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-lab-toolkit-title"
      >
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
            <h3 id="modal-lab-toolkit-title" className="modal-title">
              <FlaskConical size={16} style={{ color: 'var(--accent)', flexShrink: 0 }} />
              {tr('Lab & Report Toolkit', '实验报告与论文工具箱')}
            </h3>
            <span className="pill pill-accent">
              <Sparkles size={10} />
              {tr('Zero-API · Instant', '零 API · 本地即时生成')}
            </span>
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            aria-label={tr('Close', '关闭')}
            disabled={uploading}
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>

        <div className="modal-body">
          {/* 3-Tab Linear Pill Navigation */}
          <div className="settings-nav" role="tablist" aria-label={tr('Toolkit generators', '工具箱生成器')}>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'table'}
              className={activeTab === 'table' ? 'active' : ''}
              onClick={() => setActiveTab('table')}
            >
              <Table2 size={14} />
              {tr('CSV / Excel → Booktabs Table', '表格生成 (CSV / Excel)')}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'code'}
              className={activeTab === 'code' ? 'active' : ''}
              onClick={() => setActiveTab('code')}
            >
              <Code2 size={14} />
              {tr('Code → Highlighted Listing', '代码块生成 (listings)')}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'figure'}
              className={activeTab === 'figure' ? 'active' : ''}
              onClick={() => setActiveTab('figure')}
            >
              <ImageIcon size={14} />
              {tr('Figure / Subfigures', '插图 / 双图并排')}
            </button>
          </div>

          {readOnly && (
            <div className="alert alert-warning" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <AlertTriangle size={14} style={{ flexShrink: 0 }} />
              <span>
                {tr(
                  'Read-only mode: you can generate and copy LaTeX snippets, but cursor insertion and image upload require edit permission.',
                  '当前为只读权限：仍可自由生成并复制 LaTeX 代码，但插入编辑器与上传图片需要编辑权限。',
                )}
              </span>
            </div>
          )}

          {/* ===================== TAB 1: BOOKTABS TABLE ===================== */}
          {activeTab === 'table' && (
            <div>
              <div style={panelSectionStyle}>
                <div className="field">
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 8,
                      flexWrap: 'wrap',
                    }}
                  >
                    <label className="field-label" htmlFor="lab-table-input">
                      {tr(
                        'Paste Excel / Google Sheets (TSV), CSV, or Markdown Table',
                        '粘贴 Excel / Google Sheets（制表符）、CSV 或 Markdown 表格',
                      )}
                    </label>
                    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => setTableInput(SAMPLE_TABLE_TSV)}
                      >
                        <Sparkles size={12} style={{ color: 'var(--accent)' }} />
                        {tr('Load Sample', '填入示例数据')}
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        disabled={!tableInput}
                        onClick={() => setTableInput('')}
                      >
                        <Eraser size={12} />
                        {tr('Clear', '清空')}
                      </button>
                    </div>
                  </div>
                  <textarea
                    id="lab-table-input"
                    className="textarea"
                    rows={6}
                    spellCheck={false}
                    placeholder={tr(
                      'Model\tLatency (ms)\tAccuracy (%)\tMemory (MB)\nBaseline\t18.4 ± 0.5\t89.2%\t412\n"Ours, v2"\t7.4 ± 0.2\t95.6%\t245',
                      '直接从 Excel / WPS / 飞书表格复制粘贴，或输入逗号分隔 CSV / Markdown 管道表...',
                    )}
                    value={tableInput}
                    onChange={(e) => setTableInput(e.target.value)}
                  />
                  <div className="field-hint">
                    {tr(
                      'First row is treated as the table header. Quoted CSV cells (e.g. "a, b") and Markdown separator rows (|---|) are parsed automatically.',
                      '首行自动识别为表头；自动支持带引号的 CSV 单元格（如 "a, b"）与 Markdown 分隔线（|---|）。',
                    )}
                  </div>
                </div>

                <div className="form-grid-2">
                  <div className="field">
                    <label className="field-label" htmlFor="lab-table-caption">
                      {tr('Caption', '表题（Caption）')}
                    </label>
                    <input
                      id="lab-table-caption"
                      className="input"
                      placeholder={tr('e.g. Experimental benchmark results', '例如：模型性能对比实验结果')}
                      value={tableCaption}
                      onChange={(e) => setTableCaption(e.target.value)}
                    />
                  </div>
                  <div className="field">
                    <label className="field-label" htmlFor="lab-table-label">
                      {tr('Label', '交叉引用标签（Label）')}
                    </label>
                    <input
                      id="lab-table-label"
                      className="input"
                      style={{ fontFamily: 'var(--font-mono)' }}
                      placeholder="tab:results"
                      value={tableLabel}
                      onChange={(e) => setTableLabel(e.target.value)}
                    />
                  </div>
                </div>

                <div className="form-grid-2">
                  <div className="field" style={{ marginBottom: 0 }}>
                    <label className="field-label" htmlFor="lab-table-highlight">
                      {tr('Highlight Best Numeric Value', '最优数值自动加粗')}
                    </label>
                    <select
                      id="lab-table-highlight"
                      className="select"
                      value={highlightMode}
                      onChange={(e) => setHighlightMode(e.target.value as HighlightMode)}
                    >
                      <option value="none">{tr('None', '不高亮')}</option>
                      <option value="max">
                        {tr('Bold Max (per numeric column)', 'Bold Max · 加粗每列最大值')}
                      </option>
                      <option value="min">
                        {tr('Bold Min (per numeric column)', 'Bold Min · 加粗每列最小值')}
                      </option>
                    </select>
                  </div>
                  <div className="field" style={{ marginBottom: 0 }}>
                    <label className="field-label" htmlFor="lab-table-align">
                      {tr('Column Alignment', '列对齐方式')}
                    </label>
                    <select
                      id="lab-table-align"
                      className="select"
                      value={alignmentMode}
                      onChange={(e) => setAlignmentMode(e.target.value as AlignmentMode)}
                    >
                      <option value="auto">
                        {tr('Auto: l + r (left col 1, right rest)', '自动：首列左对齐，其余右对齐 (l + r)')}
                      </option>
                      <option value="left">{tr('All Left (l)', '全部左对齐 (l)')}</option>
                      <option value="center">{tr('All Center (c)', '全部居中 (c)')}</option>
                      <option value="right">{tr('All Right (r)', '全部右对齐 (r)')}</option>
                    </select>
                  </div>
                </div>

                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    flexWrap: 'wrap',
                    gap: '8px 16px',
                    marginTop: 12,
                    paddingTop: 12,
                    borderTop: '1px solid var(--border-subtle)',
                  }}
                >
                  <label
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 7,
                      cursor: 'pointer',
                      fontSize: 12.5,
                      color: 'var(--text-primary)',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={autoEscape}
                      onChange={(e) => setAutoEscape(e.target.checked)}
                    />
                    {tr(
                      'Auto-escape LaTeX specials (% _ # & $)',
                      '自动转义 LaTeX 特殊字符 (% _ # & $)',
                    )}
                  </label>
                  <span className="field-hint" style={{ margin: 0 }}>
                    {tr(
                      'Best-value scan skips column 0 labels and understands % and ± notation.',
                      '最优值自动跳过第 1 列名称，兼容 % 与 ± 误差写法。',
                    )}
                  </span>
                </div>
              </div>

              {/* Live Preview */}
              <div>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 8,
                    flexWrap: 'wrap',
                    marginBottom: 8,
                  }}
                >
                  <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <span className="field-label">{tr('Live LaTeX Preview', '实时 LaTeX 预览')}</span>
                    {detectedFormatBadge && <span className="pill">{detectedFormatBadge}</span>}
                    {highlightMode !== 'none' && tableBuild.highlightedCount > 0 && (
                      <span className="pill pill-success">
                        {tr(
                          `${tableBuild.highlightedCount} best bolded`,
                          `已加粗 ${tableBuild.highlightedCount} 处最优值`,
                        )}
                      </span>
                    )}
                  </div>
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={!tableBuild.latex}
                    onClick={() => void handleCopyLatex()}
                  >
                    {copiedFlag ? (
                      <Check size={12} style={{ color: 'var(--success)' }} />
                    ) : (
                      <Copy size={12} />
                    )}
                    {copiedFlag ? tr('Copied', '已复制') : tr('Copy LaTeX', '复制 LaTeX')}
                  </button>
                </div>

                {tableBuild.latex ? (
                  <pre style={previewPreStyle}>{tableBuild.latex}</pre>
                ) : (
                  <div className="alert" style={{ marginBottom: 0, color: 'var(--text-muted)' }}>
                    {tr(
                      'Paste rows above or click "Load Sample" to generate a publication-ready booktabs table.',
                      '在上方粘贴表格数据或点击「填入示例数据」，立即生成规范的三线表 LaTeX 代码。',
                    )}
                  </div>
                )}

                <div
                  className="field-hint"
                  style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8 }}
                >
                  <Info size={12} style={{ flexShrink: 0, color: 'var(--accent)' }} />
                  <span>
                    {tr(
                      'Uses \\toprule / \\midrule / \\bottomrule — \\usepackage{booktabs} is pre-configured in NovaTeX report & paper templates.',
                      '使用 \\toprule / \\midrule / \\bottomrule 三线表语法，NovaTeX 实验报告与论文模板已预置 \\usepackage{booktabs}。',
                    )}
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* ===================== TAB 2: CODE LISTING ===================== */}
          {activeTab === 'code' && (
            <div>
              <div style={panelSectionStyle}>
                <div className="form-grid-2">
                  <div className="field">
                    <label className="field-label" htmlFor="lab-code-lang">
                      {tr('Language', '编程语言')}
                    </label>
                    <select
                      id="lab-code-lang"
                      className="select"
                      value={codeLanguage}
                      onChange={(e) => setCodeLanguage(e.target.value as ListingLanguageId)}
                    >
                      {LISTING_LANGUAGES.map((lang) => (
                        <option key={lang.id} value={lang.id}>
                          {lang.id === 'Plain'
                            ? tr('Plain (no syntax highlighting)', 'Plain（纯文本无高亮）')
                            : lang.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label className="field-label" htmlFor="lab-code-label">
                      {tr('Label', '交叉引用标签（Label）')}
                    </label>
                    <input
                      id="lab-code-label"
                      className="input"
                      style={{ fontFamily: 'var(--font-mono)' }}
                      placeholder="lst:impl"
                      value={codeLabel}
                      onChange={(e) => setCodeLabel(e.target.value)}
                    />
                  </div>
                </div>

                <div className="form-grid-2">
                  <div className="field">
                    <label className="field-label" htmlFor="lab-code-caption">
                      {tr('Caption', '代码标题（Caption）')}
                    </label>
                    <input
                      id="lab-code-caption"
                      className="input"
                      placeholder={tr('Core algorithm implementation', '例如：核心算法实现')}
                      value={codeCaption}
                      onChange={(e) => setCodeCaption(e.target.value)}
                    />
                  </div>
                  <div className="field" style={{ justifyContent: 'flex-end' }}>
                    <label
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 7,
                        cursor: 'pointer',
                        height: 33,
                        fontSize: 12.5,
                        color: 'var(--text-primary)',
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={showLineNumbers}
                        onChange={(e) => setShowLineNumbers(e.target.checked)}
                      />
                      {tr('Show line numbers (numbers=left)', '显示左侧行号（numbers=left）')}
                    </label>
                  </div>
                </div>

                <div className="field" style={{ marginBottom: 0 }}>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 8,
                      flexWrap: 'wrap',
                    }}
                  >
                    <label className="field-label" htmlFor="lab-code-input">
                      {tr('Source Code', '源代码内容')}
                    </label>
                    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => {
                          setCodeLanguage('Python');
                          setCodeContent(SAMPLE_PYTHON_CODE);
                        }}
                      >
                        <FileCode2 size={12} style={{ color: 'var(--accent)' }} />
                        {tr('Load Python Sample', '填入 Python 示例')}
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        disabled={!codeContent}
                        onClick={() => setCodeContent('')}
                      >
                        <Eraser size={12} />
                        {tr('Clear', '清空')}
                      </button>
                    </div>
                  </div>
                  <textarea
                    id="lab-code-input"
                    className="textarea"
                    rows={8}
                    spellCheck={false}
                    placeholder={tr(
                      'Paste your Python, C/C++, Java, Bash, MATLAB, or SQL code here...',
                      '在此粘贴 Python / C++ / C / Java / Bash / MATLAB / SQL 等源代码...',
                    )}
                    value={codeContent}
                    onChange={(e) => setCodeContent(e.target.value)}
                  />
                </div>
              </div>

              {codeBuild.hasEndListingConflict && (
                <div className="alert alert-warning">
                  {tr(
                    'Detected literal "\\end{lstlisting}" inside your code. LaTeX listings will terminate early at that line unless escaped or renamed.',
                    '检测到源码中包含字面量「\\end{lstlisting}」，LaTeX 编译时会在该行提前结束代码块，请适当调整。',
                  )}
                </div>
              )}

              {/* Live Preview */}
              <div>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 8,
                    flexWrap: 'wrap',
                    marginBottom: 8,
                  }}
                >
                  <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <span className="field-label">{tr('Live LaTeX Preview', '实时 LaTeX 预览')}</span>
                    {codeBuild.lineCount > 0 && (
                      <span className="pill">
                        {codeLanguage} ·{' '}
                        {tr(`${codeBuild.lineCount} lines`, `${codeBuild.lineCount} 行`)}
                      </span>
                    )}
                  </div>
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={!codeBuild.latex}
                    onClick={() => void handleCopyLatex()}
                  >
                    {copiedFlag ? (
                      <Check size={12} style={{ color: 'var(--success)' }} />
                    ) : (
                      <Copy size={12} />
                    )}
                    {copiedFlag ? tr('Copied', '已复制') : tr('Copy LaTeX', '复制 LaTeX')}
                  </button>
                </div>

                {codeBuild.latex ? (
                  <pre style={previewPreStyle}>{codeBuild.latex}</pre>
                ) : (
                  <div className="alert" style={{ marginBottom: 0, color: 'var(--text-muted)' }}>
                    {tr(
                      'Paste code above or click "Load Python Sample" to generate a highlighted lstlisting block.',
                      '在上方粘贴代码或点击「填入 Python 示例」，立即生成带高亮的 lstlisting 代码块。',
                    )}
                  </div>
                )}

                <div
                  className="field-hint"
                  style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8 }}
                >
                  <Info size={12} style={{ flexShrink: 0, color: 'var(--accent)' }} />
                  <span>
                    {codeLanguage === 'JavaScript'
                      ? tr(
                          '\\usepackage{listings} is pre-configured in Lab/Tech Report templates. Note: standard listings needs a custom \\lstdefinelanguage{JavaScript} rule (or switch to Java) if your preamble does not define it.',
                          '实验报告与技术报告模板已预置 \\usepackage{listings}。注：若自定义导言区未声明 \\lstdefinelanguage{JavaScript}，可先定义或改选 Java 高亮兼容。',
                        )
                      : tr(
                          '\\usepackage{listings} is pre-configured in Lab/Tech Report templates for clean syntax highlighting and line numbers.',
                          '实验报告与技术报告模板已预置 \\usepackage{listings}，开箱支持语法高亮与行号排版。',
                        )}
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* ===================== TAB 3: FIGURE / SUBFIGURES ===================== */}
          {activeTab === 'figure' && (
            <div>
              <div style={panelSectionStyle}>
                {/* Layout Toggle */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 10,
                    flexWrap: 'wrap',
                    marginBottom: 14,
                  }}
                >
                  <span className="field-label">{tr('Figure Layout', '插图排版模式')}</span>
                  <div className="mode-switcher" role="group" aria-label={tr('Figure layout', '插图排版模式')}>
                    <button
                      type="button"
                      className={`mode-switcher-btn ${figureLayout === 'single' ? 'active' : ''}`}
                      onClick={() => setFigureLayout('single')}
                    >
                      <Square size={13} />
                      {tr('Single Figure', '单图居中')}
                    </button>
                    <button
                      type="button"
                      className={`mode-switcher-btn ${figureLayout === 'side-by-side' ? 'active' : ''}`}
                      onClick={() => setFigureLayout('side-by-side')}
                    >
                      <Columns2 size={13} />
                      {tr('Side-by-Side 2 Panels', '双图并排 (minipage)')}
                    </button>
                  </div>
                </div>

                {/* Image Picker(s) */}
                {figureLayout === 'single' ? (
                  <div className="field">
                    <label className="field-label" htmlFor="lab-fig-single-img">
                      {tr('Project Image File', '选择项目图片')}
                    </label>
                    <select
                      id="lab-fig-single-img"
                      className="select"
                      value={singleImage}
                      onChange={(e) => setSingleImage(e.target.value)}
                    >
                      {imageFiles.length === 0 ? (
                        <option value="">
                          {tr(
                            'No image files yet — upload below (preview uses figures/result.png)',
                            '项目暂无图片，请在下方上传（预览暂用 figures/result.png）',
                          )}
                        </option>
                      ) : (
                        imageFiles.map((imgPath) => (
                          <option key={imgPath} value={imgPath}>
                            {imgPath}
                          </option>
                        ))
                      )}
                    </select>
                  </div>
                ) : (
                  <div className="form-grid-2">
                    <div className="field">
                      <label className="field-label" htmlFor="lab-fig-left-img">
                        {tr('Left Panel (a) Image', '左图 (a) 文件')}
                      </label>
                      <select
                        id="lab-fig-left-img"
                        className="select"
                        value={leftImage}
                        onChange={(e) => setLeftImage(e.target.value)}
                      >
                        {imageFiles.length === 0 ? (
                          <option value="">
                            {tr('No images yet (figures/panel-a.png)', '暂无图片（暂用 figures/panel-a.png）')}
                          </option>
                        ) : (
                          imageFiles.map((imgPath) => (
                            <option key={imgPath} value={imgPath}>
                              {imgPath}
                            </option>
                          ))
                        )}
                      </select>
                    </div>
                    <div className="field">
                      <label className="field-label" htmlFor="lab-fig-right-img">
                        {tr('Right Panel (b) Image', '右图 (b) 文件')}
                      </label>
                      <select
                        id="lab-fig-right-img"
                        className="select"
                        value={rightImage}
                        onChange={(e) => setRightImage(e.target.value)}
                      >
                        {imageFiles.length === 0 ? (
                          <option value="">
                            {tr('No images yet (figures/panel-b.png)', '暂无图片（暂用 figures/panel-b.png）')}
                          </option>
                        ) : (
                          imageFiles.map((imgPath) => (
                            <option key={imgPath} value={imgPath}>
                              {imgPath}
                            </option>
                          ))
                        )}
                      </select>
                    </div>
                  </div>
                )}

                {/* Direct Upload to figures/ */}
                <div className="field">
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 8,
                      flexWrap: 'wrap',
                    }}
                  >
                    <span className="field-label">
                      {tr('Direct Upload Image to figures/', '直接上传图片到 figures/ 目录')}
                    </span>
                    {figureLayout === 'side-by-side' && (
                      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5 }}>
                        <span style={{ color: 'var(--text-muted)' }}>
                          {tr('Assign to:', '上传后自动填入：')}
                        </span>
                        <button
                          type="button"
                          className={`preset-chip ${uploadTargetSlot === 'left' ? 'active' : ''}`}
                          style={{ height: 22, padding: '0 8px', fontSize: 11 }}
                          onClick={() => setUploadTargetSlot('left')}
                        >
                          {tr('Panel (a)', '左图 (a)')}
                        </button>
                        <button
                          type="button"
                          className={`preset-chip ${uploadTargetSlot === 'right' ? 'active' : ''}`}
                          style={{ height: 22, padding: '0 8px', fontSize: 11 }}
                          onClick={() => setUploadTargetSlot('right')}
                        >
                          {tr('Panel (b)', '右图 (b)')}
                        </button>
                      </div>
                    )}
                  </div>

                  <input
                    ref={imageInputRef}
                    type="file"
                    accept=".png,.jpg,.jpeg,.pdf,.eps,.svg"
                    multiple={figureLayout === 'side-by-side'}
                    style={{ display: 'none' }}
                    disabled={readOnly || uploading}
                    onChange={(e) => {
                      const list = e.target.files;
                      if (list && list.length > 0) {
                        void handleUploadImages(list);
                      }
                      e.target.value = '';
                    }}
                  />

                  <div
                    role="button"
                    tabIndex={readOnly || uploading ? -1 : 0}
                    aria-disabled={readOnly || uploading}
                    className={`word-dropzone ${isDraggingImage ? 'dragging' : ''}`}
                    style={{
                      padding: '14px 16px',
                      opacity: readOnly ? 0.55 : 1,
                      cursor: readOnly || uploading ? 'not-allowed' : 'pointer',
                    }}
                    onClick={() => {
                      if (!readOnly && !uploading) {
                        imageInputRef.current?.click();
                      }
                    }}
                    onKeyDown={(e) => {
                      if ((e.key === 'Enter' || e.key === ' ') && !readOnly && !uploading) {
                        e.preventDefault();
                        imageInputRef.current?.click();
                      }
                    }}
                    onDragOver={(e) => {
                      e.preventDefault();
                      if (!readOnly && !uploading) {
                        setIsDraggingImage(true);
                      }
                    }}
                    onDragLeave={(e) => {
                      e.preventDefault();
                      setIsDraggingImage(false);
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      setIsDraggingImage(false);
                      if (!readOnly && !uploading && e.dataTransfer.files.length > 0) {
                        void handleUploadImages(e.dataTransfer.files);
                      }
                    }}
                  >
                    {uploading ? (
                      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                        <Loader2 size={16} className="spin" style={{ color: 'var(--accent)' }} />
                        <span style={{ fontWeight: 500 }}>
                          {tr('Uploading to figures/…', '正在上传至 figures/…')}
                        </span>
                      </div>
                    ) : (
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          gap: 10,
                          flexWrap: 'wrap',
                        }}
                      >
                        <UploadCloud size={18} style={{ color: 'var(--accent)', flexShrink: 0 }} />
                        <div style={{ textAlign: 'left' }}>
                          <div style={{ fontWeight: 600, fontSize: 12.5, color: 'var(--text-primary)' }}>
                            {readOnly
                              ? tr('Image upload disabled in read-only mode', '只读模式下不可上传图片')
                              : figureLayout === 'side-by-side'
                                ? tr(
                                    'Drop 1 or 2 images here, or click to upload to figures/',
                                    '拖入 1~2 张图片到此处，或点击上传至 figures/',
                                  )
                                : tr(
                                    'Drop an image here, or click to upload to figures/',
                                    '拖入图片到此处，或点击上传至 figures/',
                                  )}
                          </div>
                          <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                            {tr(
                              'Supports .png, .jpg, .jpeg, .pdf, .eps, .svg — filename is sanitized and auto-selected.',
                              '支持 .png / .jpg / .jpeg / .pdf / .eps / .svg，自动清洗文件名并立即选中。',
                            )}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                {uploadError && <div className="alert alert-danger">{uploadError}</div>}

                {/* Width Slider */}
                <div className="field">
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 8,
                    }}
                  >
                    <label className="field-label" htmlFor="lab-fig-width">
                      {figureLayout === 'single'
                        ? tr('Image Width', '图片宽度')
                        : tr('Panel Image Scale (inside each 0.48\\linewidth minipage)', '单侧图宽比例（位于 0.48\\linewidth minipage 内）')}
                    </label>
                    <span
                      className="pill pill-accent"
                      style={{ fontFamily: 'var(--font-mono)' }}
                    >
                      {formatLinewidth(figureWidth)}\linewidth
                    </span>
                  </div>
                  <input
                    id="lab-fig-width"
                    type="range"
                    min={0.4}
                    max={1.0}
                    step={0.05}
                    value={figureWidth}
                    onChange={(e) => setFigureWidth(Number(e.target.value))}
                    style={{ width: '100%', accentColor: 'var(--accent)', cursor: 'pointer' }}
                  />
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      fontSize: 11,
                      fontFamily: 'var(--font-mono)',
                      color: 'var(--text-faint)',
                    }}
                  >
                    <span>0.4\linewidth</span>
                    <span>0.7\linewidth</span>
                    <span>1.0\linewidth</span>
                  </div>
                </div>

                {/* Panel Sub-captions when Side-by-Side */}
                {figureLayout === 'side-by-side' && (
                  <div className="form-grid-2">
                    <div className="field">
                      <label className="field-label" htmlFor="lab-fig-cap-a">
                        {tr('Left Panel (a) Caption', '左图 (a) 说明')}
                      </label>
                      <input
                        id="lab-fig-cap-a"
                        className="input"
                        placeholder={tr('Training loss curve', '例如：训练损失曲线')}
                        value={leftCaption}
                        onChange={(e) => setLeftCaption(e.target.value)}
                      />
                    </div>
                    <div className="field">
                      <label className="field-label" htmlFor="lab-fig-cap-b">
                        {tr('Right Panel (b) Caption', '右图 (b) 说明')}
                      </label>
                      <input
                        id="lab-fig-cap-b"
                        className="input"
                        placeholder={tr('Validation accuracy', '例如：验证集准确率')}
                        value={rightCaption}
                        onChange={(e) => setRightCaption(e.target.value)}
                      />
                    </div>
                  </div>
                )}

                {/* Overall Caption & Label */}
                <div className="form-grid-2">
                  <div className="field" style={{ marginBottom: 0 }}>
                    <label className="field-label" htmlFor="lab-fig-caption">
                      {figureLayout === 'single'
                        ? tr('Caption', '图题（Caption）')
                        : tr('Overall Figure Caption', '总图题（Caption）')}
                    </label>
                    <input
                      id="lab-fig-caption"
                      className="input"
                      placeholder={tr('Experimental results overview.', '例如：实验结果总览。')}
                      value={figureCaption}
                      onChange={(e) => setFigureCaption(e.target.value)}
                    />
                  </div>
                  <div className="field" style={{ marginBottom: 0 }}>
                    <label className="field-label" htmlFor="lab-fig-label">
                      {tr('Label', '交叉引用标签（Label）')}
                    </label>
                    <input
                      id="lab-fig-label"
                      className="input"
                      style={{ fontFamily: 'var(--font-mono)' }}
                      placeholder="fig:result"
                      value={figureLabel}
                      onChange={(e) => setFigureLabel(e.target.value)}
                    />
                  </div>
                </div>
              </div>

              {figureBuild.hasSvgWarning && (
                <div className="alert alert-warning">
                  {tr(
                    'Note: standard \\includegraphics supports .pdf, .png, .jpg, and .eps directly; .svg files require \\usepackage{svg} (with shell-escape) or exporting to PDF/PNG.',
                    '提示：标准 \\includegraphics 原生支持 .pdf / .png / .jpg / .eps；直接插入 .svg 需额外配置 svg 宏包或转为 PDF/PNG。',
                  )}
                </div>
              )}

              {/* Live Preview */}
              <div>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 8,
                    flexWrap: 'wrap',
                    marginBottom: 8,
                  }}
                >
                  <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <span className="field-label">{tr('Live LaTeX Preview', '实时 LaTeX 预览')}</span>
                    <span className="pill">
                      {figureLayout === 'single'
                        ? tr('Single · graphicx', '单图 · graphicx')
                        : tr('2-Panel · minipage (no subcaption required)', '双图并排 · minipage（无需 subcaption）')}
                    </span>
                    {figureBuild.usesPlaceholder && (
                      <span className="pill pill-warning">
                        {tr('Placeholder path', '占位路径')}
                      </span>
                    )}
                  </div>
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={!figureBuild.latex}
                    onClick={() => void handleCopyLatex()}
                  >
                    {copiedFlag ? (
                      <Check size={12} style={{ color: 'var(--success)' }} />
                    ) : (
                      <Copy size={12} />
                    )}
                    {copiedFlag ? tr('Copied', '已复制') : tr('Copy LaTeX', '复制 LaTeX')}
                  </button>
                </div>

                <pre style={previewPreStyle}>{figureBuild.latex}</pre>

                <div
                  className="field-hint"
                  style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8 }}
                >
                  <Info size={12} style={{ flexShrink: 0, color: 'var(--accent)' }} />
                  <span>
                    {figureLayout === 'side-by-side'
                      ? tr(
                          'Uses pure minipage side-by-side layout so it compiles cleanly in any LaTeX template even without \\usepackage{subcaption}.',
                          '采用纯 minipage 并排方案，即使文档未引入 \\usepackage{subcaption} 也能在任意模板下稳定编译。',
                        )
                      : tr(
                          'Uses standard \\usepackage{graphicx}; reference this figure in prose via \\ref{' +
                            (figureLabel.trim() || 'fig:result') +
                            '}.',
                          '基于标准 \\usepackage{graphicx}，正文可用 \\ref{' +
                            (figureLabel.trim() || 'fig:result') +
                            '} 引用此图。',
                        )}
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="modal-footer" style={{ justifyContent: 'space-between' }}>
          <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
            {readOnly
              ? tr('Read-only session · Copy LaTeX is available', '只读会话 · 可一键复制 LaTeX 代码')
              : tr(
                  'Tip: press Esc or Close to exit without inserting.',
                  '提示：按 Esc 或点击关闭可取消，点击背景不会误关。',
                )}
          </span>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <button
              type="button"
              className="btn"
              disabled={uploading}
              onClick={onClose}
            >
              {tr('Close', '关闭')}
            </button>
            <button
              type="button"
              className="btn"
              disabled={!activeLatex}
              onClick={() => void handleCopyLatex()}
            >
              {copiedFlag ? (
                <Check size={14} style={{ color: 'var(--success)' }} />
              ) : (
                <Copy size={14} />
              )}
              {copiedFlag ? tr('Copied', '已复制') : tr('Copy LaTeX', '复制 LaTeX')}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={readOnly || !activeLatex || uploading}
              title={
                readOnly
                  ? tr('Edit permission required to insert into editor', '需要编辑权限才能插入到编辑器')
                  : undefined
              }
              onClick={handleInsert}
            >
              <CornerDownLeft size={14} />
              {tr('Insert at Cursor', '插入到光标处')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
