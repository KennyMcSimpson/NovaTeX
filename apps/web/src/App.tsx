import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AcademicTemplateId,
  AiFixMode,
  AiFixResponse,
  CommentThread,
  CompileDiagnostic,
  CompileEngine,
  CompileResult,
  OutlineItem,
  ProjectFileEntry,
  ProjectMemberInfo,
  ProjectSummary,
  SyncTeXForwardResult,
  SystemCapabilities,
  UserPublic,
} from '@novatex/shared';
import {
  ArrowLeftRight,
  Check,
  ChevronDown,
  Code2,
  Cpu,
  FileArchive,
  FileText,
  FileType2,
  FlaskConical,
  FolderPlus,
  Globe,
  History,
  Languages,
  Loader2,
  LogOut,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Search,
  ShieldCheck,
  Sparkles,
  Sun,
  Terminal,
  Users,
  X,
} from 'lucide-react';
import { api, fileToBase64, type AuthMeResponse, type BibKeysResponse } from './api.ts';
import { detectInitialLocale, LocaleContext, type UiLocale } from './i18n.ts';
import { AuthScreen } from './components/AuthScreen.tsx';
import { BrandMark } from './components/BrandMark.tsx';
import { DiagnosticsBar } from './components/DiagnosticsBar.tsx';
import { DiffModal } from './components/DiffModal.tsx';
import {
  EditorPane,
  type EditorHandle,
  type PresenceUser,
} from './components/EditorPane.tsx';
import { FormatHubModal } from './components/FormatHubModal.tsx';
import { GitHistoryModal } from './components/GitHistoryModal.tsx';
import { LabToolkitModal } from './components/LabToolkitModal.tsx';
import { MarkdownWorkspacePane } from './components/MarkdownWorkspacePane.tsx';
import { PdfPane } from './components/PdfPane.tsx';
import { SettingsPage, type SettingsSection } from './components/SettingsPage.tsx';
import { ShareModal } from './components/ShareModal.tsx';
import { Sidebar, type SidebarTab } from './components/Sidebar.tsx';
import { WordCollabPane } from './components/WordCollabPane.tsx';

type WorkspaceMode = 'latex' | 'markdown' | 'word';

interface ToastItem {
  id: number;
  kind: 'success' | 'error' | 'info';
  message: string;
}

interface PendingLabInsert {
  projectId: string;
  filePath: string;
  latex: string;
  label: string;
}

const AI_MODE_TITLES: Record<AiFixMode, { en: string; zh: string }> = {
  'diagnose-and-fix': {
    en: 'AI Compile Error Diagnosis & Fix',
    zh: 'AI 编译报错诊断与修复',
  },
  'format-table': {
    en: 'AI Three-Line Table Formatting',
    zh: 'AI 三线表格式整理',
  },
  'format-math': {
    en: 'AI Math Formatting Fix',
    zh: 'AI 公式排版修正',
  },
  'cleanup-conversion': {
    en: 'AI Conversion Light Cleanup',
    zh: 'AI 格式互转轻度清洗',
  },
};

const ENGINE_LABELS: Record<CompileEngine, string> = {
  xelatex: 'XeLaTeX',
  pdflatex: 'pdfLaTeX',
  lualatex: 'LuaLaTeX',
};

export const App: React.FC = () => {
  // Bilingual UI locale state (EN / ZH)
  const [locale, setLocaleState] = useState<UiLocale>(() => detectInitialLocale());

  const applyDocumentLocale = useCallback((next: UiLocale) => {
    document.documentElement.lang = next === 'zh' ? 'zh-CN' : 'en';
    document.title =
      next === 'zh'
        ? 'NovaTeX — 多格式 LaTeX 与实验报告工作台'
        : 'NovaTeX — Multi-Format LaTeX & Lab Report Studio';
  }, []);

  const setLocale = useCallback(
    (next: UiLocale) => {
      setLocaleState(next);
      try {
        window.localStorage.setItem('novatex-lang', next);
      } catch {
        // ignore storage quota / private mode failures
      }
      applyDocumentLocale(next);
    },
    [applyDocumentLocale],
  );

  useEffect(() => {
    applyDocumentLocale(locale);
  }, [locale, applyDocumentLocale]);

  const tr = useCallback((en: string, zh: string) => (locale === 'zh' ? zh : en), [locale]);
  const trRef = useRef(tr);
  trRef.current = tr;

  const localeContextValue = useMemo(
    () => ({ locale, setLocale, tr }),
    [locale, setLocale, tr],
  );

  // Theme state
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    const saved = window.localStorage.getItem('novatex-theme');
    return saved === 'dark' ? 'dark' : 'light';
  });

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    window.localStorage.setItem('novatex-theme', theme);
  }, [theme]);

  // URL invite token
  const [inviteToken, setInviteToken] = useState<string | null>(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('invite');
  });

  // Auth & system state
  const [authLoading, setAuthLoading] = useState(true);
  const [authMeta, setAuthMeta] = useState<AuthMeResponse | null>(null);
  const [user, setUser] = useState<UserPublic | null>(null);
  const [capabilities, setCapabilities] = useState<SystemCapabilities | null>(null);

  // Feature gate: multi-user collaboration UI (off by default in local solo mode)
  const collaborationEnabled = Boolean(capabilities?.features?.collaboration);

  // Projects & files state
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const activeProjectIdRef = useRef<string | null>(activeProjectId);
  activeProjectIdRef.current = activeProjectId;
  const [members, setMembers] = useState<ProjectMemberInfo[]>([]);
  const [files, setFiles] = useState<ProjectFileEntry[]>([]);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [outline, setOutline] = useState<OutlineItem[]>([]);
  const [bibData, setBibData] = useState<BibKeysResponse>({ citeKeys: [], labels: [] });
  const [comments, setComments] = useState<CommentThread[]>([]);

  // Workspace mode & dedicated full-page Settings view
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>('latex');
  const [settingsSection, setSettingsSection] = useState<SettingsSection | null>(null);

  // Collaboration & Editor state
  const editorHandleRef = useRef<EditorHandle | null>(null);
  const pendingInsertRef = useRef<PendingLabInsert | null>(null);
  const [presenceUsers, setPresenceUsers] = useState<PresenceUser[]>([]);
  const [jumpRequest, setJumpRequest] = useState<{
    file: string;
    line: number;
    nonce: number;
  } | null>(null);
  const [draftCommentAnchor, setDraftCommentAnchor] = useState<{
    line: number;
    quote: string;
  } | null>(null);

  // Compile & SyncTeX state
  const [compiling, setCompiling] = useState(false);
  const [compileResult, setCompileResult] = useState<CompileResult | null>(null);
  const [pdfVersion, setPdfVersion] = useState(1);
  const [synctexHighlight, setSynctexHighlight] = useState<SyncTeXForwardResult | null>(null);

  // AI Fixer state
  const [aiLoading, setAiLoading] = useState(false);
  const [useReasoner, setUseReasoner] = useState(false);
  const aiFixSeqRef = useRef<number>(0);
  const [pendingAiFix, setPendingAiFix] = useState<{
    projectId: string;
    filePath: string;
    response: AiFixResponse;
  } | null>(null);

  // Layout, Menus & Modals
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(224);
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('files');
  const [editorRatio, setEditorRatio] = useState(0.48);
  const [draggingSplit, setDraggingSplit] = useState<'sidebar' | 'center' | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [projectSearch, setProjectSearch] = useState('');
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const accountMenuRef = useRef<HTMLDivElement | null>(null);

  const [showNewProjectModal, setShowNewProjectModal] = useState(false);
  const [newProjName, setNewProjName] = useState('');
  const [newProjDesc, setNewProjDesc] = useState('');
  const [newProjTemplate, setNewProjTemplate] = useState<AcademicTemplateId>(() =>
    detectInitialLocale() === 'zh' ? 'lab-report-zh' : 'lab-report-en',
  );
  const [newProjEngine, setNewProjEngine] = useState<CompileEngine>(() =>
    detectInitialLocale() === 'zh' ? 'xelatex' : 'pdflatex',
  );
  const [creatingProj, setCreatingProj] = useState(false);

  const [showImportZipModal, setShowImportZipModal] = useState(false);
  const [zipFile, setZipFile] = useState<File | null>(null);
  const [zipProjName, setZipProjName] = useState('');
  const [importingZip, setImportingZip] = useState(false);

  const [showFormatHub, setShowFormatHub] = useState(false);
  const [showGitHistory, setShowGitHistory] = useState(false);
  const [showShareModal, setShowShareModal] = useState(false);
  const [showLabToolkit, setShowLabToolkit] = useState(false);

  // Toasts
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const toastSeqRef = useRef(1);

  const notify = useCallback((kind: 'success' | 'error' | 'info', message: string) => {
    const id = toastSeqRef.current++;
    setToasts((prev) => [...prev.slice(-3), { id, kind, message }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 3600);
  }, []);

  const refreshCapabilities = useCallback(() => {
    api
      .getHealth()
      .then((cap) => setCapabilities(cap))
      .catch(() => {});
  }, []);

  // Ensure collaboration-only surfaces close cleanly when feature gate is off
  useEffect(() => {
    if (!collaborationEnabled) {
      setShowShareModal(false);
      setSidebarTab((tab) => (tab === 'comments' ? 'files' : tab));
    }
  }, [collaborationEnabled]);

  // Initial auth & health bootstrap
  useEffect(() => {
    refreshCapabilities();
    api
      .getAuthMe()
      .then(async (res) => {
        setAuthMeta(res);
        if (res.authenticated && res.user) {
          setUser(res.user);
          // If already logged in and visiting an invite URL, auto-accept
          if (inviteToken) {
            try {
              const accepted = await api.acceptInvite(inviteToken);
              const pid = accepted.projectId ?? accepted.project?.id;
              if (pid) setActiveProjectId(pid);
              notify(
                'success',
                trRef.current('Joined project via invite link', '已通过邀请链接加入项目'),
              );
            } catch {
              // ignore if already joined or expired
            } finally {
              setInviteToken(null);
              window.history.replaceState({}, '', window.location.pathname);
            }
          }
        }
      })
      .catch((err: unknown) => {
        notify(
          'error',
          err instanceof Error
            ? err.message
            : trRef.current('Unable to connect to NovaTeX server', '无法连接 NovaTeX 服务'),
        );
      })
      .finally(() => setAuthLoading(false));
  }, [refreshCapabilities]);

  // Load projects when authenticated
  const loadProjects = useCallback(
    async (preferId?: string) => {
      try {
        const list = await api.listProjects();
        setProjects(list);
        setActiveProjectId((curr) => {
          if (preferId && list.some((p) => p.id === preferId)) return preferId;
          if (curr && list.some((p) => p.id === curr)) return curr;
          return list[0]?.id ?? null;
        });
      } catch (err: unknown) {
        notify(
          'error',
          err instanceof Error
            ? err.message
            : trRef.current('Failed to load project list', '加载项目列表失败'),
        );
      }
    },
    [notify],
  );

  useEffect(() => {
    if (user) {
      void loadProjects();
    }
  }, [user, loadProjects]);

  const activeProject = useMemo(
    () => projects.find((p) => p.id === activeProjectId) ?? null,
    [projects, activeProjectId],
  );

  const filteredProjects = useMemo(() => {
    const q = projectSearch.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        (p.description && p.description.toLowerCase().includes(q)) ||
        p.engine.toLowerCase().includes(q),
    );
  }, [projects, projectSearch]);

  const activeFileEntry = useMemo(
    () => files.find((f) => f.path === activeFile) ?? null,
    [files, activeFile],
  );

  const readOnly = activeProject
    ? activeProject.role === 'viewer' || activeProject.role === 'commenter'
    : true;
  const canEdit = !readOnly;
  const canComment = activeProject ? activeProject.role !== 'viewer' : false;

  const formatTargetFile =
    activeFile && activeFile.toLowerCase().endsWith('.tex')
      ? activeFile
      : (activeProject?.mainFile ?? 'main.tex');

  const refreshProjectFiles = useCallback(async (projectId: string) => {
    const [detail, fileList, outlineItems, bib] = await Promise.allSettled([
      api.getProject(projectId),
      api.listFiles(projectId),
      api.getOutline(projectId),
      api.getBibKeys(projectId),
    ]);

    let projMain = 'main.tex';
    if (detail.status === 'fulfilled') {
      setMembers(detail.value.members);
      projMain = detail.value.project.mainFile || 'main.tex';
    }
    if (fileList.status === 'fulfilled') {
      setFiles(fileList.value);
      setActiveFile((curr) => {
        if (curr && fileList.value.some((f) => f.path === curr && f.kind === 'file')) {
          return curr;
        }
        const mainEntry = fileList.value.find((f) => f.path === projMain && f.kind === 'file');
        if (mainEntry) return mainEntry.path;
        const firstTex = fileList.value.find(
          (f) => f.kind === 'file' && f.path.endsWith('.tex'),
        );
        return firstTex?.path ?? fileList.value.find((f) => f.kind === 'file')?.path ?? null;
      });
    }
    if (outlineItems.status === 'fulfilled') setOutline(outlineItems.value);
    if (bib.status === 'fulfilled') setBibData(bib.value);
  }, []);

  const refreshFilesAndMeta = useCallback(
    async (projectId: string) => {
      const [, latest] = await Promise.allSettled([
        refreshProjectFiles(projectId),
        api.getLatestCompile(projectId),
      ]);
      if (latest.status === 'fulfilled') {
        setCompileResult(latest.value);
        if (latest.value?.pdfReady) {
          setPdfVersion((v) => v + 1);
        }
      }
    },
    [refreshProjectFiles],
  );

  const refreshComments = useCallback(async () => {
    if (!activeProjectId || !collaborationEnabled) {
      setComments([]);
      return;
    }
    try {
      const list = await api.listComments(activeProjectId, activeFile ?? undefined);
      setComments(list);
    } catch {
      setComments([]);
    }
  }, [activeProjectId, activeFile, collaborationEnabled]);

  // Load project bundle when activeProjectId changes
  useEffect(() => {
    aiFixSeqRef.current += 1;
    pendingInsertRef.current = null;
    setPendingAiFix(null);
    setAiLoading(false);
    setShowLabToolkit(false);
    if (!activeProjectId) {
      setFiles([]);
      setActiveFile(null);
      setOutline([]);
      setCompileResult(null);
      setMembers([]);
      return;
    }
    setSynctexHighlight(null);
    setPresenceUsers([]);
    void refreshFilesAndMeta(activeProjectId);
  }, [activeProjectId, refreshFilesAndMeta]);

  // Refresh comments when active file changes
  useEffect(() => {
    void refreshComments();
  }, [refreshComments]);

  // Close Account Menu on outside click
  useEffect(() => {
    if (!accountMenuOpen) return;
    const onMouseDown = (e: MouseEvent) => {
      if (accountMenuRef.current && !accountMenuRef.current.contains(e.target as Node)) {
        setAccountMenuOpen(false);
      }
    };
    window.addEventListener('mousedown', onMouseDown);
    return () => window.removeEventListener('mousedown', onMouseDown);
  }, [accountMenuOpen]);

  // Clean Escape key handlers for App-owned modals & dropdown menus (never while submitting)
  useEffect(() => {
    if (!showNewProjectModal && !showImportZipModal && !projectMenuOpen && !accountMenuOpen) {
      return;
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing) return;
      if (showNewProjectModal) {
        if (!creatingProj) setShowNewProjectModal(false);
        return;
      }
      if (showImportZipModal) {
        if (!importingZip) setShowImportZipModal(false);
        return;
      }
      if (accountMenuOpen) {
        setAccountMenuOpen(false);
        return;
      }
      if (projectMenuOpen) {
        setProjectMenuOpen(false);
        setProjectSearch('');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    showNewProjectModal,
    creatingProj,
    showImportZipModal,
    importingZip,
    projectMenuOpen,
    accountMenuOpen,
  ]);

  // Drag splitters
  useEffect(() => {
    if (!draggingSplit) return;
    const onMove = (e: MouseEvent) => {
      if (draggingSplit === 'sidebar') {
        setSidebarWidth(Math.max(190, Math.min(380, e.clientX)));
      } else if (draggingSplit === 'center' && bodyRef.current) {
        const rect = bodyRef.current.getBoundingClientRect();
        const leftOffset = sidebarOpen ? sidebarWidth + 5 : 0;
        const avail = rect.width - leftOffset;
        if (avail > 400) {
          const ratio = (e.clientX - rect.left - leftOffset) / avail;
          setEditorRatio(Math.max(0.28, Math.min(0.74, ratio)));
        }
      }
    };
    const onUp = () => setDraggingSplit(null);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [draggingSplit, sidebarOpen, sidebarWidth]);

  // Compile PDF
  const handleCompile = useCallback(async () => {
    if (!activeProjectId || compiling || readOnly) return;
    setCompiling(true);
    try {
      const res = await api.compile(activeProjectId, {
        engine: activeProject?.engine,
        mainFile: activeProject?.mainFile,
      });
      setCompileResult(res);
      if (res.pdfReady) {
        setPdfVersion((v) => v + 1);
      }
      // Refresh outline & bib keys after compile
      void Promise.allSettled([
        api.getOutline(activeProjectId).then(setOutline),
        api.getBibKeys(activeProjectId).then(setBibData),
      ]);
      if (res.ok) {
        notify(
          'success',
          trRef.current(`Compiled in ${res.durationMs} ms`, `编译成功（${res.durationMs} ms）`),
        );
      } else if (!res.compilerAvailable) {
        notify(
          'info',
          trRef.current('No local/remote TeX compiler detected', '未检测到本地/远端 TeX 编译器'),
        );
      } else {
        notify(
          'error',
          trRef.current(
            `Compile found ${res.errorCount} error(s) — click "AI Fix" to diagnose`,
            `编译发现 ${res.errorCount} 个错误，可点击「AI 修错」诊断修复`,
          ),
        );
      }
    } catch (err: unknown) {
      notify(
        'error',
        err instanceof Error
          ? err.message
          : trRef.current('Compile request failed', '编译请求失败'),
      );
    } finally {
      setCompiling(false);
    }
  }, [activeProjectId, activeProject?.engine, activeProject?.mainFile, compiling, readOnly, notify]);

  // Global Ctrl+S / Ctrl+Enter shortcut to trigger PDF compile cleanly in LaTeX mode
  useEffect(() => {
    const anyModalOpen =
      settingsSection !== null ||
      showNewProjectModal ||
      showImportZipModal ||
      showFormatHub ||
      showGitHistory ||
      showShareModal ||
      showLabToolkit ||
      Boolean(pendingAiFix);
    if (!activeProjectId || anyModalOpen || readOnly || workspaceMode !== 'latex') return;

    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 's' || e.key === 'Enter')) {
        e.preventDefault();
        void handleCompile();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    activeProjectId,
    readOnly,
    workspaceMode,
    handleCompile,
    settingsSection,
    showNewProjectModal,
    showImportZipModal,
    showFormatHub,
    showGitHistory,
    showShareModal,
    showLabToolkit,
    pendingAiFix,
  ]);

  // Engine switch
  const handleChangeEngine = async (engine: CompileEngine) => {
    if (!activeProjectId || readOnly) return;
    try {
      const updated = await api.updateProject(activeProjectId, { engine });
      setProjects((prev) => prev.map((p) => (p.id === updated.id ? { ...p, ...updated } : p)));
      notify(
        'info',
        trRef.current(
          `Compile engine switched to ${ENGINE_LABELS[engine]}`,
          `编译引擎已切换为 ${ENGINE_LABELS[engine]}`,
        ),
      );
    } catch (err: unknown) {
      notify(
        'error',
        err instanceof Error
          ? err.message
          : trRef.current('Failed to switch engine', '切换引擎失败'),
      );
    }
  };

  const handleSetMainFile = async (filePath: string) => {
    if (!activeProjectId || readOnly) return;
    try {
      const updated = await api.updateProject(activeProjectId, { mainFile: filePath });
      setProjects((prev) => prev.map((p) => (p.id === updated.id ? { ...p, ...updated } : p)));
      notify(
        'success',
        trRef.current(
          `Set ${filePath} as main compile file`,
          `已将 ${filePath} 设为主编译文件`,
        ),
      );
    } catch (err: unknown) {
      notify(
        'error',
        err instanceof Error
          ? err.message
          : trRef.current('Failed to set main file', '设置主文件失败'),
      );
    }
  };

  // SyncTeX Forward & Inverse
  const handleForwardSync = useCallback(
    async (file: string, line: number) => {
      if (!activeProjectId) return;
      try {
        const res = await api.synctexForward(activeProjectId, file, line);
        if (res.found && res.boxes.length > 0) {
          setSynctexHighlight({ ...res });
        } else {
          notify(
            'info',
            trRef.current(
              'No matching PDF position for this line — recompile PDF first',
              '未找到该行对应的 PDF 位置，请先重新编译 PDF',
            ),
          );
        }
      } catch (err: unknown) {
        notify(
          'error',
          err instanceof Error
            ? err.message
            : trRef.current('Forward SyncTeX failed', '正向定位失败'),
        );
      }
    },
    [activeProjectId, notify],
  );

  const handleInverseSync = useCallback(
    async (page: number, x: number, y: number) => {
      if (!activeProjectId) return;
      try {
        const res = await api.synctexInverse(activeProjectId, page, x, y);
        if (res.found && res.file) {
          setWorkspaceMode('latex');
          setActiveFile(res.file);
          setJumpRequest({ file: res.file, line: res.line, nonce: Date.now() });
        } else {
          notify(
            'info',
            trRef.current(
              'No SyncTeX source mapping at this position',
              '该位置无对应 SyncTeX 源码映射',
            ),
          );
        }
      } catch (err: unknown) {
        notify(
          'error',
          err instanceof Error
            ? err.message
            : trRef.current('Inverse SyncTeX failed', '反向定位失败'),
        );
      }
    },
    [activeProjectId, notify],
  );

  const handleJumpToLocation = useCallback((file: string, line: number) => {
    setWorkspaceMode('latex');
    setActiveFile(file);
    setJumpRequest({ file, line, nonce: Date.now() });
  }, []);

  const handleSelectDiagnostic = useCallback(
    (diag: CompileDiagnostic) => {
      const target = diag.file || activeProject?.mainFile || activeFile;
      if (!target) return;
      handleJumpToLocation(target, diag.line || 1);
    },
    [activeProject?.mainFile, activeFile, handleJumpToLocation],
  );

  // Lab Toolkit snippet insertion (supports cursor insertion in LaTeX mode, deferred insert across modes, and REST fallback)
  const insertSnippetViaApi = useCallback(
    async (pending: PendingLabInsert) => {
      try {
        const existing = await api.readFile(pending.projectId, pending.filePath);
        if (activeProjectIdRef.current !== pending.projectId) return;
        const currentText = existing.content ?? '';
        const endDocMatches = [
          ...currentText.matchAll(
            /(?:^|\r?\n)[ \t]*\\end\{document\}(?=[ \t]*(?:%[^\r\n]*)?(?:\r?\n|$))/g,
          ),
        ];
        const lastEndDoc =
          endDocMatches.length > 0 ? endDocMatches[endDocMatches.length - 1] : null;
        let nextContent: string;
        if (lastEndDoc && typeof lastEndDoc.index === 'number') {
          const before = currentText.slice(0, lastEndDoc.index).trimEnd();
          const after = currentText.slice(lastEndDoc.index).replace(/^\r?\n/, '');
          nextContent = before
            ? `${before}\n\n${pending.latex}\n\n${after}`
            : `${pending.latex}\n\n${after}`;
        } else {
          const trimmedEnd = currentText.trimEnd();
          nextContent = trimmedEnd
            ? `${trimmedEnd}\n\n${pending.latex}\n`
            : `${pending.latex}\n`;
        }
        await api.writeFile(pending.projectId, {
          path: pending.filePath,
          content: nextContent,
        });
        if (activeProjectIdRef.current !== pending.projectId) return;
        void refreshProjectFiles(pending.projectId);
        notify(
          'success',
          trRef.current(
            `Inserted ${pending.label} into ${pending.filePath}`,
            `已将「${pending.label}」插入 ${pending.filePath}`,
          ),
        );
      } catch (err: unknown) {
        if (activeProjectIdRef.current !== pending.projectId) return;
        notify(
          'error',
          err instanceof Error
            ? err.message
            : trRef.current('Failed to insert LaTeX snippet', '插入 LaTeX 代码片段失败'),
        );
      }
    },
    [notify, refreshProjectFiles],
  );

  const handleInsertLabSnippet = useCallback(
    (latex: string, label: string) => {
      if (!activeProjectId || !activeProject) return;
      if (readOnly) {
        notify(
          'info',
          trRef.current(
            'Read-only mode cannot insert snippets',
            '当前为只读权限，无法插入代码片段',
          ),
        );
        return;
      }

      const targetFile = formatTargetFile;
      setShowLabToolkit(false);

      if (workspaceMode === 'latex' && activeFile === targetFile) {
        if (editorHandleRef.current?.isSynced()) {
          const inserted = editorHandleRef.current.insertAtCursor(latex);
          if (inserted) {
            notify(
              'success',
              trRef.current(
                `Inserted ${label} into ${targetFile}`,
                `已将「${label}」插入 ${targetFile}`,
              ),
            );
            return;
          }
        }
        void insertSnippetViaApi({
          projectId: activeProject.id,
          filePath: targetFile,
          latex,
          label,
        });
        return;
      }

      // Triggered from Markdown/Word mode or non-.tex file: switch to LaTeX editor and flush once mounted & synced
      pendingInsertRef.current = {
        projectId: activeProject.id,
        filePath: targetFile,
        latex,
        label,
      };
      setWorkspaceMode('latex');
      if (activeFile !== targetFile) {
        setActiveFile(targetFile);
      }
    },
    [
      activeProjectId,
      activeProject,
      readOnly,
      formatTargetFile,
      workspaceMode,
      activeFile,
      insertSnippetViaApi,
      notify,
    ],
  );

  useEffect(() => {
    const pending = pendingInsertRef.current;
    if (!pending) return;
    if (pending.projectId !== activeProjectId) {
      pendingInsertRef.current = null;
      return;
    }
    if (workspaceMode !== 'latex' || activeFile !== pending.filePath) {
      return;
    }

    let cancelled = false;
    let attempts = 0;
    const maxAttempts = 20;

    const tryFlush = () => {
      if (cancelled) return;
      const current = pendingInsertRef.current;
      if (!current || current !== pending) return;
      if (activeProjectIdRef.current !== current.projectId) {
        pendingInsertRef.current = null;
        return;
      }

      if (editorHandleRef.current?.isSynced()) {
        const inserted = editorHandleRef.current.insertAtCursor(current.latex);
        if (inserted) {
          pendingInsertRef.current = null;
          notify(
            'success',
            trRef.current(
              `Inserted ${current.label} into ${current.filePath}`,
              `已将「${current.label}」插入 ${current.filePath}`,
            ),
          );
          return;
        }
      }

      attempts += 1;
      if (attempts >= maxAttempts) {
        pendingInsertRef.current = null;
        void insertSnippetViaApi(current);
        return;
      }
      timerId = window.setTimeout(tryFlush, 80);
    };

    let timerId = window.setTimeout(tryFlush, 80);
    return () => {
      cancelled = true;
      window.clearTimeout(timerId);
    };
  }, [workspaceMode, activeProjectId, activeFile, insertSnippetViaApi, notify]);

  // AI Fixer (Diagnose, Format Table, Format Math) — always carries compile diagnostics & log context
  const runAiFixFlow = useCallback(
    async (
      mode: AiFixMode,
      sourceOverride?: string,
      selectionRange?: { startLine: number; endLine: number },
    ) => {
      if (aiLoading) return;
      if (readOnly) {
        notify(
          'info',
          trRef.current(
            'Read-only / commenter role cannot modify source code',
            '当前为只读/仅评论权限，无法修改源码',
          ),
        );
        return;
      }
      const targetFile = activeFile ?? activeProject?.mainFile ?? null;
      if (!activeProjectId || !targetFile) {
        notify('info', trRef.current('Please open a LaTeX file first', '请先打开一个 LaTeX 文件'));
        return;
      }
      const reqProjectId = activeProjectId;
      const seq = ++aiFixSeqRef.current;

      let sourceCode = sourceOverride ?? editorHandleRef.current?.getValue() ?? '';
      if (!sourceCode.trim()) {
        try {
          const fetched = await api.readFile(reqProjectId, targetFile);
          if (activeProjectIdRef.current !== reqProjectId || seq !== aiFixSeqRef.current) {
            return;
          }
          sourceCode = fetched.content ?? '';
        } catch (err: unknown) {
          if (activeProjectIdRef.current !== reqProjectId || seq !== aiFixSeqRef.current) {
            return;
          }
          notify(
            'error',
            err instanceof Error
              ? err.message
              : trRef.current('Failed to read current source file', '读取当前源码失败'),
          );
          return;
        }
      }
      if (!sourceCode.trim()) {
        notify('info', trRef.current('Current file is empty', '当前文件内容为空'));
        return;
      }

      setAiLoading(true);
      if (mode === 'format-table' || mode === 'format-math') {
        notify(
          'info',
          selectionRange
            ? trRef.current('Fixing selected region…', '正在修复选中区域…')
            : trRef.current(
                'Scanning document with compile diagnostics…',
                '正在自动扫描全篇并结合编译报错修复…',
              ),
        );
      } else if (mode === 'diagnose-and-fix') {
        notify(
          'info',
          trRef.current(
            'Diagnosing compile errors and generating patch…',
            '正在结合编译报错诊断并生成修复补丁…',
          ),
        );
      }

      try {
        const res = await api.runAiFix(reqProjectId, {
          mode,
          filePath: targetFile,
          sourceCode,
          diagnostics: compileResult?.diagnostics,
          rawLogExcerpt: compileResult?.rawLog
            ? compileResult.rawLog.slice(mode === 'diagnose-and-fix' ? -6000 : -4000)
            : undefined,
          selectionRange,
          useReasoner,
        });
        if (activeProjectIdRef.current !== reqProjectId || seq !== aiFixSeqRef.current) {
          return;
        }
        setPendingAiFix({ projectId: reqProjectId, filePath: targetFile, response: res });
      } catch (err: unknown) {
        if (activeProjectIdRef.current !== reqProjectId || seq !== aiFixSeqRef.current) {
          return;
        }
        const msg =
          err instanceof Error
            ? err.message
            : trRef.current('AI engine request failed', 'AI 引擎调用失败');
        notify('error', msg);
        if (
          msg.includes('API Key') ||
          msg.includes('配置') ||
          msg.toLowerCase().includes('api key') ||
          msg.toLowerCase().includes('not configured')
        ) {
          setSettingsSection('my-ai');
        }
      } finally {
        if (seq === aiFixSeqRef.current) {
          setAiLoading(false);
        }
      }
    },
    [
      aiLoading,
      activeProjectId,
      activeFile,
      activeProject?.mainFile,
      readOnly,
      compileResult,
      useReasoner,
      notify,
    ],
  );

  const handleAiFormat = useCallback(
    async (
      mode: 'format-table' | 'format-math',
      sourceCode: string,
      selectionRange?: { startLine: number; endLine: number },
    ) => {
      await runAiFixFlow(mode, sourceCode, selectionRange);
    },
    [runAiFixFlow],
  );

  const applyPendingAiFix = async (recompile: boolean) => {
    if (!pendingAiFix || !activeProjectId || readOnly) return;
    const { projectId, filePath, response } = pendingAiFix;
    if (projectId !== activeProjectId || activeProjectIdRef.current !== projectId) {
      setPendingAiFix(null);
      return;
    }
    try {
      const appliedLive =
        workspaceMode === 'latex' &&
        filePath === activeFile &&
        editorHandleRef.current?.isSynced()
          ? editorHandleRef.current.applyPatchedText(response.patchedCode)
          : false;
      if (!appliedLive) {
        await api.writeFile(projectId, { path: filePath, content: response.patchedCode });
      }
      if (activeProjectIdRef.current !== projectId) return;
      setPendingAiFix(null);
      notify('success', trRef.current('Applied AI fix patch', '已应用 AI 修复补丁'));
      if (recompile) {
        // Allow brief Yjs flush before invoking compile
        window.setTimeout(() => {
          if (activeProjectIdRef.current === projectId) {
            void handleCompile();
          }
        }, 350);
      }
    } catch (err: unknown) {
      notify(
        'error',
        err instanceof Error
          ? err.message
          : trRef.current('Failed to apply AI fix patch', '应用 AI 修复补丁失败'),
      );
    }
  };

  // New project / Import zip
  const openNewProjectModal = useCallback(() => {
    const defaultTpl: AcademicTemplateId = locale === 'zh' ? 'lab-report-zh' : 'lab-report-en';
    setNewProjTemplate(defaultTpl);
    setNewProjEngine(defaultTpl === 'lab-report-zh' ? 'xelatex' : 'pdflatex');
    setShowNewProjectModal(true);
  }, [locale]);

  const handleNewProjectTemplateChange = (nextTemplate: AcademicTemplateId) => {
    setNewProjTemplate(nextTemplate);
    setNewProjEngine(
      nextTemplate === 'lab-report-zh' || nextTemplate === 'chinese-ctex'
        ? 'xelatex'
        : 'pdflatex',
    );
  };

  const handleCreateProject = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newProjName.trim()) return;
    setCreatingProj(true);
    try {
      const created = await api.createProject({
        name: newProjName.trim(),
        description: newProjDesc.trim(),
        engine: newProjEngine,
        template: newProjTemplate,
      });
      setShowNewProjectModal(false);
      setNewProjName('');
      setNewProjDesc('');
      await loadProjects(created.id);
      notify(
        'success',
        trRef.current(`Created document "${created.name}"`, `已新建项目「${created.name}」`),
      );
    } catch (err: unknown) {
      notify(
        'error',
        err instanceof Error
          ? err.message
          : trRef.current('Failed to create project', '创建项目失败'),
      );
    } finally {
      setCreatingProj(false);
    }
  };

  const handleImportZip = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!zipFile) return;
    setImportingZip(true);
    try {
      const base64 = await fileToBase64(zipFile);
      const name = zipProjName.trim() || zipFile.name.replace(/\.zip$/i, '');
      const created = await api.importProjectZip({
        name,
        fileName: zipFile.name,
        base64,
      });
      setShowImportZipModal(false);
      setZipFile(null);
      setZipProjName('');
      await loadProjects(created.id);
      notify(
        'success',
        trRef.current(
          `Imported Overleaf archive "${created.name}"`,
          `已导入 Overleaf 压缩包「${created.name}」`,
        ),
      );
    } catch (err: unknown) {
      notify(
        'error',
        err instanceof Error
          ? err.message
          : trRef.current('Failed to import .zip archive', '导入 .zip 失败'),
      );
    } finally {
      setImportingZip(false);
    }
  };

  const handleLogout = async () => {
    try {
      await api.logout();
    } finally {
      aiFixSeqRef.current += 1;
      pendingInsertRef.current = null;
      setPendingAiFix(null);
      setAiLoading(false);
      setUser(null);
      setProjects([]);
      setActiveProjectId(null);
      setSettingsSection(null);
      setAccountMenuOpen(false);
      setProjectMenuOpen(false);
      setShowLabToolkit(false);
      setShowShareModal(false);
      setShowGitHistory(false);
      setShowFormatHub(false);
      setWorkspaceMode('latex');
      const meta = await api.getAuthMe().catch(() => null);
      if (meta) setAuthMeta(meta);
    }
  };

  const openSettingsSection = useCallback((section: SettingsSection) => {
    setAccountMenuOpen(false);
    setProjectMenuOpen(false);
    setProjectSearch('');
    setSettingsSection(section);
  }, []);

  // Deduplicated presence list & other collaborators (avoid duplicating self next to account trigger)
  const uniquePresence = useMemo(() => {
    const map = new Map<string, PresenceUser>();
    for (const u of presenceUsers) {
      const key = u.userId || `${u.name}-${u.clientId}`;
      if (!map.has(key)) map.set(key, u);
    }
    return Array.from(map.values());
  }, [presenceUsers]);

  const otherPresence = useMemo(
    () =>
      uniquePresence.filter((u) => {
        if (!user) return true;
        if (u.userId && u.userId === user.id) return false;
        if (!u.userId && u.name === (user.displayName || user.username)) return false;
        return true;
      }),
    [uniquePresence, user],
  );

  const pdfUrl =
    activeProjectId && compileResult?.pdfReady
      ? api.getPdfUrl(activeProjectId, pdfVersion)
      : null;

  const closeProjectMenu = () => {
    setProjectMenuOpen(false);
    setProjectSearch('');
  };

  let view: React.ReactNode;

  if (authLoading) {
    // Loading gate
    view = (
      <div className="auth-page">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--text-muted)' }}>
          <Loader2 size={18} className="spin" />
          <span>{tr('Connecting to NovaTeX Studio…', '正在连接 NovaTeX 工作台…')}</span>
        </div>
      </div>
    );
  } else if (!user) {
    // Auth / Setup gate
    view = (
      <AuthScreen
        authMeta={
          authMeta ?? {
            authenticated: false,
            user: null,
            needsSetup: false,
            allowPublicRegister: false,
          }
        }
        inviteToken={inviteToken}
        onAuthenticated={(loggedInUser, acceptedPid) => {
          setUser(loggedInUser);
          if (inviteToken) {
            setInviteToken(null);
            window.history.replaceState({}, '', window.location.pathname);
          }
          if (acceptedPid) {
            setActiveProjectId(acceptedPid);
          }
          refreshCapabilities();
        }}
      />
    );
  } else if (settingsSection !== null) {
    // Dedicated full-page Settings view (renders its own Back header; keeps toasts alive)
    view = (
      <div className="workbench">
        <SettingsPage
          initialSection={settingsSection}
          activeProjectId={activeProjectId}
          user={user}
          capabilities={capabilities}
          onBack={() => setSettingsSection(null)}
          onRefreshCapabilities={() => void refreshCapabilities()}
          onNotify={notify}
        />
        <div className="toast-container">
          {toasts.map((t) => (
            <div key={t.id} className={`toast ${t.kind}`}>
              <span>{t.message}</span>
            </div>
          ))}
        </div>
      </div>
    );
  } else {
    // Main Workspace View
    view = (
      <div className="workbench">
        {/* Unified Linear × Typst 48px Topbar */}
        <header className="topbar">
          <div className="topbar-left">
            <button
              type="button"
              className="topbar-btn topbar-btn-icon"
              aria-label={
                sidebarOpen
                  ? tr('Collapse Sidebar', '收起侧边栏')
                  : tr('Expand Sidebar', '展开侧边栏')
              }
              title={
                sidebarOpen
                  ? tr('Collapse Sidebar', '收起侧边栏')
                  : tr('Expand Sidebar', '展开侧边栏')
              }
              onClick={() => setSidebarOpen((v) => !v)}
            >
              {sidebarOpen ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
            </button>

            <div className="brand">
              <BrandMark size={26} />
              <span>NovaTeX</span>
            </div>

            <span className="topbar-divider" />

            {/* Project Selector Dropdown */}
            <div className="dropdown-wrap">
              <button
                type="button"
                className="project-trigger"
                aria-expanded={projectMenuOpen}
                aria-haspopup="listbox"
                onClick={() => {
                  setAccountMenuOpen(false);
                  setProjectMenuOpen((v) => {
                    if (v) setProjectSearch('');
                    return !v;
                  });
                }}
              >
                <span className="project-trigger-name">
                  {activeProject?.name ?? tr('Select or New Document', '选择或新建文档')}
                </span>
                <ChevronDown
                  size={14}
                  style={{
                    flexShrink: 0,
                    opacity: 0.72,
                    transform: projectMenuOpen ? 'rotate(180deg)' : 'none',
                    transition: 'transform 0.14s ease',
                  }}
                />
              </button>

              {projectMenuOpen && (
                <>
                  <div
                    style={{ position: 'fixed', inset: 0, zIndex: 55 }}
                    onClick={closeProjectMenu}
                  />
                  <div
                    className="dropdown-menu"
                    role="listbox"
                    aria-label={tr('Switch Document Project', '切换项目')}
                  >
                    <div
                      className="dropdown-header"
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                      }}
                    >
                      <span>{tr('Documents & Projects', '文档与项目')}</span>
                      <span style={{ fontWeight: 500, color: 'var(--text-faint)' }}>
                        {projects.length}
                      </span>
                    </div>

                    {projects.length > 5 && (
                      <div style={{ padding: '2px 4px 6px', position: 'relative' }}>
                        <Search
                          size={13}
                          style={{
                            position: 'absolute',
                            left: 12,
                            top: '50%',
                            transform: 'translateY(-60%)',
                            color: 'var(--text-faint)',
                            pointerEvents: 'none',
                          }}
                        />
                        <input
                          className="input"
                          autoFocus
                          placeholder={tr('Search projects…', '搜索项目名称…')}
                          value={projectSearch}
                          onChange={(e) => setProjectSearch(e.target.value)}
                          style={{ height: 29, padding: '4px 8px 4px 28px', fontSize: 12 }}
                        />
                      </div>
                    )}

                    <div style={{ maxHeight: 252, overflowY: 'auto' }}>
                      {projects.length === 0 ? (
                        <div style={{ padding: '10px 10px', color: 'var(--text-faint)', fontSize: 12 }}>
                          {tr('No projects yet — click below to create one', '暂无项目，点击下方新建文档')}
                        </div>
                      ) : filteredProjects.length === 0 ? (
                        <div style={{ padding: '10px 10px', color: 'var(--text-faint)', fontSize: 12 }}>
                          {tr(
                            `No projects matching "${projectSearch}"`,
                            `没有匹配「${projectSearch}」的项目`,
                          )}
                        </div>
                      ) : (
                        filteredProjects.map((p) => {
                          const isActive = p.id === activeProjectId;
                          return (
                            <button
                              key={p.id}
                              type="button"
                              role="option"
                              aria-selected={isActive}
                              className={`dropdown-item ${isActive ? 'active' : ''}`}
                              onClick={() => {
                                setActiveProjectId(p.id);
                                closeProjectMenu();
                              }}
                            >
                              <span
                                style={{
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  gap: 7,
                                  minWidth: 0,
                                  flex: 1,
                                }}
                              >
                                <span
                                  style={{
                                    width: 14,
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    flexShrink: 0,
                                  }}
                                >
                                  {isActive && <Check size={14} style={{ color: 'var(--accent)' }} />}
                                </span>
                                <span className="tree-row-name">{p.name}</span>
                              </span>
                              <span
                                style={{
                                  fontSize: 11,
                                  fontFamily: 'var(--font-mono)',
                                  color: isActive ? 'var(--accent)' : 'var(--text-faint)',
                                  flexShrink: 0,
                                }}
                              >
                                {ENGINE_LABELS[p.engine] ?? p.engine}
                              </span>
                            </button>
                          );
                        })
                      )}
                    </div>

                    <div className="dropdown-sep" />
                    <button
                      type="button"
                      className="dropdown-item"
                      onClick={() => {
                        closeProjectMenu();
                        openNewProjectModal();
                      }}
                    >
                      <span
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 7,
                          color: 'var(--accent)',
                          fontWeight: 500,
                        }}
                      >
                        <Plus size={14} /> {tr('New Document', '新建文档')}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="dropdown-item"
                      onClick={() => {
                        closeProjectMenu();
                        setShowImportZipModal(true);
                      }}
                    >
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                        <FileArchive size={14} style={{ color: 'var(--text-muted)' }} />{' '}
                        {tr('Import Overleaf .zip', '导入 Overleaf .zip')}
                      </span>
                    </button>
                  </div>
                </>
              )}
            </div>

            {/* Subtle Engine Pill */}
            {activeProject && (
              <select
                className="engine-select"
                value={activeProject.engine}
                disabled={readOnly}
                aria-label={tr('Select LaTeX Compile Engine', '选择 LaTeX 编译引擎')}
                title={tr('Select LaTeX Compile Engine', '选择 LaTeX 编译引擎')}
                onChange={(e) => void handleChangeEngine(e.target.value as CompileEngine)}
              >
                <option value="xelatex">XeLaTeX</option>
                <option value="pdflatex">pdfLaTeX</option>
                <option value="lualatex">LuaLaTeX</option>
              </select>
            )}
          </div>

          {/* Center Segmented 3-Mode Workspace Switcher */}
          {activeProject && (
            <div className="topbar-center">
              <div
                className="mode-switcher"
                role="tablist"
                aria-label={tr('Workspace Editing Mode', '工作区编辑模式')}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={workspaceMode === 'latex'}
                  className={`mode-switcher-btn ${workspaceMode === 'latex' ? 'active' : ''}`}
                  onClick={() => setWorkspaceMode('latex')}
                  title={
                    collaborationEnabled
                      ? tr(
                          'Collaborative LaTeX source editing & bidirectional SyncTeX',
                          'LaTeX 源码协同编辑与 SyncTeX 双向定位',
                        )
                      : tr(
                          'LaTeX source editing & bidirectional SyncTeX',
                          'LaTeX 源码编辑与 SyncTeX 双向定位',
                        )
                  }
                >
                  <Code2 size={14} />
                  <span>{tr('LaTeX', 'LaTeX 源码')}</span>
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={workspaceMode === 'markdown'}
                  className={`mode-switcher-btn ${workspaceMode === 'markdown' ? 'active' : ''}`}
                  onClick={() => setWorkspaceMode('markdown')}
                  title={tr(
                    'Write in Markdown and sync-compile directly to LaTeX & PDF',
                    'Markdown 轻量速写，一键同步至 LaTeX 并编译更新 PDF',
                  )}
                >
                  <FileText size={14} />
                  <span>{tr('Markdown', 'Markdown 速写')}</span>
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={workspaceMode === 'word'}
                  className={`mode-switcher-btn ${workspaceMode === 'word' ? 'active' : ''}`}
                  onClick={() => setWorkspaceMode('word')}
                  title={tr(
                    'Export to Word (.docx) or convert Word revisions back into LaTeX',
                    '导出 Word (.docx) 或将 Word 修订回灌至 LaTeX',
                  )}
                >
                  <FileType2 size={14} />
                  <span>{tr('Word / Convert', 'Word / 互转')}</span>
                </button>
              </div>
            </div>
          )}

          {/* Right Minimal Actions + Optional Online Collaborators + Account Dropdown */}
          <div className="topbar-right">
            <button
              type="button"
              className="topbar-btn"
              disabled={!activeProjectId}
              onClick={() => setShowLabToolkit(true)}
              title={tr(
                'CSV/TSV to booktabs table, figure snippet, code listing & lab macros',
                '实验数据 CSV/TSV 转三线表、图片插入、代码清单与常用实验宏',
              )}
            >
              <FlaskConical size={14} />
              {tr('Lab Toolkit', '实验工具')}
            </button>

            <button
              type="button"
              className="topbar-btn"
              disabled={!activeProjectId}
              onClick={() => setShowGitHistory(true)}
              title={tr('Git version checkpoints & diff rollback', 'Git 版本检查点与差异回滚')}
            >
              <History size={14} />
              {tr('History', '历史')}
            </button>

            {collaborationEnabled && (
              <button
                type="button"
                className="topbar-btn"
                disabled={!activeProjectId}
                onClick={() => setShowShareModal(true)}
                title={tr(
                  'Collaborators, invite links & local agent sync',
                  '协作成员管理、邀请链接与本地 Agent 同步',
                )}
              >
                <Users size={14} />
                {tr('Share', '协作')}
              </button>
            )}

            {/* Other Online Collaborator Avatars (ONLY when collaboration is enabled; never duplicate current user) */}
            {collaborationEnabled && otherPresence.length > 0 && (
              <div
                className="presence-stack"
                title={tr('Other online collaborators', '其他在线协作者')}
              >
                {otherPresence.slice(0, 4).map((u) => (
                  <span
                    key={`${u.clientId}-${u.name}`}
                    className="presence-avatar"
                    style={{ background: u.color }}
                    title={`${u.name}${
                      u.file ? tr(` · viewing ${u.file}`, ` · 正在查看 ${u.file}`) : ''
                    }`}
                  >
                    {u.name.slice(0, 1).toUpperCase()}
                  </span>
                ))}
                {otherPresence.length > 4 && (
                  <span
                    className="presence-avatar"
                    style={{ background: '#475569', fontSize: 10 }}
                    title={tr(
                      `${otherPresence.length} collaborators online`,
                      `另有 ${otherPresence.length} 位协作者在线`,
                    )}
                  >
                    +{otherPresence.length - 4}
                  </span>
                )}
              </div>
            )}

            <span className="topbar-divider" />

            {/* Refined User Avatar Dropdown Menu */}
            <div className="account-menu-wrap" ref={accountMenuRef}>
              <button
                type="button"
                className="account-trigger"
                aria-expanded={accountMenuOpen}
                aria-haspopup="menu"
                onClick={() => {
                  closeProjectMenu();
                  setAccountMenuOpen((v) => !v);
                }}
                title={`${user.displayName || user.username} (@${user.username})`}
              >
                <span
                  className="account-avatar"
                  style={{ background: user.color || '#10b981' }}
                >
                  {(user.displayName || user.username).slice(0, 1).toUpperCase()}
                </span>
                <span
                  style={{
                    maxWidth: 104,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {user.displayName || user.username}
                </span>
                <ChevronDown
                  size={13}
                  style={{
                    opacity: 0.72,
                    flexShrink: 0,
                    transform: accountMenuOpen ? 'rotate(180deg)' : 'none',
                    transition: 'transform 0.14s ease',
                  }}
                />
              </button>

              {accountMenuOpen && (
                <div
                  className="account-dropdown"
                  role="menu"
                  aria-label={tr('Account & Settings Menu', '账号与设置菜单')}
                >
                  <div className="account-dropdown-header">
                    <div className="account-dropdown-name">
                      {user.displayName || user.username}
                    </div>
                    <div className="account-dropdown-meta">
                      <span
                        style={{
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        @{user.username}
                      </span>
                      <span className="pill" style={{ height: 17, fontSize: 10, padding: '0 6px' }}>
                        {user.role === 'admin' ? tr('Admin', '管理员') : tr('Member', '成员')}
                      </span>
                    </div>
                  </div>

                  <div className="account-dropdown-sep" />

                  <button
                    type="button"
                    role="menuitem"
                    className="account-dropdown-item"
                    onClick={() => openSettingsSection('my-ai')}
                  >
                    <span className="account-dropdown-item-left">
                      <Sparkles size={14} style={{ color: 'var(--ai-accent)', flexShrink: 0 }} />
                      <span>{tr('My AI Engine', '我的 AI 引擎配置')}</span>
                    </span>
                  </button>

                  <button
                    type="button"
                    role="menuitem"
                    className="account-dropdown-item"
                    onClick={() => openSettingsSection('local-sync')}
                  >
                    <span className="account-dropdown-item-left">
                      <Terminal size={14} style={{ color: 'var(--accent)', flexShrink: 0 }} />
                      <span>{tr('Local AI Sync (CLI)', '本地 AI 同步 (CLI)')}</span>
                    </span>
                  </button>

                  <button
                    type="button"
                    role="menuitem"
                    className="account-dropdown-item"
                    onClick={() => openSettingsSection('account')}
                  >
                    <span className="account-dropdown-item-left">
                      <ShieldCheck size={14} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
                      <span>{tr('Account & Security', '账号与安全')}</span>
                    </span>
                  </button>

                  {user.role === 'admin' && (
                    <button
                      type="button"
                      role="menuitem"
                      className="account-dropdown-item"
                      onClick={() => openSettingsSection('admin-global')}
                    >
                      <span className="account-dropdown-item-left">
                        <Globe size={14} style={{ color: 'var(--accent)', flexShrink: 0 }} />
                        <span>{tr('Site Default AI', '全局默认 AI（站长）')}</span>
                      </span>
                    </button>
                  )}

                  <button
                    type="button"
                    role="menuitem"
                    className="account-dropdown-item"
                    onClick={() => openSettingsSection('environment')}
                  >
                    <span className="account-dropdown-item-left">
                      <Cpu size={14} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
                      <span>{tr('Environment', '运行环境诊断')}</span>
                    </span>
                  </button>

                  <div className="account-dropdown-sep" />

                  <button
                    type="button"
                    role="menuitem"
                    className="account-dropdown-item"
                    onClick={() => {
                      setLocale(locale === 'zh' ? 'en' : 'zh');
                      setAccountMenuOpen(false);
                    }}
                  >
                    <span className="account-dropdown-item-left">
                      <Languages size={14} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
                      <span>{tr('切换至中文 (ZH)', 'Switch to English (EN)')}</span>
                    </span>
                  </button>

                  <button
                    type="button"
                    role="menuitem"
                    className="account-dropdown-item"
                    onClick={() => {
                      setTheme((t) => (t === 'dark' ? 'light' : 'dark'));
                      setAccountMenuOpen(false);
                    }}
                  >
                    <span className="account-dropdown-item-left">
                      {theme === 'dark' ? (
                        <Sun size={14} style={{ color: 'var(--warning)', flexShrink: 0 }} />
                      ) : (
                        <Moon size={14} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
                      )}
                      <span>
                        {theme === 'dark'
                          ? tr('Light Mode', '切换浅色主题')
                          : tr('Dark Mode', '切换深色主题')}
                      </span>
                    </span>
                  </button>

                  <button
                    type="button"
                    role="menuitem"
                    className="account-dropdown-item"
                    disabled={!activeProjectId}
                    onClick={() => {
                      setAccountMenuOpen(false);
                      setShowFormatHub(true);
                    }}
                  >
                    <span className="account-dropdown-item-left">
                      <ArrowLeftRight
                        size={14}
                        style={{ color: 'var(--text-muted)', flexShrink: 0 }}
                      />
                      <span>{tr('Format Hub Modal', '高级格式互转工具')}</span>
                    </span>
                  </button>

                  <div className="account-dropdown-sep" />

                  <button
                    type="button"
                    role="menuitem"
                    className="account-dropdown-item danger"
                    onClick={() => {
                      setAccountMenuOpen(false);
                      void handleLogout();
                    }}
                  >
                    <span className="account-dropdown-item-left">
                      <LogOut size={14} style={{ flexShrink: 0 }} />
                      <span>{tr('Sign Out', '退出登录')}</span>
                    </span>
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>

        {/* Main Three-Pane Body */}
        {!activeProject ? (
          <div
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'var(--bg-subtle)',
            }}
          >
            <div className="empty-state-card">
              <FolderPlus size={38} strokeWidth={1.5} style={{ color: 'var(--accent)' }} />
              <h3>{tr('Welcome to NovaTeX Studio', '欢迎来到 NovaTeX 工作台')}</h3>
              <p>
                {locale === 'zh' ? (
                  <>
                    创建一个新的实验报告、技术文档或学术论文项目，或直接导入现有的 Overleaf{' '}
                    <code>.zip</code> 项目包开始无干扰写作。
                  </>
                ) : (
                  <>
                    Create a new lab report, technical document, or academic paper, or import an
                    existing Overleaf <code>.zip</code> archive to start writing.
                  </>
                )}
              </p>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={openNewProjectModal}
                >
                  <Plus size={14} />
                  {tr('New Document', '新建文档')}
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => setShowImportZipModal(true)}
                >
                  <FileArchive size={14} />
                  {tr('Import Overleaf .zip', '导入 Overleaf .zip')}
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div ref={bodyRef} className="workspace-body">
            {sidebarOpen && (
              <>
                <Sidebar
                  width={sidebarWidth}
                  projectId={activeProject.id}
                  mainFile={activeProject.mainFile}
                  readOnly={readOnly}
                  canComment={canComment}
                  collaborationEnabled={collaborationEnabled}
                  activeTab={sidebarTab}
                  onChangeTab={setSidebarTab}
                  files={files}
                  activeFile={activeFile}
                  outline={outline}
                  comments={comments}
                  draftCommentAnchor={draftCommentAnchor}
                  onClearDraftAnchor={() => setDraftCommentAnchor(null)}
                  onSelectFile={(p) => {
                    setActiveFile(p);
                    if (!p.toLowerCase().endsWith('.tex') && workspaceMode !== 'latex') {
                      setWorkspaceMode('latex');
                    }
                  }}
                  onSetMainFile={(p) => void handleSetMainFile(p)}
                  onJumpToLocation={handleJumpToLocation}
                  onRefreshFiles={() => refreshFilesAndMeta(activeProject.id)}
                  onRefreshComments={refreshComments}
                  onNotify={notify}
                />
                <div
                  className={`splitter ${draggingSplit === 'sidebar' ? 'dragging' : ''}`}
                  onMouseDown={() => setDraggingSplit('sidebar')}
                />
              </>
            )}

            {/* Center Multi-Format Pane (LaTeX / Markdown / Word) */}
            <div
              className="center-pane"
              style={{
                width: `calc(${Math.round(editorRatio * 1000) / 10}%)`,
                minWidth: 280,
                display: 'flex',
                flexDirection: 'column',
                minHeight: 0,
              }}
            >
              {workspaceMode === 'latex' ? (
                <EditorPane
                  projectId={activeProject.id}
                  filePath={activeFile}
                  fileEntry={activeFileEntry}
                  user={user}
                  theme={theme}
                  readOnly={readOnly}
                  canComment={canComment}
                  collaborationEnabled={collaborationEnabled}
                  diagnostics={compileResult?.diagnostics ?? []}
                  bibData={bibData}
                  jumpRequest={jumpRequest}
                  editorHandleRef={editorHandleRef}
                  onCompileShortcut={() => void handleCompile()}
                  onCursorChange={() => {}}
                  onPresenceChange={setPresenceUsers}
                  onForwardSync={(file, line) => void handleForwardSync(file, line)}
                  onAiFormat={(mode, code, sel) => void handleAiFormat(mode, code, sel)}
                  onOpenCommentAtLine={(line, quote) => {
                    if (!collaborationEnabled) return;
                    setDraftCommentAnchor({ line, quote });
                    setSidebarOpen(true);
                    setSidebarTab('comments');
                  }}
                />
              ) : workspaceMode === 'markdown' ? (
                <MarkdownWorkspacePane
                  projectId={activeProject.id}
                  targetFile={formatTargetFile}
                  mainFile={activeProject.mainFile}
                  engine={activeProject.engine}
                  theme={theme}
                  readOnly={!canEdit}
                  onCompiled={(result) => {
                    if (activeProjectIdRef.current !== activeProject.id) return;
                    setCompileResult(result);
                    if (result.pdfReady) setPdfVersion((v) => v + 1);
                    void refreshProjectFiles(activeProject.id);
                  }}
                  onNotify={notify}
                />
              ) : (
                <WordCollabPane
                  projectId={activeProject.id}
                  files={files}
                  mainFile={activeProject.mainFile}
                  activeFile={activeFile}
                  engine={activeProject.engine}
                  readOnly={!canEdit}
                  onAppliedAndCompiled={(targetFile, result) => {
                    if (activeProjectIdRef.current !== activeProject.id) return;
                    if (targetFile && targetFile !== activeFile) {
                      setActiveFile(targetFile);
                    }
                    if (result) {
                      setCompileResult(result);
                      if (result.pdfReady) setPdfVersion((v) => v + 1);
                    }
                    void refreshProjectFiles(activeProject.id);
                  }}
                  onNotify={notify}
                />
              )}
            </div>

            <div
              className={`splitter ${draggingSplit === 'center' ? 'dragging' : ''}`}
              onMouseDown={() => setDraggingSplit('center')}
            />

            {/* Right Pane: Always-Visible Live PDF Preview + Smart Diagnostics */}
            <div className="right-pane">
              <PdfPane
                pdfUrl={pdfUrl}
                pdfVersion={pdfVersion}
                compiling={compiling}
                readOnly={readOnly}
                compileResult={compileResult}
                synctexHighlight={synctexHighlight}
                onInverseSync={(page, x, y) => void handleInverseSync(page, x, y)}
                onTriggerCompile={() => void handleCompile()}
              />
              <DiagnosticsBar
                compileResult={compileResult}
                compiling={compiling}
                aiLoading={aiLoading}
                readOnly={readOnly}
                useReasoner={useReasoner}
                onToggleReasoner={setUseReasoner}
                onSelectDiagnostic={handleSelectDiagnostic}
                onRunAiDiagnose={() => void runAiFixFlow('diagnose-and-fix')}
                onQuickAiFormat={(mode) => {
                  const code = editorHandleRef.current?.getValue() ?? '';
                  const targetPath = activeFile ?? activeProject.mainFile;
                  if (!code && activeProject && targetPath) {
                    const reqProjectId = activeProject.id;
                    void api
                      .readFile(reqProjectId, targetPath)
                      .then((f) => {
                        if (activeProjectIdRef.current !== reqProjectId) return;
                        if (f.content) void handleAiFormat(mode, f.content, undefined);
                        else {
                          notify(
                            'info',
                            trRef.current('Current file is empty', '当前文件内容为空'),
                          );
                        }
                      })
                      .catch((err: unknown) => {
                        if (activeProjectIdRef.current !== reqProjectId) return;
                        notify(
                          'error',
                          err instanceof Error
                            ? err.message
                            : trRef.current('Failed to read source code', '读取源码失败'),
                        );
                      });
                    return;
                  }
                  if (code) void handleAiFormat(mode, code, undefined);
                }}
              />
            </div>
          </div>
        )}

        {/* New Document / Project Modal (No accidental backdrop dismissal) */}
        {showNewProjectModal && (
          <div className="modal-backdrop">
            <div
              className="modal-card modal-sm"
              role="dialog"
              aria-modal="true"
              aria-labelledby="modal-new-project-title"
            >
              <div className="modal-header">
                <h3 id="modal-new-project-title" className="modal-title">
                  <Plus size={16} style={{ color: 'var(--accent)' }} />
                  {tr('New Document / Project', '新建文档 / 项目')}
                </h3>
                <button
                  type="button"
                  className="btn btn-ghost btn-icon"
                  aria-label={tr('Close', '关闭')}
                  disabled={creatingProj}
                  onClick={() => setShowNewProjectModal(false)}
                >
                  <X size={16} />
                </button>
              </div>
              <form onSubmit={(e) => void handleCreateProject(e)}>
                <div className="modal-body">
                  <div className="field">
                    <label className="field-label" htmlFor="new-proj-name">
                      {tr('Document Name', '项目名称')}
                    </label>
                    <input
                      id="new-proj-name"
                      className="input"
                      autoFocus
                      required
                      placeholder={tr(
                        'e.g., Physics Lab 3 — Optics Report',
                        '例如：大学物理实验三 — 光学实验报告',
                      )}
                      value={newProjName}
                      onChange={(e) => setNewProjName(e.target.value)}
                    />
                  </div>
                  <div className="field">
                    <label className="field-label" htmlFor="new-proj-desc">
                      {tr('Description (Optional)', '简介（可选）')}
                    </label>
                    <input
                      id="new-proj-desc"
                      className="input"
                      placeholder={tr(
                        'Course code, conference, or notes',
                        '课程编号 / 投稿会议 / 备注',
                      )}
                      value={newProjDesc}
                      onChange={(e) => setNewProjDesc(e.target.value)}
                    />
                  </div>
                  <div className="form-grid-2">
                    <div className="field" style={{ marginBottom: 0 }}>
                      <label className="field-label" htmlFor="new-proj-template">
                        {tr('Starter Template', '初始模板')}
                      </label>
                      <select
                        id="new-proj-template"
                        className="select"
                        value={newProjTemplate}
                        onChange={(e) =>
                          handleNewProjectTemplateChange(e.target.value as AcademicTemplateId)
                        }
                      >
                        <optgroup label={tr('Lab & Technical Reports', '实验报告与技术文档')}>
                          <option value="lab-report-en">
                            {tr(
                              'Engineering Lab Report (English, pdfLaTeX)',
                              '英文工科实验报告 (pdfLaTeX)',
                            )}
                          </option>
                          <option value="lab-report-zh">
                            {tr(
                              'Chinese Lab Report (ctexart, XeLaTeX)',
                              '中文课程实验报告 (ctexart / XeLaTeX)',
                            )}
                          </option>
                          <option value="tech-report">
                            {tr(
                              'Technical / Course Project Report (pdfLaTeX)',
                              '技术报告 / 课程大作业 (pdfLaTeX)',
                            )}
                          </option>
                          <option value="beamer-slides">
                            {tr(
                              'Presentation Slides (Beamer, pdfLaTeX)',
                              '学术答辩幻灯片 (Beamer / pdfLaTeX)',
                            )}
                          </option>
                        </optgroup>
                        <optgroup label={tr('Academic Papers', '学术论文')}>
                          <option value="clean-article">
                            {tr(
                              'Clean Academic Article (English, pdfLaTeX)',
                              '极简英文论文 (Clean Article)',
                            )}
                          </option>
                          <option value="ieee-conf">
                            {tr(
                              'IEEE Two-Column Conference (pdfLaTeX)',
                              'IEEE 双栏会议论文',
                            )}
                          </option>
                          <option value="chinese-ctex">
                            {tr(
                              'Chinese Academic Paper (ctexart, XeLaTeX)',
                              '中文学术论文 (ctexart / XeLaTeX)',
                            )}
                          </option>
                        </optgroup>
                      </select>
                    </div>
                    <div className="field" style={{ marginBottom: 0 }}>
                      <label className="field-label" htmlFor="new-proj-engine">
                        {tr('Default Engine', '默认引擎')}
                      </label>
                      <select
                        id="new-proj-engine"
                        className="select"
                        value={newProjEngine}
                        onChange={(e) => setNewProjEngine(e.target.value as CompileEngine)}
                      >
                        <option value="xelatex">
                          {tr('XeLaTeX (Recommended for CJK)', 'XeLaTeX（推荐中文）')}
                        </option>
                        <option value="pdflatex">pdfLaTeX</option>
                        <option value="lualatex">LuaLaTeX</option>
                      </select>
                    </div>
                  </div>
                </div>
                <div className="modal-footer">
                  <button
                    type="button"
                    className="btn"
                    disabled={creatingProj}
                    onClick={() => setShowNewProjectModal(false)}
                  >
                    {tr('Cancel', '取消')}
                  </button>
                  <button
                    type="submit"
                    className="btn btn-primary"
                    disabled={creatingProj || !newProjName.trim()}
                  >
                    {creatingProj ? <Loader2 size={14} className="spin" /> : <Plus size={14} />}
                    {tr('Create Document', '创建项目')}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* Import Overleaf Zip Modal (No accidental backdrop dismissal) */}
        {showImportZipModal && (
          <div className="modal-backdrop">
            <div
              className="modal-card modal-sm"
              role="dialog"
              aria-modal="true"
              aria-labelledby="modal-import-zip-title"
            >
              <div className="modal-header">
                <h3 id="modal-import-zip-title" className="modal-title">
                  <FileArchive size={16} style={{ color: 'var(--accent)' }} />
                  {tr('Import Overleaf Archive (.zip)', '导入 Overleaf 项目压缩包')}
                </h3>
                <button
                  type="button"
                  className="btn btn-ghost btn-icon"
                  aria-label={tr('Close', '关闭')}
                  disabled={importingZip}
                  onClick={() => setShowImportZipModal(false)}
                >
                  <X size={16} />
                </button>
              </div>
              <form onSubmit={(e) => void handleImportZip(e)}>
                <div className="modal-body">
                  <div className="field">
                    <label className="field-label" htmlFor="import-zip-file">
                      {tr('Choose .zip File', '选择 .zip 文件')}
                    </label>
                    <input
                      id="import-zip-file"
                      type="file"
                      accept=".zip"
                      className="input"
                      onChange={(e) => {
                        const f = e.target.files?.[0] ?? null;
                        setZipFile(f);
                        if (f && !zipProjName) {
                          setZipProjName(f.name.replace(/\.zip$/i, ''));
                        }
                      }}
                    />
                    {zipFile && (
                      <div
                        className="field-hint"
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          marginTop: 2,
                        }}
                      >
                        <span
                          style={{
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {tr('Selected: ', '已选择：')}
                          {zipFile.name}
                        </span>
                        <span className="pill">{(zipFile.size / 1024).toFixed(1)} KB</span>
                      </div>
                    )}
                  </div>
                  <div className="field" style={{ marginBottom: 0 }}>
                    <label className="field-label" htmlFor="import-zip-name">
                      {tr('Document Name', '项目名称')}
                    </label>
                    <input
                      id="import-zip-name"
                      className="input"
                      placeholder={tr('Defaults to archive filename', '默认取压缩包文件名')}
                      value={zipProjName}
                      onChange={(e) => setZipProjName(e.target.value)}
                    />
                  </div>
                </div>
                <div className="modal-footer">
                  <button
                    type="button"
                    className="btn"
                    disabled={importingZip}
                    onClick={() => setShowImportZipModal(false)}
                  >
                    {tr('Cancel', '取消')}
                  </button>
                  <button
                    type="submit"
                    className="btn btn-primary"
                    disabled={importingZip || !zipFile}
                  >
                    {importingZip ? (
                      <Loader2 size={14} className="spin" />
                    ) : (
                      <FileArchive size={14} />
                    )}
                    {tr('Import Project', '导入项目')}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* AI Red/Green Diff Review Modal */}
        {pendingAiFix && pendingAiFix.projectId === activeProjectId && (
          <DiffModal
            open
            title={tr(
              AI_MODE_TITLES[pendingAiFix.response.mode].en,
              AI_MODE_TITLES[pendingAiFix.response.mode].zh,
            )}
            filePath={pendingAiFix.filePath}
            modelUsed={pendingAiFix.response.modelUsed}
            summaryZh={pendingAiFix.response.summaryZh}
            rootCauseZh={pendingAiFix.response.rootCauseZh}
            actionsTakenZh={pendingAiFix.response.actionsTakenZh}
            warningsZh={pendingAiFix.response.warningsZh}
            usage={pendingAiFix.response.usage}
            diff={pendingAiFix.response.diff}
            onApplyAndCompile={() => void applyPendingAiFix(true)}
            onApplyOnly={() => void applyPendingAiFix(false)}
            onClose={() => setPendingAiFix(null)}
          />
        )}

        {/* Lab Report Toolkit Modal (CSV -> booktabs, Figure, Code Listing, Lab Macros) */}
        {showLabToolkit && activeProject && (
          <LabToolkitModal
            projectId={activeProject.id}
            files={files}
            readOnly={readOnly}
            onInsertSnippet={handleInsertLabSnippet}
            onRefreshFiles={() => refreshProjectFiles(activeProject.id)}
            onClose={() => setShowLabToolkit(false)}
            onNotify={notify}
          />
        )}

        {/* 4-Layer Academic Format Hub (accessible from Account Dropdown) */}
        {activeProject && (
          <FormatHubModal
            open={showFormatHub}
            projectId={activeProject.id}
            readOnly={readOnly}
            activeFile={activeFile}
            files={files}
            currentEditorContent={editorHandleRef.current?.getValue() ?? ''}
            onImportApplied={(targetFile) => {
              // Server POST /format/apply-import already calls collab.patchLiveDocument()
              // to broadcast the Yjs update over WebSocket — never double-insert locally!
              if (targetFile !== activeFile) {
                setActiveFile(targetFile);
              }
              void refreshFilesAndMeta(activeProject.id);
            }}
            onNotify={notify}
            onClose={() => setShowFormatHub(false)}
          />
        )}

        {/* Git History & Rollback */}
        {activeProject && (
          <GitHistoryModal
            open={showGitHistory}
            projectId={activeProject.id}
            readOnly={readOnly}
            onRestored={() => void refreshFilesAndMeta(activeProject.id)}
            onNotify={notify}
            onClose={() => setShowGitHistory(false)}
          />
        )}

        {/* Collaborators, Invite Links & Local Agent Sync (ONLY when ENABLE_COLLAB is true) */}
        {collaborationEnabled && activeProject && (
          <ShareModal
            open={showShareModal}
            projectId={activeProject.id}
            projectName={activeProject.name}
            currentRole={activeProject.role}
            members={members}
            onNotify={notify}
            onClose={() => setShowShareModal(false)}
          />
        )}

        {/* Toast Container */}
        <div className="toast-container">
          {toasts.map((t) => (
            <div key={t.id} className={`toast ${t.kind}`}>
              <span>{t.message}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return <LocaleContext.Provider value={localeContextValue}>{view}</LocaleContext.Provider>;
};
