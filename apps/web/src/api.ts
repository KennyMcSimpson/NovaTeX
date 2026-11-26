import type {
  AcademicTemplateId,
  AiConfigOverview,
  AiConfigScope,
  AiFixRequest,
  AiFixResponse,
  AiProviderConfig,
  CommentThread,
  CompileEngine,
  CompileResult,
  ConvertOptions,
  ConvertOutputArtifact,
  GitCommitInfo,
  GitDiffResult,
  MdCompileResponse,
  OutlineItem,
  ProjectFileEntry,
  ProjectInvite,
  ProjectMemberInfo,
  ProjectMemberRole,
  ProjectSummary,
  SectionMergePreview,
  SyncTeXForwardResult,
  SyncTeXInverseResult,
  SystemCapabilities,
  UserPublic,
  FormatLayer,
} from '@novatex/shared';

export class ApiError extends Error {
  status: number;
  payload: unknown;
  constructor(status: number, message: string, payload?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.payload = payload;
  }
}

async function requestJson<T>(
  url: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && typeof init.body === 'string' && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const res = await fetch(url, {
    credentials: 'include',
    ...init,
    headers,
  });
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    const obj = data && typeof data === 'object' ? (data as Record<string, unknown>) : null;
    const msg =
      (typeof obj?.error === 'string' && obj.error) ||
      (typeof obj?.message === 'string' && obj.message) ||
      (typeof data === 'string' && data.slice(0, 200)) ||
      `请求失败 (${res.status})`;
    throw new ApiError(res.status, msg, data);
  }
  return data as T;
}

export interface AuthMeResponse {
  authenticated: boolean;
  user: UserPublic | null;
  needsSetup: boolean;
  allowPublicRegister: boolean;
}

export interface ProjectDetailResponse {
  project: ProjectSummary;
  members: ProjectMemberInfo[];
}

export interface FileReadResponse {
  path: string;
  content?: string;
  base64?: string;
  isBinary: boolean;
  size: number;
  mtimeMs?: number;
}

export interface BibKeysResponse {
  citeKeys: Array<{ key: string; title?: string; author?: string; year?: string }>;
  labels: Array<{ label: string; file?: string; line?: number }>;
}

export interface FormatImportPreviewResponse {
  artifact?: ConvertOutputArtifact;
  mergePreview?: SectionMergePreview;
  generatedCode: string;
  targetFile: string;
  extractedMedia?: Array<{ relativePath: string; byteLength: number; base64?: string }>;
  warnings: string[];
}

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? '');
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
}

export function downloadBase64File(base64: string, fileName: string, mimeType: string): void {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  const blob = new Blob([bytes], { type: mimeType });
  downloadBlob(blob, fileName);
}

export function downloadTextFile(text: string, fileName: string, mimeType = 'text/plain;charset=utf-8'): void {
  const blob = new Blob([text], { type: mimeType });
  downloadBlob(blob, fileName);
}

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const api = {
  // Health & System
  async getHealth(): Promise<SystemCapabilities> {
    const res = await requestJson<SystemCapabilities | { capabilities: SystemCapabilities }>('/api/health');
    return 'capabilities' in res ? res.capabilities : res;
  },

  // Auth
  async getAuthMe(): Promise<AuthMeResponse> {
    return requestJson<AuthMeResponse>('/api/auth/me');
  },

  async setupAdmin(payload: {
    username: string;
    displayName: string;
    password: string;
  }): Promise<{ user: UserPublic }> {
    return requestJson<{ user: UserPublic }>('/api/auth/setup', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  async register(payload: {
    username: string;
    displayName: string;
    password: string;
    inviteToken?: string;
  }): Promise<{ user: UserPublic; projectId?: string }> {
    return requestJson<{ user: UserPublic; projectId?: string }>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  async login(payload: {
    username: string;
    password: string;
  }): Promise<{ user: UserPublic }> {
    return requestJson<{ user: UserPublic }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  async logout(): Promise<{ ok: boolean }> {
    return requestJson<{ ok: boolean }>('/api/auth/logout', { method: 'POST' });
  },

  async changePassword(payload: {
    currentPassword: string;
    newPassword: string;
  }): Promise<{ ok: boolean }> {
    return requestJson<{ ok: boolean }>('/api/auth/change-password', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  async getCollabToken(): Promise<{ token: string }> {
    return requestJson<{ token: string }>('/api/auth/collab-token');
  },

  async createSyncToken(label = 'local-agent'): Promise<{ token: string; label?: string; createdAt?: string }> {
    return requestJson('/api/auth/sync-token', {
      method: 'POST',
      body: JSON.stringify({ label }),
    });
  },

  // Projects
  async listProjects(): Promise<ProjectSummary[]> {
    const res = await requestJson<ProjectSummary[] | { projects: ProjectSummary[] }>('/api/projects');
    return Array.isArray(res) ? res : (res.projects ?? []);
  },

  async createProject(payload: {
    name: string;
    description?: string;
    engine?: CompileEngine;
    template?: AcademicTemplateId;
  }): Promise<ProjectSummary> {
    const res = await requestJson<ProjectSummary | { project: ProjectSummary }>('/api/projects', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    return 'project' in res ? res.project : res;
  },

  async importProjectZip(payload: {
    name: string;
    fileName: string;
    base64: string;
  }): Promise<ProjectSummary> {
    const res = await requestJson<ProjectSummary | { project: ProjectSummary }>(
      '/api/projects/import-zip',
      {
        method: 'POST',
        body: JSON.stringify({
          name: payload.name,
          fileName: payload.fileName,
          base64: payload.base64,
          zipBase64: payload.base64,
        }),
      },
    );
    return 'project' in res ? res.project : res;
  },

  async getProject(projectId: string): Promise<ProjectDetailResponse> {
    const res = await requestJson<
      ProjectDetailResponse | (ProjectSummary & { members?: ProjectMemberInfo[] })
    >(`/api/projects/${encodeURIComponent(projectId)}`);
    if ('project' in res) {
      return { project: res.project, members: res.members ?? [] };
    }
    const { members, ...proj } = res;
    return { project: proj, members: members ?? [] };
  },

  async updateProject(
    projectId: string,
    patch: Partial<Pick<ProjectSummary, 'name' | 'description' | 'mainFile' | 'engine'>>,
  ): Promise<ProjectSummary> {
    const res = await requestJson<ProjectSummary | { project: ProjectSummary }>(
      `/api/projects/${encodeURIComponent(projectId)}`,
      {
        method: 'PATCH',
        body: JSON.stringify(patch),
      },
    );
    return 'project' in res ? res.project : res;
  },

  async deleteProject(projectId: string): Promise<{ ok: boolean }> {
    return requestJson(`/api/projects/${encodeURIComponent(projectId)}`, {
      method: 'DELETE',
    });
  },

  getExportZipUrl(projectId: string): string {
    return `/api/projects/${encodeURIComponent(projectId)}/export-zip`;
  },

  async listInvites(projectId: string): Promise<ProjectInvite[]> {
    const res = await requestJson<ProjectInvite[] | { invites: ProjectInvite[] }>(
      `/api/projects/${encodeURIComponent(projectId)}/invites`,
    );
    return Array.isArray(res) ? res : (res.invites ?? []);
  },

  async createInvite(
    projectId: string,
    payload: { role: Exclude<ProjectMemberRole, 'owner'>; expiresInHours?: number; maxUses?: number },
  ): Promise<ProjectInvite> {
    const res = await requestJson<ProjectInvite | { invite: ProjectInvite }>(
      `/api/projects/${encodeURIComponent(projectId)}/invites`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
    );
    return 'invite' in res ? res.invite : res;
  },

  async acceptInvite(token: string): Promise<{ ok: boolean; projectId?: string; project?: ProjectSummary }> {
    return requestJson(`/api/invites/${encodeURIComponent(token)}/accept`, {
      method: 'POST',
    });
  },

  // Files & Navigation
  async listFiles(projectId: string): Promise<ProjectFileEntry[]> {
    const res = await requestJson<ProjectFileEntry[] | { files: ProjectFileEntry[] }>(
      `/api/projects/${encodeURIComponent(projectId)}/files`,
    );
    return Array.isArray(res) ? res : (res.files ?? []);
  },

  async readFile(projectId: string, filePath: string): Promise<FileReadResponse> {
    return requestJson<FileReadResponse>(
      `/api/projects/${encodeURIComponent(projectId)}/file?path=${encodeURIComponent(filePath)}`,
    );
  },

  async writeFile(
    projectId: string,
    payload: { path: string; content?: string; base64?: string; isBinary?: boolean; kind?: 'file' | 'dir' },
  ): Promise<{ ok: boolean; path: string }> {
    return requestJson(`/api/projects/${encodeURIComponent(projectId)}/file`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
  },

  async renameFile(
    projectId: string,
    fromPath: string,
    toPath: string,
  ): Promise<{ ok: boolean }> {
    return requestJson(`/api/projects/${encodeURIComponent(projectId)}/files/rename`, {
      method: 'POST',
      body: JSON.stringify({ fromPath, toPath, oldPath: fromPath, newPath: toPath }),
    });
  },

  async deleteFile(projectId: string, filePath: string): Promise<{ ok: boolean }> {
    return requestJson(
      `/api/projects/${encodeURIComponent(projectId)}/file?path=${encodeURIComponent(filePath)}`,
      { method: 'DELETE' },
    );
  },

  async getOutline(projectId: string): Promise<OutlineItem[]> {
    const res = await requestJson<OutlineItem[] | { items: OutlineItem[]; outline?: OutlineItem[] }>(
      `/api/projects/${encodeURIComponent(projectId)}/outline`,
    );
    if (Array.isArray(res)) return res;
    return res.items ?? res.outline ?? [];
  },

  async getBibKeys(projectId: string): Promise<BibKeysResponse> {
    const res = await requestJson<
      Partial<BibKeysResponse> & {
        keys?: Array<string | { key: string; title?: string; author?: string; year?: string }>;
        citations?: Array<string | { key: string; title?: string; author?: string; year?: string }>;
      }
    >(`/api/projects/${encodeURIComponent(projectId)}/bib-keys`);
    const rawCite = res.citeKeys ?? res.citations ?? res.keys ?? [];
    const citeKeys = rawCite.map((item) => (typeof item === 'string' ? { key: item } : item));
    const rawLabels = res.labels ?? [];
    const labels = rawLabels.map((item) =>
      typeof item === 'string' ? { label: item } : item,
    );
    return { citeKeys, labels };
  },

  // Compile, PDF & SyncTeX
  async compile(
    projectId: string,
    payload: { engine?: CompileEngine; mainFile?: string } = {},
  ): Promise<CompileResult> {
    const res = await requestJson<CompileResult | { result: CompileResult }>(
      `/api/projects/${encodeURIComponent(projectId)}/compile`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
    );
    return 'result' in res ? res.result : res;
  },

  async getLatestCompile(projectId: string): Promise<CompileResult | null> {
    const res = await requestJson<CompileResult | { result: CompileResult | null } | null>(
      `/api/projects/${encodeURIComponent(projectId)}/compile/latest`,
    );
    if (!res) return null;
    if ('result' in res) return res.result;
    return 'jobId' in res ? res : null;
  },

  getPdfUrl(projectId: string, cacheBust?: string | number): string {
    const qs = cacheBust ? `?v=${encodeURIComponent(String(cacheBust))}` : '';
    return `/api/projects/${encodeURIComponent(projectId)}/pdf${qs}`;
  },

  async synctexForward(
    projectId: string,
    file: string,
    line: number,
  ): Promise<SyncTeXForwardResult> {
    return requestJson<SyncTeXForwardResult>(
      `/api/projects/${encodeURIComponent(projectId)}/synctex/forward?file=${encodeURIComponent(file)}&line=${encodeURIComponent(String(line))}`,
    );
  },

  async synctexInverse(
    projectId: string,
    page: number,
    x: number,
    y: number,
  ): Promise<SyncTeXInverseResult> {
    return requestJson<SyncTeXInverseResult>(
      `/api/projects/${encodeURIComponent(projectId)}/synctex/inverse?page=${page}&x=${x.toFixed(2)}&y=${y.toFixed(2)}`,
    );
  },

  // AI Fixer (Per-User BYOK + Site Global Fallback)
  async getAiConfig(): Promise<AiProviderConfig> {
    const res = await requestJson<AiProviderConfig | { config: AiProviderConfig }>('/api/ai/config');
    return 'config' in res ? res.config : res;
  },

  async getAiConfigOverview(): Promise<AiConfigOverview> {
    return requestJson<AiConfigOverview>('/api/ai/config');
  },

  async saveAiConfig(config: Partial<AiProviderConfig>): Promise<AiProviderConfig> {
    const res = await requestJson<AiProviderConfig | { config: AiProviderConfig }>('/api/ai/config', {
      method: 'PUT',
      body: JSON.stringify(config),
    });
    return 'config' in res ? res.config : res;
  },

  async saveGlobalAiConfig(config: Partial<AiProviderConfig>): Promise<AiConfigOverview> {
    return requestJson<AiConfigOverview>('/api/ai/config', {
      method: 'PUT',
      body: JSON.stringify(config),
    });
  },

  async saveMyAiConfig(config: Partial<AiProviderConfig>): Promise<AiConfigOverview> {
    return requestJson<AiConfigOverview>('/api/ai/config/me', {
      method: 'PUT',
      body: JSON.stringify(config),
    });
  },

  async deleteMyAiConfig(): Promise<AiConfigOverview & { ok: boolean }> {
    return requestJson<AiConfigOverview & { ok: boolean }>('/api/ai/config/me', {
      method: 'DELETE',
    });
  },

  async testAiConfig(
    override?: Partial<AiProviderConfig> & { scope?: AiConfigScope },
  ): Promise<{ ok: boolean; latencyMs?: number; model?: string; message?: string; error?: string }> {
    return requestJson('/api/ai/test', {
      method: 'POST',
      body: JSON.stringify(override ?? {}),
    });
  },

  async fetchAiModels(
    override?: Partial<AiProviderConfig> & { scope?: AiConfigScope },
  ): Promise<{
    ok: boolean;
    models: string[];
    normalizedBaseUrl?: string;
    latencyMs?: number;
    message?: string;
    error?: string;
  }> {
    return requestJson('/api/ai/models', {
      method: 'POST',
      body: JSON.stringify(override ?? {}),
    });
  },

  async runAiFix(projectId: string, payload: AiFixRequest): Promise<AiFixResponse> {
    return requestJson<AiFixResponse>(`/api/projects/${encodeURIComponent(projectId)}/ai/fix`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  // 4-Layer Academic Format Hub
  async exportFormat(
    projectId: string,
    payload: {
      sourceScope: 'project' | 'file';
      sourceFile?: string;
      targetFormat: FormatLayer;
      options?: ConvertOptions;
    },
  ): Promise<ConvertOutputArtifact> {
    const res = await requestJson<
      ConvertOutputArtifact | { artifact: ConvertOutputArtifact }
    >(`/api/projects/${encodeURIComponent(projectId)}/format/export`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    return 'artifact' in res ? res.artifact : res;
  },

  async previewImportFormat(
    projectId: string,
    payload: {
      sourceFormat: Exclude<FormatLayer, 'tex'>;
      fileName: string;
      text?: string;
      base64?: string;
      targetMode: 'merge-tex' | 'new-tex' | 'save-md';
      targetFile: string;
      options?: ConvertOptions;
    },
  ): Promise<FormatImportPreviewResponse> {
    return requestJson<FormatImportPreviewResponse>(
      `/api/projects/${encodeURIComponent(projectId)}/format/import-preview`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
    );
  },

  async applyImportFormat(
    projectId: string,
    payload: {
      targetFile: string;
      content: string;
      extractedMedia?: Array<{ relativePath: string; base64?: string }>;
      commitMessage?: string;
    },
  ): Promise<{ ok: boolean; targetFile: string }> {
    return requestJson(`/api/projects/${encodeURIComponent(projectId)}/format/apply-import`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  async mdCompile(
    projectId: string,
    payload: {
      markdown: string;
      targetFile?: string;
      engine?: CompileEngine;
      commitMessage?: string;
      options?: ConvertOptions;
    },
  ): Promise<MdCompileResponse> {
    return requestJson<MdCompileResponse>(
      `/api/projects/${encodeURIComponent(projectId)}/format/md-compile`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
    );
  },

  // Git History
  async getGitLog(projectId: string): Promise<GitCommitInfo[]> {
    const res = await requestJson<GitCommitInfo[] | { commits: GitCommitInfo[] }>(
      `/api/projects/${encodeURIComponent(projectId)}/git/log`,
    );
    return Array.isArray(res) ? res : (res.commits ?? []);
  },

  async createGitCommit(projectId: string, message: string): Promise<GitCommitInfo> {
    const res = await requestJson<GitCommitInfo | { commit: GitCommitInfo }>(
      `/api/projects/${encodeURIComponent(projectId)}/git/commit`,
      {
        method: 'POST',
        body: JSON.stringify({ message }),
      },
    );
    return 'commit' in res ? res.commit : res;
  },

  async getGitDiff(projectId: string, fromRef: string, toRef = 'HEAD'): Promise<GitDiffResult> {
    return requestJson<GitDiffResult>(
      `/api/projects/${encodeURIComponent(projectId)}/git/diff?from=${encodeURIComponent(fromRef)}&to=${encodeURIComponent(toRef)}`,
    );
  },

  async restoreGitCommit(projectId: string, commitHash: string): Promise<{ ok: boolean }> {
    return requestJson(`/api/projects/${encodeURIComponent(projectId)}/git/restore`, {
      method: 'POST',
      body: JSON.stringify({ hash: commitHash, commitHash, ref: commitHash }),
    });
  },

  // Comments
  async listComments(projectId: string, file?: string): Promise<CommentThread[]> {
    const qs = file ? `?file=${encodeURIComponent(file)}` : '';
    const res = await requestJson<CommentThread[] | { threads: CommentThread[] }>(
      `/api/projects/${encodeURIComponent(projectId)}/comments${qs}`,
    );
    return Array.isArray(res) ? res : (res.threads ?? []);
  },

  async createComment(
    projectId: string,
    payload: { filePath: string; lineNumber: number; quote: string; body: string },
  ): Promise<CommentThread> {
    const res = await requestJson<CommentThread | { thread: CommentThread }>(
      `/api/projects/${encodeURIComponent(projectId)}/comments`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
    );
    return 'thread' in res ? res.thread : res;
  },

  async replyComment(
    projectId: string,
    threadId: string,
    body: string,
  ): Promise<CommentThread> {
    const res = await requestJson<CommentThread | { thread: CommentThread }>(
      `/api/projects/${encodeURIComponent(projectId)}/comments/${encodeURIComponent(threadId)}/reply`,
      {
        method: 'POST',
        body: JSON.stringify({ body }),
      },
    );
    return 'thread' in res ? res.thread : res;
  },

  async updateCommentThread(
    projectId: string,
    threadId: string,
    resolved: boolean,
  ): Promise<CommentThread> {
    const res = await requestJson<CommentThread | { thread: CommentThread }>(
      `/api/projects/${encodeURIComponent(projectId)}/comments/${encodeURIComponent(threadId)}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ resolved }),
      },
    );
    return 'thread' in res ? res.thread : res;
  },
};
