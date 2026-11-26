import React, { useEffect, useRef, useState } from 'react';
import { basicSetup, EditorView } from 'codemirror';
import {
  Compartment,
  EditorState,
  Prec,
  StateEffect,
  StateField,
  type Extension,
} from '@codemirror/state';
import { Decoration, type DecorationSet, keymap } from '@codemirror/view';
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import { markdown } from '@codemirror/lang-markdown';
import { oneDark } from '@codemirror/theme-one-dark';
import {
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete';
import { lintGutter, setDiagnostics, type Diagnostic as CmDiagnostic } from '@codemirror/lint';
import * as Y from 'yjs';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
import type {
  CompileDiagnostic,
  ProjectFileEntry,
  UserPublic,
} from '@novatex/shared';
import { computeMinimalTextSplice } from '../utils/diff.ts';
import {
  BookOpen,
  Crosshair,
  Download,
  FileCode2,
  FileImage,
  FileText,
  Loader2,
  Lock,
  MessageSquarePlus,
  Sigma,
  Table2,
} from 'lucide-react';
import { api, downloadBase64File, type BibKeysResponse } from '../api.ts';
import { useLocale, type UiLocale } from '../i18n.ts';

const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff]/;

export interface PresenceUser {
  clientId: number;
  userId?: string;
  name: string;
  color: string;
  file?: string;
}

export interface EditorHandle {
  getValue: () => string;
  isSynced: () => boolean;
  applyPatchedText: (newText: string) => boolean;
  insertAtCursor: (text: string) => boolean;
  jumpToLine: (line: number) => void;
}

interface EditorPaneProps {
  projectId: string;
  filePath: string | null;
  fileEntry: ProjectFileEntry | null;
  user: UserPublic;
  theme: 'light' | 'dark';
  readOnly: boolean;
  canComment: boolean;
  collaborationEnabled?: boolean;
  diagnostics: CompileDiagnostic[];
  bibData: BibKeysResponse;
  jumpRequest: { file: string; line: number; nonce: number } | null;
  editorHandleRef: React.MutableRefObject<EditorHandle | null>;
  onCompileShortcut: () => void;
  onCursorChange: (
    line: number,
    lineText: string,
    selection: { startLine: number; endLine: number } | null,
  ) => void;
  onPresenceChange: (users: PresenceUser[]) => void;
  onForwardSync: (file: string, line: number) => void;
  onAiFormat: (
    mode: 'format-table' | 'format-math',
    sourceCode: string,
    selectionRange?: { startLine: number; endLine: number },
  ) => void;
  onOpenCommentAtLine: (line: number, quote: string) => void;
}

// Harmonious Linear-inspired editorial light syntax theme for LaTeX & Markdown
const overleafLightHighlight = HighlightStyle.define([
  { tag: tags.tagName, color: '#1E40AF', fontWeight: '500' },
  { tag: tags.atom, color: '#0F7B4C', fontWeight: '500' },
  { tag: tags.keyword, color: '#9A3412', fontWeight: '500' },
  { tag: [tags.operator, tags.special(tags.variableName)], color: '#B45309' },
  { tag: [tags.string, tags.number], color: '#0F766E' },
  { tag: tags.comment, color: '#8B95A5', fontStyle: 'italic' },
  { tag: tags.bracket, color: '#64748B' },
  { tag: [tags.variableName, tags.standard(tags.variableName)], color: '#5B21B6' },
  { tag: tags.heading, color: '#0F172A', fontWeight: '700' },
  { tag: tags.strong, fontWeight: '700' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.link, color: '#1E40AF', textDecoration: 'underline' },
]);

const getEditorThemeExtension = (theme: 'light' | 'dark'): Extension =>
  theme === 'dark' ? oneDark : syntaxHighlighting(overleafLightHighlight);

// Line decoration effects for diagnostics & jump flash
const setDiagLinesEffect = StateEffect.define<Array<{ line: number; severity: 'error' | 'warning' }>>();
const flashLineEffect = StateEffect.define<number | null>();

const diagLineDecoField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(decos, tr) {
    let next = decos.map(tr.changes);
    for (const eff of tr.effects) {
      if (eff.is(setDiagLinesEffect)) {
        const marks: Array<{ from: number; deco: Decoration }> = [];
        const doc = tr.state.doc;
        for (const item of eff.value) {
          if (item.line >= 1 && item.line <= doc.lines) {
            const lineInfo = doc.line(item.line);
            const cls =
              item.severity === 'error' ? 'cm-novatex-error-line' : 'cm-novatex-warning-line';
            marks.push({ from: lineInfo.from, deco: Decoration.line({ class: cls }) });
          }
        }
        marks.sort((a, b) => a.from - b.from);
        next = Decoration.set(marks.map((m) => m.deco.range(m.from)));
      }
    }
    return next;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const flashLineDecoField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(decos, tr) {
    let next = decos.map(tr.changes);
    for (const eff of tr.effects) {
      if (eff.is(flashLineEffect)) {
        if (eff.value === null) {
          next = Decoration.none;
        } else if (eff.value >= 1 && eff.value <= tr.state.doc.lines) {
          const lineInfo = tr.state.doc.line(eff.value);
          next = Decoration.set([
            Decoration.line({ class: 'cm-novatex-flash-line' }).range(lineInfo.from),
          ]);
        }
      }
    }
    return next;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const LATEX_ENVS: Array<{ label: string; detailEn: string; detailZh: string }> = [
  { label: 'equation', detailEn: 'Numbered equation', detailZh: '编号公式环境' },
  { label: 'align', detailEn: 'Multi-line aligned math', detailZh: '多行对齐公式' },
  { label: 'figure', detailEn: 'Floating figure', detailZh: '浮动插图环境' },
  { label: 'table', detailEn: 'Floating table', detailZh: '浮动表格环境' },
  { label: 'tabular', detailEn: 'Table / booktabs body', detailZh: '三线表/表格内容' },
  { label: 'itemize', detailEn: 'Bulleted list', detailZh: '无序列表' },
  { label: 'enumerate', detailEn: 'Numbered list', detailZh: '有序列表' },
  { label: 'abstract', detailEn: 'Paper abstract', detailZh: '论文摘要' },
  { label: 'theorem', detailEn: 'Theorem environment', detailZh: '定理环境' },
  { label: 'proof', detailEn: 'Proof environment', detailZh: '证明环境' },
  { label: 'algorithm', detailEn: 'Algorithm pseudocode', detailZh: '算法伪代码' },
  { label: 'bmatrix', detailEn: 'Bracketed matrix', detailZh: '方括号矩阵' },
  { label: 'cases', detailEn: 'Piecewise function', detailZh: '分段函数' },
  { label: 'subcaptionblock', detailEn: 'Subfigure block', detailZh: '子图块' },
];

interface BilingualMacro {
  label: string;
  apply?: string;
  detailEn: string;
  detailZh: string;
  type: string;
}

const LATEX_MACROS: BilingualMacro[] = [
  { label: '\\section{}', apply: '\\section{}', detailEn: 'Section heading', detailZh: '一级章节', type: 'keyword' },
  { label: '\\subsection{}', apply: '\\subsection{}', detailEn: 'Subsection heading', detailZh: '二级小节', type: 'keyword' },
  { label: '\\subsubsection{}', apply: '\\subsubsection{}', detailEn: 'Subsubsection heading', detailZh: '三级小节', type: 'keyword' },
  { label: '\\paragraph{}', apply: '\\paragraph{}', detailEn: 'Paragraph heading', detailZh: '段落标题', type: 'keyword' },
  { label: '\\begin{}', apply: '\\begin{equation}\n  \n\\end{equation}', detailEn: 'Begin environment', detailZh: '新建环境', type: 'keyword' },
  { label: '\\cite{}', apply: '\\cite{}', detailEn: 'Cite reference', detailZh: '引用文献', type: 'function' },
  { label: '\\ref{}', apply: '\\ref{}', detailEn: 'Cross-reference', detailZh: '交叉引用', type: 'function' },
  { label: '\\eqref{}', apply: '\\eqref{}', detailEn: 'Equation reference', detailZh: '公式引用', type: 'function' },
  { label: '\\label{}', apply: '\\label{}', detailEn: 'Define label', detailZh: '定义标签', type: 'function' },
  { label: '\\includegraphics', apply: '\\includegraphics[width=0.85\\linewidth]{}', detailEn: 'Insert image', detailZh: '插入图片', type: 'function' },
  { label: '\\caption{}', apply: '\\caption{}', detailEn: 'Figure/table caption', detailZh: '图表标题', type: 'function' },
  { label: '\\textbf{}', apply: '\\textbf{}', detailEn: 'Bold text', detailZh: '加粗文本', type: 'function' },
  { label: '\\textit{}', apply: '\\textit{}', detailEn: 'Italic text', detailZh: '斜体文本', type: 'function' },
  { label: '\\emph{}', apply: '\\emph{}', detailEn: 'Emphasized text', detailZh: '强调文本', type: 'function' },
  { label: '\\frac{}{}', apply: '\\frac{}{}', detailEn: 'Fraction', detailZh: '分式', type: 'function' },
  { label: '\\sum_{}^{}', apply: '\\sum_{i=1}^{n}', detailEn: 'Summation', detailZh: '求和', type: 'function' },
  { label: '\\int_{}^{}', apply: '\\int_{0}^{\\infty}', detailEn: 'Integral', detailZh: '积分', type: 'function' },
  { label: '\\mathbb{}', apply: '\\mathbb{R}', detailEn: 'Blackboard bold', detailZh: '黑板粗体', type: 'function' },
  { label: '\\mathcal{}', apply: '\\mathcal{L}', detailEn: 'Calligraphic letter', detailZh: '花体字母', type: 'function' },
  { label: '\\mathrm{}', apply: '\\mathrm{}', detailEn: 'Upright math text', detailZh: '正体数学字符', type: 'function' },
  { label: '\\toprule', apply: '\\toprule', detailEn: 'Top rule (booktabs)', detailZh: '三线表顶线 (booktabs)', type: 'keyword' },
  { label: '\\midrule', apply: '\\midrule', detailEn: 'Mid rule (booktabs)', detailZh: '三线表中线 (booktabs)', type: 'keyword' },
  { label: '\\bottomrule', apply: '\\bottomrule', detailEn: 'Bottom rule (booktabs)', detailZh: '三线表底线 (booktabs)', type: 'keyword' },
  { label: '\\multicolumn{}{}{}', apply: '\\multicolumn{2}{c}{}', detailEn: 'Span columns', detailZh: '跨列合并', type: 'function' },
  { label: '\\usepackage{}', apply: '\\usepackage{}', detailEn: 'Load package', detailZh: '导入宏包', type: 'keyword' },
  { label: '\\input{}', apply: '\\input{}', detailEn: 'Include sub-file', detailZh: '引入子文件', type: 'keyword' },
  { label: '\\footnote{}', apply: '\\footnote{}', detailEn: 'Footnote', detailZh: '脚注', type: 'function' },
  { label: '\\alpha', detailEn: 'α', detailZh: 'α', type: 'constant' },
  { label: '\\beta', detailEn: 'β', detailZh: 'β', type: 'constant' },
  { label: '\\gamma', detailEn: 'γ', detailZh: 'γ', type: 'constant' },
  { label: '\\theta', detailEn: 'θ', detailZh: 'θ', type: 'constant' },
  { label: '\\lambda', detailEn: 'λ', detailZh: 'λ', type: 'constant' },
  { label: '\\sigma', detailEn: 'σ', detailZh: 'σ', type: 'constant' },
  { label: '\\omega', detailEn: 'ω', detailZh: 'ω', type: 'constant' },
];

function formatLintMessage(d: CompileDiagnostic, locale: UiLocale): string {
  if (locale === 'zh') {
    return `${d.titleZh}\n${d.explanationZh}`;
  }
  const raw = (d.rawMessage ?? '').trim();
  if (raw && !CJK_RE.test(raw)) {
    return raw;
  }
  return d.severity === 'warning'
    ? `LaTeX warning (${d.code})`
    : `LaTeX compile error (${d.code})`;
}

function getLanguageExtension(filePath: string): Extension {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) {
    return markdown();
  }
  if (
    lower.endsWith('.tex') ||
    lower.endsWith('.sty') ||
    lower.endsWith('.cls') ||
    lower.endsWith('.bib') ||
    lower.endsWith('.ltx')
  ) {
    return StreamLanguage.define(stex);
  }
  return [];
}

function isImagePath(filePath: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(filePath);
}

function getFileModeLabel(
  filePath: string | null,
  isBinary: boolean,
  tr: (en: string, zh: string) => string,
): string {
  if (!filePath) return tr('No file', '未打开');
  if (isBinary) {
    const ext = filePath.split('.').pop()?.toUpperCase();
    return ext ? tr(`${ext} Asset`, `${ext} 资源`) : tr('Binary Asset', '二进制资源');
  }
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.bib')) return 'BibTeX';
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'Markdown';
  if (
    lower.endsWith('.tex') ||
    lower.endsWith('.ltx') ||
    lower.endsWith('.sty') ||
    lower.endsWith('.cls')
  ) {
    return 'LaTeX';
  }
  return 'Plain Text';
}

function renderFileIcon(filePath: string | null, isBinary: boolean): React.ReactNode {
  if (!filePath) {
    return <FileCode2 size={14} style={{ flexShrink: 0, color: 'var(--text-faint)' }} />;
  }
  if (isBinary) {
    return <FileImage size={14} style={{ flexShrink: 0, color: 'var(--text-muted)' }} />;
  }
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.bib')) {
    return <BookOpen size={14} style={{ flexShrink: 0, color: '#4F46E5' }} />;
  }
  if (lower.endsWith('.md') || lower.endsWith('.markdown') || lower.endsWith('.txt')) {
    return <FileText size={14} style={{ flexShrink: 0, color: '#B45309' }} />;
  }
  if (lower.endsWith('.tex') || lower.endsWith('.ltx')) {
    return <FileCode2 size={14} style={{ flexShrink: 0, color: '#0F7B4C' }} />;
  }
  if (lower.endsWith('.sty') || lower.endsWith('.cls')) {
    return <FileCode2 size={14} style={{ flexShrink: 0, color: 'var(--text-muted)' }} />;
  }
  return <FileCode2 size={14} style={{ flexShrink: 0, color: 'var(--text-muted)' }} />;
}

function normalizePathMatch(a: string, b: string): boolean {
  const clean = (s: string) => s.replace(/\\/g, '/').replace(/^\.\//, '');
  const ca = clean(a);
  const cb = clean(b);
  return ca === cb || ca.endsWith(`/${cb}`) || cb.endsWith(`/${ca}`);
}

export const EditorPane: React.FC<EditorPaneProps> = ({
  projectId,
  filePath,
  fileEntry,
  user,
  theme,
  readOnly,
  canComment,
  collaborationEnabled = false,
  diagnostics,
  bibData,
  jumpRequest,
  editorHandleRef,
  onCompileShortcut,
  onCursorChange,
  onPresenceChange,
  onForwardSync,
  onAiFormat,
  onOpenCommentAtLine,
}) => {
  const { locale, tr } = useLocale();
  const localeRef = useRef<UiLocale>(locale);
  localeRef.current = locale;
  const trRef = useRef(tr);
  trRef.current = tr;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const ydocRef = useRef<Y.Doc | null>(null);
  const ytextRef = useRef<Y.Text | null>(null);
  const providerRef = useRef<HocuspocusProvider | null>(null);

  const themeCompRef = useRef(new Compartment());
  const readOnlyCompRef = useRef(new Compartment());
  const langCompRef = useRef(new Compartment());

  // Latest callbacks in refs to avoid tearing down Yjs connection on prop re-renders
  const bibDataRef = useRef(bibData);
  bibDataRef.current = bibData;
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  const onCompileRef = useRef(onCompileShortcut);
  onCompileRef.current = onCompileShortcut;
  const onCursorRef = useRef(onCursorChange);
  onCursorRef.current = onCursorChange;
  const onPresenceRef = useRef(onPresenceChange);
  onPresenceRef.current = onPresenceChange;

  const [syncState, setSyncState] = useState<'synced' | 'connecting' | 'offline'>('connecting');
  const [hasSyncedOnce, setHasSyncedOnce] = useState(false);
  const hasSyncedOnceRef = useRef(false);
  hasSyncedOnceRef.current = hasSyncedOnce;
  const [restPreviewText, setRestPreviewText] = useState<string | null>(null);
  const [cursorLine, setCursorLine] = useState(1);
  const [cursorCol, setCursorCol] = useState(1);
  const [cursorLineText, setCursorLineText] = useState('');
  const [selectionRange, setSelectionRange] = useState<{ startLine: number; endLine: number } | null>(
    null,
  );
  const [binaryPreview, setBinaryPreview] = useState<{
    base64: string;
    size: number;
    mime: string;
  } | null>(null);
  const [binaryError, setBinaryError] = useState<string | null>(null);

  const isBinary = Boolean(fileEntry?.isBinary || (filePath && isImagePath(filePath)));

  // Binary file loader
  useEffect(() => {
    if (!filePath || !isBinary) {
      setBinaryPreview(null);
      setBinaryError(null);
      return;
    }
    let cancelled = false;
    setBinaryPreview(null);
    setBinaryError(null);
    api
      .readFile(projectId, filePath)
      .then((res) => {
        if (cancelled) return;
        const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
        const mimeMap: Record<string, string> = {
          png: 'image/png',
          jpg: 'image/jpeg',
          jpeg: 'image/jpeg',
          gif: 'image/gif',
          webp: 'image/webp',
          svg: 'image/svg+xml',
          pdf: 'application/pdf',
        };
        setBinaryPreview({
          base64: res.base64 ?? '',
          size: res.size,
          mime: mimeMap[ext] ?? 'application/octet-stream',
        });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setBinaryError(
            err instanceof Error
              ? err.message
              : trRef.current('Failed to load binary file', '加载二进制文件失败'),
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, filePath, isBinary]);

  // CodeMirror 6 + Yjs HocuspocusProvider lifecycle
  useEffect(() => {
    if (!filePath || isBinary || !containerRef.current) {
      editorHandleRef.current = null;
      return;
    }

    let disposed = false;
    let flashTimer: number | null = null;
    let previewTimer: number | null = null;

    setSyncState('connecting');
    hasSyncedOnceRef.current = false;
    setHasSyncedOnce(false);
    setRestPreviewText(null);
    setCursorLine(1);
    setCursorCol(1);
    setCursorLineText('');
    setSelectionRange(null);

    const ydoc = new Y.Doc();
    const ytext = ydoc.getText('content');
    const undoManager = new Y.UndoManager(ytext);
    ydocRef.current = ydoc;
    ytextRef.current = ytext;

    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsProtocol}//${window.location.host}/collab`;
    const docName = `${projectId}::${filePath}`;

    const provider = new HocuspocusProvider({
      url: wsUrl,
      name: docName,
      document: ydoc,
      token: async () => {
        try {
          const res = await api.getCollabToken();
          return res.token;
        } catch {
          return '';
        }
      },
      onStatus: ({ status }) => {
        if (disposed) return;
        if (status === 'connected') {
          setSyncState((prev) => (prev === 'synced' ? 'synced' : 'connecting'));
        } else if (status === 'connecting') {
          setSyncState('connecting');
        } else {
          setSyncState('offline');
        }
      },
      onSynced: ({ state }) => {
        if (disposed) return;
        if (state) {
          setSyncState('synced');
          hasSyncedOnceRef.current = true;
          setHasSyncedOnce(true);
          setRestPreviewText(null);
          if (previewTimer !== null) {
            window.clearTimeout(previewTimer);
            previewTimer = null;
          }
        }
      },
      onAwarenessChange: ({ states }) => {
        if (disposed) return;
        const users: PresenceUser[] = [];
        for (const s of states) {
          const u = s.user as
            | { name?: string; color?: string; userId?: string; file?: string }
            | undefined;
          if (u?.name) {
            users.push({
              clientId: s.clientId,
              userId: u.userId,
              name: u.name,
              color: u.color ?? '#2563eb',
              file: u.file,
            });
          }
        }
        onPresenceRef.current(users);
      },
    });

    provider.setAwarenessField('user', {
      userId: user.id,
      name: user.displayName || user.username,
      color: user.color || '#2563eb',
      colorLight: `${user.color || '#2563eb'}33`,
      file: filePath,
    });
    providerRef.current = provider;

    // Non-destructive read-only REST preview on slow links — NEVER insert into live connecting Y.Doc!
    previewTimer = window.setTimeout(async () => {
      if (disposed || provider.isSynced) return;
      try {
        const res = await api.readFile(projectId, filePath);
        if (!disposed && !provider.isSynced && typeof res.content === 'string') {
          setRestPreviewText(res.content);
        }
      } catch {
        // ignore read-only preview fetch error
      }
    }, 2200);

    const latexCompletionSource = (context: CompletionContext): CompletionResult | null => {
      const isZh = localeRef.current === 'zh';

      // 1. \cite{...} / \citep{...} / \citet{...} / \autocite{...}
      const citeMatch = context.matchBefore(/\\(?:auto|foot|text|super)?cite[pt*]?\{[^}]*$/);
      if (citeMatch) {
        const braceIdx = citeMatch.text.lastIndexOf('{');
        const commaIdx = citeMatch.text.lastIndexOf(',');
        const startOffset = Math.max(braceIdx, commaIdx) + 1;
        const from = citeMatch.from + startOffset;
        const options: Completion[] = bibDataRef.current.citeKeys.map((entry) => ({
          label: entry.key,
          type: 'variable',
          detail: [entry.author, entry.year].filter(Boolean).join(' · ') || 'BibTeX',
          info: entry.title,
        }));
        return { from, options, validFor: /^[^,}]*$/ };
      }

      // 2. \ref{...} / \eqref{...} / \autoref{...} / \cref{...}
      const refMatch = context.matchBefore(/\\(?:eq|page|auto|c|C)?ref\{[^}]*$/);
      if (refMatch) {
        const braceIdx = refMatch.text.lastIndexOf('{');
        const from = refMatch.from + braceIdx + 1;
        const options: Completion[] = bibDataRef.current.labels.map((item) => ({
          label: item.label,
          type: 'property',
          detail: item.file ? `${item.file}:${item.line ?? ''}` : 'Label',
        }));
        return { from, options, validFor: /^[^}]*$/ };
      }

      // 3. \begin{...}
      const beginMatch = context.matchBefore(/\\begin\{[a-zA-Z*]*$/);
      if (beginMatch) {
        const braceIdx = beginMatch.text.lastIndexOf('{');
        const from = beginMatch.from + braceIdx + 1;
        const options: Completion[] = LATEX_ENVS.map((env) => ({
          label: env.label,
          detail: isZh ? env.detailZh : env.detailEn,
          type: 'keyword',
          apply: `${env.label}}\n  \n\\end{${env.label}}`,
        }));
        return { from, options, validFor: /^[a-zA-Z*]*$/ };
      }

      // 4. General LaTeX macros starting with backslash
      const cmdMatch = context.matchBefore(/\\[a-zA-Z]+$/);
      if (cmdMatch) {
        const options: Completion[] = LATEX_MACROS.map((m) => ({
          label: m.label,
          apply: m.apply,
          detail: isZh ? m.detailZh : m.detailEn,
          type: m.type,
        }));
        return {
          from: cmdMatch.from,
          options,
          validFor: /^\\[a-zA-Z]*$/,
        };
      }
      return null;
    };

    const handleSaveAndCompile = (): boolean => {
      if (readOnlyRef.current || !provider.isSynced) {
        return true;
      }
      onCompileRef.current();
      return true;
    };

    const state = EditorState.create({
      doc: ytext.toString(),
      extensions: [
        Prec.high(
          keymap.of([
            ...yUndoManagerKeymap,
            { key: 'Mod-s', run: handleSaveAndCompile },
            { key: 'Mod-Enter', run: handleSaveAndCompile },
          ]),
        ),
        basicSetup,
        EditorView.lineWrapping,
        lintGutter(),
        diagLineDecoField,
        flashLineDecoField,
        yCollab(ytext, provider.awareness, { undoManager }),
        langCompRef.current.of(getLanguageExtension(filePath)),
        themeCompRef.current.of(getEditorThemeExtension(theme)),
        readOnlyCompRef.current.of([
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
        ]),
        EditorState.languageData.of(() => [{ autocomplete: latexCompletionSource }]),
        EditorView.updateListener.of((update) => {
          if (update.selectionSet || update.docChanged) {
            const sel = update.state.selection.main;
            const headLine = update.state.doc.lineAt(sel.head);
            const nextCol = sel.head - headLine.from + 1;
            const nextRange =
              sel.from !== sel.to
                ? {
                    startLine: update.state.doc.lineAt(sel.from).number,
                    endLine: update.state.doc.lineAt(sel.to).number,
                  }
                : null;
            setCursorLine(headLine.number);
            setCursorCol(nextCol);
            setCursorLineText(headLine.text);
            setSelectionRange(nextRange);
            onCursorRef.current(headLine.number, headLine.text, nextRange);
          }
        }),
      ],
    });

    const view = new EditorView({
      state,
      parent: containerRef.current,
    });
    viewRef.current = view;

    const triggerJumpToLine = (line: number) => {
      const doc = view.state.doc;
      const clamped = Math.max(1, Math.min(line, doc.lines));
      const lineInfo = doc.line(clamped);
      view.dispatch({
        selection: { anchor: lineInfo.from },
        effects: [
          EditorView.scrollIntoView(lineInfo.from, { y: 'center' }),
          flashLineEffect.of(clamped),
        ],
      });
      view.focus();
      if (flashTimer !== null) window.clearTimeout(flashTimer);
      flashTimer = window.setTimeout(() => {
        if (!disposed && viewRef.current === view) {
          view.dispatch({ effects: flashLineEffect.of(null) });
        }
      }, 1700);
    };

    editorHandleRef.current = {
      getValue: () => ytext.toString(),
      isSynced: () => Boolean(provider.isSynced),
      applyPatchedText: (newText: string) => {
        if (!provider.isSynced) return false;
        const current = ytext.toString();
        const splice = computeMinimalTextSplice(current, newText);
        if (!splice) return true;
        ydoc.transact(() => {
          if (splice.deleteCount > 0) {
            ytext.delete(splice.index, splice.deleteCount);
          }
          if (splice.insertText.length > 0) {
            ytext.insert(splice.index, splice.insertText);
          }
        });
        return true;
      },
      insertAtCursor: (text: string) => {
        const currentView = viewRef.current;
        if (!currentView || readOnlyRef.current || !hasSyncedOnceRef.current) {
          return false;
        }
        const { from, to } = currentView.state.selection.main;
        currentView.dispatch({
          changes: { from, to, insert: text },
          selection: { anchor: from + text.length },
        });
        currentView.focus();
        return true;
      },
      jumpToLine: triggerJumpToLine,
    };

    return () => {
      disposed = true;
      hasSyncedOnceRef.current = false;
      if (flashTimer !== null) window.clearTimeout(flashTimer);
      if (previewTimer !== null) window.clearTimeout(previewTimer);
      editorHandleRef.current = null;
      view.destroy();
      viewRef.current = null;
      provider.destroy();
      providerRef.current = null;
      ydoc.destroy();
      ydocRef.current = null;
      ytextRef.current = null;
    };
  }, [projectId, filePath, isBinary, user.id, user.displayName, user.username, user.color]);

  // Reactive theme compartment update
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: themeCompRef.current.reconfigure(getEditorThemeExtension(theme)),
    });
  }, [theme]);

  // Reactive readOnly compartment update (locks editor until initial Yjs sync completes)
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const effectiveReadOnly = readOnly || !hasSyncedOnce;
    view.dispatch({
      effects: readOnlyCompRef.current.reconfigure([
        EditorState.readOnly.of(effectiveReadOnly),
        EditorView.editable.of(!effectiveReadOnly),
      ]),
    });
  }, [readOnly, hasSyncedOnce]);

  // Sync diagnostics into CodeMirror lint gutter + tinted line decorations
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !filePath) return;

    const relevant = diagnostics.filter(
      (d) => !d.file || normalizePathMatch(d.file, filePath),
    );

    const cmDiags: CmDiagnostic[] = [];
    const lineHighlights: Array<{ line: number; severity: 'error' | 'warning' }> = [];
    const doc = view.state.doc;

    for (const d of relevant) {
      if (d.line < 1 || d.line > doc.lines) continue;
      const lineInfo = doc.line(d.line);
      cmDiags.push({
        from: lineInfo.from,
        to: lineInfo.to,
        severity: d.severity === 'error' ? 'error' : d.severity === 'warning' ? 'warning' : 'info',
        message: formatLintMessage(d, locale),
      });
      if (d.severity === 'error' || d.severity === 'warning') {
        lineHighlights.push({ line: d.line, severity: d.severity });
      }
    }

    view.dispatch(
      setDiagnostics(view.state, cmDiags),
      { effects: setDiagLinesEffect.of(lineHighlights) },
    );
  }, [diagnostics, filePath, locale]);

  // Handle jump-to-line requests
  useEffect(() => {
    if (!jumpRequest || !filePath) return;
    if (!normalizePathMatch(jumpRequest.file, filePath)) return;
    const handle = editorHandleRef.current;
    if (handle) {
      // Slight defer to ensure newly switched doc has hydrated
      const t = window.setTimeout(() => handle.jumpToLine(jumpRequest.line), 60);
      return () => window.clearTimeout(t);
    }
  }, [jumpRequest, filePath, syncState]);

  const hasSelection = selectionRange !== null;

  const handleQuickAi = (mode: 'format-table' | 'format-math') => {
    const code = editorHandleRef.current?.getValue() ?? '';
    onAiFormat(mode, code, selectionRange ?? undefined);
  };

  const syncLabel =
    syncState === 'synced'
      ? tr('Synced', '已同步')
      : syncState === 'connecting'
        ? tr('Syncing…', '同步中…')
        : tr('Offline', '离线');
  const modeLabel = getFileModeLabel(filePath, isBinary, tr);
  const normalizedParts = filePath ? filePath.replace(/\\/g, '/').split('/').filter(Boolean) : [];
  const fileName = normalizedParts.length > 0 ? normalizedParts[normalizedParts.length - 1] : null;
  const folderPrefix = normalizedParts.length > 1 ? normalizedParts.slice(0, -1).join(' / ') : '';

  return (
    <section className="editor-pane">
      <div className="pane-subheader">
        <div className="breadcrumb" title={filePath ?? ''}>
          {renderFileIcon(filePath, isBinary)}
          {fileName ? (
            <span
              className="breadcrumb-path"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                minWidth: 0,
                overflow: 'hidden',
              }}
            >
              {folderPrefix && (
                <span
                  className="breadcrumb-dir"
                  style={{
                    color: 'var(--text-muted)',
                    fontWeight: 400,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    minWidth: 0,
                    flexShrink: 2,
                  }}
                >
                  {folderPrefix}
                  <span
                    className="breadcrumb-sep"
                    aria-hidden="true"
                    style={{ margin: '0 5px', color: 'var(--text-faint)' }}
                  >
                    /
                  </span>
                </span>
              )}
              <span
                className="breadcrumb-name"
                style={{
                  color: 'var(--text-primary)',
                  fontWeight: 600,
                  minWidth: 0,
                  flexShrink: 1,
                }}
              >
                {fileName}
              </span>
            </span>
          ) : (
            <span className="breadcrumb-name" style={{ color: 'var(--text-faint)', fontWeight: 400 }}>
              {tr('No file selected', '未打开文件')}
            </span>
          )}
        </div>

        {filePath && !isBinary && (
          <div className="pane-toolbar-actions">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              title={tr(
                'Jump to PDF location (Forward SyncTeX)',
                '正向定位到 PDF（Forward SyncTeX）',
              )}
              onClick={() => onForwardSync(filePath, cursorLine)}
            >
              <Crosshair size={13} />
              {tr('Locate PDF', '定位 PDF')}
            </button>
            {!readOnly && (
              <>
                <span
                  aria-hidden="true"
                  style={{
                    width: 1,
                    height: 14,
                    background: 'var(--border)',
                    margin: '0 2px',
                    flexShrink: 0,
                  }}
                />
                <button
                  type="button"
                  className={`btn btn-ghost btn-sm${hasSelection ? ' active' : ''}`}
                  disabled={!hasSyncedOnce}
                  title={
                    selectionRange
                      ? tr(
                          `Fix tables in selected lines ${selectionRange.startLine}–${selectionRange.endLine} using latest compile diagnostics as a diff`,
                          `仅修复当前选中的第 ${selectionRange.startLine}–${selectionRange.endLine} 行表格，结合最新编译报错给出红绿 Diff`,
                        )
                      : tr(
                          'Scan and fix all tables in this file with compile diagnostics as a diff',
                          '无需手动选中——自动扫描当前文件全部表格，并结合编译报错定位修复，给出红绿 Diff 确认',
                        )
                  }
                  onClick={() => handleQuickAi('format-table')}
                >
                  <Table2 size={13} />
                  {hasSelection
                    ? tr('Fix Selected Table', '修选中表格')
                    : tr('Fix Tables', '全篇修表格')}
                </button>
                <button
                  type="button"
                  className={`btn btn-ghost btn-sm${hasSelection ? ' active' : ''}`}
                  disabled={!hasSyncedOnce}
                  title={
                    selectionRange
                      ? tr(
                          `Fix math in selected lines ${selectionRange.startLine}–${selectionRange.endLine} using latest compile diagnostics as a diff`,
                          `仅修复当前选中的第 ${selectionRange.startLine}–${selectionRange.endLine} 行公式，结合最新编译报错给出红绿 Diff`,
                        )
                      : tr(
                          'Scan and fix all math equations in this file with compile diagnostics as a diff',
                          '无需手动选中——自动扫描当前文件全部公式，并结合编译报错定位修复，给出红绿 Diff 确认',
                        )
                  }
                  onClick={() => handleQuickAi('format-math')}
                >
                  <Sigma size={13} />
                  {hasSelection
                    ? tr('Fix Selected Math', '修选中公式')
                    : tr('Fix Math', '全篇修公式')}
                </button>
              </>
            )}
            {collaborationEnabled && canComment && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                style={{ width: 26, padding: 0 }}
                title={tr('Add comment at current line', '在当前行添加批注')}
                aria-label={tr('Add comment', '添加批注')}
                onClick={() => onOpenCommentAtLine(cursorLine, cursorLineText.trim())}
              >
                <MessageSquarePlus size={14} />
              </button>
            )}
          </div>
        )}
      </div>

      <div className="editor-host">
        {!filePath ? (
          <div className="editor-binary-preview">
            <div
              style={{
                width: 52,
                height: 52,
                borderRadius: 14,
                background: 'var(--bg-subtle)',
                border: '1px solid var(--border)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--accent)',
                boxShadow: 'var(--shadow-sm)',
              }}
            >
              <FileCode2 size={24} strokeWidth={1.6} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5, alignItems: 'center' }}>
              <div style={{ fontSize: 14.5, fontWeight: 600, color: 'var(--text-primary)' }}>
                {tr('No file selected', '未打开文件')}
              </div>
              <div
                style={{
                  fontSize: 12.5,
                  color: 'var(--text-muted)',
                  maxWidth: 320,
                  lineHeight: 1.6,
                }}
              >
                {locale === 'en' ? (
                  <>
                    Select a{' '}
                    <code
                      style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 11.5,
                        padding: '1px 5px',
                        borderRadius: 4,
                        background: 'var(--bg-subtle)',
                        border: '1px solid var(--border)',
                        color: 'var(--text-secondary)',
                      }}
                    >
                      .tex
                    </code>
                    ,{' '}
                    <code
                      style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 11.5,
                        padding: '1px 5px',
                        borderRadius: 4,
                        background: 'var(--bg-subtle)',
                        border: '1px solid var(--border)',
                        color: 'var(--text-secondary)',
                      }}
                    >
                      .bib
                    </code>
                    , or{' '}
                    <code
                      style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 11.5,
                        padding: '1px 5px',
                        borderRadius: 4,
                        background: 'var(--bg-subtle)',
                        border: '1px solid var(--border)',
                        color: 'var(--text-secondary)',
                      }}
                    >
                      .md
                    </code>{' '}
                    file from the sidebar to start editing
                  </>
                ) : (
                  <>
                    从左侧文件树选择{' '}
                    <code
                      style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 11.5,
                        padding: '1px 5px',
                        borderRadius: 4,
                        background: 'var(--bg-subtle)',
                        border: '1px solid var(--border)',
                        color: 'var(--text-secondary)',
                      }}
                    >
                      .tex
                    </code>
                    、
                    <code
                      style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 11.5,
                        padding: '1px 5px',
                        borderRadius: 4,
                        background: 'var(--bg-subtle)',
                        border: '1px solid var(--border)',
                        color: 'var(--text-secondary)',
                      }}
                    >
                      .bib
                    </code>{' '}
                    或{' '}
                    <code
                      style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 11.5,
                        padding: '1px 5px',
                        borderRadius: 4,
                        background: 'var(--bg-subtle)',
                        border: '1px solid var(--border)',
                        color: 'var(--text-secondary)',
                      }}
                    >
                      .md
                    </code>{' '}
                    {collaborationEnabled ? '文件开始协同编写' : '文件开始编写'}
                  </>
                )}
              </div>
            </div>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 14,
                flexWrap: 'wrap',
                marginTop: 4,
                fontSize: 11.5,
                color: 'var(--text-faint)',
              }}
            >
              {!readOnly && (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                  <kbd
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 10.5,
                      padding: '1px 6px',
                      borderRadius: 4,
                      background: 'var(--bg-subtle)',
                      border: '1px solid var(--border)',
                      color: 'var(--text-secondary)',
                    }}
                  >
                    Ctrl+S
                  </kbd>
                  <span>{tr('Save & Compile', '保存并编译')}</span>
                </span>
              )}
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <kbd
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 10.5,
                    padding: '1px 6px',
                    borderRadius: 4,
                    background: 'var(--bg-subtle)',
                    border: '1px solid var(--border)',
                    color: 'var(--text-secondary)',
                  }}
                >
                  \
                </kbd>
                <span>{tr('LaTeX Autocomplete', 'LaTeX 智能补全')}</span>
              </span>
            </div>
          </div>
        ) : isBinary ? (
          <div className="editor-binary-preview">
            {binaryError ? (
              <div className="alert alert-danger">{binaryError}</div>
            ) : binaryPreview ? (
              <>
                {binaryPreview.mime.startsWith('image/') && binaryPreview.base64 ? (
                  <img
                    src={`data:${binaryPreview.mime};base64,${binaryPreview.base64}`}
                    alt={filePath}
                  />
                ) : (
                  <FileImage size={42} strokeWidth={1.5} />
                )}
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5 }}>{filePath}</div>
                <div style={{ fontSize: 12, color: 'var(--text-faint)' }}>
                  {tr('Binary Asset', '二进制资源')} · {(binaryPreview.size / 1024).toFixed(1)} KB
                </div>
                {binaryPreview.base64 && (
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() =>
                      downloadBase64File(
                        binaryPreview.base64,
                        filePath.split('/').pop() ?? 'file',
                        binaryPreview.mime,
                      )
                    }
                  >
                    <Download size={13} />
                    {tr('Download File', '下载原文件')}
                  </button>
                )}
              </>
            ) : (
              <div>{tr('Loading asset preview…', '正在加载资源预览...')}</div>
            )}
          </div>
        ) : (
          <>
            <div ref={containerRef} style={{ height: '100%', width: '100%' }} />
            {!hasSyncedOnce && (
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  background: 'var(--bg-app)',
                  display: 'flex',
                  flexDirection: 'column',
                  zIndex: 5,
                }}
              >
                {restPreviewText !== null ? (
                  <>
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 10,
                        padding: '6px 14px',
                        borderBottom: '1px solid var(--border-subtle)',
                        background: 'var(--bg-subtle)',
                        fontSize: 11.5,
                        color: 'var(--text-muted)',
                        flexShrink: 0,
                      }}
                    >
                      <span
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 7,
                          minWidth: 0,
                        }}
                      >
                        <Loader2
                          size={12}
                          className="spin"
                          style={{ color: 'var(--accent)', flexShrink: 0 }}
                        />
                        <span
                          style={{
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {tr(
                            'Connecting to document session · Read-only snapshot preview',
                            '协同连接建立中 · 当前为只读快照预览',
                          )}
                        </span>
                      </span>
                      <span style={{ color: 'var(--text-faint)', fontSize: 11, flexShrink: 0 }}>
                        {tr('Editing enables once ready', '就绪后自动切入编辑')}
                      </span>
                    </div>
                    <pre
                      style={{
                        flex: 1,
                        margin: 0,
                        padding: '12px 18px 40px',
                        overflow: 'auto',
                        fontFamily: 'var(--font-mono)',
                        fontSize: 13.5,
                        lineHeight: 1.7,
                        color: 'var(--text-secondary)',
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                        tabSize: 2,
                      }}
                    >
                      {restPreviewText}
                    </pre>
                  </>
                ) : (
                  <div
                    style={{
                      flex: 1,
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 8,
                      padding: 24,
                      textAlign: 'center',
                    }}
                  >
                    <Loader2 size={18} className="spin" style={{ color: 'var(--accent)' }} />
                    <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-secondary)' }}>
                      {tr('Syncing document…', '正在同步实时协同文档…')}
                    </div>
                    <div style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>
                      {tr(
                        'Waiting for initial CRDT sync before editing',
                        '等待 CRDT 初始同步完成，以防止并发写入冲突',
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>

      <div className="editor-statusbar" role="status" aria-live="polite">
        <div
          className="editor-statusbar-group"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0 }}
        >
          {filePath && !isBinary ? (
            <>
              <span
                className={`editor-statusbar-sync ${syncState}`}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  color:
                    syncState === 'connecting'
                      ? 'var(--warning)'
                      : syncState === 'offline'
                        ? 'var(--text-faint)'
                        : 'var(--text-secondary)',
                }}
              >
                <span className={`sync-dot ${syncState}`} />
                <span>{syncLabel}</span>
              </span>
              <span aria-hidden="true" style={{ color: 'var(--border-strong)' }}>
                ·
              </span>
              <span className="editor-statusbar-mode" style={{ color: 'var(--text-muted)' }}>
                {modeLabel}
              </span>
            </>
          ) : (
            <span className="editor-statusbar-mode" style={{ color: 'var(--text-faint)' }}>
              {modeLabel}
            </span>
          )}
        </div>

        <div
          className="editor-statusbar-group"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexShrink: 0 }}
        >
          {filePath && !isBinary ? (
            <>
              <span
                className="editor-statusbar-cursor"
                style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}
                title={
                  selectionRange
                    ? tr(
                        `Selected lines ${selectionRange.startLine}–${selectionRange.endLine}`,
                        `已选中第 ${selectionRange.startLine}–${selectionRange.endLine} 行`,
                      )
                    : tr(
                        `Line ${cursorLine}, Column ${cursorCol}`,
                        `当前第 ${cursorLine} 行，第 ${cursorCol} 列`,
                      )
                }
              >
                {tr(`Ln ${cursorLine}, Col ${cursorCol}`, `行 ${cursorLine}, 列 ${cursorCol}`)}
                {selectionRange
                  ? tr(
                      ` · Sel L${selectionRange.startLine}–${selectionRange.endLine}`,
                      ` · 已选 L${selectionRange.startLine}–${selectionRange.endLine}`,
                    )
                  : ''}
              </span>
              <span aria-hidden="true" style={{ color: 'var(--border-strong)' }}>
                ·
              </span>
              <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-faint)' }}>
                UTF-8
              </span>
              <span aria-hidden="true" style={{ color: 'var(--border-strong)' }}>
                ·
              </span>
              {readOnly ? (
                <span
                  className="editor-statusbar-readonly"
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                    color: 'var(--text-muted)',
                  }}
                >
                  <Lock size={10.5} />
                  {tr('Read-only', '只读模式')}
                </span>
              ) : (
                <span
                  className="editor-statusbar-hint"
                  style={{ color: 'var(--text-faint)' }}
                  title={tr(
                    'Press Ctrl+S or Ctrl+Enter to save and compile PDF',
                    '按下 Ctrl+S 或 Ctrl+Enter 保存并编译 PDF',
                  )}
                >
                  {tr('Ctrl+S Compile', 'Ctrl+S 编译')}
                </span>
              )}
            </>
          ) : filePath && isBinary ? (
            <>
              {binaryPreview && (
                <>
                  <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-faint)' }}>
                    {(binaryPreview.size / 1024).toFixed(1)} KB
                  </span>
                  <span aria-hidden="true" style={{ color: 'var(--border-strong)' }}>
                    ·
                  </span>
                </>
              )}
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  color: 'var(--text-faint)',
                }}
              >
                {readOnly && <Lock size={10.5} />}
                {readOnly ? tr('Read-only', '只读模式') : tr('Read-only preview', '只读预览')}
              </span>
            </>
          ) : (
            <>
              <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-faint)' }}>
                UTF-8
              </span>
              <span aria-hidden="true" style={{ color: 'var(--border-strong)' }}>
                ·
              </span>
              {readOnly ? (
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                    color: 'var(--text-muted)',
                  }}
                >
                  <Lock size={10.5} />
                  {tr('Read-only', '只读模式')}
                </span>
              ) : (
                <span style={{ color: 'var(--text-faint)' }}>{tr('Ctrl+S Compile', 'Ctrl+S 编译')}</span>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
};
