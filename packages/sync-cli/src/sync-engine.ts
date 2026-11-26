import fs from 'node:fs';
import path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import { HocuspocusProvider } from '@hocuspocus/provider';
import * as Y from 'yjs';
import {
  isBinaryFilePath,
  normalizeProjectRelPath,
  PathSecurityError,
  resolveInsideWorkspace,
} from '@novatex/shared';
import {
  AntiLoopTracker,
  applyMinimalTextToYText,
  LOCAL_FS_ORIGIN,
} from './text-sync.js';

export const TRACKED_TEXT_EXTENSIONS = new Set([
  '.tex',
  '.bib',
  '.md',
  '.sty',
  '.cls',
  '.txt',
]);

export interface SyncLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface SyncProviderLike {
  isSynced?: boolean;
  setAwarenessField?(key: string, value: unknown): void;
  destroy(): void;
}

export interface ProviderFactoryParams {
  url: string;
  name: string;
  token: string;
  document: Y.Doc;
  relPath: string;
  onSynced: (data: { state: boolean }) => void;
  onStatus?: (data: { status: string }) => void;
  onAuthenticationFailed?: (data: { reason: string }) => void;
}

export type HocuspocusProviderFactory = (params: ProviderFactoryParams) => SyncProviderLike;

export interface NovaTeXSyncConfig {
  serverUrl: string;
  projectId: string;
  token: string;
  localDir: string;
  agentName?: string;
  pollIntervalMs?: number;
  antiLoopTtlMs?: number;
  logger?: SyncLogger;
  fetchImpl?: typeof fetch;
  providerFactory?: HocuspocusProviderFactory;
  awaitWriteFinish?: boolean | { stabilityThreshold?: number; pollInterval?: number };
}

export interface RemoteFileDescriptor {
  path: string;
  name?: string;
  kind?: 'file' | 'dir';
  size?: number;
  mtimeMs?: number;
  isBinary?: boolean;
  content?: string;
  base64?: string;
}

export interface PullSkippedEntry {
  path: string;
  reason: string;
}

export interface PullResult {
  downloaded: string[];
  skipped: PullSkippedEntry[];
  remoteCount: number;
}

export interface TrackedTextRoom {
  relPath: string;
  roomName: string;
  ydoc: Y.Doc;
  ytext: Y.Text;
  provider: SyncProviderLike;
  synced: boolean;
  pendingLocalText?: string;
  disposeObserver: () => void;
}

export type LocalFileChangeOutcome =
  | 'suppressed'
  | 'synced-text'
  | 'queued-text'
  | 'uploaded-binary'
  | 'ignored';

const DEFAULT_LOGGER: SyncLogger = {
  info: (msg) => console.log(`[novatex-sync] ${msg}`),
  warn: (msg) => console.warn(`[novatex-sync] WARN: ${msg}`),
  error: (msg) => console.error(`[novatex-sync] ERROR: ${msg}`),
};

let atomicCounter = 0;

/**
 * Determine whether a project-relative path should be synced over Yjs/Hocuspocus as live collaborative text.
 */
export function isTrackedTextFile(relPath: string): boolean {
  const ext = path.extname(relPath).toLowerCase();
  return TRACKED_TEXT_EXTENSIONS.has(ext);
}

/**
 * Convert an HTTP(S) or WS(S) NovaTeX server URL to the Hocuspocus `/collab` WebSocket endpoint URL.
 */
export function toCollabWebSocketUrl(serverUrl: string): string {
  const trimmed = serverUrl.trim().replace(/\/+$/, '');
  const parsed = new URL(trimmed);
  if (parsed.protocol === 'http:') {
    parsed.protocol = 'ws:';
  } else if (parsed.protocol === 'https:') {
    parsed.protocol = 'wss:';
  } else if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    throw new Error(`Unsupported server protocol for collaboration URL: ${parsed.protocol}`);
  }

  const cleanPath = parsed.pathname.replace(/\/+$/, '');
  parsed.pathname = cleanPath.endsWith('/collab') ? cleanPath : `${cleanPath}/collab`;
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

/**
 * Check whether an absolute path inside `localDir` should be ignored by Chokidar or local directory scans.
 * Only inspects path segments relative to `localDir`, so dotfiles in parent directories (e.g. `.tmp`)
 * never break watching.
 */
export function isIgnoredLocalPath(localDir: string, targetPath: string): boolean {
  const resolvedRoot = path.resolve(localDir);
  const resolvedTarget = path.resolve(targetPath);
  const rel = path.relative(resolvedRoot, resolvedTarget);

  if (!rel || rel === '.') {
    return false;
  }
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return true;
  }

  const segments = rel.split(/[\\/]+/).filter(Boolean);
  for (const seg of segments) {
    if (seg.startsWith('.')) return true;
    if (seg === 'node_modules' || seg === '_build') return true;
  }
  return false;
}

/**
 * Write a file atomically via a hidden sibling temp file + rename so concurrent readers
 * never observe partially written content.
 */
export function writeFileAtomic(absPath: string, data: string | Buffer): void {
  const dir = path.dirname(absPath);
  const base = path.basename(absPath);
  fs.mkdirSync(dir, { recursive: true });

  atomicCounter = (atomicCounter + 1) % 1_000_000;
  const tmpPath = path.join(dir, `.${base}.novatex-sync-${process.pid}-${atomicCounter}.tmp`);

  try {
    if (typeof data === 'string') {
      fs.writeFileSync(tmpPath, data, 'utf8');
    } else {
      fs.writeFileSync(tmpPath, data);
    }

    try {
      fs.renameSync(tmpPath, absPath);
    } catch {
      // Fallback on Windows when an antivirus/editor briefly locks target during atomic rename
      if (typeof data === 'string') {
        fs.writeFileSync(absPath, data, 'utf8');
      } else {
        fs.writeFileSync(absPath, data);
      }
    }
  } finally {
    try {
      if (fs.existsSync(tmpPath)) {
        fs.unlinkSync(tmpPath);
      }
    } catch {
      // ignore temp cleanup errors
    }
  }
}

function walkSafeLocalFiles(localDir: string): string[] {
  const resolvedRoot = path.resolve(localDir);
  if (!fs.existsSync(resolvedRoot)) {
    return [];
  }

  const results: string[] = [];
  const visit = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (isIgnoredLocalPath(resolvedRoot, full)) continue;

      if (entry.isDirectory()) {
        visit(full);
      } else if (entry.isFile()) {
        const rawRel = path.relative(resolvedRoot, full);
        try {
          const safeRel = normalizeProjectRelPath(rawRel);
          results.push(safeRel);
        } catch {
          // Skip unsafe/forbidden filenames
        }
      }
    }
  };

  visit(resolvedRoot);
  return results.sort();
}

function createDefaultHocuspocusProvider(params: ProviderFactoryParams): HocuspocusProvider {
  return new HocuspocusProvider({
    url: params.url,
    name: params.name,
    token: params.token,
    document: params.document,
    onSynced: params.onSynced,
    onStatus: params.onStatus ? ({ status }) => params.onStatus?.({ status: String(status) }) : undefined,
    onAuthenticationFailed: params.onAuthenticationFailed,
  });
}

/**
 * Bidirectional Local Agent Companion sync client connecting a local folder to a NovaTeX server.
 * - Tracked text files (.tex, .bib, .md, .sty, .cls, .txt) sync live via Yjs/Hocuspocus with minimal splices.
 * - Binary files (e.g. .png, .pdf figures) sync via authenticated REST file endpoints.
 * - Content-hash anti-loop protection prevents remote -> disk -> Chokidar -> Yjs feedback loops.
 */
export class NovaTeXSyncClient {
  readonly serverUrl: string;
  readonly collabUrl: string;
  readonly projectId: string;
  readonly localDir: string;
  readonly agentName: string;

  private readonly token: string;
  private readonly pollIntervalMs: number;
  private readonly logger: SyncLogger;
  private readonly fetchImpl: typeof fetch;
  private readonly providerFactory: HocuspocusProviderFactory;
  private readonly awaitWriteFinish: boolean | { stabilityThreshold?: number; pollInterval?: number };

  private readonly antiLoop: AntiLoopTracker;
  private readonly rooms = new Map<string, TrackedTextRoom>();
  private watcher: FSWatcher | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(config: NovaTeXSyncConfig) {
    this.serverUrl = config.serverUrl.trim().replace(/\/+$/, '');
    this.collabUrl = toCollabWebSocketUrl(this.serverUrl);
    this.projectId = config.projectId.trim();
    this.token = config.token;
    this.localDir = path.resolve(config.localDir);
    this.agentName = config.agentName?.trim() || 'Local Agent (novatex-sync)';
    this.pollIntervalMs = config.pollIntervalMs ?? 15_000;
    this.logger = config.logger ?? DEFAULT_LOGGER;
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.providerFactory = config.providerFactory ?? createDefaultHocuspocusProvider;
    this.awaitWriteFinish = config.awaitWriteFinish ?? {
      stabilityThreshold: 120,
      pollInterval: 40,
    };
    this.antiLoop = new AntiLoopTracker(config.antiLoopTtlMs ?? 5_000);

    if (!this.projectId) {
      throw new Error('projectId 不能为空');
    }
  }

  getAntiLoopTracker(): AntiLoopTracker {
    return this.antiLoop;
  }

  getTrackedRooms(): ReadonlyMap<string, TrackedTextRoom> {
    return this.rooms;
  }

  private authHeaders(extra?: Record<string, string>): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      ...extra,
    };
  }

  private async fetchRemoteFileList(): Promise<RemoteFileDescriptor[]> {
    const endpoint = `${this.serverUrl}/api/projects/${encodeURIComponent(this.projectId)}/files`;
    const res = await this.fetchImpl(endpoint, {
      method: 'GET',
      headers: this.authHeaders({ Accept: 'application/json' }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`拉取项目文件列表失败 (HTTP ${res.status}): ${detail || res.statusText}`);
    }

    const payload = (await res.json()) as
      | RemoteFileDescriptor[]
      | { files?: RemoteFileDescriptor[]; entries?: RemoteFileDescriptor[] };

    if (Array.isArray(payload)) {
      return payload;
    }
    if (Array.isArray(payload.files)) {
      return payload.files;
    }
    if (Array.isArray(payload.entries)) {
      return payload.entries;
    }
    return [];
  }

  private async fetchSingleRemoteFile(
    safeRel: string,
    hintBinary: boolean,
  ): Promise<{ content?: string; base64?: string }> {
    const endpoint = `${this.serverUrl}/api/projects/${encodeURIComponent(this.projectId)}/file?path=${encodeURIComponent(safeRel)}`;
    const res = await this.fetchImpl(endpoint, {
      method: 'GET',
      headers: this.authHeaders({ Accept: 'application/json, application/octet-stream, text/plain' }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`下载远端文件失败 (${safeRel}, HTTP ${res.status}): ${detail || res.statusText}`);
    }

    const contentType = res.headers.get('content-type')?.toLowerCase() ?? '';
    if (contentType.includes('application/json')) {
      const data = (await res.json()) as {
        content?: string;
        base64?: string;
        isBinary?: boolean;
      };
      return { content: data.content, base64: data.base64 };
    }

    if (hintBinary || isBinaryFilePath(safeRel)) {
      const buf = Buffer.from(await res.arrayBuffer());
      return { base64: buf.toString('base64') };
    }

    return { content: await res.text() };
  }

  /**
   * Download all safe project files from the NovaTeX server into `localDir`.
   * Rejects path traversal, `.git`, `.latexmkrc`, Windows reserved names, and symlink escapes.
   */
  async pullAll(): Promise<PullResult> {
    fs.mkdirSync(this.localDir, { recursive: true });
    const entries = await this.fetchRemoteFileList();

    const downloaded: string[] = [];
    const skipped: PullSkippedEntry[] = [];

    for (const entry of entries) {
      if (!entry || typeof entry.path !== 'string') {
        skipped.push({ path: String(entry?.path ?? ''), reason: '无效的文件路径字段' });
        continue;
      }

      if (entry.kind === 'dir') {
        continue;
      }

      let resolved: { relPath: string; absPath: string };
      try {
        const safeRel = normalizeProjectRelPath(entry.path);
        resolved = resolveInsideWorkspace(this.localDir, safeRel);
      } catch (err) {
        const reason =
          err instanceof PathSecurityError
            ? `${err.code}: ${err.message}`
            : err instanceof Error
              ? err.message
              : String(err);
        skipped.push({ path: entry.path, reason });
        this.logger.warn(`已拦截不安全的远端路径 "${entry.path}": ${reason}`);
        continue;
      }

      let textContent = typeof entry.content === 'string' ? entry.content : undefined;
      let base64Content = typeof entry.base64 === 'string' ? entry.base64 : undefined;

      if (textContent === undefined && base64Content === undefined) {
        const fetched = await this.fetchSingleRemoteFile(
          resolved.relPath,
          Boolean(entry.isBinary),
        );
        textContent = fetched.content;
        base64Content = fetched.base64;
      }

      if (base64Content !== undefined) {
        const buf = Buffer.from(base64Content, 'base64');
        this.writeBinaryWithAntiLoop(resolved.relPath, resolved.absPath, buf);
        downloaded.push(resolved.relPath);
      } else if (textContent !== undefined) {
        this.writeTextWithAntiLoop(resolved.relPath, resolved.absPath, textContent);
        downloaded.push(resolved.relPath);
      } else {
        skipped.push({ path: resolved.relPath, reason: '远端条目缺少 content 与 base64 数据' });
      }
    }

    return {
      downloaded,
      skipped,
      remoteCount: entries.length,
    };
  }

  /**
   * Upload a binary file (e.g. figure PNG/PDF) via REST `PUT /api/projects/:id/file`.
   */
  async pushBinaryFile(relPath: string, buffer: Buffer): Promise<void> {
    const safeRel = normalizeProjectRelPath(relPath);
    const endpoint = `${this.serverUrl}/api/projects/${encodeURIComponent(this.projectId)}/file`;
    const res = await this.fetchImpl(endpoint, {
      method: 'PUT',
      headers: this.authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        path: safeRel,
        base64: buffer.toString('base64'),
        isBinary: true,
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`上传二进制文件失败 (${safeRel}, HTTP ${res.status}): ${detail || res.statusText}`);
    }
  }

  /**
   * Upload a text file via REST `PUT /api/projects/:id/file` (used when seeding a missing remote file).
   */
  async pushTextFile(relPath: string, content: string): Promise<void> {
    const safeRel = normalizeProjectRelPath(relPath);
    const endpoint = `${this.serverUrl}/api/projects/${encodeURIComponent(this.projectId)}/file`;
    const res = await this.fetchImpl(endpoint, {
      method: 'PUT',
      headers: this.authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        path: safeRel,
        content,
        isBinary: false,
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`上传文本文件失败 (${safeRel}, HTTP ${res.status}): ${detail || res.statusText}`);
    }
  }

  private writeTextWithAntiLoop(safeRel: string, absPath: string, text: string): boolean {
    if (fs.existsSync(absPath)) {
      try {
        const existing = fs.readFileSync(absPath, 'utf8');
        if (existing === text) {
          this.antiLoop.record(safeRel, text);
          return false;
        }
      } catch {
        // proceed with overwrite
      }
    }

    this.antiLoop.record(safeRel, text);
    writeFileAtomic(absPath, text);
    return true;
  }

  private writeBinaryWithAntiLoop(safeRel: string, absPath: string, buf: Buffer): boolean {
    if (fs.existsSync(absPath)) {
      try {
        const existing = fs.readFileSync(absPath);
        if (existing.equals(buf)) {
          this.antiLoop.record(safeRel, buf);
          return false;
        }
      } catch {
        // proceed with overwrite
      }
    }

    this.antiLoop.record(safeRel, buf);
    writeFileAtomic(absPath, buf);
    return true;
  }

  /**
   * Persist remote Yjs text update to disk safely while recording its content hash
   * so the resulting Chokidar event is suppressed.
   */
  handleRemoteTextUpdate(relPath: string, nextText: string): boolean {
    const { relPath: safeRel, absPath } = resolveInsideWorkspace(this.localDir, relPath);
    const written = this.writeTextWithAntiLoop(safeRel, absPath, nextText);
    if (written) {
      this.logger.info(`↓ 远端同步到本地: ${safeRel} (${Buffer.byteLength(nextText, 'utf8')} B)`);
    }
    return written;
  }

  /**
   * Open (or reuse) a Hocuspocus Yjs room for a tracked text file (`${projectId}::${relPath}`).
   */
  openTextRoom(relPath: string): TrackedTextRoom {
    const safeRel = normalizeProjectRelPath(relPath);
    const existing = this.rooms.get(safeRel);
    if (existing) {
      return existing;
    }

    const roomName = `${this.projectId}::${safeRel}`;
    const ydoc = new Y.Doc();
    const ytext = ydoc.getText('content');

    const observer = (_event: Y.YTextEvent, transaction: Y.Transaction) => {
      if (transaction.origin === LOCAL_FS_ORIGIN) {
        return;
      }
      try {
        this.handleRemoteTextUpdate(safeRel, ytext.toString());
      } catch (err) {
        this.logger.error(
          `写入远端更新失败 (${safeRel}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    };
    ytext.observe(observer);

    const room: TrackedTextRoom = {
      relPath: safeRel,
      roomName,
      ydoc,
      ytext,
      provider: null as unknown as SyncProviderLike,
      synced: false,
      disposeObserver: () => {
        ytext.unobserve(observer);
      },
    };

    const provider = this.providerFactory({
      url: this.collabUrl,
      name: roomName,
      token: this.token,
      document: ydoc,
      relPath: safeRel,
      onSynced: ({ state }) => {
        if (!state) return;
        room.synced = true;

        if (room.pendingLocalText !== undefined) {
          const pending = room.pendingLocalText;
          room.pendingLocalText = undefined;
          const changed = applyMinimalTextToYText(ytext, pending, LOCAL_FS_ORIGIN);
          if (changed) {
            this.logger.info(`↑ 本地队列变更已同步到协同房间: ${safeRel}`);
          }
          return;
        }

        const remoteText = ytext.toString();
        const { absPath } = resolveInsideWorkspace(this.localDir, safeRel);
        if (remoteText.length > 0) {
          this.handleRemoteTextUpdate(safeRel, remoteText);
        } else if (fs.existsSync(absPath)) {
          const localText = fs.readFileSync(absPath, 'utf8');
          if (localText.length > 0) {
            applyMinimalTextToYText(ytext, localText, LOCAL_FS_ORIGIN);
            this.logger.info(`↑ 初始化远端空白协同房间: ${safeRel}`);
          }
        }
      },
      onAuthenticationFailed: ({ reason }) => {
        this.logger.error(`协同房间认证失败 (${roomName}): ${reason}`);
      },
    });

    room.provider = provider;
    if (provider.isSynced) {
      room.synced = true;
    }

    try {
      provider.setAwarenessField?.('user', {
        name: this.agentName,
        color: '#10b981',
      });
    } catch {
      // Awareness may be disabled in mock/custom providers
    }

    this.rooms.set(safeRel, room);
    return room;
  }

  /**
   * Process a local file creation/modification event (invoked by Chokidar or tests).
   */
  async handleLocalFileChange(filePath: string): Promise<LocalFileChangeOutcome> {
    const absInput = path.isAbsolute(filePath)
      ? path.resolve(filePath)
      : path.resolve(this.localDir, filePath);

    if (isIgnoredLocalPath(this.localDir, absInput)) {
      return 'ignored';
    }

    const rawRel = path.relative(this.localDir, absInput);
    let safeRel: string;
    let absPath: string;
    try {
      const resolved = resolveInsideWorkspace(this.localDir, rawRel);
      safeRel = resolved.relPath;
      absPath = resolved.absPath;
    } catch (err) {
      this.logger.warn(
        `忽略不安全的本地路径 "${rawRel}": ${err instanceof Error ? err.message : String(err)}`,
      );
      return 'ignored';
    }

    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(absPath);
    } catch {
      return 'ignored';
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return 'ignored';
    }

    if (isTrackedTextFile(safeRel)) {
      const content = fs.readFileSync(absPath, 'utf8');
      if (this.antiLoop.shouldSuppress(safeRel, content)) {
        return 'suppressed';
      }

      const room = this.openTextRoom(safeRel);
      if (room.synced) {
        const applied = applyMinimalTextToYText(room.ytext, content, LOCAL_FS_ORIGIN);
        if (applied) {
          this.logger.info(`↑ 本地最小补丁已推送: ${safeRel}`);
        }
        return 'synced-text';
      }

      room.pendingLocalText = content;
      return 'queued-text';
    }

    const buf = fs.readFileSync(absPath);
    if (this.antiLoop.shouldSuppress(safeRel, buf)) {
      return 'suppressed';
    }

    await this.pushBinaryFile(safeRel, buf);
    this.logger.info(`↑ 二进制资源已上传: ${safeRel} (${buf.byteLength} B)`);
    return 'uploaded-binary';
  }

  private async syncNewRemoteFilesFromPoll(): Promise<void> {
    try {
      const remoteEntries = await this.fetchRemoteFileList();
      for (const entry of remoteEntries) {
        if (!entry || entry.kind === 'dir' || typeof entry.path !== 'string') continue;

        let safeRel: string;
        let absPath: string;
        try {
          const resolved = resolveInsideWorkspace(this.localDir, entry.path);
          safeRel = resolved.relPath;
          absPath = resolved.absPath;
        } catch {
          continue;
        }

        if (isTrackedTextFile(safeRel)) {
          if (!this.rooms.has(safeRel)) {
            if (!fs.existsSync(absPath)) {
              const data =
                typeof entry.content === 'string'
                  ? { content: entry.content }
                  : await this.fetchSingleRemoteFile(safeRel, false);
              if (data.content !== undefined) {
                this.writeTextWithAntiLoop(safeRel, absPath, data.content);
              }
            }
            this.openTextRoom(safeRel);
            this.logger.info(`+ 发现远端新增文本文件并接入协同: ${safeRel}`);
          }
        } else if (!fs.existsSync(absPath)) {
          const data =
            typeof entry.base64 === 'string'
              ? { base64: entry.base64 }
              : await this.fetchSingleRemoteFile(safeRel, true);
          if (data.base64 !== undefined) {
            this.writeBinaryWithAntiLoop(safeRel, absPath, Buffer.from(data.base64, 'base64'));
            this.logger.info(`+ 发现远端新增资源并下载: ${safeRel}`);
          }
        }
      }
    } catch (err) {
      this.logger.warn(
        `轮询远端文件列表失败: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Start bidirectional synchronization:
   * 1. Pull all safe files from remote (and push local files missing on remote).
   * 2. Open Hocuspocus Yjs rooms for all tracked text files.
   * 3. Start Chokidar filesystem watcher for live local -> remote syncing.
   */
  async start(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;

    fs.mkdirSync(this.localDir, { recursive: true });

    const pullResult = await this.pullAll();
    const downloadedSet = new Set(pullResult.downloaded);
    this.logger.info(
      `初始拉取完成：下载 ${pullResult.downloaded.length} 个文件，拦截 ${pullResult.skipped.length} 个不安全条目`,
    );

    // Push any local files missing from the remote project
    const localFiles = walkSafeLocalFiles(this.localDir);
    for (const relPath of localFiles) {
      if (downloadedSet.has(relPath)) continue;
      const { absPath } = resolveInsideWorkspace(this.localDir, relPath);
      try {
        if (isTrackedTextFile(relPath)) {
          const text = fs.readFileSync(absPath, 'utf8');
          await this.pushTextFile(relPath, text);
          this.logger.info(`↑ 推送本地新增文本文件到远端: ${relPath}`);
        } else {
          const buf = fs.readFileSync(absPath);
          await this.pushBinaryFile(relPath, buf);
          this.logger.info(`↑ 推送本地新增资源到远端: ${relPath}`);
        }
      } catch (err) {
        this.logger.warn(
          `推送本地文件失败 (${relPath}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Open Hocuspocus rooms for all tracked text files
    const allTrackedTextFiles = new Set<string>([
      ...pullResult.downloaded.filter(isTrackedTextFile),
      ...localFiles.filter(isTrackedTextFile),
    ]);
    for (const relPath of allTrackedTextFiles) {
      this.openTextRoom(relPath);
    }

    // Start Chokidar watcher
    const watcher = chokidar.watch(this.localDir, {
      ignoreInitial: true,
      awaitWriteFinish: this.awaitWriteFinish,
      ignored: (targetPath) => isIgnoredLocalPath(this.localDir, targetPath),
    });

    const onFsEvent = (changedPath: string) => {
      void this.handleLocalFileChange(changedPath).catch((err) => {
        this.logger.error(
          `处理本地文件变更失败 (${changedPath}): ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    };

    watcher.on('add', onFsEvent);
    watcher.on('change', onFsEvent);
    watcher.on('error', (err) => {
      this.logger.error(`文件监听异常: ${err instanceof Error ? err.message : String(err)}`);
    });

    this.watcher = watcher;

    if (this.pollIntervalMs > 0) {
      this.pollTimer = setInterval(() => {
        void this.syncNewRemoteFilesFromPoll();
      }, this.pollIntervalMs);
    }

    this.logger.info(
      `双向实时同步已启动 (项目: ${this.projectId}, 目录: ${this.localDir}, 协同身份: ${this.agentName})`,
    );
  }

  /**
   * Cleanly close Chokidar watcher, stop polling timers, and destroy all Hocuspocus providers and Yjs documents.
   */
  async stop(): Promise<void> {
    this.running = false;

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    if (this.watcher) {
      const currentWatcher = this.watcher;
      this.watcher = null;
      await currentWatcher.close();
    }

    for (const room of this.rooms.values()) {
      try {
        room.disposeObserver();
      } catch {
        // ignore observer cleanup errors
      }
      try {
        room.provider.destroy();
      } catch {
        // ignore provider destroy errors
      }
      try {
        room.ydoc.destroy();
      } catch {
        // ignore ydoc destroy errors
      }
    }

    this.rooms.clear();
    this.antiLoop.clear();
  }
}
