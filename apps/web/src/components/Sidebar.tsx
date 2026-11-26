import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  CommentThread,
  OutlineItem,
  ProjectFileEntry,
} from '@novatex/shared';
import {
  BookOpen,
  CheckCircle2,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Download,
  File,
  FileCode2,
  FileImage,
  FilePlus2,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  ListTree,
  MessageSquare,
  Pencil,
  RotateCcw,
  Search,
  Send,
  Star,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { api, fileToBase64 } from '../api.ts';
import { useLocale, type UiLocale } from '../i18n.ts';

export type SidebarTab = 'files' | 'outline' | 'comments';

interface SidebarProps {
  width: number;
  projectId: string;
  mainFile: string;
  readOnly: boolean;
  canComment: boolean;
  collaborationEnabled?: boolean;
  activeTab: SidebarTab;
  onChangeTab: (tab: SidebarTab) => void;
  files: ProjectFileEntry[];
  activeFile: string | null;
  outline: OutlineItem[];
  comments: CommentThread[];
  draftCommentAnchor: { line: number; quote: string } | null;
  onClearDraftAnchor: () => void;
  onSelectFile: (filePath: string) => void;
  onSetMainFile: (filePath: string) => void;
  onJumpToLocation: (file: string, line: number) => void;
  onRefreshFiles: () => Promise<void>;
  onRefreshComments: () => Promise<void>;
  onNotify: (kind: 'success' | 'error' | 'info', msg: string) => void;
}

interface FileTreeNode {
  path: string;
  name: string;
  kind: 'dir' | 'file';
  entry: ProjectFileEntry | null;
  children: FileTreeNode[];
  fileCount: number;
}

function normalizeTreePath(raw: string): string {
  return raw.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').replace(/\/+/g, '/');
}

function getAncestorDirs(filePath: string): string[] {
  const clean = normalizeTreePath(filePath);
  if (!clean) return [];
  const parts = clean.split('/');
  const ancestors: string[] = [];
  for (let i = 1; i < parts.length; i++) {
    ancestors.push(parts.slice(0, i).join('/'));
  }
  return ancestors;
}

function getBaseName(filePath: string): string {
  const clean = normalizeTreePath(filePath);
  const idx = clean.lastIndexOf('/');
  return idx >= 0 ? clean.slice(idx + 1) : clean;
}

function buildFileTree(
  files: ProjectFileEntry[],
  mainFile: string,
  locale: UiLocale,
): FileTreeNode[] {
  const mainNorm = normalizeTreePath(mainFile);
  const virtualRoot: FileTreeNode = {
    path: '',
    name: '',
    kind: 'dir',
    entry: null,
    children: [],
    fileCount: 0,
  };
  const dirMap = new Map<string, FileTreeNode>();
  const fileSet = new Set<string>();

  const ensureDir = (dirPath: string): FileTreeNode => {
    const existing = dirMap.get(dirPath);
    if (existing) return existing;

    const slashIdx = dirPath.lastIndexOf('/');
    const parent = slashIdx >= 0 ? ensureDir(dirPath.slice(0, slashIdx)) : virtualRoot;
    const name = slashIdx >= 0 ? dirPath.slice(slashIdx + 1) : dirPath;

    const node: FileTreeNode = {
      path: dirPath,
      name,
      kind: 'dir',
      entry: null,
      children: [],
      fileCount: 0,
    };
    dirMap.set(dirPath, node);
    parent.children.push(node);
    return node;
  };

  for (const entry of files) {
    const cleanPath = normalizeTreePath(entry.path);
    if (!cleanPath) continue;

    if (entry.kind === 'dir') {
      const dirNode = ensureDir(cleanPath);
      dirNode.entry = entry;
      if (entry.name) dirNode.name = entry.name;
    } else {
      if (fileSet.has(cleanPath)) continue;
      fileSet.add(cleanPath);
      const slashIdx = cleanPath.lastIndexOf('/');
      const parent = slashIdx >= 0 ? ensureDir(cleanPath.slice(0, slashIdx)) : virtualRoot;
      const name = entry.name || (slashIdx >= 0 ? cleanPath.slice(slashIdx + 1) : cleanPath);
      parent.children.push({
        path: cleanPath,
        name,
        kind: 'file',
        entry,
        children: [],
        fileCount: 1,
      });
    }
  }

  const sortLocale = locale === 'zh' ? 'zh-CN' : 'en';

  const finalize = (node: FileTreeNode): number => {
    if (node.kind === 'file') {
      node.fileCount = 1;
      return 1;
    }
    node.children.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
      if (a.kind === 'file') {
        const aIsMain = a.path === mainNorm;
        const bIsMain = b.path === mainNorm;
        if (aIsMain !== bIsMain) return aIsMain ? -1 : 1;
      }
      return a.name.localeCompare(b.name, sortLocale, {
        numeric: true,
        sensitivity: 'base',
      });
    });
    let total = 0;
    for (const child of node.children) {
      total += finalize(child);
    }
    node.fileCount = total;
    return total;
  };

  finalize(virtualRoot);
  return virtualRoot.children;
}

function collectAllDirPaths(nodes: FileTreeNode[], out: string[] = []): string[] {
  for (const node of nodes) {
    if (node.kind === 'dir') {
      out.push(node.path);
      collectAllDirPaths(node.children, out);
    }
  }
  return out;
}

function matchesAllTokens(text: string, tokens: string[]): boolean {
  const lower = text.toLowerCase();
  return tokens.every((tok) => lower.includes(tok));
}

function filterFileTree(nodes: FileTreeNode[], tokens: string[]): FileTreeNode[] {
  if (tokens.length === 0) return nodes;
  const result: FileTreeNode[] = [];

  for (const node of nodes) {
    if (node.kind === 'file') {
      if (matchesAllTokens(node.path, tokens)) {
        result.push(node);
      }
    } else {
      if (matchesAllTokens(node.path, tokens)) {
        result.push(node);
      } else {
        const filteredChildren = filterFileTree(node.children, tokens);
        if (filteredChildren.length > 0) {
          const matchedCount = filteredChildren.reduce((sum, c) => sum + c.fileCount, 0);
          result.push({
            ...node,
            children: filteredChildren,
            fileCount: matchedCount,
          });
        }
      }
    }
  }
  return result;
}

function findFirstFileInTree(nodes: FileTreeNode[]): string | null {
  for (const node of nodes) {
    if (node.kind === 'file') return node.path;
    const nested = findFirstFileInTree(node.children);
    if (nested) return nested;
  }
  return null;
}

function countFilesInTree(nodes: FileTreeNode[]): number {
  let count = 0;
  for (const node of nodes) {
    count += node.kind === 'file' ? 1 : countFilesInTree(node.children);
  }
  return count;
}

function renderHighlightedText(text: string, tokens: string[]): React.ReactNode {
  if (tokens.length === 0) return text;
  const lower = text.toLowerCase();
  let bestIdx = -1;
  let bestLen = 0;

  for (const tok of tokens) {
    const idx = lower.indexOf(tok);
    if (idx !== -1 && (tok.length > bestLen || (tok.length === bestLen && idx < bestIdx))) {
      bestIdx = idx;
      bestLen = tok.length;
    }
  }

  if (bestIdx === -1 || bestLen === 0) return text;
  return (
    <>
      {text.slice(0, bestIdx)}
      <mark
        style={{
          background: 'var(--accent-soft)',
          color: 'var(--accent)',
          borderRadius: 2,
          padding: '0 1px',
          fontWeight: 600,
        }}
      >
        {text.slice(bestIdx, bestIdx + bestLen)}
      </mark>
      {text.slice(bestIdx + bestLen)}
    </>
  );
}

function renderFileIcon(node: FileTreeNode, isExpanded: boolean): React.ReactNode {
  if (node.kind === 'dir') {
    return isExpanded ? (
      <FolderOpen size={13.5} style={{ flexShrink: 0, color: 'var(--text-secondary)' }} />
    ) : (
      <Folder size={13.5} style={{ flexShrink: 0, color: 'var(--text-muted)' }} />
    );
  }

  const lower = node.path.toLowerCase();
  if (/\.(tex|ltx)$/i.test(lower)) {
    return <FileCode2 size={13.5} style={{ flexShrink: 0, color: '#0F7B4C' }} />;
  }
  if (lower.endsWith('.bib')) {
    return <BookOpen size={13.5} style={{ flexShrink: 0, color: '#4F46E5' }} />;
  }
  if (/\.(md|markdown|txt)$/i.test(lower)) {
    return <FileText size={13.5} style={{ flexShrink: 0, color: '#B45309' }} />;
  }
  if (/\.(png|jpe?g|gif|webp|svg|eps|bmp|ico)$/i.test(lower)) {
    return <FileImage size={13.5} style={{ flexShrink: 0, color: 'var(--text-muted)' }} />;
  }
  if (lower.endsWith('.pdf')) {
    return <FileText size={13.5} style={{ flexShrink: 0, color: 'var(--text-muted)' }} />;
  }
  if (/\.(sty|cls|bst|def|dtx)$/i.test(lower)) {
    return <FileCode2 size={13.5} style={{ flexShrink: 0, color: 'var(--text-muted)' }} />;
  }
  if (node.entry?.isBinary) {
    return <FileImage size={13.5} style={{ flexShrink: 0, color: 'var(--text-muted)' }} />;
  }
  return <File size={13.5} style={{ flexShrink: 0, color: 'var(--text-muted)' }} />;
}

function formatCommentTime(iso: string, locale: UiLocale): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  const isToday =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  const timeLocale = locale === 'zh' ? 'zh-CN' : 'en-US';

  if (isToday) {
    return date.toLocaleTimeString(timeLocale, {
      hour: '2-digit',
      minute: '2-digit',
    });
  }
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const time = date.toLocaleTimeString(timeLocale, {
    hour: '2-digit',
    minute: '2-digit',
  });
  return `${month}/${day} ${time}`;
}

export const Sidebar: React.FC<SidebarProps> = ({
  width,
  projectId,
  mainFile,
  readOnly,
  canComment,
  collaborationEnabled = false,
  activeTab,
  onChangeTab,
  files,
  activeFile,
  outline,
  comments,
  draftCommentAnchor,
  onClearDraftAnchor,
  onSelectFile,
  onSetMainFile,
  onJumpToLocation,
  onRefreshFiles,
  onRefreshComments,
  onNotify,
}) => {
  const { locale, tr } = useLocale();
  const effectiveTab: SidebarTab =
    !collaborationEnabled && activeTab === 'comments' ? 'files' : activeTab;

  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  // Tree expansion & quick search state
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(() => new Set());
  const seenTopDirsRef = useRef<Set<string>>(new Set());
  const prevProjectIdRef = useRef<string>(projectId);
  const [searchQuery, setSearchQuery] = useState('');

  // Inline create/rename/delete state
  const [creatingKind, setCreatingKind] = useState<'file' | 'dir' | null>(null);
  const [newPath, setNewPath] = useState('');
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState('');
  const [confirmDeletePath, setConfirmDeletePath] = useState<string | null>(null);

  // Outline active item state
  const [selectedOutlineKey, setSelectedOutlineKey] = useState<string | null>(null);

  // Comments state
  const [newCommentBody, setNewCommentBody] = useState('');
  const [submittingComment, setSubmittingComment] = useState(false);
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const [replyingThreadId, setReplyingThreadId] = useState<string | null>(null);
  const [commentFilter, setCommentFilter] = useState<'open' | 'all'>('open');

  const mainFileNorm = useMemo(() => normalizeTreePath(mainFile), [mainFile]);
  const activeFileNorm = useMemo(
    () => (activeFile ? normalizeTreePath(activeFile) : null),
    [activeFile],
  );

  // Build hierarchical file tree
  const treeRoots = useMemo(
    () => buildFileTree(files, mainFileNorm, locale),
    [files, mainFileNorm, locale],
  );

  const topLevelDirPaths = useMemo(
    () => treeRoots.filter((n) => n.kind === 'dir').map((n) => n.path),
    [treeRoots],
  );

  const allDirPaths = useMemo(() => collectAllDirPaths(treeRoots), [treeRoots]);

  const totalFileCount = useMemo(
    () => files.filter((f) => f.kind === 'file').length,
    [files],
  );

  // Reset transient states on project switch & default all top-level dirs open
  useEffect(() => {
    const projectChanged = prevProjectIdRef.current !== projectId;
    if (projectChanged) {
      prevProjectIdRef.current = projectId;
      seenTopDirsRef.current = new Set();
      setSearchQuery('');
      setCreatingKind(null);
      setNewPath('');
      setRenamingPath(null);
      setRenameTarget('');
      setConfirmDeletePath(null);
      setSelectedOutlineKey(null);
      setNewCommentBody('');
      setReplyDrafts({});
    }

    const newTopDirs: string[] = [];
    for (const dirPath of topLevelDirPaths) {
      if (!seenTopDirsRef.current.has(dirPath)) {
        seenTopDirsRef.current.add(dirPath);
        newTopDirs.push(dirPath);
      }
    }

    if (projectChanged) {
      const initial = new Set<string>(newTopDirs);
      if (activeFileNorm) {
        for (const anc of getAncestorDirs(activeFileNorm)) {
          initial.add(anc);
        }
      }
      setExpandedDirs(initial);
    } else if (newTopDirs.length > 0) {
      setExpandedDirs((prev) => {
        const next = new Set(prev);
        for (const d of newTopDirs) next.add(d);
        return next;
      });
    }
  }, [projectId, topLevelDirPaths, activeFileNorm]);

  // Automatically expand ancestor directories whenever activeFile changes
  useEffect(() => {
    if (!activeFileNorm) return;
    const ancestors = getAncestorDirs(activeFileNorm);
    if (ancestors.length === 0) return;

    setExpandedDirs((prev) => {
      if (ancestors.every((dir) => prev.has(dir))) return prev;
      const next = new Set(prev);
      for (const dir of ancestors) next.add(dir);
      return next;
    });
  }, [activeFileNorm]);

  // Search filtering
  const queryTokens = useMemo(() => {
    const trimmed = searchQuery.trim().toLowerCase();
    return trimmed ? trimmed.split(/\s+/).filter(Boolean) : [];
  }, [searchQuery]);

  const isSearching = queryTokens.length > 0;

  const visibleTree = useMemo(
    () => (isSearching ? filterFileTree(treeRoots, queryTokens) : treeRoots),
    [treeRoots, isSearching, queryTokens],
  );

  const firstMatchedFile = useMemo(
    () => (isSearching ? findFirstFileInTree(visibleTree) : null),
    [isSearching, visibleTree],
  );

  const matchedFileCount = useMemo(
    () => (isSearching ? countFilesInTree(visibleTree) : totalFileCount),
    [isSearching, visibleTree, totalFileCount],
  );

  const anyDirExpanded = useMemo(
    () => allDirPaths.some((dirPath) => expandedDirs.has(dirPath)),
    [allDirPaths, expandedDirs],
  );

  const toggleDir = useCallback((dirPath: string) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(dirPath)) {
        next.delete(dirPath);
      } else {
        next.add(dirPath);
      }
      return next;
    });
  }, []);

  const handleToggleAllDirs = useCallback(() => {
    if (anyDirExpanded) {
      setExpandedDirs(new Set());
    } else {
      setExpandedDirs(new Set(allDirPaths));
    }
  }, [anyDirExpanded, allDirPaths]);

  // Outline normalization
  const minOutlineLevel = useMemo(() => {
    if (outline.length === 0) return 2;
    return outline.reduce((min, item) => Math.min(min, item.level), Infinity);
  }, [outline]);

  const outlineHasMultipleFiles = useMemo(() => {
    const set = new Set<string>();
    for (const item of outline) {
      set.add(normalizeTreePath(item.file));
      if (set.size > 1) return true;
    }
    return false;
  }, [outline]);

  // Comments filtering & counts
  const openCommentCount = useMemo(
    () => comments.filter((c) => !c.resolved).length,
    [comments],
  );

  const filteredComments = useMemo(() => {
    return comments.filter((c) => (commentFilter === 'all' ? true : !c.resolved));
  }, [comments, commentFilter]);

  // Handlers
  const handleCreateEntry = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleaned = normalizeTreePath(newPath.trim());
    if (!cleaned || !creatingKind) return;
    try {
      await api.writeFile(projectId, {
        path: cleaned,
        kind: creatingKind,
        content: creatingKind === 'file' ? '' : undefined,
      });
      const createdKind = creatingKind;
      setCreatingKind(null);
      setNewPath('');
      const dirsToExpand =
        createdKind === 'dir' ? [...getAncestorDirs(cleaned), cleaned] : getAncestorDirs(cleaned);
      if (dirsToExpand.length > 0) {
        setExpandedDirs((prev) => {
          const next = new Set(prev);
          for (const d of dirsToExpand) next.add(d);
          return next;
        });
      }
      await onRefreshFiles();
      if (createdKind === 'file') {
        onSelectFile(cleaned);
      }
      onNotify('success', tr(`Created ${cleaned}`, `已创建 ${cleaned}`));
    } catch (err: unknown) {
      onNotify('error', err instanceof Error ? err.message : tr('Failed to create', '创建失败'));
    }
  };

  const handleRenameSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!renamingPath) return;
    const to = normalizeTreePath(renameTarget.trim());
    if (!to || to === renamingPath) {
      setRenamingPath(null);
      return;
    }
    const from = renamingPath;
    try {
      await api.renameFile(projectId, from, to);
      setRenamingPath(null);

      // Update expanded dir keys if a directory (or ancestor) was renamed
      setExpandedDirs((prev) => {
        let changed = false;
        const next = new Set<string>();
        for (const dir of prev) {
          if (dir === from) {
            next.add(to);
            changed = true;
          } else if (dir.startsWith(`${from}/`)) {
            next.add(`${to}${dir.slice(from.length)}`);
            changed = true;
          } else {
            next.add(dir);
          }
        }
        return changed ? next : prev;
      });

      await onRefreshFiles();
      if (activeFileNorm === from) {
        onSelectFile(to);
      } else if (activeFileNorm && activeFileNorm.startsWith(`${from}/`)) {
        onSelectFile(`${to}${activeFileNorm.slice(from.length)}`);
      }
      onNotify('success', tr(`Renamed to ${to}`, `已重命名为 ${to}`));
    } catch (err: unknown) {
      onNotify('error', err instanceof Error ? err.message : tr('Failed to rename', '重命名失败'));
    }
  };

  const handleDeleteEntry = async (filePath: string) => {
    try {
      await api.deleteFile(projectId, filePath);
      setConfirmDeletePath(null);
      await onRefreshFiles();
      onNotify('success', tr(`Deleted ${filePath}`, `已删除 ${filePath}`));
    } catch (err: unknown) {
      onNotify('error', err instanceof Error ? err.message : tr('Failed to delete', '删除失败'));
    }
  };

  const handleUploadFiles = async (fileList: FileList) => {
    for (const file of Array.from(fileList)) {
      const isBin = /\.(png|jpe?g|gif|webp|pdf|eps|svg|zip|docx)$/i.test(file.name);
      const targetPath = /\.(png|jpe?g|gif|webp|eps|svg)$/i.test(file.name)
        ? `figures/${file.name}`
        : file.name;
      try {
        if (isBin) {
          const base64 = await fileToBase64(file);
          await api.writeFile(projectId, { path: targetPath, base64, isBinary: true });
        } else {
          const text = await file.text();
          await api.writeFile(projectId, { path: targetPath, content: text, isBinary: false });
        }
        onNotify('success', tr(`Uploaded ${targetPath}`, `已上传 ${targetPath}`));
      } catch (err: unknown) {
        onNotify(
          'error',
          tr(
            `Failed to upload ${file.name}: ${err instanceof Error ? err.message : ''}`,
            `上传 ${file.name} 失败：${err instanceof Error ? err.message : ''}`,
          ),
        );
      }
    }
    await onRefreshFiles();
  };

  const submitNewComment = async () => {
    if (!activeFile || !newCommentBody.trim() || submittingComment) return;
    const lineNum = draftCommentAnchor?.line ?? 1;
    const quote = draftCommentAnchor?.quote ?? '';
    setSubmittingComment(true);
    try {
      await api.createComment(projectId, {
        filePath: activeFile,
        lineNumber: lineNum,
        quote,
        body: newCommentBody.trim(),
      });
      setNewCommentBody('');
      onClearDraftAnchor();
      await onRefreshComments();
      onNotify(
        'success',
        tr(`Added comment at line ${lineNum}`, `已在第 ${lineNum} 行添加评论`),
      );
    } catch (err: unknown) {
      onNotify(
        'error',
        err instanceof Error ? err.message : tr('Failed to post comment', '发表评论失败'),
      );
    } finally {
      setSubmittingComment(false);
    }
  };

  const handleCreateComment = async (e: React.FormEvent) => {
    e.preventDefault();
    await submitNewComment();
  };

  const handleReplyComment = async (threadId: string) => {
    const body = (replyDrafts[threadId] ?? '').trim();
    if (!body || replyingThreadId === threadId) return;
    setReplyingThreadId(threadId);
    try {
      await api.replyComment(projectId, threadId, body);
      setReplyDrafts((prev) => ({ ...prev, [threadId]: '' }));
      await onRefreshComments();
    } catch (err: unknown) {
      onNotify('error', err instanceof Error ? err.message : tr('Failed to reply', '回复评论失败'));
    } finally {
      setReplyingThreadId(null);
    }
  };

  const handleToggleResolved = async (thread: CommentThread) => {
    try {
      await api.updateCommentThread(projectId, thread.id, !thread.resolved);
      await onRefreshComments();
    } catch (err: unknown) {
      onNotify(
        'error',
        err instanceof Error ? err.message : tr('Failed to update status', '更新状态失败'),
      );
    }
  };

  // Recursive file tree renderer
  const renderTreeNodes = (nodes: FileTreeNode[]): React.ReactNode => {
    const hasSiblingDirs = nodes.some((n) => n.kind === 'dir');

    return nodes.map((node) => {
      const isDir = node.kind === 'dir';
      const isExpanded = isDir && (isSearching || expandedDirs.has(node.path));
      const isSelected = !isDir && activeFileNorm === node.path;
      const isMain = !isDir && node.path === mainFileNorm;
      const isRenaming = renamingPath === node.path;
      const isConfirmingDelete = confirmDeletePath === node.path;

      if (isRenaming) {
        return (
          <form
            key={node.path}
            onSubmit={(e) => void handleRenameSubmit(e)}
            style={{ padding: '2px 4px', display: 'flex', gap: 4 }}
          >
            <input
              className="input"
              style={{ padding: '3px 6px', fontSize: 12, height: 26 }}
              autoFocus
              value={renameTarget}
              onChange={(e) => setRenameTarget(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault();
                  setRenamingPath(null);
                }
              }}
              onBlur={() => setRenamingPath(null)}
            />
          </form>
        );
      }

      return (
        <div
          key={node.path}
          className="tree-node"
          role="treeitem"
          aria-expanded={isDir ? isExpanded : undefined}
        >
          <div
            className={`tree-row ${isDir ? 'is-dir' : ''} ${isSelected ? 'active' : ''}`}
            tabIndex={0}
            onClick={() => {
              if (isDir) {
                toggleDir(node.path);
              } else {
                onSelectFile(node.path);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                if (isDir) toggleDir(node.path);
                else onSelectFile(node.path);
              } else if (isDir && e.key === 'ArrowRight' && !isExpanded) {
                e.preventDefault();
                toggleDir(node.path);
              } else if (isDir && e.key === 'ArrowLeft' && isExpanded) {
                e.preventDefault();
                toggleDir(node.path);
              }
            }}
            title={
              isDir
                ? tr(
                    `${node.path} (${node.fileCount} ${node.fileCount === 1 ? 'file' : 'files'})`,
                    `${node.path}（${node.fileCount} 个文件）`,
                  )
                : node.path
            }
          >
            <div className="tree-row-main">
              {isDir ? (
                <span
                  className={`tree-chevron ${isExpanded ? 'open' : ''}`}
                  aria-hidden="true"
                >
                  <ChevronRight size={12} />
                </span>
              ) : hasSiblingDirs ? (
                <span className="tree-chevron-placeholder" aria-hidden="true" />
              ) : null}

              <span className="tree-row-icon" aria-hidden="true">
                {renderFileIcon(node, isExpanded)}
              </span>

              <span className="tree-row-name" style={{ letterSpacing: '-0.005em' }}>
                {renderHighlightedText(node.name, queryTokens)}
              </span>

              {isMain && <span className="tree-badge-main">{tr('Main', '主')}</span>}
            </div>

            {!readOnly && (
              <div
                className="tree-row-actions"
                onClick={(e) => e.stopPropagation()}
              >
                {isDir && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-icon"
                    style={{ width: 20, height: 20 }}
                    title={tr('New file in this folder', '在此文件夹新建文件')}
                    onClick={() => {
                      setCreatingKind('file');
                      setNewPath(`${node.path}/new.tex`);
                      setExpandedDirs((prev) => {
                        if (prev.has(node.path)) return prev;
                        const next = new Set(prev);
                        next.add(node.path);
                        return next;
                      });
                    }}
                  >
                    <FilePlus2 size={11} />
                  </button>
                )}
                {!isDir && node.path.toLowerCase().endsWith('.tex') && !isMain && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-icon"
                    style={{ width: 20, height: 20 }}
                    title={tr('Set as main compile file', '设为主编译文件')}
                    onClick={() => onSetMainFile(node.path)}
                  >
                    <Star size={11} />
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn-ghost btn-icon"
                  style={{ width: 20, height: 20 }}
                  title={tr('Rename', '重命名')}
                  onClick={() => {
                    setRenamingPath(node.path);
                    setRenameTarget(node.path);
                    setConfirmDeletePath(null);
                  }}
                >
                  <Pencil size={11} />
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-icon"
                  style={{ width: 20, height: 20, color: 'var(--danger)' }}
                  title={tr('Delete', '删除')}
                  onClick={() => setConfirmDeletePath(node.path)}
                >
                  <Trash2 size={11} />
                </button>
              </div>
            )}
          </div>

          {isConfirmingDelete && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 6,
                padding: '5px 8px',
                margin: '2px 4px 6px',
                borderRadius: 'var(--radius-sm)',
                background: 'var(--danger-soft)',
                border: '1px solid var(--danger-border)',
                fontSize: 11.5,
              }}
            >
              <span
                style={{
                  color: 'var(--danger)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {isDir && node.fileCount > 0
                  ? tr(
                      `Delete folder and ${node.fileCount} items?`,
                      `删除目录及 ${node.fileCount} 项？`,
                    )
                  : tr('Confirm delete?', '确认删除？')}
              </span>
              <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                <button
                  type="button"
                  className="btn btn-sm"
                  style={{ height: 22, padding: '0 6px' }}
                  onClick={() => setConfirmDeletePath(null)}
                >
                  {tr('Cancel', '取消')}
                </button>
                <button
                  type="button"
                  className="btn btn-danger btn-sm"
                  style={{ height: 22, padding: '0 6px' }}
                  onClick={() => void handleDeleteEntry(node.path)}
                >
                  {tr('Delete', '删除')}
                </button>
              </div>
            </div>
          )}

          {isDir && isExpanded && (
            <div className="tree-children" role="group">
              {node.children.length > 0 ? (
                renderTreeNodes(node.children)
              ) : (
                <div
                  style={{
                    padding: '3px 8px',
                    fontSize: 11,
                    color: 'var(--text-faint)',
                    fontStyle: 'italic',
                    userSelect: 'none',
                  }}
                >
                  {tr('Empty folder', '空文件夹')}
                </div>
              )}
            </div>
          )}
        </div>
      );
    });
  };

  return (
    <aside className="sidebar" style={{ width }}>
      {/* Crisp Segmented Tabs */}
      <div
        className="sidebar-tabs"
        role="tablist"
        aria-label={tr('Sidebar views', '侧边栏视图')}
        style={{ gap: 4 }}
      >
        <button
          type="button"
          role="tab"
          aria-selected={effectiveTab === 'files'}
          className={`sidebar-tab ${effectiveTab === 'files' ? 'active' : ''}`}
          onClick={() => onChangeTab('files')}
        >
          <FileText size={13} />
          <span>{tr('Files', '文件')}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={effectiveTab === 'outline'}
          className={`sidebar-tab ${effectiveTab === 'outline' ? 'active' : ''}`}
          onClick={() => onChangeTab('outline')}
        >
          <ListTree size={13} />
          <span>{tr('Outline', '大纲')}</span>
        </button>
        {collaborationEnabled && (
          <button
            type="button"
            role="tab"
            aria-selected={effectiveTab === 'comments'}
            className={`sidebar-tab ${effectiveTab === 'comments' ? 'active' : ''}`}
            onClick={() => onChangeTab('comments')}
          >
            <MessageSquare size={13} />
            <span>{tr('Comments', '评论')}</span>
            {openCommentCount > 0 && (
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  minWidth: 16,
                  height: 16,
                  padding: '0 4px',
                  borderRadius: 999,
                  fontSize: 10,
                  fontWeight: 600,
                  lineHeight: 1,
                  background:
                    effectiveTab === 'comments' ? 'var(--accent-soft)' : 'var(--bg-muted)',
                  color:
                    effectiveTab === 'comments' ? 'var(--accent)' : 'var(--text-muted)',
                  border:
                    effectiveTab === 'comments'
                      ? '1px solid var(--accent-border)'
                      : '1px solid var(--border)',
                }}
              >
                {openCommentCount > 99 ? '99+' : openCommentCount}
              </span>
            )}
          </button>
        )}
      </div>

      {/* FILES TAB */}
      {effectiveTab === 'files' && (
        <>
          <div className="sidebar-toolbar">
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                minWidth: 0,
                overflow: 'hidden',
                whiteSpace: 'nowrap',
                textOverflow: 'ellipsis',
              }}
            >
              <span>{tr('Project Files', '项目文件')}</span>
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontVariantNumeric: 'tabular-nums',
                  fontSize: 10.5,
                  color: 'var(--text-faint)',
                }}
              >
                {isSearching ? `${matchedFileCount}/${totalFileCount}` : totalFileCount}
              </span>
            </span>
            <div className="sidebar-actions" style={{ gap: 4 }}>
              {allDirPaths.length > 0 && !isSearching && (
                <button
                  type="button"
                  className="btn btn-ghost btn-icon-sm"
                  title={anyDirExpanded ? tr('Collapse All', '全部折叠') : tr('Expand All', '全部展开')}
                  onClick={handleToggleAllDirs}
                >
                  {anyDirExpanded ? <ChevronsDownUp size={13} /> : <ChevronsUpDown size={13} />}
                </button>
              )}
              {!readOnly && (
                <>
                  <button
                    type="button"
                    className="btn btn-ghost btn-icon-sm"
                    title={tr('New File', '新建文件')}
                    onClick={() => {
                      setCreatingKind('file');
                      setNewPath('sections/new.tex');
                    }}
                  >
                    <FilePlus2 size={13} />
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-icon-sm"
                    title={tr('New Folder', '新建文件夹')}
                    onClick={() => {
                      setCreatingKind('dir');
                      setNewPath('figures');
                    }}
                  >
                    <FolderPlus size={13} />
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-icon-sm"
                    title={tr('Upload', '上传图片 / .bib / .tex')}
                    onClick={() => uploadInputRef.current?.click()}
                  >
                    <Upload size={13} />
                  </button>
                  <input
                    ref={uploadInputRef}
                    type="file"
                    multiple
                    style={{ display: 'none' }}
                    onChange={(e) => {
                      if (e.target.files?.length) {
                        void handleUploadFiles(e.target.files);
                        e.target.value = '';
                      }
                    }}
                  />
                </>
              )}
              <a
                href={api.getExportZipUrl(projectId)}
                download
                className="btn btn-ghost btn-icon-sm"
                title={tr('Download ZIP', '打包下载项目 .zip')}
                style={{ textDecoration: 'none' }}
              >
                <Download size={13} />
              </a>
            </div>
          </div>

          {/* Quick Search Filter Input */}
          {(files.length > 5 || searchQuery.length > 0) && (
            <div className="sidebar-search">
              <Search size={12} aria-hidden="true" style={{ flexShrink: 0 }} />
              <input
                ref={searchInputRef}
                type="text"
                className="sidebar-search-input"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    setSearchQuery('');
                  } else if (e.key === 'Enter' && firstMatchedFile) {
                    e.preventDefault();
                    onSelectFile(firstMatchedFile);
                  }
                }}
                placeholder={tr('Filter files…', '筛选文件…')}
                aria-label={tr('Filter project files', '筛选项目文件')}
              />
              {searchQuery && (
                <button
                  type="button"
                  className="sidebar-search-clear"
                  title={tr('Clear filter', '清空筛选')}
                  aria-label={tr('Clear filter', '清空筛选')}
                  onClick={() => {
                    setSearchQuery('');
                    searchInputRef.current?.focus();
                  }}
                >
                  <X size={12} />
                </button>
              )}
            </div>
          )}

          <div
            className="sidebar-content"
            role="tree"
            aria-label={tr('Project file tree', '项目文件树')}
          >
            {creatingKind && (
              <form
                onSubmit={(e) => void handleCreateEntry(e)}
                style={{
                  padding: 6,
                  marginBottom: 6,
                  border: '1px solid var(--accent-border)',
                  borderRadius: 'var(--radius-sm)',
                  background: 'var(--bg-app)',
                  boxShadow: 'var(--shadow-sm)',
                }}
              >
                <input
                  className="input"
                  style={{ padding: '4px 8px', fontSize: 12, marginBottom: 6 }}
                  autoFocus
                  value={newPath}
                  onChange={(e) => setNewPath(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      e.preventDefault();
                      setCreatingKind(null);
                    }
                  }}
                  placeholder={
                    creatingKind === 'file'
                      ? tr('e.g. sections/method.tex', '例如 sections/method.tex')
                      : tr('e.g. figures', '例如 figures')
                  }
                />
                <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => setCreatingKind(null)}
                  >
                    {tr('Cancel', '取消')}
                  </button>
                  <button type="submit" className="btn btn-primary btn-sm">
                    {tr('Create', '创建')}
                  </button>
                </div>
              </form>
            )}

            {visibleTree.length === 0 ? (
              <div className="tree-empty">
                {isSearching ? (
                  <>
                    <div style={{ marginBottom: 8 }}>
                      {tr(
                        `No files matching "${searchQuery}"`,
                        `未找到匹配「${searchQuery}」的文件`,
                      )}
                    </div>
                    <button
                      type="button"
                      className="btn btn-xs"
                      onClick={() => {
                        setSearchQuery('');
                        searchInputRef.current?.focus();
                      }}
                    >
                      {tr('Clear filter', '清空筛选')}
                    </button>
                  </>
                ) : (
                  tr('No files in project yet', '项目暂无文件')
                )}
              </div>
            ) : (
              renderTreeNodes(visibleTree)
            )}
          </div>
        </>
      )}

      {/* OUTLINE TAB */}
      {effectiveTab === 'outline' && (
        <>
          <div className="sidebar-toolbar">
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <span>{tr('Document Outline', '章节大纲')}</span>
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontVariantNumeric: 'tabular-nums',
                  fontSize: 10.5,
                  color: 'var(--text-faint)',
                }}
              >
                {outline.length}
              </span>
            </span>
          </div>
          <div className="sidebar-content">
            {outline.length === 0 ? (
              <div
                style={{
                  padding: '20px 12px',
                  textAlign: 'center',
                  color: 'var(--text-faint)',
                  fontSize: 12,
                  lineHeight: 1.6,
                }}
              >
                <ListTree
                  size={20}
                  strokeWidth={1.5}
                  style={{ opacity: 0.45, marginBottom: 6 }}
                />
                {locale === 'en' ? (
                  <div>
                    No headings yet. Add <code>\section</code> or <code>\subsection</code> commands.
                  </div>
                ) : (
                  <div>
                    当前项目未检测到 <code>\section</code> / <code>\subsection</code> 结构。
                  </div>
                )}
              </div>
            ) : (
              outline.map((item, idx) => {
                const itemKey = `${item.file}:${item.line}:${idx}`;
                const relDepth = Math.min(4, Math.max(0, item.level - minOutlineLevel));
                const isItemInActiveFile =
                  activeFileNorm !== null && normalizeTreePath(item.file) === activeFileNorm;
                const isSelected = selectedOutlineKey === itemKey && isItemInActiveFile;
                const isTopLevel = relDepth === 0;
                const isMidLevel = relDepth === 1;

                return (
                  <button
                    key={itemKey}
                    type="button"
                    className="outline-item"
                    style={{
                      paddingLeft: 8 + relDepth * 12,
                      paddingRight: 6,
                      paddingTop: isTopLevel ? 6 : 5,
                      paddingBottom: isTopLevel ? 6 : 5,
                      background: isSelected ? 'var(--bg-active)' : undefined,
                      color: isSelected
                        ? 'var(--accent)'
                        : isTopLevel
                          ? 'var(--text-primary)'
                          : isMidLevel
                            ? 'var(--text-secondary)'
                            : 'var(--text-muted)',
                      fontWeight: isSelected || isTopLevel ? 600 : isMidLevel ? 500 : 400,
                      fontSize: isTopLevel ? 12.5 : 12,
                      letterSpacing: '-0.005em',
                    }}
                    onClick={() => {
                      setSelectedOutlineKey(itemKey);
                      onJumpToLocation(item.file, item.line);
                    }}
                    title={`${item.title}\n${item.file}:${item.line} (\\${item.command})`}
                  >
                    <span
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 7,
                        minWidth: 0,
                        flex: 1,
                      }}
                    >
                      {/* Hierarchy dot indicator */}
                      <span
                        aria-hidden="true"
                        style={
                          isTopLevel
                            ? {
                                width: 6,
                                height: 6,
                                borderRadius: 99,
                                flexShrink: 0,
                                background: isSelected
                                  ? 'var(--accent)'
                                  : isItemInActiveFile
                                    ? 'var(--accent)'
                                    : 'var(--border-strong)',
                              }
                            : isMidLevel
                              ? {
                                  width: 5,
                                  height: 5,
                                  borderRadius: 99,
                                  flexShrink: 0,
                                  border: `1.5px solid ${isSelected ? 'var(--accent)' : 'var(--text-faint)'}`,
                                  background: isSelected ? 'var(--accent)' : 'transparent',
                                }
                              : {
                                  width: 4,
                                  height: 4,
                                  borderRadius: 99,
                                  flexShrink: 0,
                                  background: isSelected ? 'var(--accent)' : 'var(--text-faint)',
                                  opacity: isSelected ? 1 : 0.7,
                                }
                        }
                      />
                      <span className="tree-row-name">{item.title}</span>
                    </span>

                    <span
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 4,
                        flexShrink: 0,
                      }}
                    >
                      {outlineHasMultipleFiles && !isItemInActiveFile && (
                        <span
                          style={{
                            maxWidth: 52,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                            fontSize: 10,
                            color: 'var(--text-faint)',
                          }}
                        >
                          {getBaseName(item.file).replace(/\.tex$/i, '')}
                        </span>
                      )}
                      <span
                        className="outline-line"
                        style={{
                          padding: '1px 5px',
                          borderRadius: 4,
                          fontSize: 10.5,
                          lineHeight: '15px',
                          background: isSelected ? 'var(--accent-soft)' : 'var(--bg-muted)',
                          color: isSelected ? 'var(--accent)' : 'var(--text-faint)',
                          border: `1px solid ${isSelected ? 'var(--accent-border)' : 'transparent'}`,
                        }}
                      >
                        L{item.line}
                      </span>
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </>
      )}

      {/* COMMENTS TAB */}
      {collaborationEnabled && effectiveTab === 'comments' && (
        <>
          <div className="sidebar-toolbar" style={{ gap: 6 }}>
            <span
              style={{
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
              title={
                activeFile
                  ? tr(`Current file: ${activeFile}`, `当前文件：${activeFile}`)
                  : tr('All comments', '全部评论')
              }
            >
              {tr('Comments', '评论')}
            </span>
            <div
              role="group"
              aria-label={tr('Filter comments', '评论筛选')}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                padding: 2,
                borderRadius: 6,
                background: 'var(--bg-muted)',
                border: '1px solid var(--border)',
                flexShrink: 0,
              }}
            >
              <button
                type="button"
                onClick={() => setCommentFilter('open')}
                style={{
                  border: 'none',
                  borderRadius: 4,
                  height: 20,
                  padding: '0 7px',
                  fontSize: 11,
                  fontWeight: commentFilter === 'open' ? 600 : 500,
                  background: commentFilter === 'open' ? 'var(--bg-app)' : 'transparent',
                  color: commentFilter === 'open' ? 'var(--accent)' : 'var(--text-muted)',
                  boxShadow: commentFilter === 'open' ? 'var(--shadow-sm)' : 'none',
                  transition: 'background 0.12s ease, color 0.12s ease',
                }}
              >
                {tr('Open', '未解决')}
                {openCommentCount > 0 ? ` ${openCommentCount}` : ''}
              </button>
              <button
                type="button"
                onClick={() => setCommentFilter('all')}
                style={{
                  border: 'none',
                  borderRadius: 4,
                  height: 20,
                  padding: '0 7px',
                  fontSize: 11,
                  fontWeight: commentFilter === 'all' ? 600 : 500,
                  background: commentFilter === 'all' ? 'var(--bg-app)' : 'transparent',
                  color: commentFilter === 'all' ? 'var(--accent)' : 'var(--text-muted)',
                  boxShadow: commentFilter === 'all' ? 'var(--shadow-sm)' : 'none',
                  transition: 'background 0.12s ease, color 0.12s ease',
                }}
              >
                {tr('All', '全部')}
                {comments.length > 0 ? ` ${comments.length}` : ''}
              </button>
            </div>
          </div>

          <div className="sidebar-content">
            {canComment && activeFile && (
              <form className="comment-composer" onSubmit={(e) => void handleCreateComment(e)}>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 6,
                    marginBottom: 6,
                    fontSize: 11,
                    color: 'var(--text-muted)',
                  }}
                >
                  <button
                    type="button"
                    className="comment-anchor"
                    style={{
                      maxWidth: '100%',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                    title={tr(
                      `Jump to ${activeFile}:${draftCommentAnchor?.line ?? 1}`,
                      `跳转至 ${activeFile}:${draftCommentAnchor?.line ?? 1}`,
                    )}
                    onClick={() => onJumpToLocation(activeFile, draftCommentAnchor?.line ?? 1)}
                  >
                    {getBaseName(activeFile)}:L{draftCommentAnchor?.line ?? 1}
                  </button>
                  {draftCommentAnchor && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-icon"
                      style={{ width: 20, height: 20, color: 'var(--text-faint)' }}
                      title={tr('Clear line anchor', '清除行锚点')}
                      onClick={onClearDraftAnchor}
                    >
                      <X size={11} />
                    </button>
                  )}
                </div>

                {draftCommentAnchor?.quote && (
                  <p className="comment-quote" title={draftCommentAnchor.quote}>
                    {draftCommentAnchor.quote}
                  </p>
                )}

                <textarea
                  className="textarea"
                  rows={2}
                  style={{
                    fontFamily: 'var(--font-sans)',
                    fontSize: 12,
                    marginBottom: 6,
                    padding: '6px 8px',
                  }}
                  placeholder={tr(
                    'Write a review comment or suggestion for this line…',
                    '输入针对此行的审阅意见或修改建议…',
                  )}
                  value={newCommentBody}
                  onChange={(e) => setNewCommentBody(e.target.value)}
                  onKeyDown={(e) => {
                    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                      e.preventDefault();
                      void submitNewComment();
                    }
                  }}
                />
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 6,
                  }}
                >
                  <span style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>
                    {tr('Ctrl+Enter to post', 'Ctrl+Enter 发表')}
                  </span>
                  <button
                    type="submit"
                    className="btn btn-primary btn-xs"
                    disabled={!newCommentBody.trim() || submittingComment}
                  >
                    <Send size={11} />
                    {tr('Post', '发表')}
                  </button>
                </div>
              </form>
            )}

            {filteredComments.length === 0 ? (
              <div
                style={{
                  padding: '20px 12px',
                  textAlign: 'center',
                  color: 'var(--text-faint)',
                  fontSize: 12,
                  lineHeight: 1.6,
                }}
              >
                <MessageSquare
                  size={20}
                  strokeWidth={1.5}
                  style={{ opacity: 0.45, marginBottom: 6 }}
                />
                {comments.length > 0 && commentFilter === 'open' ? (
                  <>
                    <div style={{ marginBottom: 8 }}>
                      {tr(
                        'All comments in this file are resolved',
                        '当前文件的评论已全部解决',
                      )}
                    </div>
                    <button
                      type="button"
                      className="btn btn-xs"
                      onClick={() => setCommentFilter('all')}
                    >
                      {tr(`View all (${comments.length})`, `查看全部（${comments.length}）`)}
                    </button>
                  </>
                ) : (
                  <div>
                    {tr(
                      'No comments yet. Click the comment icon in the editor toolbar to anchor the current line.',
                      '暂无评论。可在编辑器右上角点击评论图标锚定当前行。',
                    )}
                  </div>
                )}
              </div>
            ) : (
              filteredComments.map((thread) => {
                const replyDraft = replyDrafts[thread.id] ?? '';
                const isReplying = replyingThreadId === thread.id;

                return (
                  <div
                    key={thread.id}
                    className={`comment-card ${thread.resolved ? 'resolved' : ''}`}
                  >
                    <div className="comment-card-header">
                      <button
                        type="button"
                        className="comment-anchor"
                        style={{
                          maxWidth: '65%',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                        title={tr(
                          `Jump to ${thread.filePath} line ${thread.lineNumber}`,
                          `跳转至 ${thread.filePath} 第 ${thread.lineNumber} 行`,
                        )}
                        onClick={() => onJumpToLocation(thread.filePath, thread.lineNumber)}
                      >
                        {getBaseName(thread.filePath)}:L{thread.lineNumber}
                      </button>

                      {canComment ? (
                        <button
                          type="button"
                          className="btn btn-ghost btn-xs"
                          style={{ height: 22, padding: '0 6px', fontSize: 11 }}
                          onClick={() => void handleToggleResolved(thread)}
                        >
                          {thread.resolved ? (
                            <>
                              <RotateCcw size={11} /> {tr('Reopen', '重开')}
                            </>
                          ) : (
                            <>
                              <CheckCircle2 size={11} /> {tr('Resolve', '解决')}
                            </>
                          )}
                        </button>
                      ) : thread.resolved ? (
                        <span
                          style={{
                            fontSize: 10.5,
                            color: 'var(--text-faint)',
                            fontWeight: 500,
                          }}
                        >
                          {tr('Resolved', '已解决')}
                        </span>
                      ) : null}
                    </div>

                    {thread.quote && (
                      <p className="comment-quote" title={thread.quote}>
                        {thread.quote}
                      </p>
                    )}

                    {thread.messages.map((m) => (
                      <div key={m.id} className="comment-msg">
                        <div className="comment-msg-meta">
                          <span
                            className="comment-dot"
                            style={{
                              background: m.authorColor || '#2563eb',
                              width: 8,
                              height: 8,
                              flexShrink: 0,
                              boxShadow: '0 0 0 1.5px var(--bg-app)',
                            }}
                          />
                          <strong
                            style={{
                              color: 'var(--text-primary)',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {m.authorName}
                          </strong>
                          <span
                            style={{
                              marginLeft: 'auto',
                              fontSize: 10.5,
                              color: 'var(--text-faint)',
                              flexShrink: 0,
                            }}
                          >
                            {formatCommentTime(m.createdAt, locale)}
                          </span>
                        </div>
                        <div
                          style={{
                            whiteSpace: 'pre-wrap',
                            wordBreak: 'break-word',
                            color: 'var(--text-secondary)',
                            lineHeight: 1.5,
                          }}
                        >
                          {m.body}
                        </div>
                      </div>
                    ))}

                    {canComment && !thread.resolved && (
                      <div style={{ display: 'flex', gap: 4, marginTop: 6 }}>
                        <input
                          className="input"
                          style={{ padding: '4px 7px', fontSize: 11.5, height: 26 }}
                          placeholder={tr('Reply…', '回复…')}
                          value={replyDraft}
                          onChange={(e) =>
                            setReplyDrafts((prev) => ({
                              ...prev,
                              [thread.id]: e.target.value,
                            }))
                          }
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.shiftKey) {
                              e.preventDefault();
                              void handleReplyComment(thread.id);
                            }
                          }}
                        />
                        <button
                          type="button"
                          className="btn btn-xs"
                          style={{ height: 26, padding: '0 8px' }}
                          disabled={!replyDraft.trim() || isReplying}
                          onClick={() => void handleReplyComment(thread.id)}
                        >
                          {tr('Reply', '回复')}
                        </button>
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </>
      )}
    </aside>
  );
};
