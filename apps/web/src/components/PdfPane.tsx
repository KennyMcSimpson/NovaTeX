import React, { useCallback, useEffect, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist/types/src/display/api';
import type { CompileResult, SyncTeXBox, SyncTeXForwardResult } from '@novatex/shared';
import {
  AlertCircle,
  AlertTriangle,
  Download,
  FileText,
  Info,
  Loader2,
  Maximize2,
  Play,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { useLocale } from '../i18n.ts';

const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff]/;

// Required Vite worker resolution for pdfjs-dist v4
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

export interface PdfPaneProps {
  pdfUrl: string | null;
  pdfVersion: number;
  compiling: boolean;
  readOnly?: boolean;
  compileResult: CompileResult | null;
  synctexHighlight: SyncTeXForwardResult | null;
  onInverseSync: (page: number, x: number, y: number) => void;
  onTriggerCompile: () => void;
}

interface PdfPageCanvasProps {
  pdfDoc: PDFDocumentProxy;
  pageNumber: number;
  scale: number;
  highlights: SyncTeXBox[];
  onInverseSync: (page: number, x: number, y: number) => void;
  onVisible: (pageNumber: number) => void;
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function getBasePdfPath(url: string | null): string | null {
  if (!url) return null;
  const qIndex = url.indexOf('?');
  return qIndex >= 0 ? url.slice(0, qIndex) : url;
}

const PdfPageCanvas: React.FC<PdfPageCanvasProps> = ({
  pdfDoc,
  pageNumber,
  scale,
  highlights,
  onInverseSync,
  onVisible,
}) => {
  const { tr } = useLocale();
  const cardRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [baseSize, setBaseSize] = useState<{ width: number; height: number }>({
    width: 595,
    height: 842,
  });
  const [isNearViewport, setIsNearViewport] = useState(pageNumber <= 3);

  const cssWidth = Math.floor(baseSize.width * scale);
  const cssHeight = Math.floor(baseSize.height * scale);

  useEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setIsNearViewport(true);
            if (entry.intersectionRatio >= 0.35) {
              onVisible(pageNumber);
            }
          }
        }
      },
      { rootMargin: '360px 0px', threshold: [0.05, 0.35] },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [pageNumber, onVisible]);

  useEffect(() => {
    if (!isNearViewport) return;
    let cancelled = false;
    let renderTask: RenderTask | null = null;

    (async () => {
      try {
        const page = await pdfDoc.getPage(pageNumber);
        if (cancelled) return;
        const unitViewport = page.getViewport({ scale: 1 });
        setBaseSize((prev) =>
          Math.abs(prev.width - unitViewport.width) > 0.5 ||
          Math.abs(prev.height - unitViewport.height) > 0.5
            ? { width: unitViewport.width, height: unitViewport.height }
            : prev,
        );

        const viewport = page.getViewport({ scale });
        const targetWidth = Math.floor(viewport.width);
        const targetHeight = Math.floor(viewport.height);

        const canvas = canvasRef.current;
        if (!canvas) return;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = Math.floor(targetWidth * dpr);
        canvas.height = Math.floor(targetHeight * dpr);
        canvas.style.width = `${targetWidth}px`;
        canvas.style.height = `${targetHeight}px`;

        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        renderTask = page.render({
          canvasContext: ctx,
          viewport,
        });
        await renderTask.promise;
      } catch (err: unknown) {
        if (err instanceof Error && err.name === 'RenderingCancelledException') return;
      }
    })();

    return () => {
      cancelled = true;
      try {
        renderTask?.cancel();
      } catch {
        // ignore cancel error
      }
    };
  }, [pdfDoc, pageNumber, scale, isNearViewport]);

  const handleDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const clickX = (e.clientX - rect.left) / scale;
    const clickY = (e.clientY - rect.top) / scale;
    onInverseSync(pageNumber, clickX, clickY);
  };

  return (
    <div
      ref={cardRef}
      data-pdf-page={pageNumber}
      className="pdf-page-card"
      style={{ width: cssWidth, height: cssHeight }}
      onDoubleClick={handleDoubleClick}
      title={tr(
        'Double-click PDF to jump to source (Inverse SyncTeX)',
        '双击 PDF 反向跳转至源码（Inverse SyncTeX）',
      )}
    >
      <canvas ref={canvasRef} />
      {highlights.map((box, idx) => (
        <div
          key={`${pageNumber}-${idx}-${box.x}-${box.y}`}
          className="synctex-highlight"
          style={{
            left: `${box.x * scale}px`,
            top: `${Math.max(0, box.y * scale)}px`,
            width: `${Math.max(24, box.width * scale)}px`,
            height: `${Math.max(12, box.height * scale)}px`,
          }}
        />
      ))}
      <div className="pdf-page-number">{pageNumber}</div>
    </div>
  );
};

export const PdfPane: React.FC<PdfPaneProps> = ({
  pdfUrl,
  pdfVersion,
  compiling,
  readOnly = false,
  compileResult,
  synctexHighlight,
  onInverseSync,
  onTriggerCompile,
}) => {
  const { locale, tr } = useLocale();
  const trRef = useRef(tr);
  trRef.current = tr;
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const pdfDocRef = useRef<PDFDocumentProxy | null>(null);
  const hasManualZoomRef = useRef(false);
  const lastBasePdfPathRef = useRef<string | null>(null);

  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [scale, setScale] = useState(1.1);
  const [loadingPdf, setLoadingPdf] = useState(false);
  const [pdfError, setPdfError] = useState<string | null>(null);

  useEffect(() => {
    const nextBasePath = getBasePdfPath(pdfUrl);
    if (nextBasePath !== lastBasePdfPathRef.current) {
      lastBasePdfPathRef.current = nextBasePath;
      hasManualZoomRef.current = false;
    }

    if (!pdfUrl) {
      const prev = pdfDocRef.current;
      pdfDocRef.current = null;
      setPdfDoc(null);
      setNumPages(0);
      setPdfError(null);
      if (prev) void prev.destroy();
      return;
    }

    let cancelled = false;
    setLoadingPdf(true);
    setPdfError(null);

    const loadingTask = pdfjsLib.getDocument({
      url: pdfUrl,
      withCredentials: true,
      disableAutoFetch: true,
      disableStream: false,
      rangeChunkSize: 65536,
    });

    loadingTask.promise
      .then((doc) => {
        if (cancelled) {
          void doc.destroy();
          return;
        }
        const prev = pdfDocRef.current;
        pdfDocRef.current = doc;
        setPdfDoc(doc);
        if (prev && prev !== doc) {
          void prev.destroy();
        }
        setNumPages(doc.numPages);
        setCurrentPage((p) => Math.min(Math.max(1, p), doc.numPages));
        setLoadingPdf(false);

        // Auto-fit A4 page cleanly to the drafting-table viewport on initial document load
        if (!hasManualZoomRef.current) {
          void doc
            .getPage(1)
            .then((firstPage) => {
              const baseViewport = firstPage.getViewport({ scale: 1 });
              const avail = (viewportRef.current?.clientWidth ?? 0) - 48;
              if (!cancelled && !hasManualZoomRef.current && avail > 180 && baseViewport.width > 0) {
                const fitted = Math.max(0.55, Math.min(1.35, avail / baseViewport.width));
                setScale(Number(fitted.toFixed(2)));
              }
            })
            .catch(() => {
              // keep default scale if viewport not measurable yet
            });
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadingPdf(false);
        const msg = err instanceof Error ? err.message : trRef.current('Failed to load PDF', 'PDF 加载失败');
        if (msg.includes('404') || msg.includes('Missing PDF')) {
          const prev = pdfDocRef.current;
          pdfDocRef.current = null;
          setPdfDoc(null);
          setNumPages(0);
          if (prev) void prev.destroy();
        } else {
          setPdfError(msg);
        }
      });

    return () => {
      cancelled = true;
      void loadingTask.destroy();
    };
  }, [pdfUrl, pdfVersion]);

  // Cleanup doc on unmount
  useEffect(() => {
    return () => {
      const current = pdfDocRef.current;
      pdfDocRef.current = null;
      if (current) void current.destroy();
    };
  }, []);

  // Scroll to SyncTeX forward target page
  useEffect(() => {
    if (!synctexHighlight?.found || synctexHighlight.boxes.length === 0) return;
    const firstBox = synctexHighlight.boxes[0];
    if (!firstBox || !viewportRef.current) return;
    const pageEl = viewportRef.current.querySelector<HTMLElement>(
      `[data-pdf-page="${firstBox.page}"]`,
    );
    if (pageEl) {
      pageEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setCurrentPage(firstBox.page);
    }
  }, [synctexHighlight]);

  const handleZoomOut = useCallback(() => {
    hasManualZoomRef.current = true;
    setScale((s) => Math.max(0.5, Number((s - 0.15).toFixed(2))));
  }, []);

  const handleZoomIn = useCallback(() => {
    hasManualZoomRef.current = true;
    setScale((s) => Math.min(2.6, Number((s + 0.15).toFixed(2))));
  }, []);

  const handleResetZoom = useCallback(() => {
    hasManualZoomRef.current = true;
    setScale(1.0);
  }, []);

  const handleFitWidth = useCallback(async () => {
    if (!pdfDoc || !viewportRef.current) return;
    try {
      const page = await pdfDoc.getPage(currentPage);
      const baseViewport = page.getViewport({ scale: 1 });
      const availableWidth = viewportRef.current.clientWidth - 48;
      if (availableWidth > 160 && baseViewport.width > 0) {
        const nextScale = Math.max(0.5, Math.min(2.5, availableWidth / baseViewport.width));
        hasManualZoomRef.current = true;
        setScale(Number(nextScale.toFixed(2)));
      }
    } catch {
      // ignore
    }
  }, [pdfDoc, currentPage]);

  const zoomPercent = Math.round(scale * 100);
  const compilerMissing = Boolean(compileResult && !compileResult.compilerAvailable);
  const safeCompilerNote =
    compileResult?.compilerNote && (locale === 'zh' || !CJK_RE.test(compileResult.compilerNote))
      ? compileResult.compilerNote
      : null;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        minHeight: 0,
        overflow: 'hidden',
      }}
    >
      {/* Ultra-Clean 38px Overleaf Emerald Compile Bar — Always Spacious Even at 280px */}
      <div className="pdf-toolbar">
        <div className="pane-toolbar-group" style={{ gap: 8 }}>
          <button
            type="button"
            className="btn btn-compile"
            disabled={compiling || readOnly}
            onClick={onTriggerCompile}
            title={
              readOnly
                ? tr(
                    'Read-only / commenter role cannot trigger compilation',
                    '当前为只读/仅评论权限，无法触发编译',
                  )
                : tr(
                    'Compile PDF (Ctrl+S / Ctrl+Enter)',
                    '重新编译 PDF（快捷键 Ctrl+S / Ctrl+Enter）',
                  )
            }
          >
            {compiling ? (
              <Loader2 size={13} className="spin" />
            ) : (
              <Play size={12} fill="currentColor" />
            )}
            {tr('Compile PDF', '编译 PDF')}
          </button>

          {compiling ? (
            <span
              className="pill pill-accent"
              style={{ height: 22 }}
              title={tr('Compiling document with TeX engine', '正在调用 TeX 引擎编译当前文档')}
            >
              <Loader2 size={11} className="spin" />
              {tr('Compiling…', '编译中…')}
            </span>
          ) : compileResult ? (
            compileResult.errorCount > 0 ? (
              <span
                className="pill pill-danger"
                style={{ height: 22 }}
                title={tr(
                  `${compileResult.errorCount} ${compileResult.errorCount === 1 ? 'error' : 'errors'}${
                    compileResult.warningCount > 0
                      ? `, ${compileResult.warningCount} ${compileResult.warningCount === 1 ? 'warning' : 'warnings'}`
                      : ''
                  }`,
                  `发现 ${compileResult.errorCount} 个编译错误${
                    compileResult.warningCount > 0 ? `，${compileResult.warningCount} 个警告` : ''
                  }`,
                )}
              >
                <AlertCircle size={11} />
                {tr(
                  `${compileResult.errorCount} ${compileResult.errorCount === 1 ? 'error' : 'errors'}`,
                  `${compileResult.errorCount} 错误`,
                )}
              </span>
            ) : compileResult.warningCount > 0 ? (
              <span
                className="pill pill-warning"
                style={{ height: 22 }}
                title={tr(
                  `Compiled with ${compileResult.warningCount} ${compileResult.warningCount === 1 ? 'warning' : 'warnings'} (${formatDuration(
                    compileResult.durationMs,
                  )})`,
                  `编译完成，含 ${compileResult.warningCount} 个警告（${formatDuration(
                    compileResult.durationMs,
                  )}）`,
                )}
              >
                <AlertTriangle size={11} />
                {tr(
                  `${compileResult.warningCount} ${compileResult.warningCount === 1 ? 'warning' : 'warnings'}`,
                  `${compileResult.warningCount} 警告`,
                )}
              </span>
            ) : compileResult.ok ? (
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 5,
                  fontSize: 11.5,
                  fontWeight: 500,
                  color: 'var(--success)',
                  whiteSpace: 'nowrap',
                  flexShrink: 0,
                }}
                title={tr(
                  `Compiled successfully (${formatDuration(compileResult.durationMs)})`,
                  `编译成功（${formatDuration(compileResult.durationMs)}）`,
                )}
              >
                <span
                  aria-hidden="true"
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    background: 'var(--success)',
                    boxShadow: '0 0 0 2px var(--success-soft)',
                    flexShrink: 0,
                  }}
                />
                {tr('Compiled', '已编译')}
              </span>
            ) : (
              <span
                className="pill pill-warning"
                style={{ height: 22 }}
                title={safeCompilerNote || tr('Compilation did not finish', '编译未完成')}
              >
                <AlertTriangle size={11} />
                {tr('Not ready', '未就绪')}
              </span>
            )
          ) : null}
        </div>

        <div className="pane-toolbar-actions" style={{ gap: 2 }}>
          <span
            className="btn btn-ghost btn-icon-sm"
            style={{ cursor: 'help', color: 'var(--text-faint)' }}
            title={tr(
              'Double-click PDF to jump to source (Inverse SyncTeX)',
              '双击 PDF 反向跳转至源码（Inverse SyncTeX）',
            )}
            aria-label={tr('Double-click PDF to jump to source', '双击 PDF 反向跳转至源码')}
            tabIndex={0}
          >
            <Info size={13} />
          </span>

          {pdfUrl && pdfDoc ? (
            <a
              href={pdfUrl}
              download="document.pdf"
              className="btn btn-ghost btn-icon-sm"
              style={{ textDecoration: 'none' }}
              title={tr('Download PDF', '下载 PDF')}
              aria-label={tr('Download PDF', '下载 PDF')}
            >
              <Download size={14} />
            </a>
          ) : (
            <button
              type="button"
              className="btn btn-ghost btn-icon-sm"
              disabled
              title={tr('Compile PDF first to download', '编译生成 PDF 后可下载')}
              aria-label={tr('Download PDF', '下载 PDF')}
            >
              <Download size={14} />
            </button>
          )}
        </div>
      </div>

      {/* Drafting-Table Viewport + Floating Glassmorphic Zoom Dock */}
      <div
        className="pdf-viewport-wrap"
        style={{
          position: 'relative',
          flex: 1,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <div ref={viewportRef} className="pdf-viewport">
          {compilerMissing ? (
            <div className="empty-state-card">
              <div
                style={{
                  width: 46,
                  height: 46,
                  margin: '0 auto',
                  borderRadius: 12,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: 'var(--warning-soft)',
                  border: '1px solid var(--warning-border)',
                  color: 'var(--warning)',
                }}
              >
                <AlertTriangle size={22} />
              </div>
              <h3>{tr('TeX Compiler Not Detected', '当前未检测到 TeX 编译器')}</h3>
              <p>
                {safeCompilerNote ||
                  tr(
                    'No local or remote TeX Live engine (xelatex / pdflatex / lualatex) was found. You can still edit documents, run AI formatting fixes, and convert across formats.',
                    '本机或远端编译节点尚未安装 TeX Live（xelatex / pdflatex / lualatex）。你仍可继续编辑文档、使用 AI 格式修复与四层格式互转。',
                  )}
              </p>
              <button
                type="button"
                className="btn btn-compile"
                disabled={readOnly}
                title={
                  readOnly
                    ? tr(
                        'Read-only / commenter role cannot trigger compilation',
                        '当前为只读/仅评论权限，无法触发编译',
                      )
                    : undefined
                }
                onClick={onTriggerCompile}
              >
                <Play size={12} fill="currentColor" />
                {tr('Re-check & Compile', '重新检测并编译')}
              </button>
            </div>
          ) : pdfError ? (
            <div className="empty-state-card">
              <div
                style={{
                  width: 46,
                  height: 46,
                  margin: '0 auto',
                  borderRadius: 12,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: 'var(--danger-soft)',
                  border: '1px solid var(--danger-border)',
                  color: 'var(--danger)',
                }}
              >
                <AlertCircle size={22} />
              </div>
              <h3>{tr('PDF Preview Error', 'PDF 预览加载异常')}</h3>
              <p style={{ wordBreak: 'break-word' }}>{pdfError}</p>
              <button
                type="button"
                className="btn btn-compile"
                disabled={readOnly}
                title={
                  readOnly
                    ? tr(
                        'Read-only / commenter role cannot trigger compilation',
                        '当前为只读/仅评论权限，无法触发编译',
                      )
                    : undefined
                }
                onClick={onTriggerCompile}
              >
                <Play size={12} fill="currentColor" />
                {tr('Recompile PDF', '重新编译 PDF')}
              </button>
            </div>
          ) : pdfDoc ? (
            Array.from({ length: numPages }, (_, i) => i + 1).map((pageNum) => {
              const pageBoxes = synctexHighlight?.found
                ? synctexHighlight.boxes.filter((b) => b.page === pageNum)
                : [];
              return (
                <PdfPageCanvas
                  key={`${pdfVersion}-${pageNum}`}
                  pdfDoc={pdfDoc}
                  pageNumber={pageNum}
                  scale={scale}
                  highlights={pageBoxes}
                  onInverseSync={onInverseSync}
                  onVisible={setCurrentPage}
                />
              );
            })
          ) : loadingPdf || compiling ? (
            <div className="empty-state-card">
              <div
                style={{
                  width: 46,
                  height: 46,
                  margin: '0 auto',
                  borderRadius: 12,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: 'var(--accent-soft)',
                  border: '1px solid var(--accent-border)',
                  color: 'var(--accent)',
                }}
              >
                <Loader2 size={22} className="spin" />
              </div>
              <h3>
                {compiling
                  ? tr('Compiling LaTeX document…', '正在编译 LaTeX 文档…')
                  : tr('Streaming PDF…', '正在流式加载 PDF…')}
              </h3>
              <p>
                {compiling
                  ? tr(
                      'Running TeX typesetting and SyncTeX indexing. High-DPI preview will appear automatically once done.',
                      '正在执行 TeX 排版与 SyncTeX 索引生成，完成后将自动呈现高清文档预览。',
                    )
                  : tr(
                      'Streaming pages on demand via HTTP Range requests for fast first-page display.',
                      '采用按页分块 HTTP Range 流式传输，低带宽链路也能快速呈现首页。',
                    )}
              </p>
            </div>
          ) : (
            <div className="empty-state-card">
              <div
                style={{
                  width: 46,
                  height: 46,
                  margin: '0 auto',
                  borderRadius: 12,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: 'var(--bg-subtle)',
                  border: '1px solid var(--border)',
                  color: 'var(--text-muted)',
                }}
              >
                <FileText size={22} strokeWidth={1.6} />
              </div>
              <h3>{tr('No PDF Preview Yet', '尚未生成 PDF 预览')}</h3>
              <p>
                {readOnly
                  ? tr(
                      'Read-only / commenter role. Preview and SyncTeX will appear once an editor compiles the project.',
                      '当前为只读/仅评论权限，待项目编辑者触发编译后即可查看高清 PDF 预览与双向定位。',
                    )
                  : tr(
                      'Press Ctrl+S / Ctrl+Enter or click Compile PDF below. Double-click the rendered PDF to jump back to source.',
                      '按 Ctrl+S / Ctrl+Enter 或点击下方按钮编译当前项目；生成后支持双击 PDF 反向跳转至对应源码行。',
                    )}
              </p>
              {!readOnly && (
                <button type="button" className="btn btn-compile" onClick={onTriggerCompile}>
                  <Play size={12} fill="currentColor" />
                  {tr('Compile PDF', '立即编译 PDF')}
                </button>
              )}
            </div>
          )}
        </div>

        {/* Floating Glassmorphic Bottom Zoom & Page Dock */}
        {pdfDoc && numPages > 0 && (
          <div
            className="pdf-floating-dock"
            role="toolbar"
            aria-label={tr('PDF page and zoom controls', 'PDF 页面与缩放控制')}
          >
            <span
              className="pdf-dock-text"
              title={tr(
                `Page ${currentPage} of ${numPages}`,
                `当前第 ${currentPage} 页，共 ${numPages} 页`,
              )}
            >
              {currentPage} / {numPages}
            </span>

            <span className="pdf-dock-sep" aria-hidden="true" />

            <button
              type="button"
              className="pdf-dock-btn"
              title={tr('Zoom out', '缩小')}
              aria-label={tr('Zoom out', '缩小')}
              disabled={scale <= 0.5}
              onClick={handleZoomOut}
            >
              <ZoomOut size={14} />
            </button>

            <button
              type="button"
              className="pdf-dock-btn pdf-dock-text"
              style={{ width: 'auto', minWidth: 44, padding: '0 6px' }}
              title={tr('Click to reset zoom to 100%', '点击重置缩放为 100%')}
              aria-label={tr(
                `Current zoom ${zoomPercent}%, click to reset to 100%`,
                `当前缩放 ${zoomPercent}%，点击重置为 100%`,
              )}
              onClick={handleResetZoom}
            >
              {zoomPercent}%
            </button>

            <button
              type="button"
              className="pdf-dock-btn"
              title={tr('Zoom in', '放大')}
              aria-label={tr('Zoom in', '放大')}
              disabled={scale >= 2.6}
              onClick={handleZoomIn}
            >
              <ZoomIn size={14} />
            </button>

            <span className="pdf-dock-sep" aria-hidden="true" />

            <button
              type="button"
              className="pdf-dock-btn"
              title={tr('Fit width', '适应页面宽度')}
              aria-label={tr('Fit width', '适应页面宽度')}
              onClick={() => void handleFitWidth()}
            >
              <Maximize2 size={13} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
