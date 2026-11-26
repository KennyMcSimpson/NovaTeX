import React, { useEffect, useMemo, useRef, useState } from 'react';
import type {
  AcademicTemplateId,
  ConvertOutputArtifact,
  FormatLayer,
  ProjectFileEntry,
} from '@novatex/shared';
import { computeLineDiff } from '../utils/diff.ts';
import {
  ArrowLeftRight,
  ArrowRight,
  Check,
  Copy,
  Download,
  FileCheck2,
  FileCode2,
  FileText,
  FileUp,
  Image as ImageIcon,
  Loader2,
  Sparkles,
  X,
} from 'lucide-react';
import {
  api,
  downloadBase64File,
  downloadTextFile,
  fileToBase64,
  type FormatImportPreviewResponse,
} from '../api.ts';
import { DiffViewer } from './DiffModal.tsx';

interface FormatHubModalProps {
  open: boolean;
  projectId: string;
  readOnly: boolean;
  activeFile: string | null;
  files: ProjectFileEntry[];
  currentEditorContent: string;
  onImportApplied: (targetFile: string) => void;
  onNotify: (kind: 'success' | 'error' | 'info', msg: string) => void;
  onClose: () => void;
}

const LAYER_META: Array<{
  id: FormatLayer;
  title: string;
  ext: string;
  role: string;
  flowAfter?: '↔' | '→';
}> = [
  { id: 'md', title: 'Markdown', ext: '.md', role: '给 AI 审校 · 保留 [@bib]', flowAfter: '↔' },
  { id: 'docx', title: 'Word / TXT', ext: '.docx / .txt', role: '给导师与审稿人批注', flowAfter: '↔' },
  { id: 'tex', title: 'LaTeX 源码', ext: '.tex', role: '论文正本 · 编译核心', flowAfter: '→' },
  { id: 'pdf', title: 'PDF 终稿', ext: '.pdf', role: '期刊会议投稿排版' },
];

export const FormatHubModal: React.FC<FormatHubModalProps> = ({
  open,
  projectId,
  readOnly,
  activeFile,
  files,
  currentEditorContent,
  onImportApplied,
  onNotify,
  onClose,
}) => {
  const [activeTab, setActiveTab] = useState<'export' | 'import'>('export');

  // Export state
  const [sourceScope, setSourceScope] = useState<'project' | 'file'>('project');
  const [sourceFile, setSourceFile] = useState<string>(activeFile ?? 'main.tex');
  const [exportTarget, setExportTarget] = useState<FormatLayer>('md');
  const [preserveCitations, setPreserveCitations] = useState(true);
  const [flattenInputs, setFlattenInputs] = useState(true);
  const [citationFormat, setCitationFormat] = useState<'natbib' | 'biblatex'>('natbib');
  const [exportTitle, setExportTitle] = useState('');
  const [exportLoading, setExportLoading] = useState(false);
  const [exportArtifact, setExportArtifact] = useState<ConvertOutputArtifact | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  // Import state
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [importSourceFormat, setImportSourceFormat] = useState<Exclude<FormatLayer, 'tex'>>('md');
  const [importFileName, setImportFileName] = useState('draft.md');
  const [importText, setImportText] = useState('');
  const [importBase64, setImportBase64] = useState<string | null>(null);
  const [targetMode, setTargetMode] = useState<'merge-tex' | 'new-tex' | 'save-md'>('merge-tex');
  const [targetFile, setTargetFile] = useState<string>(activeFile ?? 'main.tex');
  const [template, setTemplate] = useState<AcademicTemplateId>('chinese-ctex');
  const [trackChanges, setTrackChanges] = useState<'accept' | 'reject' | 'all'>('accept');
  const [extractMedia, setExtractMedia] = useState(true);
  const [importCitationFmt, setImportCitationFmt] = useState<'natbib' | 'biblatex'>('natbib');
  const [previewLoading, setPreviewLoading] = useState(false);
  const [cleaningAi, setCleaningAi] = useState(false);
  const [applying, setApplying] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [previewResult, setPreviewResult] = useState<FormatImportPreviewResponse | null>(null);
  const [cleanedCode, setCleanedCode] = useState<string | null>(null);

  const isBusy = exportLoading || previewLoading || cleaningAi || applying;

  const texFiles = useMemo(
    () => files.filter((f) => f.kind === 'file' && !f.isBinary).map((f) => f.path),
    [files],
  );

  useEffect(() => {
    if (open && activeFile) {
      setSourceFile(activeFile);
      setTargetFile(activeFile);
    }
    if (open && readOnly) {
      setActiveTab('export');
    }
  }, [open, activeFile, readOnly]);

  // Clean Escape key handler (only when not mid-submitting; no accidental backdrop dismissal)
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.isComposing && !isBusy) {
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, isBusy, onClose]);

  const finalImportCode = cleanedCode ?? previewResult?.mergePreview?.mergedCode ?? previewResult?.generatedCode ?? '';

  const activeDiff = useMemo(() => {
    if (!previewResult) return null;
    if (cleanedCode !== null) {
      const base =
        previewResult.mergePreview?.originalCode ??
        (targetMode === 'merge-tex' && targetFile === activeFile ? currentEditorContent : '');
      return computeLineDiff(base, cleanedCode, targetFile);
    }
    if (previewResult.mergePreview) {
      return previewResult.mergePreview.diff;
    }
    return computeLineDiff('', previewResult.generatedCode, previewResult.targetFile);
  }, [previewResult, cleanedCode, targetMode, targetFile, activeFile, currentEditorContent]);

  if (!open) return null;

  const handleRunExport = async () => {
    setExportLoading(true);
    setExportError(null);
    setExportArtifact(null);
    try {
      const artifact = await api.exportFormat(projectId, {
        sourceScope,
        sourceFile: sourceScope === 'file' ? sourceFile : undefined,
        targetFormat: exportTarget,
        options: {
          preserveCitations,
          flattenInputs: sourceScope === 'project' ? flattenInputs : false,
          citationFormat,
          title: exportTitle.trim() || undefined,
        },
      });
      setExportArtifact(artifact);
    } catch (err: unknown) {
      setExportError(err instanceof Error ? err.message : '格式导出失败');
    } finally {
      setExportLoading(false);
    }
  };

  const handleDownloadExport = () => {
    if (!exportArtifact) return;
    if (exportArtifact.base64) {
      downloadBase64File(exportArtifact.base64, exportArtifact.fileName, exportArtifact.mimeType);
    } else if (typeof exportArtifact.text === 'string') {
      downloadTextFile(exportArtifact.text, exportArtifact.fileName, exportArtifact.mimeType);
    }
  };

  const handleCopyExport = async () => {
    if (!exportArtifact?.text) return;
    try {
      await navigator.clipboard.writeText(exportArtifact.text);
      onNotify('success', '已复制导出文本到剪贴板');
    } catch {
      onNotify('error', '复制失败，请手动选中复制');
    }
  };

  const handleFileUpload = async (file: File) => {
    setImportFileName(file.name);
    setPreviewResult(null);
    setCleanedCode(null);
    setImportError(null);
    const lower = file.name.toLowerCase();
    if (lower.endsWith('.docx')) {
      setImportSourceFormat('docx');
      setImportText('');
      setImportBase64(await fileToBase64(file));
    } else if (lower.endsWith('.pdf')) {
      setImportSourceFormat('pdf');
      setImportText('');
      setImportBase64(await fileToBase64(file));
    } else if (lower.endsWith('.txt')) {
      setImportSourceFormat('txt');
      setImportBase64(null);
      setImportText(await file.text());
    } else {
      setImportSourceFormat('md');
      setImportBase64(null);
      setImportText(await file.text());
    }
  };

  const handlePreviewImport = async () => {
    if ((importSourceFormat === 'md' || importSourceFormat === 'txt') && !importText.trim()) {
      setImportError('请先上传文件或粘贴文本内容。');
      return;
    }
    if ((importSourceFormat === 'docx' || importSourceFormat === 'pdf') && !importBase64) {
      setImportError(`请先选择要导入的 .${importSourceFormat} 文件。`);
      return;
    }

    setPreviewLoading(true);
    setImportError(null);
    setCleanedCode(null);
    try {
      const resolvedTarget =
        targetMode === 'save-md'
          ? targetFile.endsWith('.md')
            ? targetFile
            : `${targetFile.replace(/\.[^.]+$/, '')}.md`
          : targetFile.endsWith('.tex')
            ? targetFile
            : `${targetFile}.tex`;

      const res = await api.previewImportFormat(projectId, {
        sourceFormat: importSourceFormat,
        fileName: importFileName,
        text: importBase64 ? undefined : importText,
        base64: importBase64 ?? undefined,
        targetMode,
        targetFile: resolvedTarget,
        options: {
          preserveCitations: true,
          bodyOnly: targetMode === 'merge-tex',
          template: targetMode === 'new-tex' ? template : undefined,
          trackChanges: importSourceFormat === 'docx' ? trackChanges : undefined,
          mediaDir: extractMedia ? 'figures' : undefined,
          citationFormat: importCitationFmt,
        },
      });
      setPreviewResult(res);
    } catch (err: unknown) {
      setImportError(err instanceof Error ? err.message : '导入预览生成失败');
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleDeepSeekCleanup = async () => {
    if (!previewResult || !finalImportCode) return;
    setCleaningAi(true);
    setImportError(null);
    try {
      const res = await api.runAiFix(projectId, {
        mode: 'cleanup-conversion',
        filePath: previewResult.targetFile,
        sourceCode: finalImportCode,
      });
      setCleanedCode(res.patchedCode);
      onNotify('success', `DeepSeek 轻度格式清洗完成（${res.modelUsed}）`);
    } catch (err: unknown) {
      setImportError(err instanceof Error ? err.message : 'DeepSeek 格式清洗失败');
    } finally {
      setCleaningAi(false);
    }
  };

  const handleApplyImport = async () => {
    if (readOnly || !previewResult || !finalImportCode) return;
    setApplying(true);
    setImportError(null);
    try {
      await api.applyImportFormat(projectId, {
        targetFile: previewResult.targetFile,
        content: finalImportCode,
        extractedMedia: previewResult.extractedMedia,
        commitMessage: `格式互转导入：${importFileName} -> ${previewResult.targetFile}`,
      });
      onImportApplied(previewResult.targetFile);
      onNotify('success', `已安全写入 ${previewResult.targetFile}`);
      onClose();
    } catch (err: unknown) {
      setImportError(err instanceof Error ? err.message : '写入失败');
    } finally {
      setApplying(false);
    }
  };

  const renderLayerIcon = (id: FormatLayer) => {
    if (id === 'md') return <FileCode2 size={14} />;
    if (id === 'docx') return <FileText size={14} />;
    if (id === 'tex') return <ArrowLeftRight size={14} />;
    return <FileCheck2 size={14} />;
  };

  return (
    <div className="modal-backdrop">
      <div
        className="modal-card modal-xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-format-hub-title"
      >
        <div className="modal-header">
          <h3 id="modal-format-hub-title" className="modal-title">
            <ArrowLeftRight size={16} style={{ color: 'var(--accent)' }} />
            四层科研格式无痛互转中心
          </h3>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            aria-label="关闭"
            disabled={isBusy}
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>

        <div className="modal-body">
          {/* Clean 4-Layer Visual Pipeline Flow */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              flexWrap: 'wrap',
              gap: 8,
              marginBottom: 10,
              fontSize: 11.5,
              color: 'var(--text-muted)',
            }}
          >
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 500 }}>
              <span className="pill">Markdown</span>
              <span>↔</span>
              <span className="pill">Word / TXT</span>
              <span>↔</span>
              <span className="pill pill-accent">LaTeX 正本</span>
              <ArrowRight size={12} />
              <span className="pill">PDF 终稿</span>
            </div>
            <span>
              {activeTab === 'export'
                ? '点击任意目标卡片切换导出格式'
                : '点击任意外部格式卡片切换导入源'}
            </span>
          </div>

          <div className="layer-flow">
            {LAYER_META.map((layer, index) => {
              const isSelected =
                (activeTab === 'export' &&
                  (exportTarget === layer.id || (layer.id === 'docx' && exportTarget === 'txt'))) ||
                (activeTab === 'import' &&
                  (importSourceFormat === layer.id ||
                    (layer.id === 'docx' && importSourceFormat === 'txt')));
              const isAnchor = layer.id === 'tex';
              const stepTag = isAnchor
                ? activeTab === 'export'
                  ? '源 · 核心正本'
                  : '目标 · 核心正本'
                : `LAYER ${index + 1}${layer.flowAfter ? ` · ${layer.flowAfter}` : ''}`;

              return (
                <button
                  key={layer.id}
                  type="button"
                  className={`layer-node ${isSelected ? 'active' : ''}`}
                  style={
                    isAnchor
                      ? {
                          borderStyle: 'dashed',
                          borderColor: 'var(--accent-border)',
                        }
                      : undefined
                  }
                  onClick={() => {
                    if (activeTab === 'export') {
                      if (layer.id !== 'tex') setExportTarget(layer.id);
                    } else if (layer.id !== 'tex') {
                      setImportSourceFormat(layer.id);
                      setPreviewResult(null);
                    }
                  }}
                >
                  <div
                    className="layer-node-step"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 6,
                      color: isAnchor ? 'var(--accent)' : undefined,
                    }}
                  >
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                      {renderLayerIcon(layer.id)}
                      <span>{stepTag}</span>
                    </span>
                    {isSelected && <Check size={12} style={{ color: 'var(--accent)' }} />}
                  </div>
                  <div className="layer-node-title" style={{ marginTop: 4 }}>
                    {layer.title}{' '}
                    <span
                      style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 11,
                        fontWeight: 500,
                        opacity: 0.72,
                      }}
                    >
                      {layer.ext}
                    </span>
                  </div>
                  <div className="layer-node-sub">{layer.role}</div>
                </button>
              );
            })}
          </div>

          <div className="tab-bar">
            <button
              type="button"
              className={`tab-btn ${activeTab === 'export' ? 'active' : ''}`}
              onClick={() => setActiveTab('export')}
            >
              导出当前项目 / 章节（LaTeX → MD / Word / TXT / PDF）
            </button>
            <button
              type="button"
              className={`tab-btn ${activeTab === 'import' ? 'active' : ''}`}
              disabled={readOnly}
              title={readOnly ? '当前为只读/仅评论权限，仅支持导出文档' : undefined}
              onClick={() => setActiveTab('import')}
            >
              导入并局部回灌（MD / Word / TXT / PDF → LaTeX）{readOnly ? ' · 需编辑权限' : ''}
            </button>
          </div>

          {activeTab === 'export' ? (
            <div>
              <div
                style={{
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-md)',
                  padding: '14px 16px',
                  background: 'var(--bg-subtle)',
                  marginBottom: 14,
                }}
              >
                <div className="form-grid-2">
                  <div className="field">
                    <label className="field-label">导出源范围</label>
                    <select
                      className="select"
                      value={sourceScope}
                      onChange={(e) => setSourceScope(e.target.value as 'project' | 'file')}
                    >
                      <option value="project">整个项目（自动展平 \input / \include）</option>
                      <option value="file">单个文件</option>
                    </select>
                  </div>

                  <div className="field">
                    <label className="field-label">目标格式</label>
                    <select
                      className="select"
                      value={exportTarget}
                      onChange={(e) => setExportTarget(e.target.value as FormatLayer)}
                    >
                      <option value="md">Markdown (.md · 适合交给 AI 审校)</option>
                      <option value="docx">Word (.docx · 内置中文学术样式模板)</option>
                      <option value="txt">纯文本 (.txt · 含中英学术字数统计)</option>
                      <option value="pdf">PDF (.pdf · 当前编译终稿)</option>
                    </select>
                  </div>
                </div>

                {sourceScope === 'file' && (
                  <div className="field">
                    <label className="field-label">选择源文件</label>
                    <select
                      className="select"
                      value={sourceFile}
                      onChange={(e) => setSourceFile(e.target.value)}
                    >
                      {texFiles.map((f) => (
                        <option key={f} value={f}>
                          {f}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                <div className="form-grid-2">
                  <div className="field" style={{ marginBottom: 0 }}>
                    <label className="field-label">导出标题（可选）</label>
                    <input
                      className="input"
                      placeholder="留空则沿用项目标题"
                      value={exportTitle}
                      onChange={(e) => setExportTitle(e.target.value)}
                    />
                  </div>
                  <div className="field" style={{ marginBottom: 0 }}>
                    <label className="field-label">引用风格</label>
                    <select
                      className="select"
                      value={citationFormat}
                      onChange={(e) => setCitationFormat(e.target.value as 'natbib' | 'biblatex')}
                    >
                      <option value="natbib">natbib (\cite / \citep)</option>
                      <option value="biblatex">biblatex (\autocite)</option>
                    </select>
                  </div>
                </div>

                <div
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: '10px 20px',
                    marginTop: 12,
                    paddingTop: 12,
                    borderTop: '1px solid var(--border-subtle)',
                  }}
                >
                  <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={preserveCitations}
                      onChange={(e) => setPreserveCitations(e.target.checked)}
                    />
                    保留 <code>[@bibkey]</code> 学术引用标记
                  </label>
                  {sourceScope === 'project' && (
                    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={flattenInputs}
                        onChange={(e) => setFlattenInputs(e.target.checked)}
                      />
                      自动展平 <code>\input</code> / <code>\include</code> 子章节
                    </label>
                  )}
                </div>
              </div>

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={exportLoading}
                  onClick={() => void handleRunExport()}
                >
                  {exportLoading ? <Loader2 size={14} className="spin" /> : <ArrowLeftRight size={14} />}
                  生成导出预览
                </button>
                {exportArtifact && (
                  <>
                    <button type="button" className="btn" onClick={handleDownloadExport}>
                      <Download size={14} />
                      下载 {exportArtifact.fileName}
                    </button>
                    {exportArtifact.text && (
                      <button type="button" className="btn" onClick={() => void handleCopyExport()}>
                        <Copy size={14} />
                        一键复制全文
                      </button>
                    )}
                  </>
                )}
              </div>

              {exportError && <div className="alert alert-danger">{exportError}</div>}

              {exportArtifact && (
                <div>
                  {exportArtifact.wordCount && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
                      <span className="pill pill-accent">
                        中文字符：{exportArtifact.wordCount.cjkChars}
                      </span>
                      <span className="pill pill-accent">
                        英文词数：{exportArtifact.wordCount.latinWords}
                      </span>
                      <span className="pill pill-success">
                        学术总词数：{exportArtifact.wordCount.totalAcademicWords}
                      </span>
                      <span className="pill">
                        行数：{exportArtifact.wordCount.lines}
                      </span>
                      <span className="pill">
                        大小：{(exportArtifact.byteLength / 1024).toFixed(1)} KB
                      </span>
                    </div>
                  )}

                  {exportArtifact.warnings.length > 0 && (
                    <div className="alert alert-warning">
                      {exportArtifact.warnings.map((w, i) => (
                        <div key={i}>• {w}</div>
                      ))}
                    </div>
                  )}

                  {typeof exportArtifact.text === 'string' ? (
                    <textarea
                      className="textarea"
                      rows={12}
                      readOnly
                      value={exportArtifact.text}
                    />
                  ) : (
                    <div className="alert alert-success">
                      已生成二进制文档 <strong>{exportArtifact.fileName}</strong>（
                      {(exportArtifact.byteLength / 1024).toFixed(1)} KB），点击上方「下载」按钮保存。
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div>
              <div
                style={{
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-md)',
                  padding: '14px 16px',
                  background: 'var(--bg-subtle)',
                  marginBottom: 14,
                }}
              >
                <div className="form-grid-2">
                  <div className="field">
                    <label className="field-label">导入源格式</label>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <select
                        className="select"
                        value={importSourceFormat}
                        onChange={(e) => {
                          setImportSourceFormat(e.target.value as Exclude<FormatLayer, 'tex'>);
                          setPreviewResult(null);
                        }}
                      >
                        <option value="md">Markdown (.md)</option>
                        <option value="docx">Word 文档 (.docx)</option>
                        <option value="txt">纯文本 (.txt)</option>
                        <option value="pdf">PDF 轻量文本抽取 (.pdf)</option>
                      </select>
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept=".md,.markdown,.docx,.txt,.pdf"
                        style={{ display: 'none' }}
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f) void handleFileUpload(f);
                        }}
                      />
                      <button
                        type="button"
                        className="btn"
                        onClick={() => fileInputRef.current?.click()}
                      >
                        <FileUp size={14} />
                        选择文件
                      </button>
                    </div>
                  </div>

                  <div className="field">
                    <label className="field-label">回灌 / 写入方式</label>
                    <select
                      className="select"
                      value={targetMode}
                      onChange={(e) => {
                        setTargetMode(e.target.value as 'merge-tex' | 'new-tex' | 'save-md');
                        setPreviewResult(null);
                      }}
                    >
                      <option value="merge-tex">
                        局部回灌到现有 .tex（保留模板 Preamble，先看红绿 Diff）
                      </option>
                      <option value="new-tex">套用学术模板新建 .tex</option>
                      <option value="save-md">保存为项目内 .md 文件</option>
                    </select>
                  </div>
                </div>

                <div className="form-grid-2">
                  <div className="field" style={{ marginBottom: importSourceFormat === 'docx' ? 12 : 0 }}>
                    <label className="field-label">目标文件路径</label>
                    {targetMode === 'merge-tex' && texFiles.length > 0 ? (
                      <select
                        className="select"
                        value={targetFile}
                        onChange={(e) => setTargetFile(e.target.value)}
                      >
                        {texFiles.map((f) => (
                          <option key={f} value={f}>
                            {f}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        className="input"
                        value={targetFile}
                        onChange={(e) => setTargetFile(e.target.value)}
                        placeholder={targetMode === 'save-md' ? 'notes/draft.md' : 'sections/imported.tex'}
                      />
                    )}
                  </div>

                  {targetMode === 'new-tex' ? (
                    <div className="field" style={{ marginBottom: importSourceFormat === 'docx' ? 12 : 0 }}>
                      <label className="field-label">学术模板</label>
                      <select
                        className="select"
                        value={template}
                        onChange={(e) => setTemplate(e.target.value as AcademicTemplateId)}
                      >
                        <option value="chinese-ctex">中文学术论文（ctexart + XeLaTeX）</option>
                        <option value="ieee-conf">IEEE 会议双栏模板（IEEEtran）</option>
                        <option value="clean-article">极简通用英文论文（article）</option>
                      </select>
                    </div>
                  ) : (
                    <div className="field" style={{ marginBottom: importSourceFormat === 'docx' ? 12 : 0 }}>
                      <label className="field-label">引用转换格式</label>
                      <select
                        className="select"
                        value={importCitationFmt}
                        onChange={(e) => setImportCitationFmt(e.target.value as 'natbib' | 'biblatex')}
                      >
                        <option value="natbib">natbib (\cite)</option>
                        <option value="biblatex">biblatex (\autocite)</option>
                      </select>
                    </div>
                  )}
                </div>

                {importSourceFormat === 'docx' && (
                  <div className="form-grid-2">
                    <div className="field" style={{ marginBottom: 0 }}>
                      <label className="field-label">Word 修订（Track Changes）处理</label>
                      <select
                        className="select"
                        value={trackChanges}
                        onChange={(e) =>
                          setTrackChanges(e.target.value as 'accept' | 'reject' | 'all')
                        }
                      >
                        <option value="accept">接受所有修订（推荐）</option>
                        <option value="reject">拒绝修订（保留原稿）</option>
                        <option value="all">保留修订标记</option>
                      </select>
                    </div>
                    <div className="field" style={{ justifyContent: 'flex-end', marginBottom: 0 }}>
                      <label
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 6,
                          cursor: 'pointer',
                          marginBottom: 8,
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={extractMedia}
                          onChange={(e) => setExtractMedia(e.target.checked)}
                        />
                        自动抽取文档插图至 <code>figures/</code>
                      </label>
                    </div>
                  </div>
                )}
              </div>

              {importSourceFormat === 'md' || importSourceFormat === 'txt' ? (
                <div className="field">
                  <label className="field-label">
                    粘贴 {importSourceFormat.toUpperCase()} 内容（或点击上方「选择文件」）
                  </label>
                  <textarea
                    className="textarea"
                    rows={6}
                    placeholder="在此粘贴 Markdown 或纯文本草稿，支持 [@citekey] 引用与 $公式$..."
                    value={importText}
                    onChange={(e) => {
                      setImportText(e.target.value);
                      setImportBase64(null);
                    }}
                  />
                </div>
              ) : (
                <div className="alert alert-accent">
                  {importBase64
                    ? `已载入文件：${importFileName}（准备转换预览）`
                    : `请点击上方「选择文件」上传 .${importSourceFormat} 文件。`}
                </div>
              )}

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={previewLoading}
                  onClick={() => void handlePreviewImport()}
                >
                  {previewLoading ? <Loader2 size={14} className="spin" /> : <ArrowLeftRight size={14} />}
                  生成红绿 Diff 预览
                </button>

                {previewResult && (
                  <>
                    <button
                      type="button"
                      className="btn btn-ai"
                      disabled={cleaningAi}
                      onClick={() => void handleDeepSeekCleanup()}
                      title="由 DeepSeek 对转换后的 LaTeX 做轻度表格/公式/转义清洗，绝不改写文意"
                    >
                      {cleaningAi ? <Loader2 size={14} className="spin" /> : <Sparkles size={14} />}
                      DeepSeek 轻度格式清洗
                    </button>
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={readOnly || applying}
                      onClick={() => void handleApplyImport()}
                    >
                      {applying ? <Loader2 size={14} className="spin" /> : <Check size={14} />}
                      确认写入 {previewResult.targetFile}
                    </button>
                  </>
                )}
              </div>

              {importError && <div className="alert alert-danger">{importError}</div>}

              {previewResult && (
                <div>
                  {previewResult.warnings.length > 0 && (
                    <div className="alert alert-warning">
                      {previewResult.warnings.map((w, i) => (
                        <div key={i}>• {w}</div>
                      ))}
                    </div>
                  )}

                  {previewResult.extractedMedia && previewResult.extractedMedia.length > 0 && (
                    <div
                      style={{
                        display: 'flex',
                        flexWrap: 'wrap',
                        gap: 6,
                        marginBottom: 10,
                        alignItems: 'center',
                      }}
                    >
                      <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                        <ImageIcon size={13} style={{ verticalAlign: 'middle', marginRight: 4 }} />
                        自动抽取插图：
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
                      compact
                      filePath={previewResult.targetFile}
                      additions={activeDiff.additions}
                      deletions={activeDiff.deletions}
                      headerRight={
                        cleanedCode !== null ? (
                          <span className="pill pill-ai">已应用 DeepSeek 格式清洗</span>
                        ) : undefined
                      }
                    />
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button type="button" className="btn" disabled={isBusy} onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
};
