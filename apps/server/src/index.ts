import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNovaTeXServer } from './app.js';

export { createNovaTeXServer, type NovaTeXServerInstance } from './app.js';
export {
  loadServerConfig,
  parseDotEnvContent,
  type NovaTeXServerConfig,
  type NovaTeXServerOptions,
} from './config.js';
export { NovaTeXDatabase, hashPassword, verifyPassword } from './db.js';
export { createCollabHub, parseDocumentName, type CollabHub, type CollabContext } from './collab.js';
export {
  CompileCoordinator,
  streamPdfWithRanges,
  type CompileCoordinatorOptions,
} from './compile-coordinator.js';
export {
  GitOperationError,
  isValidGitRef,
  initProjectRepo,
  commitAll,
  getLog,
  getDiff,
  restoreCommit,
  type GitRestoreResult,
} from './git.js';
export {
  getProjectPaths,
  ensureProjectDirs,
  removeProjectDirs,
  createStarterProjectFiles,
  listProjectFiles,
  importProjectZip,
  exportProjectZip,
  extractBibKeysAndLabels,
  type ProjectPaths,
  type ImportZipResult,
  type ExtractedBibAndLabels,
} from './workspace.js';

function isExecutedDirectly(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return path.resolve(fileURLToPath(import.meta.url)) === path.resolve(argv1);
  } catch {
    return false;
  }
}

if (isExecutedDirectly()) {
  createNovaTeXServer()
    .then(async (server) => {
      const bound = await server.start();
      console.log(
        `[novatex-server] listening on ${bound.url} (ws: ${bound.url.replace(/^http/, 'ws')}/collab, dataDir=${server.config.dataDir}, compiler=${server.config.compilerMode})`,
      );

      let shuttingDown = false;
      const shutdown = async (signal: string) => {
        if (shuttingDown) return;
        shuttingDown = true;
        console.log(`[novatex-server] received ${signal}, flushing Yjs documents and closing...`);
        try {
          await server.close();
        } finally {
          process.exit(0);
        }
      };

      process.on('SIGINT', () => {
        void shutdown('SIGINT');
      });
      process.on('SIGTERM', () => {
        void shutdown('SIGTERM');
      });
    })
    .catch((err) => {
      console.error('[novatex-server] failed to start:', err);
      process.exit(1);
    });
}
