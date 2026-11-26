import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { basicSetup, EditorView } from 'codemirror';
import { Compartment, EditorState, Prec, type Extension } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { markdown as markdownLang } from '@codemirror/lang-markdown';
import { oneDark } from '@codemirror/theme-one-dark';
import type { CompileEngine, CompileResult } from '@novatex/shared';
import {
  AlertTriangle,
  Download,
  FileText,
  GitCompare,
  Loader2,
  Lock,
  Play,
  RefreshCw,
  ShieldCheck,
  X,
} from 'lucide-react';
import {
  api,
  downloadTextFile,
  type FormatImportPreviewResponse,
} from '../api.ts';
import { useLocale } from '../i18n.ts';
import { computeLineDiff } from '../utils/diff.ts';
import { DiffViewer } from './DiffModal.tsx';

export interface MarkdownWorkspacePaneProps {
  projectId: string;
  targetFile: string;
  mainFile?: string;
  engine: CompileEngine;
  theme: 'light' | 'dark';
  readOnly: boolean;
  onCompiled: (result: CompileResult, mergedTargetFile: string) => void;
  onNotify: (kind: 'success' | 'error' | 'info', message: string) => void;
}

const markdownLightHighlight = HighlightStyle.define([
  { tag: tags.heading, color: '#0F172A', fontWeight: '700' },
  { tag: tags.strong, color: '#0F172A', fontWeight: '700' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.quote, color: '#475569', fontStyle: 'italic' },
  { tag: tags.monospace, color: '#0F766E' },
  { tag: tags.link, color: '#1D4ED8', textDecoration: 'underline' },
  { tag: tags.url, color: '#1D4ED8' },
  { tag: tags.list, color: '#047857', fontWeight: '600' },
  { tag: tags.processingInstruction, color: '#B45309', fontWeight: '600' },
  { tag: tags.meta, color: '#64748B' },
  { tag: tags.comment, color: '#64748B', fontStyle: 'italic' },
]);

function getMarkdownThemeExtension(theme: 'light' | 'dark'): Extension {
  return theme === 'dark' ? oneDark : syntaxHighlighting(markdownLightHighlight);
}

function isMarkdownPath(filePath: string): boolean {
  return /\.(md|markdown)$/i.test(filePath);
}

function deriveMdFileName(filePath: string): string {
  const base = filePath.replace(/\\/g, '/').split('/').pop() || 'document';
  if (isMarkdownPath(base)) return base;
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return `${stem}.md`;
}

function countMarkdownStats(text: string): {
  academicWords: number;
  charCount: number;
  lineCount: number;
} {
  if (!text) {
    return { academicWords: 0, charCount: 0, lineCount: 1 };
  }
  const cjkMatches = text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g);
  const latinMatches = text.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g);
  const cjkCount = cjkMatches ? cjkMatches.length : 0;
  const latinCount = latinMatches ? latinMatches.length : 0;
  const charCount = text.replace(/\s+/g, '').length;
  const lineCount = text.split('\n').length;
  return {
    academicWords: cjkCount + latinCount,
    charCount,
    lineCount,
  };
}

export const MarkdownWorkspacePane: React.FC<MarkdownWorkspacePaneProps> = ({
  projectId,
  targetFile,
  mainFile = 'main.tex',
  engine,
  theme,
  readOnly,
  onCompiled,
  onNotify,
}) => {
  const { locale, tr } = useLocale();
  const trRef = useRef(tr);
  trRef.current = tr;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const themeCompRef = useRef(new Compartment());
  const readOnlyCompRef = useRef(new Compartment());

  // Track latest markdown content & baseline without re-creating CodeMirror on every keystroke
  const mountedRef = useRef<boolean>(true);
  const activeContextKey = `${projectId}::${targetFile}`;
  const activeContextRef = useRef<string>(activeContextKey);
  activeContextRef.current = activeContextKey;
  const markdownRef = useRef<string>('');
  const baselineRef = useRef<string>('');
  const loadSeqRef = useRef<number>(0);
  const syncSeqRef = useRef<number>(0);
  const diffSeqRef = useRef<number>(0);
  const themeRef = useRef<'light' | 'dark'>(theme);
  themeRef.current = theme;
  const readOnlyRef = useRef<boolean>(readOnly);
  readOnlyRef.current = readOnly;
  const onNotifyRef = useRef(onNotify);
  onNotifyRef.current = onNotify;

  const isRawMdFile = isMarkdownPath(targetFile);
  const mdDownloadName = useMemo(() => deriveMdFileName(targetFile), [targetFile]);

  const [loading, setLoading] = useState<boolean>(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [exportWarnings, setExportWarnings] = useState<string[]>([]);
  const [dirty, setDirty] = useState<boolean>(false);
  const [syncing, setSyncing] = useState<boolean>(false);

  // Cursor & document stats
  const [stats, setStats] = useState<{ academicWords: number; charCount: number; lineCount: number }>({
    academicWords: 0,
    charCount: 0,
    lineCount: 1,
  });
  const [cursorLine, setCursorLine] = useState<number>(1);
  const [cursorCol, setCursorCol] = useState<number>(1);

  // Inline LaTeX Diff preview drawer state
  const [showDiffDrawer, setShowDiffDrawer] = useState<boolean>(false);
  const [diffLoading, setDiffLoading] = useState<boolean>(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [diffPreview, setDiffPreview] = useState<FormatImportPreviewResponse | null>(null);
  const [diffCompact, setDiffCompact] = useState<boolean>(true);
  const [diffStale, setDiffStale] = useState<boolean>(false);

  const syncAndCompileRef = useRef<() => Promise<void>>(async () => {});

  const buildEditorState = useCallback(
    (initialDoc: string): EditorState => {
      return EditorState.create({
        doc: initialDoc,
        extensions: [
          Prec.high(
            keymap.of([
              {
                key: 'Mod-s',
                run: () => {
                  if (!readOnlyRef.current) {
                    void syncAndCompileRef.current();
                  }
                  return true;
                },
              },
              {
                key: 'Mod-Enter',
                run: () => {
                  if (!readOnlyRef.current) {
                    void syncAndCompileRef.current();
                  }
                  return true;
                },
              },
            ]),
          ),
          basicSetup,
          markdownLang(),
          EditorView.lineWrapping,
          themeCompRef.current.of(getMarkdownThemeExtension(theme)),
          readOnlyCompRef.current.of([
            EditorState.readOnly.of(readOnly),
            EditorView.editable.of(!readOnly),
          ]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              const nextText = update.state.doc.toString();
              markdownRef.current = nextText;
              setDirty(nextText !== baselineRef.current);
              setStats(countMarkdownStats(nextText));
              setDiffStale(true);
            }
            if (update.selectionSet || update.docChanged) {
              const sel = update.state.selection.main;
              const line = update.state.doc.lineAt(sel.head);
              setCursorLine(line.number);
              setCursorCol(sel.head - line.from + 1);
            }
          }),
        ],
      });
    },
    // theme and readOnly are updated reactively via Compartments below
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // Mount CodeMirror 6 instance once
  useEffect(() => {
    if (!containerRef.current) return;
    const view = new EditorView({
      state: buildEditorState(markdownRef.current),
      parent: containerRef.current,
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [buildEditorState]);

  // Reactive theme compartment update
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: themeCompRef.current.reconfigure(getMarkdownThemeExtension(theme)),
    });
  }, [theme]);

  // Reactive readOnly compartment update
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: readOnlyCompRef.current.reconfigure([
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
      ]),
    });
  }, [readOnly]);

  const setEditorDocument = useCallback(
    (nextText: string, resetHistory: boolean) => {
      markdownRef.current = nextText;
      baselineRef.current = nextText;
      setDirty(false);
      setStats(countMarkdownStats(nextText));
      setCursorLine(1);
      setCursorCol(1);

      const view = viewRef.current;
      if (!view) return;

      if (resetHistory) {
        view.setState(buildEditorState(nextText));
        // Re-apply current theme & readOnly after state reset
        view.dispatch({
          effects: [
            themeCompRef.current.reconfigure(getMarkdownThemeExtension(themeRef.current)),
            readOnlyCompRef.current.reconfigure([
              EditorState.readOnly.of(readOnlyRef.current),
              EditorView.editable.of(!readOnlyRef.current),
            ]),
          ],
        });
      } else {
        const currentLen = view.state.doc.length;
        view.dispatch({
          changes: { from: 0, to: currentLen, insert: nextText },
          selection: { anchor: 0 },
        });
      }
    },
    [buildEditorState],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      loadSeqRef.current += 1;
      syncSeqRef.current += 1;
      diffSeqRef.current += 1;
    };
  }, []);

  // Invalidate in-flight sync/diff requests whenever project or target file changes
  useEffect(() => {
    syncSeqRef.current += 1;
    diffSeqRef.current += 1;
    setSyncing(false);
    setDiffLoading(false);
  }, [activeContextKey]);

  // Load Markdown representation whenever projectId or targetFile changes
  const loadMarkdownFromSource = useCallback(
    async (opts?: { resetHistory?: boolean; notifyOnDone?: boolean }) => {
      const ctxKey = `${projectId}::${targetFile}`;
      const seq = ++loadSeqRef.current;
      if (!targetFile) {
        setLoading(false);
        setLoadError(
          trRef.current(
            'No editable file selected. Choose a .tex or .md file from the left file tree first.',
            '尚未选择可编辑的文档文件，请先从左侧文件树选择一个 .tex 文件。',
          ),
        );
        return;
      }
      setLoading(true);
      setLoadError(null);
      setExportWarnings([]);
      setDiffPreview(null);
      setDiffError(null);
      setDiffStale(false);
      if (opts?.resetHistory) {
        setShowDiffDrawer(false);
      }

      try {
        let extractedText = '';
        let warnings: string[] = [];

        if (isMarkdownPath(targetFile)) {
          const fileRes = await api.readFile(projectId, targetFile);
          if (fileRes.isBinary) {
            throw new Error(
              trRef.current(
                `File ${targetFile} is binary and cannot be opened in Markdown view.`,
                `文件 ${targetFile} 为二进制文件，无法在 Markdown 视图中打开。`,
              ),
            );
          }
          extractedText = fileRes.content ?? '';
        } else {
          const artifact = await api.exportFormat(projectId, {
            sourceScope: 'file',
            sourceFile: targetFile,
            targetFormat: 'md',
            options: {
              preserveCitations: true,
              flattenInputs: false,
            },
          });
          extractedText = artifact.text ?? '';
          warnings = artifact.warnings ?? [];
        }

        if (
          !mountedRef.current ||
          activeContextRef.current !== ctxKey ||
          seq !== loadSeqRef.current
        ) {
          return;
        }

        setEditorDocument(extractedText, Boolean(opts?.resetHistory));
        setExportWarnings(warnings);
        if (opts?.notifyOnDone) {
          onNotifyRef.current(
            'info',
            isMarkdownPath(targetFile)
              ? trRef.current(`Reloaded ${targetFile}`, `已重新加载 ${targetFile}`)
              : trRef.current(
                  `Refreshed Markdown view from ${targetFile}`,
                  `已从 ${targetFile} 重新提取最新 Markdown 视图`,
                ),
          );
        }
      } catch (err: unknown) {
        if (
          !mountedRef.current ||
          activeContextRef.current !== ctxKey ||
          seq !== loadSeqRef.current
        ) {
          return;
        }
        const msg =
          err instanceof Error
            ? err.message
            : trRef.current('Failed to load Markdown view', '加载 Markdown 视图失败');
        setLoadError(msg);
      } finally {
        if (
          mountedRef.current &&
          activeContextRef.current === ctxKey &&
          seq === loadSeqRef.current
        ) {
          setLoading(false);
        }
      }
    },
    [projectId, targetFile, setEditorDocument],
  );

  useEffect(() => {
    void loadMarkdownFromSource({ resetHistory: true, notifyOnDone: false });
  }, [loadMarkdownFromSource]);

  const handleSyncAndCompile = useCallback(async () => {
    if (readOnly || syncing || loading || loadError) return;

    const ctxKey = `${projectId}::${targetFile}`;
    const seq = ++syncSeqRef.current;
    const currentMd = viewRef.current?.state.doc.toString() ?? markdownRef.current;
    setSyncing(true);
    try {
      if (isMarkdownPath(targetFile)) {
        // Persist edits to the .md file itself first, then compile against the project's main .tex
        await api.writeFile(projectId, {
          path: targetFile,
          content: currentMd,
        });
        if (
          !mountedRef.current ||
          activeContextRef.current !== ctxKey ||
          seq !== syncSeqRef.current
        ) {
          return;
        }
        baselineRef.current = currentMd;
        setDirty(false);
        try {
          const res = await api.mdCompile(projectId, {
            markdown: currentMd,
            engine,
            options: {
              preserveCitations: true,
              bodyOnly: true,
            },
          });
          if (
            !mountedRef.current ||
            activeContextRef.current !== ctxKey ||
            seq !== syncSeqRef.current
          ) {
            return;
          }
          setDiffStale(false);
          if (res.mergePreview) {
            setDiffPreview({
              mergePreview: res.mergePreview,
              generatedCode: res.mergedCode,
              targetFile: res.targetFile,
              warnings: res.warnings,
            });
          }
          onCompiled(res.compileResult, res.targetFile);
          if (res.compileResult.ok) {
            onNotify(
              'success',
              trRef.current(
                `Saved ${targetFile} and compiled into ${res.targetFile} (preamble preserved)`,
                `已保存 ${targetFile}，并无损保留导言区合入 ${res.targetFile} 完成编译`,
              ),
            );
          } else if (res.compileResult.pdfReady) {
            onNotify(
              'info',
              trRef.current(
                `Merged into ${res.targetFile}; PDF updated with ${res.compileResult.errorCount} error(s) and ${res.compileResult.warningCount} warning(s)`,
                `已合入 ${res.targetFile}，PDF 已更新但存在 ${res.compileResult.errorCount} 个错误 / ${res.compileResult.warningCount} 条警告`,
              ),
            );
          } else {
            onNotify(
              'error',
              trRef.current(
                `Merged into ${res.targetFile}, but LaTeX compilation failed (${res.compileResult.errorCount} error(s)). Inspect diagnostics on the right.`,
                `已合入 ${res.targetFile}，但 LaTeX 编译失败（${res.compileResult.errorCount} 个错误），请查看右侧诊断栏`,
              ),
            );
          }
        } catch (compileErr: unknown) {
          if (
            !mountedRef.current ||
            activeContextRef.current !== ctxKey ||
            seq !== syncSeqRef.current
          ) {
            return;
          }
          const cMsg =
            compileErr instanceof Error
              ? compileErr.message
              : trRef.current('Failed to merge and compile main file', '合入主文件编译失败');
          onNotify(
            'error',
            trRef.current(
              `Saved ${targetFile}, but compiling main file failed: ${cMsg}`,
              `已保存 ${targetFile}，但合入主文件编译失败：${cMsg}`,
            ),
          );
        }
      } else {
        const res = await api.mdCompile(projectId, {
          markdown: currentMd,
          targetFile,
          engine,
          options: {
            preserveCitations: true,
            bodyOnly: true,
          },
        });
        if (
          !mountedRef.current ||
          activeContextRef.current !== ctxKey ||
          seq !== syncSeqRef.current
        ) {
          return;
        }
        baselineRef.current = currentMd;
        setDirty(false);
        setDiffStale(false);
        if (res.mergePreview) {
          setDiffPreview({
            mergePreview: res.mergePreview,
            generatedCode: res.mergedCode,
            targetFile: res.targetFile,
            warnings: res.warnings,
          });
        }
        onCompiled(res.compileResult, res.targetFile);
        if (res.compileResult.ok) {
          onNotify(
            'success',
            trRef.current(
              `Merged safely into ${res.targetFile} (preamble preserved) and compiled PDF`,
              `已无损保留导言区合入 ${res.targetFile} 并完成编译`,
            ),
          );
        } else if (res.compileResult.pdfReady) {
          onNotify(
            'info',
            trRef.current(
              `Merged into ${res.targetFile}; PDF generated with ${res.compileResult.errorCount} error(s) and ${res.compileResult.warningCount} warning(s)`,
              `已合入 ${res.targetFile}，PDF 已生成但存在 ${res.compileResult.errorCount} 个错误 / ${res.compileResult.warningCount} 条警告`,
            ),
          );
        } else {
          onNotify(
            'error',
            trRef.current(
              `Merged into ${res.targetFile}, but compilation reported ${res.compileResult.errorCount} error(s). Check diagnostics on the right.`,
              `已合入 ${res.targetFile}，但编译出现 ${res.compileResult.errorCount} 个错误，请检查右侧诊断信息`,
            ),
          );
        }
      }
    } catch (err: unknown) {
      if (
        !mountedRef.current ||
        activeContextRef.current !== ctxKey ||
        seq !== syncSeqRef.current
      ) {
        return;
      }
      const msg =
        err instanceof Error
          ? err.message
          : trRef.current('Failed to sync and compile Markdown', 'Markdown 同步编译失败');
      onNotify('error', msg);
    } finally {
      if (
        mountedRef.current &&
        activeContextRef.current === ctxKey &&
        seq === syncSeqRef.current
      ) {
        setSyncing(false);
      }
    }
  }, [readOnly, syncing, loading, loadError, targetFile, projectId, engine, onCompiled, onNotify]);

  syncAndCompileRef.current = handleSyncAndCompile;

  const fetchLatexDiffPreview = useCallback(async () => {
    if (readOnly || loading || loadError) return;
    const ctxKey = `${projectId}::${targetFile}`;
    const seq = ++diffSeqRef.current;
    const currentMd = viewRef.current?.state.doc.toString() ?? markdownRef.current;
    setDiffLoading(true);
    setDiffError(null);
    setShowDiffDrawer(true);

    try {
      const res = await api.previewImportFormat(projectId, {
        sourceFormat: 'md',
        fileName: mdDownloadName,
        text: currentMd,
        targetMode: 'merge-tex',
        targetFile: isMarkdownPath(targetFile) ? mainFile || 'main.tex' : targetFile,
        options: {
          preserveCitations: true,
          bodyOnly: true,
        },
      });
      if (
        !mountedRef.current ||
        activeContextRef.current !== ctxKey ||
        seq !== diffSeqRef.current
      ) {
        return;
      }
      setDiffPreview(res);
      setDiffStale(false);
    } catch (err: unknown) {
      if (
        !mountedRef.current ||
        activeContextRef.current !== ctxKey ||
        seq !== diffSeqRef.current
      ) {
        return;
      }
      setDiffError(
        err instanceof Error
          ? err.message
          : trRef.current('Failed to generate LaTeX diff preview', '生成 LaTeX Diff 预览失败'),
      );
    } finally {
      if (
        mountedRef.current &&
        activeContextRef.current === ctxKey &&
        seq === diffSeqRef.current
      ) {
        setDiffLoading(false);
      }
    }
  }, [readOnly, loading, loadError, projectId, mdDownloadName, targetFile, mainFile]);

  const handleToggleDiffDrawer = useCallback(() => {
    if (showDiffDrawer && !diffStale && !diffError) {
      setShowDiffDrawer(false);
      return;
    }
    void fetchLatexDiffPreview();
  }, [showDiffDrawer, diffStale, diffError, fetchLatexDiffPreview]);

  const handleDownloadMd = useCallback(() => {
    const currentMd = viewRef.current?.state.doc.toString() ?? markdownRef.current;
    downloadTextFile(currentMd, mdDownloadName, 'text/markdown;charset=utf-8');
    onNotify('success', trRef.current(`Downloaded ${mdDownloadName}`, `已下载 ${mdDownloadName}`));
  }, [mdDownloadName, onNotify]);

  const activeDiffSummary = useMemo(() => {
    if (!diffPreview) return null;
    if (diffPreview.mergePreview?.diff) {
      return diffPreview.mergePreview.diff;
    }
    return computeLineDiff('', diffPreview.generatedCode, diffPreview.targetFile);
  }, [diffPreview]);

  const headerPillLabel = isRawMdFile
    ? tr(`${targetFile} (Markdown source)`, `${targetFile}（Markdown 原文件）`)
    : tr(`${targetFile} → Markdown`, `${targetFile} → Markdown 视图`);

  return (
    <section className="editor-pane">
      {/* Clean 42px Markdown Workbench Header Bar */}
      <div className="md-workbench-header">
        <div
          className="pane-toolbar-group"
          style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, overflow: 'hidden' }}
        >
          <span
            className="pill pill-accent"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              maxWidth: '100%',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
            title={headerPillLabel}
          >
            <FileText size={12} style={{ flexShrink: 0 }} />
            <span
              style={{
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                fontFamily: 'var(--font-mono)',
              }}
            >
              {headerPillLabel}
            </span>
          </span>

          {dirty && !loading && !loadError && (
            <span
              className="dirty-indicator"
              style={{ marginRight: 0, fontSize: 11.5, flexShrink: 0 }}
              title={tr(
                'Markdown has unsynced edits not yet compiled into LaTeX',
                '当前 Markdown 有尚未同步编译到 LaTeX 的修改',
              )}
            >
              <span className="dirty-dot" />
              <span>{tr('Unsynced edits', '有未同步改动')}</span>
            </span>
          )}
        </div>

        <div className="pane-toolbar-actions">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={loading || syncing}
            title={
              isRawMdFile
                ? tr(`Reload ${targetFile} from project`, `重新从项目读取 ${targetFile}`)
                : tr(
                    `Re-extract Markdown from latest ${targetFile} (undoable with Ctrl+Z)`,
                    `从最新 ${targetFile} 重新提取 Markdown（可用 Ctrl+Z 撤销）`,
                  )
            }
            onClick={() => void loadMarkdownFromSource({ resetHistory: false, notifyOnDone: true })}
          >
            <RefreshCw size={13} className={loading ? 'spin' : undefined} />
            {isRawMdFile ? tr('Reload', '重新加载') : tr('Refresh from LaTeX', '从 LaTeX 刷新')}
          </button>

          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={loading || Boolean(loadError)}
            title={tr(`Download current content as ${mdDownloadName}`, `下载当前内容为 ${mdDownloadName}`)}
            onClick={handleDownloadMd}
          >
            <Download size={13} />
            {tr('Download .md', '下载 .md')}
          </button>

          <button
            type="button"
            className={`btn btn-ghost btn-sm ${showDiffDrawer ? 'active' : ''}`}
            disabled={readOnly || loading || syncing || diffLoading || Boolean(loadError)}
            title={
              readOnly
                ? tr('Edit permission required to preview LaTeX merge diff', '仅编辑权限可预览 LaTeX 合入 Diff')
                : tr(
                    'Preview the exact LaTeX diff before merging Markdown back',
                    '预览将当前 Markdown 合回原 LaTeX 文件时的精确红绿 Diff',
                  )
            }
            onClick={handleToggleDiffDrawer}
          >
            {diffLoading ? <Loader2 size={13} className="spin" /> : <GitCompare size={13} />}
            {tr('Preview Diff', '预览 LaTeX Diff')}
          </button>

          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={readOnly || syncing || loading || Boolean(loadError)}
            title={
              readOnly
                ? tr('Read-only mode: cannot sync & compile', '当前为只读模式，无法同步并编译')
                : tr(
                    'Merge Markdown safely into the LaTeX body and compile PDF immediately (Ctrl+S)',
                    '将当前 Markdown 无损合入 LaTeX 正文并立即编译刷新右侧 PDF（Ctrl+S）',
                  )
            }
            onClick={() => void handleSyncAndCompile()}
          >
            {syncing ? <Loader2 size={13} className="spin" /> : <Play size={13} />}
            {syncing ? tr('Syncing…', '同步编译中…') : tr('Sync & Compile PDF', '同步并编译 PDF')}
          </button>
        </div>
      </div>

      {/* Calm Subtle Guide Banner */}
      <div className="md-workbench-banner">
        <span style={{ flex: 1, minWidth: 0 }}>
          {locale === 'en' ? (
            <>
              Edit cleanly in Markdown (with <code>$math$</code> and <code>[@cite]</code>{' '}
              preserved) — press <code>Ctrl+S</code> or click <strong>Sync &amp; Compile PDF</strong>{' '}
              to merge without touching your LaTeX preamble.
            </>
          ) : (
            <>
              直接像写笔记一样改 Markdown（公式 <code>$...$</code> 与引用 <code>[@key]</code>{' '}
              自动无损保留），按 <code>Ctrl+S</code> 或点「同步并编译 PDF」即可保留原 LaTeX
              导言区与模板并刷新右侧 PDF。
            </>
          )}
        </span>
        {readOnly && (
          <span className="pill" style={{ flexShrink: 0 }}>
            <Lock size={10.5} />
            {tr('Read-only preview', '只读预览')}
          </span>
        )}
      </div>

      {/* Optional Pandoc conversion warning strip */}
      {exportWarnings.length > 0 && !loading && !loadError && (
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: 8,
            padding: '6px 12px',
            background: 'var(--warning-soft)',
            borderBottom: '1px solid var(--warning-border)',
            color: 'var(--warning)',
            fontSize: 11.5,
            flexShrink: 0,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, minWidth: 0 }}>
            <AlertTriangle size={13} style={{ flexShrink: 0, marginTop: 2 }} />
            <div style={{ minWidth: 0 }}>
              {exportWarnings.map((w, idx) => (
                <div key={idx}>{w}</div>
              ))}
            </div>
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-icon-sm"
            aria-label={tr('Dismiss notice', '关闭提示')}
            onClick={() => setExportWarnings([])}
          >
            <X size={12} />
          </button>
        </div>
      )}

      {/* Main Editor Host */}
      <div className="editor-host">
        <div ref={containerRef} style={{ height: '100%', width: '100%' }} />

        {loading && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              background: 'var(--bg-app)',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 10,
              padding: 24,
              textAlign: 'center',
              zIndex: 6,
            }}
          >
            <Loader2 size={20} className="spin" style={{ color: 'var(--accent)' }} />
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
              {isRawMdFile
                ? tr(`Loading ${targetFile}…`, `正在加载 ${targetFile}…`)
                : tr(`Extracting Markdown view from ${targetFile}…`, `正在将 ${targetFile} 提取为 Markdown 视图…`)}
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
              {tr(
                'Stripping LaTeX preamble while preserving equations and citations',
                '自动剥离繁琐 LaTeX 导言区，无损保留数学公式与学术引用',
              )}
            </div>
          </div>
        )}

        {!loading && loadError && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              background: 'var(--bg-app)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 24,
              zIndex: 6,
            }}
          >
            <div className="empty-state-card">
              <div
                style={{
                  width: 44,
                  height: 44,
                  margin: '0 auto',
                  borderRadius: 12,
                  background: 'var(--danger-soft)',
                  border: '1px solid var(--danger-border)',
                  color: 'var(--danger)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <AlertTriangle size={20} />
              </div>
              <h3>{tr('Unable to load Markdown view', '无法生成 Markdown 视图')}</h3>
              <p style={{ wordBreak: 'break-word' }}>{loadError}</p>
              <div style={{ display: 'flex', justifyContent: 'center', gap: 8, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() => void loadMarkdownFromSource({ resetHistory: true, notifyOnDone: false })}
                >
                  <RefreshCw size={13} />
                  {tr('Retry Markdown Extraction', '重试提取 Markdown')}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Inline Collapsible LaTeX Diff Drawer */}
      {showDiffDrawer && (
        <div
          style={{
            borderTop: '1px solid var(--border)',
            background: 'var(--bg-subtle)',
            display: 'flex',
            flexDirection: 'column',
            maxHeight: '44%',
            minHeight: 160,
            flexShrink: 0,
            boxShadow: '0 -4px 16px rgba(15, 23, 42, 0.06)',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 8,
              padding: '6px 12px',
              borderBottom: '1px solid var(--border-subtle)',
              background: 'var(--bg-subtle)',
              flexShrink: 0,
            }}
          >
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
              <GitCompare size={13} style={{ color: 'var(--accent)', flexShrink: 0 }} />
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>
                {tr('Lossless LaTeX Merge Preview', 'LaTeX 无损合入预览')}
              </span>
              {diffStale && !diffLoading && (
                <span className="pill pill-warning">
                  {tr('Edited · Refresh to update', '正文已变更 · 点刷新查看最新')}
                </span>
              )}
            </div>

            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
              <button
                type="button"
                className="btn btn-ghost btn-xs"
                disabled={diffLoading}
                onClick={() => void fetchLatexDiffPreview()}
              >
                <RefreshCw size={12} className={diffLoading ? 'spin' : undefined} />
                {tr('Refresh Diff', '刷新 Diff')}
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-xs"
                onClick={() => setDiffCompact((v) => !v)}
              >
                {diffCompact ? tr('Show Full File', '展开全文') : tr('Changes Only', '仅看变更')}
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-icon-sm"
                aria-label={tr('Close diff preview', '收起 Diff 预览')}
                onClick={() => setShowDiffDrawer(false)}
              >
                <X size={13} />
              </button>
            </div>
          </div>

          <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 10 }}>
            {diffLoading ? (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 8,
                  padding: '24px 12px',
                  color: 'var(--text-muted)',
                  fontSize: 12,
                }}
              >
                <Loader2 size={14} className="spin" style={{ color: 'var(--accent)' }} />
                {tr(
                  'Computing preamble-safe Markdown → LaTeX diff…',
                  '正在计算 Markdown → LaTeX 导言区保护合入 Diff…',
                )}
              </div>
            ) : diffError ? (
              <div className="alert alert-danger" style={{ marginBottom: 0 }}>
                {diffError}
              </div>
            ) : diffPreview && activeDiffSummary ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {diffPreview.warnings.length > 0 && (
                  <div className="alert alert-warning" style={{ marginBottom: 0 }}>
                    {diffPreview.warnings.map((w, i) => (
                      <div key={i}>• {w}</div>
                    ))}
                  </div>
                )}
                <DiffViewer
                  lines={activeDiffSummary.lines}
                  compact={diffCompact}
                  filePath={diffPreview.targetFile}
                  additions={activeDiffSummary.additions}
                  deletions={activeDiffSummary.deletions}
                />
              </div>
            ) : null}
          </div>
        </div>
      )}

      {/* Clean Bottom IDE Status Bar */}
      <div className="editor-statusbar" role="status" aria-live="polite">
        <div className="editor-statusbar-left" style={{ overflow: 'hidden' }}>
          <span
            className="editor-statusbar-item"
            style={{
              color: 'var(--accent)',
              fontFamily: 'var(--font-sans)',
              fontWeight: 500,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
            title={tr('Markdown Mode · Preamble Locked', 'Markdown 速写模式 · 导言区已锁定保护')}
          >
            <ShieldCheck size={12} style={{ flexShrink: 0 }} />
            {tr('Preamble locked', '导言区已锁定')}
          </span>
          <span className="editor-statusbar-sep" aria-hidden="true" />
          <span className="editor-statusbar-item">
            {tr(
              `${stats.academicWords} words · ${stats.lineCount} lines`,
              `${stats.academicWords} 词 · ${stats.lineCount} 行`,
            )}
          </span>
        </div>

        <div className="editor-statusbar-right" style={{ flexShrink: 0 }}>
          <span className="editor-statusbar-cursor">
            {tr(`Ln ${cursorLine}, Col ${cursorCol}`, `行 ${cursorLine}, 列 ${cursorCol}`)}
          </span>
          <span className="editor-statusbar-sep" aria-hidden="true" />
          {readOnly ? (
            <span className="editor-statusbar-readonly">
              <Lock size={10.5} />
              {tr('Read-only', '只读')}
            </span>
          ) : (
            <span className="editor-statusbar-hint">{tr('Ctrl+S Compile', 'Ctrl+S 编译')}</span>
          )}
        </div>
      </div>
    </section>
  );
};
