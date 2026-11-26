import React, { useCallback, useEffect, useState } from 'react';
import type { GitCommitInfo, GitDiffResult } from '@novatex/shared';
import { FileDiff, GitCommitHorizontal, History, Loader2, RotateCcw, Save, X } from 'lucide-react';
import { api } from '../api.ts';

interface GitHistoryModalProps {
  open: boolean;
  projectId: string;
  readOnly: boolean;
  onRestored: () => void;
  onNotify: (kind: 'success' | 'error' | 'info', msg: string) => void;
  onClose: () => void;
}

function countUnifiedDiffStats(unified: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of unified.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions++;
    else if (line.startsWith('-') && !line.startsWith('---')) deletions++;
  }
  return { additions, deletions };
}

export const GitHistoryModal: React.FC<GitHistoryModalProps> = ({
  open,
  projectId,
  readOnly,
  onRestored,
  onNotify,
  onClose,
}) => {
  const [commits, setCommits] = useState<GitCommitInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [commitMsg, setCommitMsg] = useState('');
  const [saving, setSaving] = useState(false);
  const [selectedCommit, setSelectedCommit] = useState<GitCommitInfo | null>(null);
  const [diff, setDiff] = useState<GitDiffResult | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [confirmRestoreHash, setConfirmRestoreHash] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);

  const isBusy = saving || restoring;

  const loadLog = useCallback(
    async (preferTarget: 'latest' | 'keep' = 'keep') => {
      setLoading(true);
      setError(null);
      try {
        const list = await api.getGitLog(projectId);
        setCommits(list);
        setSelectedCommit((prev) => {
          if (list.length === 0) return null;
          if (preferTarget === 'latest' || !prev) return list[0]!;
          return list.find((c) => c.hash === prev.hash) ?? list[0]!;
        });
        setRefreshNonce((n) => n + 1);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : '读取 Git 历史失败');
      } finally {
        setLoading(false);
      }
    },
    [projectId],
  );

  useEffect(() => {
    if (open) {
      setConfirmRestoreHash(null);
      setDiff(null);
      void loadLog('latest');
    }
  }, [open, projectId, loadLog]);

  useEffect(() => {
    if (!open || !selectedCommit) return;
    let cancelled = false;
    setDiffLoading(true);
    api
      .getGitDiff(projectId, selectedCommit.hash, 'HEAD')
      .then((res) => {
        if (!cancelled) setDiff(res);
      })
      .catch(() => {
        if (!cancelled) setDiff(null);
      })
      .finally(() => {
        if (!cancelled) setDiffLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, projectId, selectedCommit?.hash, refreshNonce]);

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

  if (!open) return null;

  const handleCreateCommit = async (e: React.FormEvent) => {
    e.preventDefault();
    const msg = commitMsg.trim();
    if (!msg) return;
    setSaving(true);
    setError(null);
    try {
      await api.createGitCommit(projectId, msg);
      setCommitMsg('');
      onNotify('success', `已创建版本检查点：${msg}`);
      await loadLog('latest');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '创建检查点失败');
    } finally {
      setSaving(false);
    }
  };

  const handleRestore = async (hash: string) => {
    setRestoring(true);
    setError(null);
    try {
      await api.restoreGitCommit(projectId, hash);
      onNotify('success', `已安全回滚至版本 ${hash.slice(0, 7)}`);
      setConfirmRestoreHash(null);
      onRestored();
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '版本回滚失败');
    } finally {
      setRestoring(false);
    }
  };

  const renderUnifiedDiff = (unified: string) => {
    const lines = unified.split('\n');
    return (
      <div
        className="diff-box"
        style={{
          maxHeight: 300,
          border: 'none',
          borderRadius: 0,
        }}
      >
        {lines.map((line, idx) => {
          const isAdd = line.startsWith('+') && !line.startsWith('+++');
          const isDel = line.startsWith('-') && !line.startsWith('---');
          const isHunk = line.startsWith('@@');
          const isMeta = line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ');
          return (
            <div
              key={idx}
              style={{
                padding: '0 12px',
                whiteSpace: 'pre',
                minHeight: 20,
                boxShadow: isAdd
                  ? 'inset 3px 0 0 var(--success)'
                  : isDel
                    ? 'inset 3px 0 0 var(--danger)'
                    : undefined,
                background: isAdd
                  ? 'var(--diff-add-bg)'
                  : isDel
                    ? 'var(--diff-del-bg)'
                    : isHunk
                      ? 'var(--accent-soft)'
                      : isMeta
                        ? 'var(--bg-subtle)'
                        : 'transparent',
                color: isAdd
                  ? 'var(--diff-add-text)'
                  : isDel
                    ? 'var(--diff-del-text)'
                    : isHunk
                      ? 'var(--accent)'
                      : isMeta
                        ? 'var(--text-faint)'
                        : 'var(--text-primary)',
                fontWeight: isHunk ? 600 : undefined,
              }}
            >
              {line || ' '}
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div className="modal-backdrop">
      <div
        className="modal-card modal-xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-git-history-title"
      >
        <div className="modal-header">
          <h3 id="modal-git-history-title" className="modal-title">
            <History size={16} style={{ color: 'var(--accent)' }} />
            Git 版本历史与 Diff 回滚
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
          {!readOnly && (
            <form
              onSubmit={(e) => void handleCreateCommit(e)}
              style={{ display: 'flex', gap: 8, marginBottom: 16 }}
            >
              <input
                className="input"
                placeholder="输入版本检查点备注（例如：完成第三章实验表格修订）"
                value={commitMsg}
                onChange={(e) => setCommitMsg(e.target.value)}
              />
              <button
                type="submit"
                className="btn btn-primary"
                disabled={saving || !commitMsg.trim()}
              >
                {saving ? <Loader2 size={14} className="spin" /> : <Save size={14} />}
                保存快照
              </button>
            </form>
          )}

          {error && <div className="alert alert-danger">{error}</div>}

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '286px 1fr',
              gap: 16,
              minHeight: 370,
            }}
          >
            {/* Commit List */}
            <div
              style={{
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-md)',
                overflow: 'hidden',
                display: 'flex',
                flexDirection: 'column',
                maxHeight: 440,
                background: 'var(--bg-subtle)',
              }}
            >
              <div
                style={{
                  padding: '8px 12px',
                  borderBottom: '1px solid var(--border)',
                  fontSize: 11.5,
                  fontWeight: 600,
                  color: 'var(--text-muted)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                }}
              >
                <span>版本时间线</span>
                <span className="pill">{commits.length} 条</span>
              </div>

              <div style={{ flex: 1, overflowY: 'auto', padding: 6 }}>
                {loading ? (
                  <div
                    style={{
                      padding: 20,
                      textAlign: 'center',
                      color: 'var(--text-muted)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 6,
                    }}
                  >
                    <Loader2 size={15} className="spin" /> 加载历史记录…
                  </div>
                ) : commits.length === 0 ? (
                  <div style={{ padding: 16, color: 'var(--text-muted)', fontSize: 12 }}>
                    暂无 Git 提交记录。点击上方保存首个检查点。
                  </div>
                ) : (
                  commits.map((c) => {
                    const active = selectedCommit?.hash === c.hash;
                    return (
                      <button
                        key={c.hash}
                        type="button"
                        onClick={() => {
                          setSelectedCommit(c);
                          setConfirmRestoreHash(null);
                        }}
                        style={{
                          width: '100%',
                          textAlign: 'left',
                          border: active
                            ? '1px solid var(--accent-border)'
                            : '1px solid transparent',
                          borderRadius: 'var(--radius-sm)',
                          padding: '9px 10px',
                          marginBottom: 4,
                          background: active ? 'var(--bg-active)' : 'transparent',
                          color: 'var(--text-primary)',
                          transition: 'background 0.12s ease, border-color 0.12s ease',
                        }}
                      >
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            gap: 6,
                            marginBottom: 3,
                          }}
                        >
                          <span
                            style={{
                              fontFamily: 'var(--font-mono)',
                              fontSize: 11.5,
                              color: 'var(--accent)',
                              fontWeight: 600,
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 4,
                            }}
                          >
                            <GitCommitHorizontal size={12} />
                            {c.shortHash || c.hash.slice(0, 7)}
                          </span>
                          <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>
                            {new Date(c.date).toLocaleString('zh-CN', {
                              month: '2-digit',
                              day: '2-digit',
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                          </span>
                        </div>
                        <div
                          style={{
                            fontSize: 12.5,
                            fontWeight: active ? 600 : 500,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {c.message}
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                          {c.author}
                        </div>
                      </button>
                    );
                  })
                )}
              </div>
            </div>

            {/* Diff Detail */}
            <div style={{ minWidth: 0 }}>
              {!selectedCommit ? (
                <div style={{ padding: 24, color: 'var(--text-muted)', textAlign: 'center' }}>
                  从左侧选择任意历史版本查看与当前工作区的差异。
                </div>
              ) : (
                <div>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 12,
                      marginBottom: 14,
                      paddingBottom: 12,
                      borderBottom: '1px solid var(--border)',
                    }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 2 }}>
                        {selectedCommit.message}
                      </div>
                      <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                        提交 <code>{selectedCommit.hash.slice(0, 10)}</code> · {selectedCommit.author} ·{' '}
                        {new Date(selectedCommit.date).toLocaleString('zh-CN')}
                      </div>
                    </div>

                    {!readOnly && (
                      <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                        {confirmRestoreHash === selectedCommit.hash ? (
                          <>
                            <button
                              type="button"
                              className="btn btn-sm"
                              disabled={restoring}
                              onClick={() => setConfirmRestoreHash(null)}
                            >
                              取消
                            </button>
                            <button
                              type="button"
                              className="btn btn-danger btn-sm"
                              disabled={restoring}
                              onClick={() => void handleRestore(selectedCommit.hash)}
                            >
                              {restoring ? <Loader2 size={12} className="spin" /> : <RotateCcw size={12} />}
                              确认回滚到此版本
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            className="btn btn-sm"
                            onClick={() => setConfirmRestoreHash(selectedCommit.hash)}
                          >
                            <RotateCcw size={13} />
                            回滚到此版本
                          </button>
                        )}
                      </div>
                    )}
                  </div>

                  {diffLoading ? (
                    <div
                      style={{
                        padding: 24,
                        color: 'var(--text-muted)',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                      }}
                    >
                      <Loader2 size={15} className="spin" /> 正在计算与当前版本的 Diff…
                    </div>
                  ) : !diff || diff.files.length === 0 ? (
                    <div className="alert alert-success">
                      该历史版本与当前最新版本内容完全一致（无文件差异）。
                    </div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                      {diff.files.map((f) => {
                        const fileStats = countUnifiedDiffStats(f.unifiedDiff);
                        return (
                          <div
                            key={f.path}
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
                                gap: 8,
                                padding: '7px 12px',
                                background: 'var(--bg-subtle)',
                                borderBottom: '1px solid var(--border)',
                              }}
                            >
                              <div
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: 8,
                                  minWidth: 0,
                                }}
                              >
                                <FileDiff size={13} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
                                <span
                                  style={{
                                    fontFamily: 'var(--font-mono)',
                                    fontSize: 12,
                                    fontWeight: 600,
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                    whiteSpace: 'nowrap',
                                  }}
                                >
                                  {f.path}
                                </span>
                                <span className="pill">{f.status}</span>
                              </div>
                              <span
                                style={{
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  gap: 6,
                                  fontFamily: 'var(--font-mono)',
                                  fontSize: 11.5,
                                  fontWeight: 700,
                                  flexShrink: 0,
                                }}
                              >
                                <span style={{ color: 'var(--success)' }}>+{fileStats.additions}</span>
                                <span style={{ color: 'var(--danger)' }}>-{fileStats.deletions}</span>
                              </span>
                            </div>
                            {renderUnifiedDiff(f.unifiedDiff)}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
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
