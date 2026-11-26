import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAiConfigFromEnv } from '@novatex/ai-fixer';
import type { AiProviderConfig } from '@novatex/shared';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(THIS_DIR, '../../..');

export interface NovaTeXServerOptions {
  port?: number;
  host?: string;
  publicOrigin?: string;
  dataDir?: string;
  sessionSecret?: string;
  allowPublicRegister?: boolean;
  /** Feature gate: enable multi-user collaboration UI (Share/Comments/Presence). Defaults to false (local-first solo/AI mode). */
  enableCollab?: boolean;
  adminUsername?: string;
  adminPassword?: string;
  compilerMode?: 'local' | 'remote';
  compilerUrl?: string;
  compilerSharedSecret?: string;
  compileTimeoutMs?: number;
  compileMaxConcurrency?: number;
  texBinDir?: string;
  pandocBin?: string;
  qpdfBin?: string;
  allowLuaLatex?: boolean;
  webDistDir?: string;
  /** Whether to load `.env` from cwd/repo root (default true). Never overrides explicit process.env or options. */
  loadDotEnv?: boolean;
  /** Optional debounce ms for Hocuspocus onStoreDocument (default 400). */
  collabDebounceMs?: number;
  /** Optional maxDebounce ms for Hocuspocus onStoreDocument (default 2000). */
  collabMaxDebounceMs?: number;
  /** Optional rate limit override for auth endpoints (defaults: 20 attempts per 5 minutes). */
  authRateLimitMax?: number;
  authRateLimitWindowMs?: number;
  disableRateLimit?: boolean;
  /** Optional fetch implementation injected into AI fixer (useful for tests). */
  aiFetchImpl?: typeof fetch;
}

export interface NovaTeXServerConfig {
  port: number;
  host: string;
  publicOrigin: string;
  dataDir: string;
  sessionSecret: string;
  allowPublicRegister: boolean;
  enableCollab: boolean;
  adminUsername?: string;
  adminPassword?: string;
  compilerMode: 'local' | 'remote';
  compilerUrl: string;
  compilerSharedSecret: string;
  compileTimeoutMs: number;
  compileMaxConcurrency: number;
  texBinDir?: string;
  pandocBin?: string;
  qpdfBin?: string;
  allowLuaLatex: boolean;
  webDistDir: string;
  envAiConfig: Partial<AiProviderConfig>;
  collabDebounceMs: number;
  collabMaxDebounceMs: number;
  authRateLimitMax: number;
  authRateLimitWindowMs: number;
  disableRateLimit: boolean;
  aiFetchImpl?: typeof fetch;
}

/**
 * Zero-dependency `.env` parser supporting comments, optional `export` prefix,
 * and single/double-quoted values with standard escape sequences.
 */
export function parseDotEnvContent(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const line = trimmed.startsWith('export ') ? trimmed.slice('export '.length).trim() : trimmed;
    const eqIdx = line.indexOf('=');
    if (eqIdx <= 0) {
      continue;
    }

    const key = line.slice(0, eqIdx).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      continue;
    }

    let val = line.slice(eqIdx + 1).trim();
    if (val.length >= 2 && val.startsWith('"') && val.endsWith('"')) {
      val = val
        .slice(1, -1)
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\');
    } else if (val.length >= 2 && val.startsWith("'") && val.endsWith("'")) {
      val = val.slice(1, -1);
    } else {
      // Strip trailing inline comment preceded by whitespace
      const hashIdx = val.search(/\s+#/);
      if (hashIdx >= 0) {
        val = val.slice(0, hashIdx).trim();
      }
    }

    result[key] = val;
  }

  return result;
}

function loadDotEnvFiles(): Record<string, string> {
  const candidates = Array.from(
    new Set([path.join(REPO_ROOT, '.env'), path.join(process.cwd(), '.env')]),
  );
  const merged: Record<string, string> = {};
  for (const envPath of candidates) {
    try {
      if (fs.existsSync(envPath) && fs.statSync(envPath).isFile()) {
        const parsed = parseDotEnvContent(fs.readFileSync(envPath, 'utf8'));
        Object.assign(merged, parsed);
      }
    } catch {
      // Ignore unreadable optional .env file
    }
  }
  return merged;
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  const lower = raw.trim().toLowerCase();
  if (lower === 'true' || lower === '1' || lower === 'yes' || lower === 'on') return true;
  if (lower === 'false' || lower === '0' || lower === 'no' || lower === 'off') return false;
  return fallback;
}

function parseNonNegativeInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function ensurePersistentSessionSecret(dataDir: string): string {
  fs.mkdirSync(dataDir, { recursive: true });
  const secretPath = path.join(dataDir, '.session-secret');
  try {
    if (fs.existsSync(secretPath)) {
      const existing = fs.readFileSync(secretPath, 'utf8').trim();
      if (existing.length >= 32) {
        return existing;
      }
    }
  } catch {
    // Fall through to regenerate
  }

  const secret = crypto.randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(secretPath, `${secret}\n`, { encoding: 'utf8', mode: 0o600 });
    try {
      fs.chmodSync(secretPath, 0o600);
    } catch {
      // chmod may be a no-op on Windows
    }
  } catch {
    // If writing secret file fails, still keep in-memory secret
  }
  return secret;
}

/**
 * Load server configuration with precedence:
 *   explicit `options` > `process.env` > `.env` file > safe defaults.
 */
export function loadServerConfig(options: NovaTeXServerOptions = {}): NovaTeXServerConfig {
  const dotEnv = options.loadDotEnv === false ? {} : loadDotEnvFiles();
  const mergedEnv: Record<string, string | undefined> = { ...dotEnv };
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) {
      mergedEnv[k] = v;
    }
  }

  const readEnv = (key: string): string | undefined => {
    const val = mergedEnv[key];
    return typeof val === 'string' && val.trim().length > 0 ? val.trim() : undefined;
  };

  const port =
    typeof options.port === 'number' && Number.isFinite(options.port) && options.port >= 0
      ? Math.trunc(options.port)
      : parseNonNegativeInt(readEnv('PORT'), 3456);

  const host = options.host?.trim() || readEnv('HOST') || '127.0.0.1';
  const publicOrigin =
    options.publicOrigin?.trim() || readEnv('PUBLIC_ORIGIN') || `http://${host}:${port}`;

  const rawDataDir = options.dataDir?.trim() || readEnv('DATA_DIR') || './.local-data';
  const dataDir = path.isAbsolute(rawDataDir)
    ? path.resolve(rawDataDir)
    : path.resolve(REPO_ROOT, rawDataDir);

  fs.mkdirSync(dataDir, { recursive: true });

  const explicitSecret = options.sessionSecret?.trim() || readEnv('SESSION_SECRET');
  const sessionSecret = explicitSecret || ensurePersistentSessionSecret(dataDir);

  const allowPublicRegister =
    typeof options.allowPublicRegister === 'boolean'
      ? options.allowPublicRegister
      : parseBool(readEnv('ALLOW_PUBLIC_REGISTER'), false);

  const enableCollab =
    typeof options.enableCollab === 'boolean'
      ? options.enableCollab
      : parseBool(readEnv('ENABLE_COLLAB'), false);

  const adminUsername = options.adminUsername?.trim() || readEnv('ADMIN_USERNAME');
  const adminPassword = options.adminPassword?.trim() || readEnv('ADMIN_PASSWORD');

  const rawCompilerMode = (options.compilerMode || readEnv('COMPILER_MODE') || 'local').toLowerCase();
  const compilerMode: 'local' | 'remote' = rawCompilerMode === 'remote' ? 'remote' : 'local';
  const compilerUrl =
    options.compilerUrl?.trim() || readEnv('COMPILER_URL') || 'http://127.0.0.1:3457';
  const compilerSharedSecret =
    options.compilerSharedSecret?.trim() || readEnv('COMPILER_SHARED_SECRET') || '';

  const compileTimeoutMs =
    typeof options.compileTimeoutMs === 'number' && options.compileTimeoutMs > 0
      ? Math.trunc(options.compileTimeoutMs)
      : parsePositiveInt(readEnv('COMPILE_TIMEOUT_MS'), 60_000);

  const compileMaxConcurrency =
    typeof options.compileMaxConcurrency === 'number' && options.compileMaxConcurrency > 0
      ? Math.trunc(options.compileMaxConcurrency)
      : parsePositiveInt(readEnv('COMPILE_MAX_CONCURRENCY'), 1);

  const texBinDir = options.texBinDir?.trim() || readEnv('TEX_BIN_DIR');
  const pandocBin = options.pandocBin?.trim() || readEnv('PANDOC_BIN');
  const qpdfBin = options.qpdfBin?.trim() || readEnv('QPDF_BIN');
  const allowLuaLatex =
    typeof options.allowLuaLatex === 'boolean'
      ? options.allowLuaLatex
      : parseBool(readEnv('ALLOW_LUALATEX'), false);

  const webDistDir = options.webDistDir
    ? path.resolve(options.webDistDir)
    : path.resolve(REPO_ROOT, 'apps/web/dist');

  const envAiConfig = readAiConfigFromEnv(mergedEnv);

  const collabDebounceMs =
    typeof options.collabDebounceMs === 'number' && options.collabDebounceMs >= 0
      ? Math.trunc(options.collabDebounceMs)
      : 400;
  const collabMaxDebounceMs =
    typeof options.collabMaxDebounceMs === 'number' && options.collabMaxDebounceMs >= 0
      ? Math.trunc(options.collabMaxDebounceMs)
      : 2000;

  const authRateLimitMax =
    typeof options.authRateLimitMax === 'number' && options.authRateLimitMax > 0
      ? Math.trunc(options.authRateLimitMax)
      : 20;
  const authRateLimitWindowMs =
    typeof options.authRateLimitWindowMs === 'number' && options.authRateLimitWindowMs > 0
      ? Math.trunc(options.authRateLimitWindowMs)
      : 5 * 60 * 1000;
  const disableRateLimit = Boolean(options.disableRateLimit);

  return {
    port,
    host,
    publicOrigin,
    dataDir,
    sessionSecret,
    allowPublicRegister,
    enableCollab,
    adminUsername,
    adminPassword,
    compilerMode,
    compilerUrl,
    compilerSharedSecret,
    compileTimeoutMs,
    compileMaxConcurrency,
    texBinDir,
    pandocBin,
    qpdfBin,
    allowLuaLatex,
    webDistDir,
    envAiConfig,
    collabDebounceMs,
    collabMaxDebounceMs,
    authRateLimitMax,
    authRateLimitWindowMs,
    disableRateLimit,
    aiFetchImpl: options.aiFetchImpl,
  };
}
