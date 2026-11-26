import React, { useEffect, useState } from 'react';
import type { ProjectInvite, ProjectMemberInfo, ProjectMemberRole } from '@novatex/shared';
import { Check, Copy, Key, Link2, Loader2, Terminal, UserPlus, Users, X } from 'lucide-react';
import { api } from '../api.ts';

interface ShareModalProps {
  open: boolean;
  projectId: string;
  projectName: string;
  currentRole: ProjectMemberRole;
  members: ProjectMemberInfo[];
  onNotify: (kind: 'success' | 'error' | 'info', msg: string) => void;
  onClose: () => void;
}

const ROLE_LABELS: Record<ProjectMemberRole, string> = {
  owner: '所有者',
  editor: '可编辑',
  commenter: '仅评论',
  viewer: '只读预览',
};

const ROLE_PILL_CLASS: Record<ProjectMemberRole, string> = {
  owner: 'pill pill-accent',
  editor: 'pill pill-success',
  commenter: 'pill',
  viewer: 'pill',
};

export const ShareModal: React.FC<ShareModalProps> = ({
  open,
  projectId,
  projectName,
  currentRole,
  members,
  onNotify,
  onClose,
}) => {
  const [invites, setInvites] = useState<ProjectInvite[]>([]);
  const [inviteRole, setInviteRole] = useState<Exclude<ProjectMemberRole, 'owner'>>('editor');
  const [creatingInvite, setCreatingInvite] = useState(false);

  const [syncToken, setSyncToken] = useState<string | null>(null);
  const [creatingToken, setCreatingToken] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const canManageInvites = currentRole === 'owner' || currentRole === 'editor';
  const isBusy = creatingInvite || creatingToken;

  useEffect(() => {
    if (!open || !canManageInvites) return;
    api
      .listInvites(projectId)
      .then((list) => setInvites(list))
      .catch(() => setInvites([]));
  }, [open, projectId, canManageInvites]);

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

  const copyText = async (text: string, label: string, key?: string) => {
    try {
      await navigator.clipboard.writeText(text);
      onNotify('success', `已复制${label}`);
      if (key) {
        setCopiedKey(key);
        window.setTimeout(() => {
          setCopiedKey((curr) => (curr === key ? null : curr));
        }, 1800);
      }
    } catch {
      onNotify('error', '复制失败，请手动复制');
    }
  };

  const handleCreateInvite = async () => {
    setCreatingInvite(true);
    setError(null);
    try {
      const inv = await api.createInvite(projectId, {
        role: inviteRole,
        expiresInHours: 168,
        maxUses: 10,
      });
      setInvites((prev) => [inv, ...prev]);
      const url = `${window.location.origin}/?invite=${encodeURIComponent(inv.token)}`;
      await copyText(url, '邀请链接', inv.token);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '生成邀请链接失败');
    } finally {
      setCreatingInvite(false);
    }
  };

  const handleCreateSyncToken = async () => {
    setCreatingToken(true);
    setError(null);
    try {
      const res = await api.createSyncToken(`agent-${new Date().toISOString().slice(0, 10)}`);
      setSyncToken(res.token);
      onNotify('success', '已生成个人本地 Agent 同步令牌');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '生成同步令牌失败');
    } finally {
      setCreatingToken(false);
    }
  };

  const safeDir = projectName.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32) || 'paper';
  const cliCommand = `npm run sync -- watch --url "${window.location.origin}" --project "${projectId}" --token "${syncToken ?? '<请先生成令牌>'}" --dir "./${safeDir}"`;

  return (
    <div className="modal-backdrop">
      <div
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-share-title"
      >
        <div className="modal-header">
          <h3 id="modal-share-title" className="modal-title">
            <Users size={16} style={{ color: 'var(--accent)' }} />
            协作邀请与本地 Agent 同步
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

        <div
          className="modal-body"
          style={{ display: 'flex', flexDirection: 'column', gap: 20 }}
        >
          {error && (
            <div className="alert alert-danger" style={{ marginBottom: 0 }}>
              {error}
            </div>
          )}

          {/* Section 1: Project Members */}
          <section>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: 8,
              }}
            >
              <div
                className="field-label"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
              >
                <Users size={13} style={{ color: 'var(--accent)' }} />
                项目协作成员
              </div>
              <span className="pill">{members.length} 人</span>
            </div>
            <div
              style={{
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-md)',
                overflow: 'hidden',
                background: 'var(--bg-app)',
              }}
            >
              {members.length === 0 ? (
                <div style={{ padding: 14, color: 'var(--text-muted)', fontSize: 12.5 }}>
                  当前仅你一人。
                </div>
              ) : (
                members.map((m, idx) => (
                  <div
                    key={m.userId}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '10px 14px',
                      borderBottom:
                        idx < members.length - 1 ? '1px solid var(--border-subtle)' : 'none',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                      <span
                        className="presence-avatar"
                        style={{
                          background: m.color || '#2563eb',
                          marginLeft: 0,
                          borderColor: 'var(--bg-app)',
                          width: 28,
                          height: 28,
                          fontSize: 11.5,
                        }}
                      >
                        {(m.displayName || m.username).slice(0, 1).toUpperCase()}
                      </span>
                      <div style={{ minWidth: 0 }}>
                        <div
                          style={{
                            fontWeight: 600,
                            fontSize: 13,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {m.displayName}
                        </div>
                        <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                          @{m.username}
                        </div>
                      </div>
                    </div>
                    <span className={ROLE_PILL_CLASS[m.role]}>{ROLE_LABELS[m.role]}</span>
                  </div>
                ))
              )}
            </div>
          </section>

          {/* Section 2: Invite Links */}
          {canManageInvites && (
            <section
              style={{
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-md)',
                padding: 14,
                background: 'var(--bg-subtle)',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  marginBottom: 10,
                }}
              >
                <div
                  className="field-label"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
                >
                  <Link2 size={13} style={{ color: 'var(--accent)' }} />
                  生成协作邀请链接
                </div>
                <span style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>
                  有效期 7 天 · 最多 10 人使用
                </span>
              </div>

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                <select
                  className="select"
                  style={{ width: 200, flexShrink: 0 }}
                  value={inviteRole}
                  onChange={(e) =>
                    setInviteRole(e.target.value as Exclude<ProjectMemberRole, 'owner'>)
                  }
                >
                  <option value="editor">编辑者（可协同改源码）</option>
                  <option value="commenter">评论者（仅可审阅评论）</option>
                  <option value="viewer">只读预览</option>
                </select>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={creatingInvite}
                  onClick={() => void handleCreateInvite()}
                >
                  {creatingInvite ? <Loader2 size={14} className="spin" /> : <UserPlus size={14} />}
                  生成并复制邀请链接
                </button>
              </div>

              {invites.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 7, marginTop: 12 }}>
                  {invites.slice(0, 4).map((inv) => {
                    const url = `${window.location.origin}/?invite=${encodeURIComponent(inv.token)}`;
                    const isCopied = copiedKey === inv.token;
                    return (
                      <div
                        key={inv.token}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: 10,
                          padding: '7px 10px',
                          borderRadius: 'var(--radius-sm)',
                          border: '1px solid var(--border)',
                          background: 'var(--bg-app)',
                          fontSize: 12,
                        }}
                      >
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 7,
                            minWidth: 0,
                            overflow: 'hidden',
                            flex: 1,
                          }}
                        >
                          <Link2 size={13} style={{ flexShrink: 0, color: 'var(--accent)' }} />
                          <span className={ROLE_PILL_CLASS[inv.role]}>{ROLE_LABELS[inv.role]}</span>
                          <span
                            style={{
                              fontFamily: 'var(--font-mono)',
                              fontSize: 11.5,
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                              color: 'var(--text-secondary)',
                            }}
                          >
                            {url}
                          </span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                          <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>
                            {inv.usedCount}/{inv.maxUses}
                          </span>
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            onClick={() => void copyText(url, '邀请链接', inv.token)}
                          >
                            {isCopied ? (
                              <Check size={12} style={{ color: 'var(--success)' }} />
                            ) : (
                              <Copy size={12} />
                            )}
                            {isCopied ? '已复制' : '复制'}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          )}

          {/* Section 3: Local Agent Sync Guide (novatex-sync) */}
          <section
            style={{
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-md)',
              padding: 14,
              background: 'var(--bg-subtle)',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 10,
                flexWrap: 'wrap',
                marginBottom: 8,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontWeight: 600 }}>
                <Terminal size={14} style={{ color: 'var(--accent)' }} />
                本地 AI Agent 双向实时同步（Codex / Claude Code / Antigravity）
              </div>
              <button
                type="button"
                className="btn btn-sm"
                disabled={creatingToken}
                onClick={() => void handleCreateSyncToken()}
              >
                {creatingToken ? <Loader2 size={12} className="spin" /> : <Key size={12} />}
                {syncToken ? '重新生成令牌' : '生成个人同步令牌'}
              </button>
            </div>
            <p className="field-hint" style={{ margin: '0 0 10px', lineHeight: 1.55 }}>
              通过 <code>novatex-sync</code> 将本项目以 CRDT 双向映射到本机目录，本机 Codex / CC / AG 改文件后网页端毫秒级无冲突实时同步。
            </p>
            <div className="code-block">{cliCommand}</div>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 10,
                marginTop: 10,
              }}
            >
              <span style={{ fontSize: 11.5, color: syncToken ? 'var(--success)' : 'var(--text-faint)' }}>
                {syncToken ? '个人同步令牌已填入上方命令，可直接复制运行' : '请先点击右上角生成个人同步令牌'}
              </span>
              <button
                type="button"
                className="btn btn-sm"
                disabled={!syncToken}
                onClick={() => void copyText(cliCommand, '同步命令', 'cli-command')}
              >
                {copiedKey === 'cli-command' ? (
                  <Check size={12} style={{ color: 'var(--success)' }} />
                ) : (
                  <Copy size={12} />
                )}
                {copiedKey === 'cli-command' ? '已复制命令' : '复制 CLI 启动命令'}
              </button>
            </div>
          </section>
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
