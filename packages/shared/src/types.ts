export type UserRole = 'admin' | 'member';
export type ProjectMemberRole = 'owner' | 'editor' | 'commenter' | 'viewer';

export interface UserPublic {
  id: string;
  username: string;
  displayName: string;
  role: UserRole;
  color: string;
  createdAt: string;
}

export type CompileEngine = 'xelatex' | 'pdflatex' | 'lualatex';

export interface ProjectSummary {
  id: string;
  name: string;
  description: string;
  mainFile: string;
  engine: CompileEngine;
  ownerId: string;
  role: ProjectMemberRole;
  createdAt: string;
  updatedAt: string;
  lastCompileStatus?: 'idle' | 'queued' | 'compiling' | 'success' | 'error';
  lastCompiledAt?: string | null;
}

export interface ProjectMemberInfo {
  userId: string;
  username: string;
  displayName: string;
  color: string;
  role: ProjectMemberRole;
  joinedAt: string;
}

export interface ProjectInvite {
  token: string;
  projectId: string;
  role: ProjectMemberRole;
  expiresAt: string;
  maxUses: number;
  usedCount: number;
  createdAt: string;
}

export interface ProjectFileEntry {
  path: string;
  name: string;
  kind: 'file' | 'dir';
  size: number;
  mtimeMs: number;
  isBinary: boolean;
}

export interface OutlineItem {
  level: number;
  command: string;
  title: string;
  file: string;
  line: number;
}

export interface CommentMessage {
  id: string;
  threadId: string;
  authorId: string;
  authorName: string;
  authorColor: string;
  body: string;
  createdAt: string;
}

export interface CommentThread {
  id: string;
  projectId: string;
  filePath: string;
  lineNumber: number;
  quote: string;
  resolved: boolean;
  createdBy: string;
  createdAt: string;
  messages: CommentMessage[];
}

export type DiagnosticSeverity = 'error' | 'warning' | 'info';

export interface CompileDiagnostic {
  id: string;
  file: string;
  line: number;
  column?: number;
  severity: DiagnosticSeverity;
  code: string;
  titleZh: string;
  explanationZh: string;
  quickFixHintZh: string;
  rawMessage: string;
  snippet?: string;
}

export interface CompileResult {
  jobId: string;
  projectId: string;
  ok: boolean;
  engine: CompileEngine;
  mainFile: string;
  durationMs: number;
  exitCode: number;
  pdfReady: boolean;
  pdfSize: number;
  synctexReady: boolean;
  linearized: boolean;
  diagnostics: CompileDiagnostic[];
  errorCount: number;
  warningCount: number;
  rawLog: string;
  compilerAvailable: boolean;
  compilerNote?: string;
  finishedAt: string;
}

export interface SyncTeXBox {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SyncTeXForwardResult {
  found: boolean;
  file: string;
  line: number;
  boxes: SyncTeXBox[];
}

export interface SyncTeXInverseResult {
  found: boolean;
  file: string;
  line: number;
  column: number;
}

export interface AiProviderConfig {
  baseUrl: string;
  apiKey?: string;
  hasApiKey?: boolean;
  model: string;
  reasonerModel: string;
  timeoutMs: number;
}

export type AiConfigScope = 'personal' | 'global';

export interface AiConfigOverview {
  /** Effective active sanitized config for the signed-in user */
  config: AiProviderConfig;
  /** Current user's own BYOK config (sanitized, never contains raw apiKey) */
  personal: AiProviderConfig;
  /** Site-wide global fallback config (sanitized, never contains raw apiKey) */
  global: AiProviderConfig;
  /** Which layer is currently active for this user */
  effectiveSource: 'personal' | 'global' | 'env' | 'none';
  /** Current dynamic open-registration setting */
  allowPublicRegister: boolean;
}

export type AiFixMode =
  | 'diagnose-and-fix'
  | 'format-table'
  | 'format-math'
  | 'cleanup-conversion';

export interface AiFixRequest {
  mode: AiFixMode;
  filePath: string;
  sourceCode: string;
  diagnostics?: CompileDiagnostic[];
  rawLogExcerpt?: string;
  selectionRange?: { startLine: number; endLine: number };
  useReasoner?: boolean;
  userNote?: string;
  /** Optional runtime override (never persisted unless explicitly saved) */
  providerOverride?: Partial<AiProviderConfig>;
}

export interface DiffLine {
  type: 'context' | 'add' | 'remove';
  oldLineNumber: number | null;
  newLineNumber: number | null;
  content: string;
}

export interface DiffSummary {
  additions: number;
  deletions: number;
  unifiedDiff: string;
  lines: DiffLine[];
}

export interface AiFixResponse {
  ok: boolean;
  mode: AiFixMode;
  modelUsed: string;
  summaryZh: string;
  rootCauseZh: string;
  actionsTakenZh: string[];
  patchedCode: string;
  diff: DiffSummary;
  warningsZh?: string[];
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
}

export type FormatLayer = 'md' | 'docx' | 'txt' | 'tex' | 'pdf';

export type AcademicTemplateId =
  | 'lab-report-en'
  | 'lab-report-zh'
  | 'tech-report'
  | 'beamer-slides'
  | 'chinese-ctex'
  | 'ieee-conf'
  | 'clean-article';

export interface WordCountStats {
  cjkChars: number;
  latinWords: number;
  numbers: number;
  totalAcademicWords: number;
  lines: number;
  nonEmptyLines: number;
  charactersNoSpaces: number;
}

export interface ConvertOptions {
  /** Preserve citations as [@key] <-> \cite{key} */
  preserveCitations?: boolean;
  /** For MD/DOCX -> LaTeX: emit body fragment only without preamble */
  bodyOnly?: boolean;
  /** Academic template when generating full standalone .tex */
  template?: AcademicTemplateId;
  /** For DOCX -> MD/LaTeX: Word track changes handling */
  trackChanges?: 'accept' | 'reject' | 'all';
  /** Media extraction directory name relative to project */
  mediaDir?: string;
  /** Bibliography file path relative to project */
  bibFile?: string;
  /** Cite style for DOCX export */
  citationFormat?: 'natbib' | 'biblatex';
  /** Flatten \input / \include before converting LaTeX */
  flattenInputs?: boolean;
  /** Optional document title for standalone exports */
  title?: string;
}

export interface ConvertOutputArtifact {
  format: FormatLayer;
  fileName: string;
  mimeType: string;
  /** UTF-8 text for md/tex/txt */
  text?: string;
  /** Base64 binary for docx/pdf */
  base64?: string;
  byteLength: number;
  extractedMedia?: Array<{ relativePath: string; byteLength: number }>;
  wordCount?: WordCountStats;
  warnings: string[];
  pandocVersion?: string;
}

export interface SectionMergePreview {
  targetFile: string;
  originalCode: string;
  mergedCode: string;
  diff: DiffSummary;
  warnings: string[];
}

export interface MdCompileResponse {
  ok: boolean;
  targetFile: string;
  mergedCode: string;
  mergePreview: SectionMergePreview;
  warnings: string[];
  compileResult: CompileResult;
}

export interface GitCommitInfo {
  hash: string;
  shortHash: string;
  message: string;
  author: string;
  date: string;
}

export interface GitDiffResult {
  fromRef: string;
  toRef: string;
  files: Array<{
    path: string;
    status: string;
    unifiedDiff: string;
  }>;
}

export interface SystemCapabilities {
  nodeVersion: string;
  pandoc: {
    available: boolean;
    version: string | null;
    binary: string | null;
  };
  compiler: {
    mode: 'local' | 'remote';
    available: boolean;
    engines: CompileEngine[];
    hasLatexmk: boolean;
    hasBibtex: boolean;
    hasBiber: boolean;
    hasQpdf: boolean;
    texBinDir: string | null;
  };
  ai: {
    configured: boolean;
    baseUrl: string;
    model: string;
    reasonerModel: string;
  };
  auth: {
    hasUsers: boolean;
    allowPublicRegister: boolean;
  };
  features?: {
    /** Whether multi-user invite/comments/presence collaboration UI is enabled (false by default for local solo mode) */
    collaboration: boolean;
  };
}
