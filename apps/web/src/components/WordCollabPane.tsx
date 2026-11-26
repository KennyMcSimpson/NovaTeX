import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CompileEngine, CompileResult, ProjectFileEntry } from '@novatex/shared';
import {
  AlertTriangle,
  Check,
  Download,
  FileCode2,
  FileDown,
  FileText,
  Image as ImageIcon,
  Loader2,
  Lock,
  Play,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  UploadCloud,
} from 'lucide-react';
import {
  api,
  downloadBase64File,
  downloadTextFile,
  fileToBase64,
  type FormatImportPreviewResponse,
} from '../api.ts';
import { useLocale } from '../i18n.ts';
import { computeLineDiff } from '../utils/diff.ts';
import { DiffViewer } from './DiffModal.tsx';

export interface WordCollabPaneProps {
  projectId: string;
  files: ProjectFileEntry[];
  mainFile: string;
  activeFile: string | null;
  engine: CompileEngine;
  readOnly: boolean;
  onAppliedAndCompiled: (targetFile: string, compileResult?: CompileResult) => void;
  onNotify: (kind: 'success' | 'error' | 'info', message: string) => void;
}

type SupportedUploadFormat = 'docx' | 'md' | 'txt' | 'pdf';

interface StagedUploadFile {
  name: string;
  size: number;
  format: SupportedUploadFormat;
  text?: string;
  base64?: string;
}

function detectUploadFormat(fileName: string): SupportedUploadFormat | null {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.docx')) return 'docx';
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'md';
  if (lower.endsWith('.txt')) return 'txt';
  if (lower.endsWith('.pdf')) return 'pdf';
  return null;
}

function isTexPath(filePath: string | null | undefined): filePath is string {
  return Boolean(filePath && /\.(tex|ltx)$/i.test(filePath));
}

export const WordCollabPane: React.FC<WordCollabPaneProps> = ({
  projectId,
  files,
  mainFile,
  activeFile,
  engine,
  readOnly,
  onAppliedAndCompiled,
  onNotify,
}) => {
  const { locale, tr } = useLocale();
  const trRef = useRef(tr);
  trRef.current = tr;

  // Available .tex files for merge target selection
  const texFiles = useMemo(() => {
    const list = files
      .filter((f) => f.kind === 'file' && !f.isBinary && isTexPath(f.path))
      .map((f) => f.path);
    if (mainFile && !list.includes(mainFile)) {
      return [mainFile, ...list];
    }
    return list.length > 0 ? list : [mainFile || 'main.tex'];
  }, [files, mainFile]);

  const defaultTexTarget = useMemo(() => {
    if (isTexPath(activeFile) && texFiles.includes(activeFile)) {
      return activeFile;
    }
    return mainFile || texFiles[0] || 'main.tex';
  }, [activeFile, mainFile, texFiles]);

  // Step 1: Export state
  const [exportScope, setExportScope] = useState<'project' | 'file'>('project');
  const [exportingFormat, setExportingFormat] = useState<'docx' | 'md' | 'txt' | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [lastExportMeta, setLastExportMeta] = useState<{
    fileName: string;
    byteLength: number;
    warnings: string[];
  } | null>(null);

  // Step 2: Import / Merge state
  const mountedRef = useRef<boolean>(true);
  const activeProjectRef = useRef<string>(projectId);
  activeProjectRef.current = projectId;
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const previewSeqRef = useRef<number>(0);
  const opSeqRef = useRef<number>(0);

  const [isDragging, setIsDragging] = useState<boolean>(false);
  const [stagedFile, setStagedFile] = useState<StagedUploadFile | null>(null);
  const [targetFile, setTargetFile] = useState<string>(defaultTexTarget);
  const [trackChanges, setTrackChanges] = useState<'accept' | 'reject' | 'all'>('accept');
  const [preservePreamble, setPreservePreamble] = useState<boolean>(true);

  const [previewLoading, setPreviewLoading] = useState<boolean>(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewResult, setPreviewResult] = useState<FormatImportPreviewResponse | null>(null);
  const [fallbackOriginalCode, setFallbackOriginalCode] = useState<string>('');
  const [optionsChangedSincePreview, setOptionsChangedSincePreview] = useState<boolean>(false);
  const [compactDiff, setCompactDiff] = useState<boolean>(true);

  const [cleaningAi, setCleaningAi] = useState<boolean>(false);
  const [cleanedCode, setCleanedCode] = useState<string | null>(null);
  const [cleanedModel, setCleanedModel] = useState<string | null>(null);
  const [applyingMode, setApplyingMode] = useState<'compile' | 'apply-only' | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      previewSeqRef.current += 1;
      opSeqRef.current += 1;
    };
  }, []);

  // Reset staged upload and invalidate in-flight operations when switching projects
  useEffect(() => {
    previewSeqRef.current += 1;
    opSeqRef.current += 1;
    setStagedFile(null);
    setPreviewLoading(false);
    setPreviewResult(null);
    setPreviewError(null);
    setCleaningAi(false);
    setCleanedCode(null);
    setCleanedModel(null);
    setApplyingMode(null);
    setExportingFormat(null);
    setExportError(null);
    setLastExportMeta(null);
    setOptionsChangedSincePreview(false);
    setTargetFile(defaultTexTarget);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // Keep targetFile synced with activeFile when user hasn't staged a file yet
  useEffect(() => {
    if (!stagedFile) {
      setTargetFile(defaultTexTarget);
    } else if (!texFiles.includes(targetFile)) {
      setTargetFile(defaultTexTarget);
    }
  }, [defaultTexTarget, stagedFile, targetFile, texFiles]);

  const currentExportSourceFile = useMemo(() => {
    if (activeFile && files.some((f) => f.path === activeFile && f.kind === 'file' && !f.isBinary)) {
      return activeFile;
    }
    return mainFile || 'main.tex';
  }, [activeFile, files, mainFile]);

  // Step 1: Handle Export (DOCX / MD / TXT)
  const handleExport = useCallback(
    async (format: 'docx' | 'md' | 'txt') => {
      if (exportingFormat) return;
      const reqProjectId = projectId;
      setExportingFormat(format);
      setExportError(null);
      try {
        const artifact = await api.exportFormat(reqProjectId, {
          sourceScope: exportScope,
          sourceFile: exportScope === 'file' ? currentExportSourceFile : undefined,
          targetFormat: format,
          options: {
            preserveCitations: true,
            flattenInputs: exportScope === 'project',
          },
        });
        if (!mountedRef.current || activeProjectRef.current !== reqProjectId) return;

        if (format === 'docx') {
          if (!artifact.base64) {
            throw new Error(
              trRef.current(
                'Server returned empty Word (.docx) payload',
                '服务器未返回 Word (.docx) 文件数据',
              ),
            );
          }
          downloadBase64File(artifact.base64, artifact.fileName, artifact.mimeType);
          onNotify(
            'success',
            trRef.current(
              `Downloaded Word document ${artifact.fileName} (equations & citations preserved)`,
              `已下载 Word 文档 ${artifact.fileName}（保留公式与引用）`,
            ),
          );
        } else {
          downloadTextFile(artifact.text ?? '', artifact.fileName, artifact.mimeType);
          onNotify(
            'success',
            trRef.current(
              `Downloaded ${format === 'md' ? 'Markdown' : 'plain text'} file ${artifact.fileName}`,
              `已下载 ${format === 'md' ? 'Markdown' : '纯文本'} 文件 ${artifact.fileName}`,
            ),
          );
        }

        setLastExportMeta({
          fileName: artifact.fileName,
          byteLength: artifact.byteLength,
          warnings: artifact.warnings ?? [],
        });
      } catch (err: unknown) {
        if (!mountedRef.current || activeProjectRef.current !== reqProjectId) return;
        const msg =
          err instanceof Error
            ? err.message
            : trRef.current('Failed to export document', '导出文档失败');
        setExportError(msg);
        onNotify('error', msg);
      } finally {
        if (mountedRef.current && activeProjectRef.current === reqProjectId) {
          setExportingFormat(null);
        }
      }
    },
    [exportingFormat, projectId, exportScope, currentExportSourceFile, onNotify],
  );

  // Step 2: Generate LaTeX merge preview
  const runPreview = useCallback(
    async (
      fileData: StagedUploadFile,
      opts: {
        targetTex: string;
        track: 'accept' | 'reject' | 'all';
        keepPreamble: boolean;
      },
    ) => {
      if (readOnly) {
        setPreviewError(
          trRef.current(
            'Read-only permission: cannot generate merge preview or modify source files.',
            '当前为只读/仅评论权限，无法生成合入预览或修改文档正本。',
          ),
        );
        return;
      }

      const reqProjectId = projectId;
      const seq = ++previewSeqRef.current;
      opSeqRef.current += 1;
      setPreviewLoading(true);
      setPreviewError(null);
      setCleaningAi(false);
      setCleanedCode(null);
      setCleanedModel(null);
      setOptionsChangedSincePreview(false);

      try {
        const isBinaryFormat = fileData.format === 'docx' || fileData.format === 'pdf';
        const res = await api.previewImportFormat(reqProjectId, {
          sourceFormat: fileData.format,
          fileName: fileData.name,
          text: isBinaryFormat ? undefined : fileData.text,
          base64: isBinaryFormat ? fileData.base64 : undefined,
          targetMode: opts.keepPreamble ? 'merge-tex' : 'new-tex',
          targetFile: opts.targetTex,
          options: {
            preserveCitations: true,
            bodyOnly: opts.keepPreamble,
            trackChanges: fileData.format === 'docx' ? opts.track : undefined,
            mediaDir: 'figures',
          },
        });
        if (
          !mountedRef.current ||
          activeProjectRef.current !== reqProjectId ||
          seq !== previewSeqRef.current
        ) {
          return;
        }

        // If full-file replacement mode (`new-tex`), fetch existing file text for accurate red/green diff
        let originalForFallback = '';
        if (!res.mergePreview) {
          try {
            const existing = await api.readFile(reqProjectId, res.targetFile);
            if (!existing.isBinary && typeof existing.content === 'string') {
              originalForFallback = existing.content;
            }
          } catch {
            // File may not exist yet; diff against empty string
          }
        }

        if (
          !mountedRef.current ||
          activeProjectRef.current !== reqProjectId ||
          seq !== previewSeqRef.current
        ) {
          return;
        }
        setFallbackOriginalCode(originalForFallback);
        setPreviewResult(res);
      } catch (err: unknown) {
        if (
          !mountedRef.current ||
          activeProjectRef.current !== reqProjectId ||
          seq !== previewSeqRef.current
        ) {
          return;
        }
        const msg =
          err instanceof Error
            ? err.message
            : trRef.current('Failed to generate merge preview', '生成合入预览失败');
        setPreviewError(msg);
        setPreviewResult(null);
      } finally {
        if (
          mountedRef.current &&
          activeProjectRef.current === reqProjectId &&
          seq === previewSeqRef.current
        ) {
          setPreviewLoading(false);
        }
      }
    },
    [projectId, readOnly],
  );

  // Load dropped or selected file and immediately trigger preview
  const handleSelectFile = useCallback(
    async (file: File) => {
      const format = detectUploadFormat(file.name);
      if (!format) {
        const msg = trRef.current(
          'Supported formats: .docx (Word), .md (Markdown), .txt (Plain Text), or .pdf (PDF draft).',
          '支持上传 .docx（Word）、.md（Markdown）、.txt（纯文本）或 .pdf（PDF 草稿）文件',
        );
        setPreviewError(msg);
        onNotify('error', msg);
        return;
      }

      const reqProjectId = projectId;
      const seq = ++previewSeqRef.current;
      opSeqRef.current += 1;
      setPreviewError(null);
      setPreviewResult(null);
      setCleanedCode(null);
      setCleanedModel(null);

      try {
        let nextStaged: StagedUploadFile;
        if (format === 'docx' || format === 'pdf') {
          const base64 = await fileToBase64(file);
          nextStaged = {
            name: file.name,
            size: file.size,
            format,
            base64,
          };
        } else {
          const text = await file.text();
          nextStaged = {
            name: file.name,
            size: file.size,
            format,
            text,
          };
        }

        if (
          !mountedRef.current ||
          activeProjectRef.current !== reqProjectId ||
          seq !== previewSeqRef.current
        ) {
          return;
        }

        setStagedFile(nextStaged);

        if (!readOnly) {
          await runPreview(nextStaged, {
            targetTex: targetFile,
            track: trackChanges,
            keepPreamble: preservePreamble,
          });
        } else {
          setPreviewError(
            trRef.current(
              'Read-only permission: file details loaded for inspection only; merging is disabled.',
              '当前为只读/仅评论权限，仅可预览文件信息，无法合入文档。',
            ),
          );
        }
      } catch (err: unknown) {
        if (
          !mountedRef.current ||
          activeProjectRef.current !== reqProjectId ||
          seq !== previewSeqRef.current
        ) {
          return;
        }
        const msg =
          err instanceof Error
            ? err.message
            : trRef.current('Failed to read uploaded file', '读取上传文件失败');
        setPreviewError(msg);
        onNotify('error', msg);
      }
    },
    [projectId, readOnly, runPreview, targetFile, trackChanges, preservePreamble, onNotify],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);
      if (readOnly) {
        onNotify(
          'info',
          trRef.current(
            'Read-only permission: cannot merge imported files',
            '当前为只读权限，无法合入导入文件',
          ),
        );
        return;
      }
      const dropped = e.dataTransfer.files?.[0];
      if (dropped) {
        void handleSelectFile(dropped);
      }
    },
    [readOnly, handleSelectFile, onNotify],
  );

  const finalCode =
    cleanedCode ?? previewResult?.mergePreview?.mergedCode ?? previewResult?.generatedCode ?? '';

  const activeDiff = useMemo(() => {
    if (!previewResult) return null;
    if (cleanedCode !== null) {
      const base = previewResult.mergePreview?.originalCode ?? fallbackOriginalCode;
      return computeLineDiff(base, cleanedCode, previewResult.targetFile);
    }
    if (previewResult.mergePreview?.diff) {
      return previewResult.mergePreview.diff;
    }
    return computeLineDiff(fallbackOriginalCode, previewResult.generatedCode, previewResult.targetFile);
  }, [previewResult, cleanedCode, fallbackOriginalCode]);

  const handleAiCleanup = useCallback(async () => {
    if (readOnly || !previewResult || !finalCode || cleaningAi || applyingMode) return;
    const reqProjectId = projectId;
    const seq = ++opSeqRef.current;
    setCleaningAi(true);
    setPreviewError(null);
    try {
      const res = await api.runAiFix(reqProjectId, {
        mode: 'cleanup-conversion',
        filePath: previewResult.targetFile,
        sourceCode: finalCode,
      });
      if (
        !mountedRef.current ||
        activeProjectRef.current !== reqProjectId ||
        seq !== opSeqRef.current
      ) {
        return;
      }
      setCleanedCode(res.patchedCode);
      setCleanedModel(res.modelUsed);
      onNotify(
        'success',
        trRef.current(
          `AI light cleanup completed (${res.modelUsed}) — document meaning untouched`,
          `AI 轻清理转换残留完成（${res.modelUsed}），未改写正文原意`,
        ),
      );
    } catch (err: unknown) {
      if (
        !mountedRef.current ||
        activeProjectRef.current !== reqProjectId ||
        seq !== opSeqRef.current
      ) {
        return;
      }
      const msg =
        err instanceof Error
          ? err.message
          : trRef.current('AI light cleanup failed', 'AI 轻清理失败');
      setPreviewError(msg);
      onNotify('error', msg);
    } finally {
      if (
        mountedRef.current &&
        activeProjectRef.current === reqProjectId &&
        seq === opSeqRef.current
      ) {
        setCleaningAi(false);
      }
    }
  }, [readOnly, previewResult, finalCode, cleaningAi, applyingMode, projectId, onNotify]);

  const handleApply = useCallback(
    async (andCompile: boolean) => {
      if (readOnly || !previewResult || !finalCode || applyingMode || cleaningAi) return;
      const reqProjectId = projectId;
      const seq = ++opSeqRef.current;
      const appliedTargetFile = previewResult.targetFile;
      setApplyingMode(andCompile ? 'compile' : 'apply-only');
      setPreviewError(null);

      try {
        await api.applyImportFormat(reqProjectId, {
          targetFile: appliedTargetFile,
          content: finalCode,
          extractedMedia: previewResult.extractedMedia,
          commitMessage: trRef.current('Multi-format document import merge', '多格式文档无损合入'),
        });

        if (
          !mountedRef.current ||
          activeProjectRef.current !== reqProjectId ||
          seq !== opSeqRef.current
        ) {
          return;
        }

        if (!andCompile) {
          onAppliedAndCompiled(appliedTargetFile, undefined);
          onNotify(
            'success',
            trRef.current(
              `Merged cleanly into ${appliedTargetFile} (compile skipped)`,
              `已无损合入 ${appliedTargetFile}（未触发编译）`,
            ),
          );
          return;
        }

        try {
          const compileRes = await api.compile(reqProjectId, { engine });
          if (
            !mountedRef.current ||
            activeProjectRef.current !== reqProjectId ||
            seq !== opSeqRef.current
          ) {
            return;
          }
          onAppliedAndCompiled(appliedTargetFile, compileRes);
          if (compileRes.ok) {
            onNotify(
              'success',
              trRef.current(
                `Merged cleanly into ${appliedTargetFile} and refreshed PDF`,
                `已无损合入 ${appliedTargetFile} 并完成编译刷新右侧 PDF`,
              ),
            );
          } else if (compileRes.pdfReady) {
            onNotify(
              'info',
              trRef.current(
                `Merged into ${appliedTargetFile}; PDF refreshed with ${compileRes.errorCount} error(s) and ${compileRes.warningCount} warning(s)`,
                `已合入 ${appliedTargetFile}，PDF 已刷新但存在 ${compileRes.errorCount} 个错误 / ${compileRes.warningCount} 条警告`,
              ),
            );
          } else {
            onNotify(
              'error',
              trRef.current(
                `Merged into ${appliedTargetFile}, but LaTeX compilation reported ${compileRes.errorCount} error(s). Check diagnostics on the right.`,
                `已合入 ${appliedTargetFile}，但 LaTeX 编译存在 ${compileRes.errorCount} 个错误，请查看右侧诊断栏`,
              ),
            );
          }
        } catch (compileErr: unknown) {
          if (
            !mountedRef.current ||
            activeProjectRef.current !== reqProjectId ||
            seq !== opSeqRef.current
          ) {
            return;
          }
          // Import succeeded even though compile call errored — notify parent so file state stays fresh
          onAppliedAndCompiled(appliedTargetFile, undefined);
          const compileMsg =
            compileErr instanceof Error
              ? compileErr.message
              : trRef.current('Automatic compile request failed', '自动编译请求失败');
          onNotify(
            'error',
            trRef.current(
              `Merged into ${appliedTargetFile}, but compilation failed: ${compileMsg}`,
              `已合入 ${appliedTargetFile}，但编译失败：${compileMsg}`,
            ),
          );
        }
      } catch (err: unknown) {
        if (
          !mountedRef.current ||
          activeProjectRef.current !== reqProjectId ||
          seq !== opSeqRef.current
        ) {
          return;
        }
        const msg =
          err instanceof Error
            ? err.message
            : trRef.current('Failed to merge document', '合入文档失败');
        setPreviewError(msg);
        onNotify('error', msg);
      } finally {
        if (
          mountedRef.current &&
          activeProjectRef.current === reqProjectId &&
          seq === opSeqRef.current
        ) {
          setApplyingMode(null);
        }
      }
    },
    [
      readOnly,
      previewResult,
      finalCode,
      applyingMode,
      cleaningAi,
      projectId,
      engine,
      onAppliedAndCompiled,
      onNotify,
    ],
  );

  const isBusyStep2 = previewLoading || cleaningAi || applyingMode !== null;

  return (
    <section className="word-workbench">
      <div className="word-workbench-inner">
        {/* Clean Editorial Intro Header */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            marginBottom: 18,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <h2
              style={{
                margin: 0,
                fontSize: 16,
                fontWeight: 700,
                letterSpacing: '-0.02em',
                color: 'var(--text-primary)',
              }}
            >
              {tr('Word & Multi-Format Converter', 'Word 与多格式无损互转')}
            </h2>
            <span className="pill pill-accent">
              <ShieldCheck size={11} />
              {tr('Preamble & Template Locked', '导言区与模板自动锁定')}
            </span>
          </div>
          <p
            style={{
              margin: 0,
              fontSize: 12.5,
              lineHeight: 1.65,
              color: 'var(--text-muted)',
            }}
          >
            {tr(
              'Export native-OMML Word (.docx) for course submissions, lab templates, or reviewers — or drop edited .docx / .md / .txt / .pdf files back to merge safely without breaking your LaTeX preamble.',
              '一键导出含原生可编辑公式的 Word (.docx) 用于课程提交或外部审阅；拖回改完的 .docx / .md / .txt / .pdf 即可自动锁定原 LaTeX 导言区与模板并编译刷新右侧 PDF。',
            )}
          </p>
          {readOnly && (
            <div className="alert alert-warning" style={{ marginTop: 4, marginBottom: 0 }}>
              <Lock size={13} style={{ verticalAlign: '-2px', marginRight: 6 }} />
              {tr(
                'Read-only access: you can export Word / Markdown / TXT files below, but cannot merge changes back into the LaTeX source.',
                '当前为只读/批注角色：你可以随时在下方导出 Word / Markdown / TXT 文件，但无法将导入改动合回 LaTeX 正本。',
              )}
            </div>
          )}
        </div>

        {/* STEP 1 CARD: Export Editable Formats */}
        <div className="word-step-card">
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
            <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
              <span className="word-step-badge">STEP 1</span>
              <div>
                <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>
                  {tr('Export Editable Formats', '导出可编辑格式')}
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                  {tr(
                    'Generate Word (.docx) with native OMML equations and BibTeX citations, or clean Markdown & plain text',
                    '导出原生 Word 可编辑公式（OMML）与参考文献引用，或干净的 Markdown / 纯文本副本',
                  )}
                </div>
              </div>
            </div>

            <div style={{ minWidth: 210 }}>
              <select
                className="select"
                aria-label={tr('Select export scope', '选择导出范围')}
                value={exportScope}
                disabled={exportingFormat !== null}
                onChange={(e) => setExportScope(e.target.value as 'project' | 'file')}
              >
                <option value="project">
                  {tr('Full document (expand \\input files)', '整篇文档（含 \\input 子章节）')}
                </option>
                <option value="file">
                  {tr(
                    `Current file only (${currentExportSourceFile})`,
                    `仅当前文件（${currentExportSourceFile}）`,
                  )}
                </option>
              </select>
            </div>
          </div>

          <div className="word-export-grid">
            <button
              type="button"
              className="btn btn-primary"
              style={{ height: 38, padding: '0 16px', fontSize: 12.5 }}
              disabled={exportingFormat !== null}
              onClick={() => void handleExport('docx')}
            >
              {exportingFormat === 'docx' ? (
                <Loader2 size={15} className="spin" />
              ) : (
                <FileDown size={15} />
              )}
              {exportingFormat === 'docx'
                ? tr('Generating Word (.docx)…', '正在生成 Word (.docx)…')
                : tr('Download Word (.docx)', '下载 Word (.docx)')}
            </button>

            <button
              type="button"
              className="btn"
              style={{ height: 38 }}
              disabled={exportingFormat !== null}
              onClick={() => void handleExport('md')}
            >
              {exportingFormat === 'md' ? (
                <Loader2 size={14} className="spin" />
              ) : (
                <FileCode2 size={14} />
              )}
              {tr('Export Markdown (.md)', '导出 Markdown (.md)')}
            </button>

            <button
              type="button"
              className="btn"
              style={{ height: 38 }}
              disabled={exportingFormat !== null}
              onClick={() => void handleExport('txt')}
            >
              {exportingFormat === 'txt' ? (
                <Loader2 size={14} className="spin" />
              ) : (
                <Download size={14} />
              )}
              {tr('Export Plain Text (.txt)', '导出纯文本 (.txt)')}
            </button>
          </div>

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: '6px 14px',
              marginTop: 10,
              fontSize: 11.5,
              color: 'var(--text-muted)',
            }}
          >
            <span>{tr('✓ Bidirectional native Word OMML equations', '✓ 原生 Word OMML 公式可双向还原')}</span>
            <span>{tr('✓ Preserves BibTeX citations & references', '✓ 自动保留 BibTeX 参考文献引用')}</span>
            <span>{tr('✓ Supports Word Track Changes on re-import', '✓ 回传时自动识别 Word「修订」标记')}</span>
          </div>

          {exportError && (
            <div className="alert alert-danger" style={{ marginTop: 12, marginBottom: 0 }}>
              {exportError}
            </div>
          )}

          {lastExportMeta && !exportError && (
            <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div className="alert alert-success" style={{ marginBottom: 0 }}>
                {locale === 'en' ? (
                  <>
                    Exported <strong>{lastExportMeta.fileName}</strong> (
                    {(lastExportMeta.byteLength / 1024).toFixed(1)} KB). Drop the edited file into
                    Step 2 below whenever you want to merge it safely back.
                  </>
                ) : (
                  <>
                    已导出 <strong>{lastExportMeta.fileName}</strong>（
                    {(lastExportMeta.byteLength / 1024).toFixed(1)} KB），修改完成后在下方第二步拖回即可无损合入。
                  </>
                )}
              </div>
              {lastExportMeta.warnings.length > 0 && (
                <div className="alert alert-warning" style={{ marginBottom: 0 }}>
                  {lastExportMeta.warnings.map((w, idx) => (
                    <div key={idx}>• {w}</div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* STEP 2 CARD: Import & Merge Back Into LaTeX */}
        <div className="word-step-card">
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
            <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
              <span className="word-step-badge">STEP 2</span>
              <div>
                <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>
                  {tr('Import & Merge Back Into LaTeX', '导入并无损合回 LaTeX')}
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                  {tr(
                    'Inspect an exact line-by-line LaTeX diff first, then merge safely and refresh your PDF in one click',
                    '上传后立刻生成红绿 Diff 预览，确认无误再一键合入并编译刷新右侧 PDF',
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Drag-and-Drop Zone */}
          <input
            ref={fileInputRef}
            type="file"
            accept=".docx,.md,.markdown,.txt,.pdf"
            style={{ display: 'none' }}
            disabled={readOnly}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) {
                void handleSelectFile(file);
              }
              // Reset input so re-selecting a saved file with the same name always triggers onChange
              e.target.value = '';
            }}
          />

          <div
            className={`word-dropzone ${isDragging ? 'dragging' : ''}`}
            role="button"
            tabIndex={readOnly ? -1 : 0}
            aria-disabled={readOnly}
            style={readOnly ? { opacity: 0.6, cursor: 'not-allowed' } : undefined}
            onClick={() => {
              if (!readOnly && !isBusyStep2) {
                fileInputRef.current?.click();
              }
            }}
            onKeyDown={(e) => {
              if (readOnly || isBusyStep2) return;
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                fileInputRef.current?.click();
              }
            }}
            onDragEnter={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (!readOnly) setIsDragging(true);
            }}
            onDragOver={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (!readOnly && !isDragging) setIsDragging(true);
            }}
            onDragLeave={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
              setIsDragging(false);
            }}
            onDrop={handleDrop}
          >
            <UploadCloud
              size={28}
              style={{
                color: isDragging || stagedFile ? 'var(--accent)' : 'var(--text-faint)',
                marginBottom: 6,
              }}
            />
            {stagedFile ? (
              <>
                <div
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    fontSize: 13,
                    fontWeight: 600,
                    color: 'var(--text-primary)',
                    flexWrap: 'wrap',
                    justifyContent: 'center',
                  }}
                >
                  <FileText size={14} style={{ color: 'var(--accent)' }} />
                  <span>{stagedFile.name}</span>
                  <span className="pill pill-accent">.{stagedFile.format}</span>
                  <span className="pill">{(stagedFile.size / 1024).toFixed(1)} KB</span>
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 4 }}>
                  {tr(
                    'Click or drop another file to replace and re-preview',
                    '点击此处或拖入新文件即可替换重新预览',
                  )}
                </div>
              </>
            ) : (
              <>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
                  {tr(
                    'Drop .docx, .md, .txt, or .pdf here — or click to browse',
                    '将改完的 Word (.docx) / Markdown (.md) / TXT / PDF 拖放到此处，或点击选择文件',
                  )}
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 4 }}>
                  {tr(
                    'Parses Word tracked changes, OMML equations, embedded figures, or PDF draft text without breaking your LaTeX preamble',
                    '自动解析 Word 修订记录、公式、嵌入插图或 PDF 草稿文本，不会破坏你的原 LaTeX 导言区与模板',
                  )}
                </div>
              </>
            )}
          </div>

          {/* Clean Options Row */}
          <div
            style={{
              marginTop: 14,
              padding: '12px 14px',
              borderRadius: 'var(--radius-md)',
              border: '1px solid var(--border-subtle)',
              background: 'var(--bg-subtle)',
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
            }}
          >
            <div className="form-grid-2">
              <div className="field" style={{ marginBottom: 0 }}>
                <label className="field-label" htmlFor="word-collab-target-tex">
                  {tr('Target .tex File', '合入目标 .tex 文件')}
                </label>
                <select
                  id="word-collab-target-tex"
                  className="select"
                  value={targetFile}
                  disabled={isBusyStep2}
                  onChange={(e) => {
                    const nextTarget = e.target.value;
                    setTargetFile(nextTarget);
                    if (stagedFile && !readOnly) {
                      void runPreview(stagedFile, {
                        targetTex: nextTarget,
                        track: trackChanges,
                        keepPreamble: preservePreamble,
                      });
                    } else if (stagedFile) {
                      setOptionsChangedSincePreview(true);
                    }
                  }}
                >
                  {texFiles.map((f) => (
                    <option key={f} value={f}>
                      {f}
                      {f === mainFile ? tr(' (main)', '（主文件）') : ''}
                    </option>
                  ))}
                </select>
              </div>

              <div className="field" style={{ marginBottom: 0 }}>
                <label className="field-label" htmlFor="word-collab-track-changes">
                  {tr('Word Track Changes', 'Word 修订记录处理')}
                </label>
                <select
                  id="word-collab-track-changes"
                  className="select"
                  value={trackChanges}
                  disabled={isBusyStep2}
                  onChange={(e) => {
                    const nextTrack = e.target.value as 'accept' | 'reject' | 'all';
                    setTrackChanges(nextTrack);
                    if (stagedFile && !readOnly) {
                      void runPreview(stagedFile, {
                        targetTex: targetFile,
                        track: nextTrack,
                        keepPreamble: preservePreamble,
                      });
                    } else if (stagedFile) {
                      setOptionsChangedSincePreview(true);
                    }
                  }}
                >
                  <option value="accept">
                    {tr('Accept all changes (recommended)', '接受所有修订（推荐 · accept）')}
                  </option>
                  <option value="reject">
                    {tr('Reject changes, keep original', '拒绝修订，保留原稿（reject）')}
                  </option>
                  <option value="all">
                    {tr('Keep all tracked markup', '保留全部修订内容（all）')}
                  </option>
                </select>
              </div>
            </div>

            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 10,
                flexWrap: 'wrap',
                paddingTop: 8,
                borderTop: '1px solid var(--border-subtle)',
              }}
            >
              <label
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 7,
                  cursor: isBusyStep2 ? 'not-allowed' : 'pointer',
                  fontSize: 12.5,
                  fontWeight: 500,
                  color: 'var(--text-primary)',
                }}
              >
                <input
                  type="checkbox"
                  checked={preservePreamble}
                  disabled={isBusyStep2}
                  onChange={(e) => {
                    const nextKeep = e.target.checked;
                    setPreservePreamble(nextKeep);
                    if (stagedFile && !readOnly) {
                      void runPreview(stagedFile, {
                        targetTex: targetFile,
                        track: trackChanges,
                        keepPreamble: nextKeep,
                      });
                    } else if (stagedFile) {
                      setOptionsChangedSincePreview(true);
                    }
                  }}
                />
                {tr(
                  'Lock existing LaTeX preamble & template (replace body only)',
                  '保护原 LaTeX 导言区与模板（仅替换正文）',
                )}
              </label>

              {stagedFile && (
                <button
                  type="button"
                  className={`btn btn-sm ${optionsChangedSincePreview ? 'btn-primary' : ''}`}
                  disabled={readOnly || isBusyStep2}
                  onClick={() =>
                    void runPreview(stagedFile, {
                      targetTex: targetFile,
                      track: trackChanges,
                      keepPreamble: preservePreamble,
                    })
                  }
                >
                  {previewLoading ? (
                    <Loader2 size={13} className="spin" />
                  ) : (
                    <RefreshCw size={13} />
                  )}
                  {previewResult
                    ? tr('Regenerate Merge Preview', '重新生成合入预览')
                    : tr('Generate Merge Preview', '生成合入预览')}
                </button>
              )}
            </div>
          </div>

          {/* Preview Loading State */}
          {previewLoading && (
            <div
              style={{
                marginTop: 14,
                padding: '22px 16px',
                borderRadius: 'var(--radius-md)',
                border: '1px solid var(--border)',
                background: 'var(--bg-subtle)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
                color: 'var(--text-muted)',
                fontSize: 12.5,
              }}
            >
              <Loader2 size={15} className="spin" style={{ color: 'var(--accent)' }} />
              {tr(
                'Converting document and computing LaTeX merge diff…',
                '正在转换文档并计算 LaTeX 红绿合入 Diff…',
              )}
            </div>
          )}

          {/* Error Banner */}
          {previewError && (
            <div className="alert alert-danger" style={{ marginTop: 14, marginBottom: 0 }}>
              <AlertTriangle size={13} style={{ verticalAlign: '-2px', marginRight: 6 }} />
              {previewError}
            </div>
          )}

          {/* Preview Result: Warnings + Extracted Images + DiffViewer + Actions */}
          {!previewLoading && previewResult && (
            <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
              {optionsChangedSincePreview && (
                <div className="alert alert-warning" style={{ marginBottom: 0 }}>
                  {tr(
                    'Merge options changed. Click "Regenerate Merge Preview" above to refresh the diff.',
                    '合入选项已更改，请点击上方「重新生成合入预览」以刷新下方 Diff。',
                  )}
                </div>
              )}

              {previewResult.warnings.length > 0 && (
                <div className="alert alert-warning" style={{ marginBottom: 0 }}>
                  {previewResult.warnings.map((w, idx) => (
                    <div key={idx}>• {w}</div>
                  ))}
                </div>
              )}

              {previewResult.extractedMedia && previewResult.extractedMedia.length > 0 && (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    flexWrap: 'wrap',
                    gap: 6,
                    padding: '8px 11px',
                    borderRadius: 'var(--radius-sm)',
                    background: 'var(--accent-soft)',
                    border: '1px solid var(--accent-border)',
                    fontSize: 12,
                    color: 'var(--accent)',
                  }}
                >
                  <ImageIcon size={14} style={{ flexShrink: 0 }} />
                  <span style={{ fontWeight: 600 }}>
                    {tr(
                      `Extracted ${previewResult.extractedMedia.length} embedded image(s) — saved automatically on merge`,
                      `提取了 ${previewResult.extractedMedia.length} 张嵌入图片，合入时将自动保存`,
                    )}
                  </span>
                  {previewResult.extractedMedia.map((m) => (
                    <span key={m.relativePath} className="pill">
                      {m.relativePath} ({(m.byteLength / 1024).toFixed(1)} KB)
                    </span>
                  ))}
                </div>
              )}

              {activeDiff && (
                <DiffViewer
                  lines={activeDiff.lines}
                  compact={compactDiff}
                  filePath={previewResult.targetFile}
                  additions={activeDiff.additions}
                  deletions={activeDiff.deletions}
                  headerRight={
                    <>
                      {cleanedCode !== null && (
                        <>
                          <span className="pill pill-ai">
                            {tr('AI cleaned', '已 AI 轻清理')}
                            {cleanedModel ? ` · ${cleanedModel}` : ''}
                          </span>
                          <button
                            type="button"
                            className="btn btn-ghost btn-xs"
                            disabled={isBusyStep2}
                            onClick={() => {
                              setCleanedCode(null);
                              setCleanedModel(null);
                            }}
                          >
                            <RotateCcw size={11} />
                            {tr('Revert Cleanup', '恢复转换原稿')}
                          </button>
                        </>
                      )}
                      <button
                        type="button"
                        className="btn btn-ghost btn-xs"
                        onClick={() => setCompactDiff((v) => !v)}
                      >
                        {compactDiff
                          ? tr('Show Full Diff', '展开全文对比')
                          : tr('Changes Only', '仅看变更上下文')}
                      </button>
                    </>
                  }
                />
              )}

              {/* Primary & Secondary Action Bar */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 8,
                  flexWrap: 'wrap',
                  paddingTop: 4,
                }}
              >
                <button
                  type="button"
                  className="btn btn-ai"
                  disabled={readOnly || isBusyStep2 || optionsChangedSincePreview}
                  title={
                    readOnly
                      ? tr('AI cleanup is unavailable in read-only mode', '只读模式不可使用 AI 清理')
                      : tr(
                          'Lightly clean Pandoc conversion artifacts (redundant commands, table/math escaping) without rewriting your text',
                          '仅清理 Pandoc 转换残留的冗余命令与表格/公式转义，绝不改写正文原意',
                        )
                  }
                  onClick={() => void handleAiCleanup()}
                >
                  {cleaningAi ? (
                    <Loader2 size={14} className="spin" />
                  ) : (
                    <Sparkles size={14} />
                  )}
                  {cleaningAi
                    ? tr('Cleaning…', 'AI 清理中…')
                    : tr('AI Light Cleanup', 'AI 轻清理转换残留')}
                </button>

                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    className="btn"
                    disabled={readOnly || isBusyStep2 || optionsChangedSincePreview}
                    onClick={() => void handleApply(false)}
                  >
                    {applyingMode === 'apply-only' ? (
                      <Loader2 size={14} className="spin" />
                    ) : (
                      <Check size={14} />
                    )}
                    {tr('Merge Only', '仅合入不编译')}
                  </button>

                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={readOnly || isBusyStep2 || optionsChangedSincePreview}
                    onClick={() => void handleApply(true)}
                  >
                    {applyingMode === 'compile' ? (
                      <Loader2 size={14} className="spin" />
                    ) : (
                      <Play size={14} />
                    )}
                    {applyingMode === 'compile'
                      ? tr('Merging & Compiling…', '正在合入并编译…')
                      : tr('Merge & Compile PDF', '合入并编译 PDF')}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
};
