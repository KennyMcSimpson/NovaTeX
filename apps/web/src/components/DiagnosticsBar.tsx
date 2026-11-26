import React, { useEffect, useRef, useState } from 'react';
import type { CompileDiagnostic, CompileResult } from '@novatex/shared';
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Loader2,
  Sigma,
  Sparkles,
  Table2,
  Terminal,
} from 'lucide-react';
import { useLocale, type UiLocale } from '../i18n.ts';

const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff]/;

interface LocalizedDiagnostic {
  title: string;
  explanation: string;
  hint: string;
}

function formatDiagnosticForLocale(
  d: CompileDiagnostic,
  locale: UiLocale,
): LocalizedDiagnostic {
  if (locale === 'zh') {
    return {
      title: d.titleZh,
      explanation: d.explanationZh,
      hint: d.quickFixHintZh,
    };
  }

  const raw = (d.rawMessage ?? '').trim();
  const safeRaw = raw && !CJK_RE.test(raw) ? raw : '';

  switch (d.code) {
    case 'CJK_NEEDS_XELATEX':
      return {
        title: 'Unicode / CJK font package requires XeLaTeX',
        explanation:
          safeRaw ||
          'This document uses Unicode characters or fontspec/xeCJK/ctex packages that pdfLaTeX cannot compile directly.',
        hint: 'Switch the project compiler engine to XeLaTeX (xelatex) and recompile.',
      };
    case 'MISSING_PACKAGE': {
      const m =
        /File [`'"]([^`'"]+)[`'"] not found/i.exec(raw) ??
        /I can't find file [`'"]([^`'"]+)[`'"]/i.exec(raw);
      const missing = m?.[1];
      const isPkg = Boolean(missing && /\.(sty|cls)$/i.test(missing));
      return {
        title: missing
          ? isPkg
            ? `Missing package or class: ${missing}`
            : `File not found: ${missing}`
          : 'Missing package or file',
        explanation:
          safeRaw ||
          'The TeX compiler could not find the referenced package, document class, or input file.',
        hint: isPkg
          ? `Verify the package name spelling or install ${missing?.replace(/\.(sty|cls)$/i, '')} in your TeX distribution.`
          : 'Check that the referenced file exists in the project and verify its relative path.',
      };
    }
    case 'ENV_MISMATCH': {
      const envMismatch =
        /\\begin\{([^}]+)\}(?:\s+on input line \d+)?\s+ended by\s+\\end\{([^}]+)\}/i.exec(raw);
      const envUndef = /Environment\s+([^\s]+)\s+undefined/i.exec(raw);
      return {
        title: envMismatch
          ? `Environment mismatch: \\begin{${envMismatch[1]}} / \\end{${envMismatch[2]}}`
          : envUndef
            ? `Undefined environment: ${envUndef[1]}`
            : 'LaTeX environment error',
        explanation:
          safeRaw || 'A LaTeX environment is undefined or not closed with a matching \\end{...}.',
        hint: envMismatch
          ? `Match \\begin{${envMismatch[1]}} with \\end{${envMismatch[1]}} or close inner environments first.`
          : 'Check the environment spelling and make sure its defining package is loaded in the preamble.',
      };
    }
    case 'UNDEFINED_CONTROL_SEQUENCE': {
      const cmdMatch = /Undefined control sequence\.?\s*(\\[a-zA-Z@]+|\\.)?/.exec(raw);
      const cmd = cmdMatch?.[1];
      return {
        title: cmd ? `Undefined control sequence: ${cmd}` : 'Undefined control sequence',
        explanation:
          safeRaw ||
          'LaTeX encountered an unrecognized command due to a typo or missing package.',
        hint: 'Check the command spelling or add the required \\usepackage{...} in the preamble.',
      };
    }
    case 'MISSING_MATH_DOLLAR':
      return {
        title: 'Missing math mode delimiter ($)',
        explanation:
          safeRaw ||
          'A math operator (_, ^, or math command) appeared outside math mode, or an unescaped underscore was used in text.',
        hint: 'Wrap math expressions in $...$ or escape literal underscores as \\_.',
      };
    case 'MISSING_BRACE':
      return {
        title: /Runaway argument/i.test(raw)
          ? 'Unclosed argument (missing closing brace })'
          : 'Mismatched braces { }',
        explanation:
          safeRaw || 'Extra or missing curly braces { } (or an unclosed $ inside braces).',
        hint: 'Check matching { and } braces on this line and the preceding lines.',
      };
    case 'UNDEFINED_CITATION': {
      const citeMatch = /Citation [`'"]([^`'"]+)[`'"].*undefined/i.exec(raw);
      return {
        title: citeMatch ? `Undefined citation: ${citeMatch[1]}` : 'Undefined citation',
        explanation:
          safeRaw || 'The cited bibliography key was not found in your .bib file.',
        hint: 'Verify the citation key exists in your .bib file and recompile.',
      };
    }
    case 'UNDEFINED_REF': {
      const dupMatch = /Label [`'"]([^`'"]+)[`'"] multiply defined/i.exec(raw);
      const refMatch = /Reference [`'"]([^`'"]+)[`'"].*undefined/i.exec(raw);
      return {
        title: dupMatch
          ? `Duplicate label: ${dupMatch[1]}`
          : refMatch
            ? `Undefined reference: ${refMatch[1]}`
            : 'Cross-reference warning',
        explanation:
          safeRaw || 'A \\ref label is undefined or duplicated in this document.',
        hint: dupMatch
          ? 'Assign unique \\label{...} names to each figure, table, or section.'
          : 'Confirm the matching \\label{...} spelling and recompile to refresh .aux files.',
      };
    }
    case 'OVERFULL_HBOX':
      return {
        title: /Underfull/i.test(raw) ? 'Underfull box warning' : 'Overfull box (line overflow)',
        explanation:
          safeRaw || 'Content overflows or stretches across the page margin.',
        hint: 'Wrap long equations, break wide tables (\\resizebox / tabularx), or use \\url{...} for long links.',
      };
    case 'PACKAGE_WARNING': {
      const pkgWarn = /Package\s+([^\s]+)\s+Warning:\s*(.*)/i.exec(raw);
      return {
        title: pkgWarn ? `Package warning (${pkgWarn[1]})` : 'Package warning',
        explanation: pkgWarn?.[2] && !CJK_RE.test(pkgWarn[2]) ? pkgWarn[2] : safeRaw || 'A LaTeX package reported a warning.',
        hint: 'Review the package options and macro arguments near this line.',
      };
    }
    case 'LATEX_WARNING':
      return {
        title: 'LaTeX warning',
        explanation: safeRaw || 'The TeX compiler reported a non-blocking warning.',
        hint: 'Warnings usually do not block PDF generation; review layout or references as needed.',
      };
    default: {
      const pkgErr = /Package\s+([^\s]+)\s+Error:\s*(.*)/i.exec(raw);
      if (pkgErr) {
        return {
          title: `Package error (${pkgErr[1]})`,
          explanation: pkgErr[2] && !CJK_RE.test(pkgErr[2]) ? pkgErr[2] : safeRaw || 'A LaTeX package reported an error.',
          hint: `Check ${pkgErr[1]} configuration, command arguments, and auxiliary files.`,
        };
      }
      if (/Emergency stop/i.test(raw)) {
        return {
          title: 'Emergency stop',
          explanation:
            safeRaw ||
            'TeX halted compilation due to a fatal error earlier in the log.',
          hint: 'Fix the first error reported above this line, then recompile.',
        };
      }
      return {
        title: d.severity === 'warning' ? 'LaTeX warning' : 'LaTeX compile error',
        explanation:
          safeRaw ||
          'The compiler reported an issue on this line. Inspect the raw log or run AI Fix for details.',
        hint: 'Check syntax, command spelling, and delimiter pairs near this line.',
      };
    }
  }
}

export interface DiagnosticsBarProps {
  compileResult: CompileResult | null;
  compiling: boolean;
  aiLoading: boolean;
  readOnly: boolean;
  useReasoner: boolean;
  onToggleReasoner: (v: boolean) => void;
  onSelectDiagnostic: (diag: CompileDiagnostic) => void;
  onRunAiDiagnose: () => void;
  onQuickAiFormat?: (mode: 'format-table' | 'format-math') => void;
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export const DiagnosticsBar: React.FC<DiagnosticsBarProps> = ({
  compileResult,
  compiling,
  aiLoading,
  readOnly,
  useReasoner,
  onToggleReasoner,
  onSelectDiagnostic,
  onRunAiDiagnose,
  onQuickAiFormat,
}) => {
  const { locale, tr } = useLocale();
  // Collapsed by default so the PDF drafting table enjoys full vertical height when 0 errors
  const [expanded, setExpanded] = useState(false);
  const [showRawLog, setShowRawLog] = useState(false);
  const lastJobIdRef = useRef<string | null>(null);
  const manualExpandedRef = useRef(false);

  const errorCount = compileResult?.errorCount ?? 0;
  const warningCount = compileResult?.warningCount ?? 0;
  const diagnostics = compileResult?.diagnostics ?? [];
  const showAiActions = errorCount > 0 || expanded || aiLoading;
  const showActions = showAiActions || Boolean(compileResult?.rawLog);

  const safeCompilerNote =
    compileResult?.compilerNote && (locale === 'zh' || !CJK_RE.test(compileResult.compilerNote))
      ? compileResult.compilerNote
      : null;

  useEffect(() => {
    const nextJobId = compileResult?.jobId ?? null;
    if (!nextJobId) {
      lastJobIdRef.current = null;
      manualExpandedRef.current = false;
      setExpanded(false);
      setShowRawLog(false);
      return;
    }

    if (nextJobId === lastJobIdRef.current) return;
    lastJobIdRef.current = nextJobId;

    if ((compileResult?.errorCount ?? 0) > 0) {
      setExpanded(true);
      setShowRawLog(false);
    } else if (!manualExpandedRef.current) {
      setExpanded(false);
    }
  }, [compileResult?.jobId, compileResult?.errorCount]);

  const handleToggleExpanded = () => {
    setExpanded((prev) => {
      const next = !prev;
      manualExpandedRef.current = next;
      return next;
    });
  };

  const handleToggleRawLog = () => {
    if (!expanded) {
      setShowRawLog(true);
      setExpanded(true);
      manualExpandedRef.current = true;
    } else if (showRawLog) {
      setShowRawLog(false);
      if (diagnostics.length === 0 && errorCount === 0) {
        setExpanded(false);
        manualExpandedRef.current = false;
      }
    } else {
      setShowRawLog(true);
    }
  };

  return (
    <div className="diag-panel">
      <div className="diag-header">
        <div
          role="button"
          tabIndex={0}
          aria-expanded={expanded}
          onClick={handleToggleExpanded}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              handleToggleExpanded();
            }
          }}
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: 6,
            cursor: 'pointer',
            flex: '1 1 160px',
            minWidth: 0,
          }}
          title={
            expanded
              ? tr('Collapse diagnostics panel', '收起编译诊断面板')
              : tr('Expand diagnostics and raw log', '展开查看编译诊断与原始日志')
          }
        >
          {expanded ? (
            <ChevronDown size={14} style={{ flexShrink: 0, color: 'var(--text-muted)' }} />
          ) : (
            <ChevronUp size={14} style={{ flexShrink: 0, color: 'var(--text-muted)' }} />
          )}

          <span
            style={{
              fontWeight: 600,
              fontSize: 12,
              color: 'var(--text-primary)',
              whiteSpace: 'nowrap',
              flexShrink: 0,
            }}
          >
            {tr('Diagnostics', '编译诊断')}
          </span>

          {compiling ? (
            <span className="pill pill-accent" style={{ height: 20, fontSize: 11 }}>
              <Loader2 size={11} className="spin" />
              {tr('Compiling…', '编译中…')}
            </span>
          ) : !compileResult ? (
            <span
              style={{
                fontSize: 11.5,
                color: 'var(--text-faint)',
                whiteSpace: 'nowrap',
              }}
            >
              {tr('Ready', '等待编译')}
            </span>
          ) : errorCount > 0 ? (
            <>
              <span className="pill pill-danger" style={{ height: 20, fontSize: 11 }}>
                <AlertCircle size={11} />
                {tr(
                  `${errorCount} ${errorCount === 1 ? 'error' : 'errors'}`,
                  `${errorCount} 错误`,
                )}
              </span>
              {warningCount > 0 && (
                <span className="pill pill-warning" style={{ height: 20, fontSize: 11 }}>
                  <AlertTriangle size={10} />
                  {tr(
                    `${warningCount} ${warningCount === 1 ? 'warning' : 'warnings'}`,
                    `${warningCount} 警告`,
                  )}
                </span>
              )}
            </>
          ) : warningCount > 0 ? (
            <span
              className="pill pill-warning"
              style={{ height: 20, fontSize: 11 }}
              title={tr(
                `Compiled with ${warningCount} non-blocking ${warningCount === 1 ? 'warning' : 'warnings'}`,
                `编译已通过，含 ${warningCount} 条非阻塞警告`,
              )}
            >
              <AlertTriangle size={11} />
              {tr(
                `${warningCount} ${warningCount === 1 ? 'warning' : 'warnings'}`,
                `${warningCount} 警告`,
              )}
            </span>
          ) : compileResult.ok ? (
            <span className="pill pill-success" style={{ height: 20, fontSize: 11 }}>
              <CheckCircle2 size={11} />
              {tr('Compiled', '编译通过')}
            </span>
          ) : (
            <span className="pill pill-warning" style={{ height: 20, fontSize: 11 }}>
              <AlertTriangle size={11} />
              {tr('Not ready', '未就绪')}
            </span>
          )}

          {compileResult && !compiling && (
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                color: 'var(--text-faint)',
                whiteSpace: 'nowrap',
                flexShrink: 0,
              }}
              title={tr(
                `Compile time ${compileResult.durationMs} ms${
                  compileResult.linearized ? ' · PDF linearized' : ''
                }`,
                `编译耗时 ${compileResult.durationMs} ms${
                  compileResult.linearized ? ' · PDF 已线性化优化' : ''
                }`,
              )}
            >
              {formatDuration(compileResult.durationMs)}
            </span>
          )}
        </div>

        {showActions && (
          <div
            className="pane-toolbar-actions"
            style={{ gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}
          >
            {showAiActions && (
              <>
                <label
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                    fontSize: 11.5,
                    color: useReasoner ? 'var(--ai-accent)' : 'var(--text-muted)',
                    cursor: readOnly ? 'not-allowed' : 'pointer',
                    whiteSpace: 'nowrap',
                    userSelect: 'none',
                  }}
                  title={tr(
                    'Enable deep reasoning model for cascading errors or package conflicts',
                    '遇到级联报错或复杂宏包冲突时开启深度推理模型',
                  )}
                >
                  <input
                    type="checkbox"
                    checked={useReasoner}
                    disabled={readOnly}
                    onChange={(e) => onToggleReasoner(e.target.checked)}
                    style={{
                      margin: 0,
                      accentColor: 'var(--ai-accent)',
                      cursor: readOnly ? 'not-allowed' : 'pointer',
                    }}
                  />
                  {tr('Deep Reason', '深度推理')}
                </label>

                <button
                  type="button"
                  className="btn btn-ai-primary btn-xs"
                  disabled={readOnly || aiLoading || compiling}
                  onClick={onRunAiDiagnose}
                  title={
                    readOnly
                      ? tr(
                          'Read-only / commenter role cannot run AI fixes',
                          '当前为只读/仅评论权限，无法调用 AI 修复源码',
                        )
                      : tr(
                          'Diagnose compile errors with AI and generate a reviewable diff patch (never rewrites prose)',
                          '调用 AI 诊断编译报错并给出红绿 Diff 补丁（绝不擅自扩写正文）',
                        )
                  }
                >
                  {aiLoading ? <Loader2 size={12} className="spin" /> : <Sparkles size={12} />}
                  {tr('AI Fix', 'AI 修错')}
                </button>

                {onQuickAiFormat && !readOnly && (
                  <>
                    <button
                      type="button"
                      className="btn btn-ghost btn-xs"
                      style={{
                        height: 22,
                        padding: '0 8px',
                        borderRadius: 999,
                        border: '1px solid var(--border)',
                        fontSize: 11,
                        gap: 4,
                      }}
                      disabled={aiLoading || compiling}
                      onClick={() => onQuickAiFormat('format-table')}
                      title={tr(
                        'Scan and fix all tables in this file using current compile diagnostics',
                        '自动扫描整篇文件表格并结合当前编译报错一键修复',
                      )}
                    >
                      <Table2 size={11} />
                      {tr('Tables', '修表格')}
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-xs"
                      style={{
                        height: 22,
                        padding: '0 8px',
                        borderRadius: 999,
                        border: '1px solid var(--border)',
                        fontSize: 11,
                        gap: 4,
                      }}
                      disabled={aiLoading || compiling}
                      onClick={() => onQuickAiFormat('format-math')}
                      title={tr(
                        'Scan and fix all math equations in this file using current compile diagnostics',
                        '自动扫描整篇文件数学公式并结合当前编译报错一键修复',
                      )}
                    >
                      <Sigma size={11} />
                      {tr('Math', '修公式')}
                    </button>
                  </>
                )}
              </>
            )}

            {compileResult?.rawLog && (
              <button
                type="button"
                className={`btn btn-xs ${expanded && showRawLog ? 'btn-primary' : 'btn-ghost'}`}
                onClick={handleToggleRawLog}
                title={
                  expanded && showRawLog
                    ? tr('Hide raw compile log', '收起原始编译日志')
                    : tr('View raw TeX compile log', '查看原始 TeX 编译日志')
                }
              >
                <Terminal size={12} />
                {expanded && showRawLog ? tr('Hide Log', '收起日志') : tr('Log', '日志')}
              </button>
            )}
          </div>
        )}
      </div>

      {expanded && (
        <div className="diag-body">
          {showRawLog ? (
            <pre className="raw-log-pre">
              {compileResult?.rawLog || tr('No compile log output yet.', '暂无编译日志输出。')}
            </pre>
          ) : !compileResult ? (
            <div style={{ fontSize: 12, color: 'var(--text-faint)', padding: '6px 2px' }}>
              {tr(
                'Click "Compile PDF" or press Ctrl+S to parse TeX logs into structured diagnostics.',
                '点击上方「编译 PDF」或按 Ctrl+S 后，此处将把原始 LaTeX 日志提炼为直观的诊断卡片。',
              )}
            </div>
          ) : diagnostics.length === 0 ? (
            compileResult.ok ? (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  fontSize: 12,
                  color: 'var(--success)',
                  padding: '6px 2px',
                }}
              >
                <CheckCircle2 size={14} style={{ flexShrink: 0 }} />
                <span>
                  {tr(
                    'No compile errors or warnings found. Double-click the PDF to jump back to source.',
                    '未发现编译错误或警告。你可以专注写作，或双击 PDF 任意位置反向跳转到对应源码行。',
                  )}
                </span>
              </div>
            ) : (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  fontSize: 12,
                  color: 'var(--warning)',
                  padding: '6px 2px',
                }}
              >
                <AlertTriangle size={14} style={{ flexShrink: 0 }} />
                <span>
                  {safeCompilerNote ||
                    tr(
                      'Compilation failed with no structured diagnostics. Open "Log" to inspect raw TeX output, or click "AI Fix" to diagnose automatically.',
                      '编译未通过，但未解析出结构化诊断条目；可点击右上角「日志」查看完整 TeX 输出，或使用「AI 修错」自动定位。',
                    )}
                </span>
              </div>
            )
          ) : (
            diagnostics.map((d) => {
              const loc = formatDiagnosticForLocale(d, locale);
              return (
                <div
                  key={d.id}
                  role="button"
                  tabIndex={0}
                  className={`diag-card ${d.severity}`}
                  style={{ wordBreak: 'break-word', overflowWrap: 'anywhere' }}
                  onClick={() => onSelectDiagnostic(d)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onSelectDiagnostic(d);
                    }
                  }}
                  title={tr(
                    `Jump to ${d.file || 'main.tex'} line ${d.line}`,
                    `点击跳转到 ${d.file || 'main.tex'} 第 ${d.line} 行并高亮`,
                  )}
                >
                  <div
                    className="diag-card-top"
                    style={{ alignItems: 'flex-start', flexWrap: 'wrap', gap: '4px 8px' }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        flex: '1 1 160px',
                        minWidth: 0,
                      }}
                    >
                      <span
                        className={`pill ${
                          d.severity === 'error'
                            ? 'pill-danger'
                            : d.severity === 'warning'
                              ? 'pill-warning'
                              : 'pill-accent'
                        }`}
                        style={{ height: 18, fontSize: 10.5, padding: '0 6px' }}
                      >
                        {d.severity === 'error'
                          ? tr('Error', '错误')
                          : d.severity === 'warning'
                            ? tr('Warning', '警告')
                            : tr('Info', '提示')}
                      </span>
                      <span
                        className="diag-card-title"
                        style={{
                          minWidth: 0,
                          wordBreak: 'break-word',
                          overflowWrap: 'anywhere',
                          lineHeight: 1.4,
                        }}
                      >
                        {loc.title}
                      </span>
                    </div>
                    <span
                      className="diag-card-loc"
                      style={{
                        padding: '1px 7px',
                        borderRadius: 5,
                        background: 'var(--bg-subtle)',
                        border: '1px solid var(--border)',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {d.file || 'main.tex'}:{d.line}
                    </span>
                  </div>
                  {loc.explanation && (
                    <p
                      className="diag-card-explain"
                      style={{ wordBreak: 'break-word', overflowWrap: 'anywhere' }}
                    >
                      {loc.explanation}
                    </p>
                  )}
                  {loc.hint && (
                    <p
                      className="diag-card-hint"
                      style={{ wordBreak: 'break-word', overflowWrap: 'anywhere' }}
                    >
                      {tr('Hint: ', '建议：')}
                      {loc.hint}
                    </p>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
};
