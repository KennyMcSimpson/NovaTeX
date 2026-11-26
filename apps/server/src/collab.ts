import crypto from 'node:crypto';
import fs from 'node:fs';
import type { IncomingMessage } from 'node:http';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import crossws from 'crossws/adapters/node';
import { Hocuspocus, type Document as HocuspocusDocument } from '@hocuspocus/server';
import * as Y from 'yjs';
import {
  computeMinimalTextSplice,
  isBinaryFilePath,
  normalizeProjectRelPath,
  resolveInsideWorkspace,
  type ProjectMemberRole,
} from '@novatex/shared';
import type { NovaTeXDatabase } from './db.js';
import { getProjectPaths } from './workspace.js';

export interface CollabContext {
  userId: string;
  username: string;
  role: ProjectMemberRole;
  projectId: string;
  relPath: string;
}

export interface ParsedDocName {
  projectId: string;
  relPath: string;
}

export function parseDocumentName(documentName: string): ParsedDocName {
  const sepIdx = documentName.indexOf('::');
  if (sepIdx <= 0 || sepIdx >= documentName.length - 2) {
    throw new Error(`非法的协同文档标识: ${documentName}`);
  }
  const projectId = documentName.slice(0, sepIdx).trim();
  const rawRelPath = documentName.slice(sepIdx + 2);
  if (!/^[A-Za-z0-9_-]+$/.test(projectId)) {
    throw new Error(`非法的项目 ID: ${projectId}`);
  }
  const relPath = normalizeProjectRelPath(rawRelPath);
  if (isBinaryFilePath(relPath)) {
    throw new Error(`二进制文件不支持文本协同编辑: ${relPath}`);
  }
  return { projectId, relPath };
}

function sha256Buffer(data: Buffer | string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function writeTextIfChanged(absPath: string, nextContent: string): void {
  const nextBuf = Buffer.from(nextContent, 'utf8');
  if (fs.existsSync(absPath)) {
    try {
      const existingBuf = fs.readFileSync(absPath);
      if (
        existingBuf.byteLength === nextBuf.byteLength &&
        sha256Buffer(existingBuf) === sha256Buffer(nextBuf)
      ) {
        return;
      }
    } catch {
      // fall through to overwrite
    }
  }
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, nextBuf);
}

export interface CollabHub {
  hocuspocus: Hocuspocus;
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
  getLiveTextIfLoaded(projectId: string, relPath: string): string | null;
  patchLiveDocument(projectId: string, relPath: string, nextContent: string): Promise<void>;
  flushProjectDocumentsToDisk(projectId: string): Promise<void>;
  flushPathOrDirToDisk(projectId: string, relPath: string): Promise<void>;
  renameLiveDocument(projectId: string, fromRel: string, toRel: string): Promise<void>;
  deleteLiveDocument(projectId: string, relPath: string): Promise<void>;
  closeProjectConnections(projectId: string): void;
  close(): Promise<void>;
}

export function createCollabHub(opts: {
  db: NovaTeXDatabase;
  dataDir: string;
  debounceMs?: number;
  maxDebounceMs?: number;
}): CollabHub {
  const { db, dataDir } = opts;
  const debounce = opts.debounceMs ?? 400;
  const maxDebounce = opts.maxDebounceMs ?? 2000;
  const suppressedDocs = new WeakSet<HocuspocusDocument>();

  const persistDocument = (documentName: string, document: HocuspocusDocument): void => {
    if (suppressedDocs.has(document)) {
      return;
    }
    let parsed: ParsedDocName;
    try {
      parsed = parseDocumentName(documentName);
    } catch {
      return;
    }

    // Do not recreate files if project was deleted
    if (!db.getProjectById(parsed.projectId)) {
      return;
    }

    const state = Y.encodeStateAsUpdate(document);
    db.saveYjsState(documentName, parsed.projectId, parsed.relPath, state);

    const { srcDir } = getProjectPaths(dataDir, parsed.projectId);
    if (!fs.existsSync(srcDir)) return;

    const { absPath } = resolveInsideWorkspace(srcDir, parsed.relPath);
    const text = document.getText('content').toString();
    writeTextIfChanged(absPath, text);
    db.touchProject(parsed.projectId);
  };

  const hocuspocus = new Hocuspocus({
    name: 'novatex-collab',
    quiet: true,
    debounce,
    maxDebounce,
    unloadImmediately: false,

    async onAuthenticate({ token, documentName, connectionConfig }) {
      const parsed = parseDocumentName(documentName);
      if (!token || typeof token !== 'string') {
        throw new Error('缺少协作认证令牌');
      }

      const user = db.verifyCollabToken(token) ?? db.verifySyncToken(token);
      if (!user) {
        throw new Error('协作认证令牌无效或已过期');
      }

      const role = db.getProjectMemberRole(parsed.projectId, user.id);
      if (!role) {
        throw new Error('无权访问此协作项目');
      }

      connectionConfig.readOnly = role === 'viewer' || role === 'commenter';

      const ctx: CollabContext = {
        userId: user.id,
        username: user.username,
        role,
        projectId: parsed.projectId,
        relPath: parsed.relPath,
      };
      return ctx;
    },

    async onLoadDocument({ documentName, document }) {
      const parsed = parseDocumentName(documentName);
      const savedState = db.getYjsState(documentName);
      if (savedState && savedState.byteLength > 0) {
        Y.applyUpdate(document, savedState);
      }

      const ytext = document.getText('content');
      if (!savedState || ytext.length === 0) {
        const { srcDir } = getProjectPaths(dataDir, parsed.projectId);
        const { absPath } = resolveInsideWorkspace(srcDir, parsed.relPath);
        if (fs.existsSync(absPath) && fs.statSync(absPath).isFile()) {
          const diskContent = fs.readFileSync(absPath, 'utf8');
          if (diskContent.length > 0 && ytext.length === 0) {
            document.transact(() => {
              ytext.insert(0, diskContent);
            });
          }
        }
      }

      return document;
    },

    async onStoreDocument({ documentName, document }) {
      persistDocument(documentName, document);
    },
  });

  const wsAdapter = crossws({
    hooks: {
      open(peer) {
        const rawWs = (peer as unknown as { websocket: unknown }).websocket;
        const rawReq = (peer as unknown as { request: Request }).request;
        const clientConnection = hocuspocus.handleConnection(
          rawWs as Parameters<Hocuspocus['handleConnection']>[0],
          rawReq,
        );
        (peer as unknown as { _hocuspocus?: ReturnType<Hocuspocus['handleConnection']> })._hocuspocus =
          clientConnection;
        (rawWs as { on?: (ev: string, cb: () => void) => void })?.on?.('pong', () => {
          clientConnection.touch();
        });
      },
      message(peer, message) {
        const conn = (
          peer as unknown as { _hocuspocus?: ReturnType<Hocuspocus['handleConnection']> }
        )._hocuspocus;
        conn?.handleMessage(message.uint8Array());
      },
      close(peer, event) {
        const conn = (
          peer as unknown as { _hocuspocus?: ReturnType<Hocuspocus['handleConnection']> }
        )._hocuspocus;
        conn?.handleClose({ code: event.code ?? 1000, reason: event.reason ?? '' });
      },
      error(peer, error) {
        console.error('[collab] WebSocket error:', peer.id, error);
      },
    },
  });

  return {
    hocuspocus,

    handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
      void wsAdapter.handleUpgrade(req, socket, head);
    },

    getLiveTextIfLoaded(projectId: string, relPath: string): string | null {
      const docName = `${projectId}::${relPath}`;
      const doc = hocuspocus.documents.get(docName);
      if (!doc) return null;
      return doc.getText('content').toString();
    },

    async patchLiveDocument(
      projectId: string,
      relPath: string,
      nextContent: string,
    ): Promise<void> {
      const safeRel = normalizeProjectRelPath(relPath);
      const { srcDir } = getProjectPaths(dataDir, projectId);
      const { absPath } = resolveInsideWorkspace(srcDir, safeRel);
      writeTextIfChanged(absPath, nextContent);

      const docName = `${projectId}::${safeRel}`;
      const loadedDoc = hocuspocus.documents.get(docName);

      if (loadedDoc) {
        const ytext = loadedDoc.getText('content');
        const current = ytext.toString();
        const splice = computeMinimalTextSplice(current, nextContent);
        if (splice) {
          loadedDoc.transact(() => {
            if (splice.deleteCount > 0) {
              ytext.delete(splice.index, splice.deleteCount);
            }
            if (splice.insertText.length > 0) {
              ytext.insert(splice.index, splice.insertText);
            }
          });
        }
        db.saveYjsState(docName, projectId, safeRel, Y.encodeStateAsUpdate(loadedDoc));
        return;
      }

      // If an offline Yjs snapshot already exists in SQLite, splice it too so reopening doesn't revert disk writes
      const existingState = db.getYjsState(docName);
      if (existingState && existingState.byteLength > 0) {
        const tempDoc = new Y.Doc();
        try {
          Y.applyUpdate(tempDoc, existingState);
          const ytext = tempDoc.getText('content');
          const splice = computeMinimalTextSplice(ytext.toString(), nextContent);
          if (splice) {
            tempDoc.transact(() => {
              if (splice.deleteCount > 0) {
                ytext.delete(splice.index, splice.deleteCount);
              }
              if (splice.insertText.length > 0) {
                ytext.insert(splice.index, splice.insertText);
              }
            });
            db.saveYjsState(docName, projectId, safeRel, Y.encodeStateAsUpdate(tempDoc));
          }
        } finally {
          tempDoc.destroy();
        }
      }
    },

    async flushProjectDocumentsToDisk(projectId: string): Promise<void> {
      const prefix = `${projectId}::`;
      for (const [docName, doc] of hocuspocus.documents.entries()) {
        if (docName.startsWith(prefix)) {
          persistDocument(docName, doc);
        }
      }
    },

    async flushPathOrDirToDisk(projectId: string, relPath: string): Promise<void> {
      const exactDoc = `${projectId}::${relPath}`;
      const dirPrefix = `${projectId}::${relPath}/`;
      for (const [docName, doc] of hocuspocus.documents.entries()) {
        if (docName === exactDoc || docName.startsWith(dirPrefix)) {
          persistDocument(docName, doc);
        }
      }
    },

    async renameLiveDocument(projectId: string, fromRel: string, toRel: string): Promise<void> {
      const exactDoc = `${projectId}::${fromRel}`;
      const dirPrefix = `${projectId}::${fromRel}/`;
      for (const [docName, doc] of Array.from(hocuspocus.documents.entries())) {
        if (docName === exactDoc || docName.startsWith(dirPrefix)) {
          // Suppress any async disconnect/debounce onStoreDocument callbacks for this moved doc instance
          suppressedDocs.add(doc);
          // Save Yjs binary state only (do NOT recreate old path on disk; caller already renamed on FS)
          const oldRel = docName.slice(`${projectId}::`.length);
          db.saveYjsState(docName, projectId, oldRel, Y.encodeStateAsUpdate(doc));
          hocuspocus.closeConnections(docName);
          await hocuspocus.unloadDocument(doc);
        }
      }
      db.renameYjsStates(projectId, fromRel, toRel);
    },

    async deleteLiveDocument(projectId: string, relPath: string): Promise<void> {
      const exactDoc = `${projectId}::${relPath}`;
      const dirPrefix = `${projectId}::${relPath}/`;
      for (const [docName, doc] of Array.from(hocuspocus.documents.entries())) {
        if (docName === exactDoc || docName.startsWith(dirPrefix)) {
          // Suppress any async disconnect/debounce onStoreDocument callbacks so deleted file never resurrects
          suppressedDocs.add(doc);
          hocuspocus.closeConnections(docName);
          await hocuspocus.unloadDocument(doc);
        }
      }
      db.deleteYjsStatesForPathOrDir(projectId, relPath);
    },

    closeProjectConnections(projectId: string): void {
      const prefix = `${projectId}::`;
      for (const [docName, doc] of Array.from(hocuspocus.documents.entries())) {
        if (docName.startsWith(prefix)) {
          suppressedDocs.add(doc);
          hocuspocus.closeConnections(docName);
        }
      }
    },

    async close(): Promise<void> {
      for (const [docName, doc] of hocuspocus.documents.entries()) {
        try {
          persistDocument(docName, doc);
        } catch {
          // best effort
        }
      }
      try {
        hocuspocus.flushPendingStores();
      } catch {
        // ignore
      }
      try {
        hocuspocus.closeConnections();
      } catch {
        // ignore
      }
      try {
        wsAdapter.closeAll(1001, 'Server shutting down', true);
      } catch {
        // ignore
      }
    },
  };
}
