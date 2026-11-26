import React, { useEffect, useMemo, useState } from 'react';
import type { DiffLine, DiffSummary } from '@novatex/shared';
import { Check, ChevronsUpDown, FileCode2, Play, Sparkles, X } from 'lucide-react';

interface DiffModalProps {
  open: boolean;
  title: string;
  filePath: string;
  modelUsed?: string;
  summaryZh?: string;
  rootCauseZh?: string;
  actionsTakenZh?: string[];
  warningsZh?: string[];
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
  diff: DiffSummary;
  primaryLabel?: string;
  secondaryLabel?: string;
  onApplyAndCompile: () => void;
  onApplyOnly?: () => void;
  onClose: () => void;
}

interface DiffViewerProps {
  lines: DiffLine[];
  compact?: boolean;
  filePath?: string;
  additions?: number;
  deletions?: number;
  headerRight?: React.ReactNode;
}

const DiffStatBlocks: React.FC<{ additions: number; deletions: number }> = ({
  additions,
  deletions,
}) => {
  const total = additions + deletions;
  const blocks = 5;
  let greenCount = 0;
  let redCount = 0;
  if (total > 0) {
    greenCount = Math.round((additions / total) * blocks);
    if (additions > 0 && greenCount === 0) greenCount = 1;
    redCount = Math.min(blocks - greenCount, Math.round((deletions / total) * blocks));
    if (deletions > 0 && redCount === 0 && greenCount > 1) {
      redCount = 1;
      greenCount = blocks - 1;
    } else if (deletions > 0 && redCount === 0) {
      redCount = 1;
    }
  }
  const neutralCount = Math.max(0, blocks - greenCount - redCount);

  return (
    <span
      aria-hidden="true"
      style={{ display: 'inline-flex', alignItems: 'center', gap: 2, marginLeft: 2 }}
    >
      {Array.from({ length: greenCount }).map((_, i) => (
        <span
          key={`g-${i}`}
          style={{ width: 7, height: 7, borderRadius: 2, background: 'var(--success)' }}
        />
      ))}
      {Array.from({ length: redCount }).map((_, i) => (
        <span
          key={`r-${i}`}
          style={{ width: 7, height: 7, borderRadius: 2, background: 'var(--danger)' }}
        />
      ))}
      {Array.from({ length: neutralCount }).map((_, i) => (
        <span
          key={`n-${i}`}
          style={{ width: 7, height: 7, borderRadius: 2, background: 'var(--border-strong)' }}
        />
      ))}
    </span>
  );
};

export const DiffViewer: React.FC<DiffViewerProps> = ({
  lines,
  compact = true,
  filePath,
  additions,
  deletions,
  headerRight,
}) => {
  const stats = useMemo(() => {
    if (typeof additions === 'number' && typeof deletions === 'number') {
      return { additions, deletions };
    }
    let add = 0;
    let del = 0;
    for (const l of lines) {
      if (l.type === 'add') add++;
      else if (l.type === 'remove') del++;
    }
    return { additions: add, deletions: del };
  }, [lines, additions, deletions]);

  const visibleLines = useMemo(() => {
    if (!compact) return lines;
    const changed = new Set<number>();
    lines.forEach((l, idx) => {
      if (l.type !== 'context') {
        for (let k = Math.max(0, idx - 3); k <= Math.min(lines.length - 1, idx + 3); k++) {
          changed.add(k);
        }
      }
    });
    if (changed.size === 0) return lines.slice(0, 40);
    const out: Array<DiffLine | { separator: true; key: string; hiddenCount: number }> = [];
    let lastIncluded = -1;
    for (let i = 0; i < lines.length; i++) {
      if (changed.has(i)) {
        if (lastIncluded >= 0 && i > lastIncluded + 1) {
          out.push({
            separator: true,
            key: `sep-${i}`,
            hiddenCount: i - lastIncluded - 1,
          });
        }
        out.push(lines[i]!);
        lastIncluded = i;
      }
    }
    return out;
  }, [lines, compact]);

  const showHeader = Boolean(filePath || headerRight);

  const renderLines = () => {
    if (lines.length === 0) {
      return (
        <div style={{ padding: '16px 14px', color: 'var(--text-muted)', fontSize: 12.5 }}>
          内容无变更。
        </div>
      );
    }

    return visibleLines.map((item, idx) => {
      if ('separator' in item) {
        return (
          <div
            key={item.key}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '3px 12px',
              background: 'var(--bg-muted)',
              color: 'var(--text-faint)',
              fontSize: 11,
              fontFamily: 'var(--font-sans)',
              borderTop: '1px solid var(--border-subtle)',
              borderBottom: '1px solid var(--border-subtle)',
              userSelect: 'none',
            }}
          >
            <ChevronsUpDown size={12} />
            <span>已折叠 {item.hiddenCount} 行未改动上下文</span>
          </div>
        );
      }

      const sign = item.type === 'add' ? '+' : item.type === 'remove' ? '-' : ' ';
      const edgeAccent =
        item.type === 'add'
          ? 'inset 3px 0 0 var(--success)'
          : item.type === 'remove'
            ? 'inset 3px 0 0 var(--danger)'
            : undefined;

      return (
        <div
          key={idx}
          className={`diff-row ${item.type}`}
          style={{
            boxShadow: edgeAccent,
            minHeight: 21,
          }}
        >
          <span
            className="diff-ln"
            style={{
              opacity: item.type === 'add' ? 0.4 : 0.85,
              borderRight: '1px solid var(--border-subtle)',
            }}
          >
            {item.oldLineNumber ?? ''}
          </span>
          <span
            className="diff-ln"
            style={{
              opacity: item.type === 'remove' ? 0.4 : 0.85,
              borderRight: '1px solid var(--border-subtle)',
            }}
          >
            {item.newLineNumber ?? ''}
          </span>
          <span className="diff-sig">{sign}</span>
          <span style={{ paddingRight: 12 }}>{item.content || ' '}</span>
        </div>
      );
    });
  };

  if (!showHeader) {
    return <div className="diff-box">{renderLines()}</div>;
  }

  return (
    <div
      style={{
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-md)',
        overflow: 'hidden',
        background: 'var(--bg-app)',
      }}
    >
      {/* GitHub-style File Header Bar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 10,
          padding: '7px 12px',
          background: 'var(--bg-subtle)',
          borderBottom: '1px solid var(--border)',
          flexWrap: 'wrap',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            minWidth: 0,
            flexWrap: 'wrap',
          }}
        >
          <FileCode2 size={14} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
          {filePath && (
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 12,
                fontWeight: 600,
                color: 'var(--text-primary)',
                wordBreak: 'break-all',
              }}
            >
              {filePath}
            </span>
          )}
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              fontFamily: 'var(--font-mono)',
              fontSize: 11.5,
              fontWeight: 700,
            }}
          >
            <span style={{ color: 'var(--success)' }}>+{stats.additions}</span>
            <span style={{ color: 'var(--danger)' }}>-{stats.deletions}</span>
            <DiffStatBlocks additions={stats.additions} deletions={stats.deletions} />
          </span>
        </div>
        {headerRight && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            {headerRight}
          </div>
        )}
      </div>

      <div
        className="diff-box"
        style={{
          border: 'none',
          borderRadius: 0,
          maxHeight: 400,
        }}
      >
        {renderLines()}
      </div>
    </div>
  );
};

export const DiffModal: React.FC<DiffModalProps> = ({
  open,
  title,
  filePath,
  modelUsed,
  summaryZh,
  rootCauseZh,
  actionsTakenZh,
  warningsZh,
  usage,
  diff,
  primaryLabel = '应用修复并重编',
  secondaryLabel = '仅应用不编译',
  onApplyAndCompile,
  onApplyOnly,
  onClose,
}) => {
  const [compact, setCompact] = useState(true);

  // Clean Escape key handler (no accidental backdrop dismissal)
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.isComposing) {
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="modal-backdrop">
      <div
        className="modal-card modal-xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-diff-title"
      >
        <div className="modal-header">
          <h3 id="modal-diff-title" className="modal-title" style={{ flexWrap: 'wrap' }}>
            <Sparkles size={16} style={{ color: 'var(--ai-accent)', flexShrink: 0 }} />
            <span>{title}</span>
            {modelUsed && <span className="pill pill-ai">{modelUsed}</span>}
          </h3>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            aria-label="关闭"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>

        <div className="modal-body">
          {(rootCauseZh || summaryZh) && (
            <div
              style={{
                border: '1px solid var(--border)',
                borderLeft: '3px solid var(--ai-accent)',
                borderRadius: 'var(--radius-md)',
                padding: '12px 14px',
                background: 'var(--bg-subtle)',
                marginBottom: 14,
                lineHeight: 1.6,
              }}
            >
              {rootCauseZh && (
                <div style={{ marginBottom: summaryZh ? 6 : 0 }}>
                  <strong style={{ color: 'var(--text-primary)' }}>根因分析：</strong>
                  <span style={{ color: 'var(--text-secondary)' }}>{rootCauseZh}</span>
                </div>
              )}
              {summaryZh && (
                <div>
                  <strong style={{ color: 'var(--text-primary)' }}>修改摘要：</strong>
                  <span style={{ color: 'var(--text-secondary)' }}>{summaryZh}</span>
                </div>
              )}
              {actionsTakenZh && actionsTakenZh.length > 0 && (
                <ul
                  style={{
                    margin: '8px 0 0',
                    paddingLeft: 18,
                    color: 'var(--text-secondary)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 2,
                  }}
                >
                  {actionsTakenZh.map((act, idx) => (
                    <li key={idx}>{act}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {warningsZh && warningsZh.length > 0 && (
            <div className="alert alert-warning">
              {warningsZh.map((w, idx) => (
                <div key={idx}>• {w}</div>
              ))}
            </div>
          )}

          <DiffViewer
            lines={diff.lines}
            compact={compact}
            filePath={filePath}
            additions={diff.additions}
            deletions={diff.deletions}
            headerRight={
              <>
                {usage?.totalTokens ? (
                  <span style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>
                    消耗 {usage.totalTokens} tokens
                  </span>
                ) : null}
                <button
                  type="button"
                  className="btn btn-ghost btn-xs"
                  onClick={() => setCompact((v) => !v)}
                >
                  {compact ? '展开全文对比' : '仅看变更上下文'}
                </button>
              </>
            }
          />
        </div>

        <div className="modal-footer">
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
          {onApplyOnly && (
            <button type="button" className="btn" onClick={onApplyOnly}>
              <Check size={14} />
              {secondaryLabel}
            </button>
          )}
          <button type="button" className="btn btn-primary" onClick={onApplyAndCompile}>
            <Play size={14} />
            {primaryLabel}
          </button>
        </div>
      </div>
    </div>
  );
};
