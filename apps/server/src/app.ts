import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import express, {
  type Express,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';
import type { Hocuspocus } from '@hocuspocus/server';
import {
  AiConfigError,
  AiFixerError,
  DEFAULT_DEEPSEEK_BASE_URL,
  fixLatexWithAi,
  listAiModels,
  normalizeOpenAiBaseUrl,
  resolveAiConfig,
  sanitizeAiConfig,
  testAiConnection,
  type AiConfigInput,
} from '@novatex/ai-fixer';
import { FormatHub } from '@novatex/format-hub';
import {
  PathSecurityError,
  isBinaryFilePath,
  normalizeProjectRelPath,
  resolveInsideWorkspace,
  type AcademicTemplateId,
  type AiConfigOverview,
  type AiConfigScope,
  type AiFixRequest,
  type AiProviderConfig,
  type CompileEngine,
  type ConvertOptions,
  type ConvertOutputArtifact,
  type FormatLayer,
  type MdCompileResponse,
  type ProjectMemberRole,
  type SectionMergePreview,
  type SystemCapabilities,
  type UserPublic,
} from '@novatex/shared';
import { createCollabHub, type CollabHub } from './collab.js';
import { CompileCoordinator, streamPdfWithRanges } from './compile-coordinator.js';
import {
  loadServerConfig,
  type NovaTeXServerConfig,
  type NovaTeXServerOptions,
} from './config.js';
import { NovaTeXDatabase } from './db.js';
import {
  GitOperationError,
  commitAll,
  getDiff,
  getLog,
  initProjectRepo,
  restoreCommit,
} from './git.js';
import {
  createStarterProjectFiles,
  ensureProjectDirs,
  exportProjectZip,
  extractBibKeysAndLabels,
  getProjectPaths,
  importProjectZip,
  isLikelyBinaryFile,
  listProjectFiles,
  removeProjectDirs,
} from './workspace.js';

const SESSION_COOKIE_NAME = 'novatex_session';
const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
const MAX_SINGLE_FILE_BYTES = 25 * 1024 * 1024;
const MIN_PASSWORD_LENGTH = 6;
const MAX_PASSWORD_LENGTH = 128;
const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const VALID_ENGINES = new Set<CompileEngine>(['xelatex', 'pdflatex', 'lualatex']);
const VALID_TEMPLATES = new Set<AcademicTemplateId>([
  'lab-report-en',
  'lab-report-zh',
  'tech-report',
  'beamer-slides',
  'chinese-ctex',
  'ieee-conf',
  'clean-article',
]);
const VALID_INVITE_ROLES = new Set<Exclude<ProjectMemberRole, 'owner'>>([
  'editor',
  'commenter',
  'viewer',
]);
const VALID_FORMAT_LAYERS = new Set<FormatLayer>(['md', 'docx', 'txt', 'tex', 'pdf']);
const USERNAME_RE = /^[a-zA-Z0-9._-]{2,32}$/;

interface AuthedRequest extends Request {
  user?: UserPublic;
  sessionToken?: string;
  sessionId?: string;
  authMethod?: 'cookie' | 'sync-token';
}

class HttpError extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

export interface NovaTeXServerInstance {
  app: Express;
  httpServer: http.Server;
  hocuspocus: Hocuspocus;
  db: NovaTeXDatabase;
  config: NovaTeXServerConfig;
  collab: CollabHub;
  start(): Promise<{ host: string; port: number; url: string }>;
  close(): Promise<void>;
}

function asyncHandler(
  fn: (req: AuthedRequest, res: Response, next: NextFunction) => Promise<void> | void,
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req as AuthedRequest, res, next)).catch(next);
  };
}

function paramStr(value: string | string[] | undefined): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.length > 0) return value[0] ?? '';
  return '';
}

function queryStr(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return '';
}

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!cookieHeader) return out;
  for (const part of cookieHeader.split(';')) {
    const eqIdx = part.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = part.slice(0, eqIdx).trim();
    const rawVal = part.slice(eqIdx + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(rawVal);
    } catch {
      out[key] = rawVal;
    }
  }
  return out;
}

function isHttpsRequest(req: Request): boolean {
  if (req.secure) return true;
  const proto = req.headers['x-forwarded-proto'];
  if (typeof proto === 'string' && proto.split(',')[0]?.trim().toLowerCase() === 'https') {
    return true;
  }
  return false;
}

function setSessionCookie(req: Request, res: Response, token: string): void {
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${SESSION_MAX_AGE_SECONDS}`,
  ];
  if (isHttpsRequest(req)) {
    parts.push('Secure');
  }
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(req: Request, res: Response): void {
  const parts = [
    `${SESSION_COOKIE_NAME}=`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    'Max-Age=0',
  ];
  if (isHttpsRequest(req)) {
    parts.push('Secure');
  }
  res.setHeader('Set-Cookie', parts.join('; '));
}

function canEdit(role: ProjectMemberRole): boolean {
  return role === 'owner' || role === 'editor';
}

function canComment(role: ProjectMemberRole): boolean {
  return role === 'owner' || role === 'editor' || role === 'commenter';
}

function detectFormatFromFileName(fileName: string): FormatLayer {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'md';
  if (lower.endsWith('.docx')) return 'docx';
  if (lower.endsWith('.txt')) return 'txt';
  if (lower.endsWith('.pdf')) return 'pdf';
  return 'tex';
}

function decodeBase64Strict(raw: string, maxBytes: number): Buffer {
  const cleaned = raw.replace(/\s+/g, '');
  if (!cleaned) return Buffer.alloc(0);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned) || cleaned.length % 4 !== 0) {
    throw new HttpError(400, '无效的 base64 编码数据', 'INVALID_BASE64');
  }
  const estimatedBytes = Math.floor((cleaned.length * 3) / 4);
  if (estimatedBytes > maxBytes) {
    throw new HttpError(
      413,
      `文件大小超出允许上限（最大 ${Math.round(maxBytes / (1024 * 1024))} MB）`,
      'FILE_TOO_LARGE',
    );
  }
  const buf = Buffer.from(cleaned, 'base64');
  if (buf.byteLength > maxBytes) {
    throw new HttpError(
      413,
      `文件大小超出允许上限（最大 ${Math.round(maxBytes / (1024 * 1024))} MB）`,
      'FILE_TOO_LARGE',
    );
  }
  return buf;
}

function extractOriginSafe(urlStr: string): string | null {
  const trimmed = urlStr.trim();
  if (!trimmed) return null;
  try {
    return new URL(
      normalizeOpenAiBaseUrl(trimmed, { allowPrivateNetwork: true }),
    ).origin.toLowerCase();
  } catch {
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        return parsed.origin.toLowerCase();
      }
      return null;
    } catch {
      return null;
    }
  }
}

export async function createNovaTeXServer(
  options: NovaTeXServerOptions = {},
): Promise<NovaTeXServerInstance> {
  const config = loadServerConfig(options);
  const dbPath = path.join(config.dataDir, 'novatex.db');
  const db = new NovaTeXDatabase(dbPath, config.sessionSecret);

  // Optional auto-bootstrap admin when configured via env/options on an empty database
  if (db.getUserCount() === 0 && config.adminUsername && config.adminPassword) {
    if (
      USERNAME_RE.test(config.adminUsername) &&
      config.adminPassword.length >= MIN_PASSWORD_LENGTH &&
      config.adminPassword.length <= MAX_PASSWORD_LENGTH
    ) {
      await db.createUser({
        username: config.adminUsername,
        displayName: config.adminUsername,
        password: config.adminPassword,
        role: 'admin',
      });
    }
  }

  const formatHub = new FormatHub({
    pandocBin: config.pandocBin,
    cacheDir: path.join(config.dataDir, 'cache'),
  });

  const compileCoordinator = new CompileCoordinator({
    mode: config.compilerMode,
    compilerUrl: config.compilerUrl,
    sharedSecret: config.compilerSharedSecret,
    timeoutMs: config.compileTimeoutMs,
    maxConcurrency: config.compileMaxConcurrency,
    texBinDir: config.texBinDir,
    qpdfBin: config.qpdfBin,
    allowLuaLatex: config.allowLuaLatex,
  });

  const collab = createCollabHub({
    db,
    dataDir: config.dataDir,
    debounceMs: config.collabDebounceMs,
    maxDebounceMs: config.collabMaxDebounceMs,
  });

  // In-memory sliding-window rate limiter for auth endpoints (login/register)
  const rateLimitBuckets = new Map<string, number[]>();
  const checkAuthRateLimit = (req: Request, bucketPrefix: string, usernameHint?: string): void => {
    if (config.disableRateLimit) return;
    const now = Date.now();
    const windowStart = now - config.authRateLimitWindowMs;
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const keys = [`${bucketPrefix}:ip:${ip}`];
    if (usernameHint && usernameHint.trim()) {
      keys.push(`${bucketPrefix}:user:${usernameHint.trim().toLowerCase()}`);
    }

    for (const key of keys) {
      const timestamps = (rateLimitBuckets.get(key) ?? []).filter((ts) => ts > windowStart);
      if (timestamps.length >= config.authRateLimitMax) {
        rateLimitBuckets.set(key, timestamps);
        throw new HttpError(429, '请求过于频繁，请稍后再试', 'RATE_LIMITED');
      }
      timestamps.push(now);
      rateLimitBuckets.set(key, timestamps);
    }

    // Bound memory growth for stale buckets
    if (rateLimitBuckets.size > 5000) {
      for (const [k, list] of rateLimitBuckets.entries()) {
        if (list.length === 0 || list[list.length - 1]! <= windowStart) {
          rateLimitBuckets.delete(k);
        }
      }
    }
  };

  let configuredPublicOrigin: string | null = null;
  try {
    configuredPublicOrigin = new URL(config.publicOrigin).origin;
  } catch {
    configuredPublicOrigin = null;
  }

  const isPublicRegisterAllowed = (): boolean => {
    // Strictly governed by server-side .env (ALLOW_PUBLIC_REGISTER) — never toggleable via web UI
    return config.allowPublicRegister;
  };

  const readSavedAiConfig = (): Partial<AiProviderConfig> => {
    return db.getGlobalAiConfig();
  };

  const getUserRawAiConfig = (userId: string): Partial<AiProviderConfig> => {
    return db.getUserAiConfig(userId) ?? {};
  };

  const allowPrivateAiHostsForUser = (user: UserPublic): boolean => {
    return user.role === 'admin' && process.env.ALLOW_PRIVATE_AI_HOSTS === 'true';
  };

  const getGlobalRawAiConfig = (): Partial<AiProviderConfig> => {
    const saved = readSavedAiConfig();
    const env = config.envAiConfig;
    let inheritedEnvKey = env.apiKey;
    if (!saved.apiKey && saved.baseUrl && env.apiKey) {
      const savedOrigin = extractOriginSafe(saved.baseUrl);
      const envOrigin = extractOriginSafe(env.baseUrl ?? DEFAULT_DEEPSEEK_BASE_URL);
      if (!savedOrigin || !envOrigin || savedOrigin !== envOrigin) {
        inheritedEnvKey = undefined;
      }
    }
    return {
      baseUrl: saved.baseUrl ?? env.baseUrl,
      apiKey: saved.apiKey ?? inheritedEnvKey,
      model: saved.model ?? env.model,
      reasonerModel: saved.reasonerModel ?? env.reasonerModel,
      timeoutMs: saved.timeoutMs ?? env.timeoutMs,
    };
  };

  const resolveEffectiveAiForUser = (
    userId: string,
  ): {
    raw: Partial<AiProviderConfig>;
    effectiveSource: AiConfigOverview['effectiveSource'];
  } => {
    const userCfg = db.getUserAiConfig(userId);
    if (userCfg && typeof userCfg.apiKey === 'string' && userCfg.apiKey.trim()) {
      return { raw: userCfg, effectiveSource: 'personal' };
    }

    const savedGlobal = readSavedAiConfig();
    const globalMerged = getGlobalRawAiConfig();
    if (typeof savedGlobal.apiKey === 'string' && savedGlobal.apiKey.trim()) {
      return { raw: globalMerged, effectiveSource: 'global' };
    }
    if (typeof globalMerged.apiKey === 'string' && globalMerged.apiKey.trim()) {
      return { raw: globalMerged, effectiveSource: 'env' };
    }

    return {
      raw: {
        baseUrl: userCfg?.baseUrl ?? savedGlobal.baseUrl ?? config.envAiConfig.baseUrl,
        model: userCfg?.model ?? savedGlobal.model ?? config.envAiConfig.model,
        reasonerModel:
          userCfg?.reasonerModel ?? savedGlobal.reasonerModel ?? config.envAiConfig.reasonerModel,
        timeoutMs: userCfg?.timeoutMs ?? savedGlobal.timeoutMs ?? config.envAiConfig.timeoutMs,
      },
      effectiveSource: 'none',
    };
  };

  const safeSanitizeAiConfig = (
    base?: AiConfigInput,
    override?: Partial<AiProviderConfig>,
    allowPrivateNetwork = false,
  ) => {
    try {
      return sanitizeAiConfig(resolveAiConfig(base, override, { allowPrivateNetwork }));
    } catch {
      return sanitizeAiConfig(resolveAiConfig({}));
    }
  };

  const getSafePublicAiConfig = () => {
    return safeSanitizeAiConfig(
      getGlobalRawAiConfig(),
      undefined,
      process.env.ALLOW_PRIVATE_AI_HOSTS === 'true',
    );
  };

  const buildAiConfigOverview = (user: UserPublic): AiConfigOverview => {
    const userCfg = db.getUserAiConfig(user.id);
    const savedGlobal = readSavedAiConfig();
    const effective = resolveEffectiveAiForUser(user.id);
    const allowPrivatePersonal = allowPrivateAiHostsForUser(user);
    const allowPrivateGlobal = process.env.ALLOW_PRIVATE_AI_HOSTS === 'true';
    const allowPrivateEffective =
      effective.effectiveSource === 'personal' ? allowPrivatePersonal : allowPrivateGlobal;
    return {
      config: safeSanitizeAiConfig(effective.raw, undefined, allowPrivateEffective),
      personal: safeSanitizeAiConfig(undefined, userCfg ?? {}, allowPrivatePersonal),
      global: safeSanitizeAiConfig(config.envAiConfig, savedGlobal, allowPrivateGlobal),
      effectiveSource: effective.effectiveSource,
      allowPublicRegister: isPublicRegisterAllowed(),
    };
  };

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '35mb' }));

  // Attach authenticated user from either session cookie or Bearer personal sync token
  // SECURITY: `collabToken` is NEVER accepted on HTTP REST endpoints (WebSocket `/collab` only).
  app.use((req, _res, next) => {
    const authed = req as AuthedRequest;
    const cookies = parseCookies(req.headers.cookie);
    const cookieToken = cookies[SESSION_COOKIE_NAME];
    if (cookieToken) {
      const session = db.getSessionByToken(cookieToken);
      if (session) {
        authed.user = session.user;
        authed.sessionToken = cookieToken;
        authed.sessionId = session.sessionId;
        authed.authMethod = 'cookie';
        next();
        return;
      }
    }

    const authHeader = req.headers.authorization;
    if (typeof authHeader === 'string' && authHeader.toLowerCase().startsWith('bearer ')) {
      const bearer = authHeader.slice(7).trim();
      if (bearer) {
        const user = db.verifySyncToken(bearer);
        if (user) {
          authed.user = user;
          authed.authMethod = 'sync-token';
        }
      }
    }
    next();
  });

  // CSRF Origin verification on state-changing HTTP requests authenticated via Cookie
  app.use((req, res, next) => {
    const authed = req as AuthedRequest;
    if (authed.authMethod !== 'cookie' || !STATE_CHANGING_METHODS.has(req.method.toUpperCase())) {
      next();
      return;
    }

    const rawOrigin = req.headers.origin;
    if (typeof rawOrigin === 'string' && rawOrigin.trim()) {
      const incomingOrigin = rawOrigin.trim();
      const allowedOrigins = new Set<string>();
      if (configuredPublicOrigin) {
        allowedOrigins.add(configuredPublicOrigin);
      }
      const hostHeader = req.get('host');
      if (hostHeader) {
        const proto = isHttpsRequest(req) ? 'https' : 'http';
        allowedOrigins.add(`${proto}://${hostHeader}`);
      }
      if (!allowedOrigins.has(incomingOrigin)) {
        res.status(403).json({
          error: '跨站请求被拦截（Origin 校验失败）',
          code: 'CSRF_ORIGIN_MISMATCH',
        });
        return;
      }
    }
    next();
  });

  const requireAuth = (req: AuthedRequest): UserPublic => {
    if (!req.user) {
      throw new HttpError(401, '请先登录 NovaTeX', 'UNAUTHORIZED');
    }
    return req.user;
  };

  const requireCookieAuth = (req: AuthedRequest): UserPublic => {
    const user = requireAuth(req);
    if (req.authMethod !== 'cookie') {
      throw new HttpError(403, '同步令牌仅限项目读写与协作同步使用', 'SYNC_TOKEN_FORBIDDEN');
    }
    return user;
  };

  const requireAdmin = (req: AuthedRequest): UserPublic => {
    const user = requireCookieAuth(req);
    if (user.role !== 'admin') {
      throw new HttpError(403, '仅管理员可执行此操作', 'FORBIDDEN');
    }
    return user;
  };

  const requireProjectAccess = (
    req: AuthedRequest,
    minAccess: 'read' | 'comment' | 'edit' | 'owner' = 'read',
  ): {
    user: UserPublic;
    projectId: string;
    role: ProjectMemberRole;
    srcDir: string;
    buildDir: string;
  } => {
    const user = requireAuth(req);
    const projectId = paramStr(req.params.id);
    if (!projectId) {
      throw new HttpError(400, '缺少项目 ID', 'INVALID_PROJECT_ID');
    }
    const role = db.getProjectMemberRole(projectId, user.id);
    if (!role) {
      const exists = db.getProjectById(projectId);
      if (!exists) {
        throw new HttpError(404, '项目不存在', 'PROJECT_NOT_FOUND');
      }
      throw new HttpError(403, '你不是该项目的协作成员', 'FORBIDDEN');
    }

    if (minAccess === 'comment' && !canComment(role)) {
      throw new HttpError(403, '只读预览权限无法发表或修改评论', 'FORBIDDEN');
    }
    if (minAccess === 'edit' && !canEdit(role)) {
      throw new HttpError(403, '当前角色无权修改项目内容（需要编辑者或所有者权限）', 'FORBIDDEN');
    }
    if (minAccess === 'owner' && role !== 'owner' && user.role !== 'admin') {
      throw new HttpError(403, '仅项目所有者可执行此操作', 'FORBIDDEN');
    }

    const paths = getProjectPaths(config.dataDir, projectId);
    return {
      user,
      projectId,
      role,
      srcDir: paths.srcDir,
      buildDir: paths.buildDir,
    };
  };

  // =========================================================================
  // 1. Health & System Capabilities
  // =========================================================================

  app.get(
    '/api/health',
    asyncHandler(async (_req, res) => {
      const [pandocInfo, compilerCap] = await Promise.all([
        formatHub.getPandocInfo(),
        compileCoordinator.getCapabilities(),
      ]);
      const aiPub = getSafePublicAiConfig();

      const capabilities: SystemCapabilities = {
        nodeVersion: process.version,
        pandoc: {
          available: pandocInfo.available,
          version: pandocInfo.version,
          binary: pandocInfo.binary,
        },
        compiler: compilerCap,
        ai: {
          configured: aiPub.hasApiKey,
          baseUrl: aiPub.baseUrl,
          model: aiPub.model,
          reasonerModel: aiPub.reasonerModel,
        },
        auth: {
          hasUsers: db.getUserCount() > 0,
          allowPublicRegister: isPublicRegisterAllowed(),
        },
        features: {
          collaboration: config.enableCollab,
        },
      };

      res.json({ ok: true, capabilities });
    }),
  );

  // =========================================================================
  // 2. Authentication & Tokens
  // =========================================================================

  app.get(
    '/api/auth/me',
    asyncHandler(async (req, res) => {
      const userCount = db.getUserCount();
      res.json({
        authenticated: Boolean(req.user),
        user: req.user ?? null,
        needsSetup: userCount === 0,
        allowPublicRegister: isPublicRegisterAllowed(),
      });
    }),
  );

  app.post(
    '/api/auth/setup',
    asyncHandler(async (req, res) => {
      if (db.getUserCount() > 0) {
        throw new HttpError(403, '系统已完成初始化，禁止重复创建管理员账号', 'SETUP_CLOSED');
      }

      const body = (req.body ?? {}) as Record<string, unknown>;
      const username = typeof body.username === 'string' ? body.username.trim() : '';
      const displayName =
        typeof body.displayName === 'string' && body.displayName.trim()
          ? body.displayName.trim().slice(0, 64)
          : username;
      const password = typeof body.password === 'string' ? body.password : '';

      if (!USERNAME_RE.test(username)) {
        throw new HttpError(
          400,
          '用户名仅允许 2-32 位字母、数字、点、下划线或短横线',
          'INVALID_USERNAME',
        );
      }
      if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
        throw new HttpError(
          400,
          `密码长度需在 ${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} 位之间`,
          'INVALID_PASSWORD',
        );
      }

      const user = await db.createUser({ username, displayName, password, role: 'admin' });
      const session = db.createSession(user.id);
      setSessionCookie(req, res, session.token);
      res.status(201).json({ user });
    }),
  );

  app.post(
    '/api/auth/register',
    asyncHandler(async (req, res) => {
      if (db.getUserCount() === 0) {
        throw new HttpError(403, '系统尚未初始化，请先创建管理员账号', 'NEEDS_SETUP');
      }

      const body = (req.body ?? {}) as Record<string, unknown>;
      const username = typeof body.username === 'string' ? body.username.trim() : '';
      checkAuthRateLimit(req, 'register', username);

      const displayName =
        typeof body.displayName === 'string' && body.displayName.trim()
          ? body.displayName.trim().slice(0, 64)
          : username;
      const password = typeof body.password === 'string' ? body.password : '';
      const inviteToken =
        typeof body.inviteToken === 'string' && body.inviteToken.trim()
          ? body.inviteToken.trim()
          : undefined;

      const allowPublicRegister = isPublicRegisterAllowed();
      if (!allowPublicRegister) {
        if (!inviteToken) {
          throw new HttpError(
            403,
            '当前实例已关闭公开注册，请通过项目邀请链接注册加入',
            'REGISTER_CLOSED',
          );
        }
        const check = db.validateInviteForUse(inviteToken);
        if (!check.ok) {
          throw new HttpError(403, check.error, 'INVALID_INVITE');
        }
      } else if (inviteToken) {
        const check = db.validateInviteForUse(inviteToken);
        if (!check.ok) {
          throw new HttpError(400, check.error, 'INVALID_INVITE');
        }
      }

      if (!USERNAME_RE.test(username)) {
        throw new HttpError(
          400,
          '用户名仅允许 2-32 位字母、数字、点、下划线或短横线',
          'INVALID_USERNAME',
        );
      }
      if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
        throw new HttpError(
          400,
          `密码长度需在 ${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} 位之间`,
          'INVALID_PASSWORD',
        );
      }
      if (db.getUserByUsername(username)) {
        throw new HttpError(409, `用户名「${username}」已被占用`, 'USERNAME_EXISTS');
      }

      const user = await db.createUser({ username, displayName, password, role: 'member' });
      let joinedProjectId: string | undefined;
      if (inviteToken) {
        const accepted = db.acceptInvite(inviteToken, user.id);
        if (!accepted.ok) {
          if (!allowPublicRegister) {
            db.deleteUser(user.id);
            throw new HttpError(accepted.status, accepted.error, 'INVALID_INVITE');
          }
        } else {
          joinedProjectId = accepted.projectId;
        }
      }

      const session = db.createSession(user.id);
      setSessionCookie(req, res, session.token);
      res.status(201).json({
        user,
        ...(joinedProjectId ? { projectId: joinedProjectId } : {}),
      });
    }),
  );

  app.post(
    '/api/auth/login',
    asyncHandler(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const username = typeof body.username === 'string' ? body.username.trim() : '';
      const password = typeof body.password === 'string' ? body.password : '';
      checkAuthRateLimit(req, 'login', username);

      if (!username || !password) {
        throw new HttpError(400, '请填写用户名和密码', 'INVALID_CREDENTIALS');
      }
      if (password.length > MAX_PASSWORD_LENGTH) {
        throw new HttpError(
          400,
          `密码长度不得超过 ${MAX_PASSWORD_LENGTH} 位`,
          'INVALID_PASSWORD',
        );
      }

      const user = await db.authenticateUser(username, password);
      if (!user) {
        throw new HttpError(401, '用户名或密码错误', 'INVALID_CREDENTIALS');
      }

      const session = db.createSession(user.id);
      setSessionCookie(req, res, session.token);
      res.json({ user });
    }),
  );

  app.post(
    '/api/auth/logout',
    asyncHandler(async (req, res) => {
      if (req.sessionToken) {
        db.deleteSession(req.sessionToken);
      }
      clearSessionCookie(req, res);
      res.json({ ok: true });
    }),
  );

  app.post(
    '/api/auth/change-password',
    asyncHandler(async (req, res) => {
      const user = requireCookieAuth(req);
      checkAuthRateLimit(req, 'change-password', user.username);

      const body = (req.body ?? {}) as Record<string, unknown>;
      const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : '';
      const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';

      if (!currentPassword || !newPassword) {
        throw new HttpError(400, '请填写当前密码与新密码', 'INVALID_PASSWORD');
      }
      if (currentPassword.length > MAX_PASSWORD_LENGTH) {
        throw new HttpError(
          400,
          `密码长度不得超过 ${MAX_PASSWORD_LENGTH} 位`,
          'INVALID_PASSWORD',
        );
      }
      if (newPassword.length < MIN_PASSWORD_LENGTH || newPassword.length > MAX_PASSWORD_LENGTH) {
        throw new HttpError(
          400,
          `新密码长度需在 ${MIN_PASSWORD_LENGTH}–${MAX_PASSWORD_LENGTH} 位之间`,
          'INVALID_PASSWORD',
        );
      }
      if (newPassword === currentPassword) {
        throw new HttpError(400, '新密码不能与当前密码相同', 'INVALID_PASSWORD');
      }

      const verified = await db.authenticateUser(user.username, currentPassword);
      if (!verified) {
        throw new HttpError(401, '当前密码不正确', 'INVALID_CREDENTIALS');
      }

      await db.updateUserPassword(user.id, newPassword, req.sessionId);
      res.json({ ok: true });
    }),
  );

  app.get(
    '/api/auth/collab-token',
    asyncHandler(async (req, res) => {
      const user = requireCookieAuth(req);
      if (!req.sessionId) {
        throw new HttpError(401, '会话状态无效，请重新登录', 'UNAUTHORIZED');
      }
      const token = db.createCollabToken(user.id, req.sessionId);
      res.json({ token });
    }),
  );

  app.post(
    '/api/auth/sync-token',
    asyncHandler(async (req, res) => {
      const user = requireCookieAuth(req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const label = typeof body.label === 'string' ? body.label : 'local-agent';
      const created = db.createSyncToken(user.id, label);
      res.status(201).json({
        id: created.id,
        token: created.token,
        label: created.label,
        createdAt: created.createdAt,
      });
    }),
  );

  app.get(
    '/api/auth/sync-tokens',
    asyncHandler(async (req, res) => {
      const user = requireCookieAuth(req);
      const tokens = db.listSyncTokens(user.id);
      res.json({ tokens });
    }),
  );

  app.delete(
    '/api/auth/sync-tokens/:id',
    asyncHandler(async (req, res) => {
      const user = requireCookieAuth(req);
      const tokenId = paramStr(req.params.id).trim();
      if (!tokenId) {
        throw new HttpError(400, '缺少同步令牌 ID');
      }
      const deleted = db.revokeSyncToken(user.id, tokenId);
      if (!deleted) {
        throw new HttpError(404, '同步令牌不存在或无权撤销', 'TOKEN_NOT_FOUND');
      }
      res.json({ ok: true });
    }),
  );

  // =========================================================================
  // 3. Projects, Invites & Zip Import/Export
  // =========================================================================

  app.get(
    '/api/projects',
    asyncHandler(async (req, res) => {
      const user = requireAuth(req);
      const projects = db.listProjectsForUser(user.id);
      res.json({ projects });
    }),
  );

  app.post(
    '/api/projects',
    asyncHandler(async (req, res) => {
      const user = requireAuth(req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const name = typeof body.name === 'string' ? body.name.trim().slice(0, 120) : '';
      if (!name) {
        throw new HttpError(400, '项目名称不能为空', 'INVALID_NAME');
      }

      const description =
        typeof body.description === 'string' ? body.description.trim().slice(0, 500) : '';
      const rawTemplate =
        typeof body.template === 'string' ? body.template.trim() : 'chinese-ctex';
      const template: AcademicTemplateId = VALID_TEMPLATES.has(rawTemplate as AcademicTemplateId)
        ? (rawTemplate as AcademicTemplateId)
        : 'chinese-ctex';

      const rawEngine = typeof body.engine === 'string' ? body.engine.trim() : '';
      if (rawEngine && !VALID_ENGINES.has(rawEngine as CompileEngine)) {
        throw new HttpError(400, `不支持的编译引擎: ${rawEngine}`, 'INVALID_ENGINE');
      }

      const projectId = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
      const paths = ensureProjectDirs(config.dataDir, projectId);

      try {
        const starter = createStarterProjectFiles(paths.srcDir, {
          name,
          author: user.displayName || user.username,
          template,
        });
        const engine = (rawEngine as CompileEngine) || starter.recommendedEngine;
        await initProjectRepo(
          paths.srcDir,
          user.displayName || user.username,
          `初始化项目：${name}`,
        );

        const project = db.createProject({
          id: projectId,
          name,
          description,
          mainFile: starter.mainFile,
          engine,
          ownerId: user.id,
        });
        res.status(201).json({ project });
      } catch (err) {
        removeProjectDirs(config.dataDir, projectId);
        throw err;
      }
    }),
  );

  app.post(
    '/api/projects/import-zip',
    asyncHandler(async (req, res) => {
      const user = requireAuth(req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const zipBase64 =
        typeof body.base64 === 'string' && body.base64.trim()
          ? body.base64
          : typeof body.zipBase64 === 'string'
            ? body.zipBase64
            : '';
      const fileName = typeof body.fileName === 'string' ? body.fileName.trim() : 'imported.zip';
      const name =
        typeof body.name === 'string' && body.name.trim()
          ? body.name.trim().slice(0, 120)
          : fileName.replace(/\.zip$/i, '').slice(0, 120) || 'Imported Project';

      const projectId = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
      const paths = ensureProjectDirs(config.dataDir, projectId);

      try {
        const imported = importProjectZip(zipBase64, paths.srcDir);
        await initProjectRepo(
          paths.srcDir,
          user.displayName || user.username,
          `导入压缩包项目：${name}`,
        );
        const project = db.createProject({
          id: projectId,
          name,
          description: `从 ${fileName} 导入`,
          mainFile: imported.mainFile,
          engine: imported.engine,
          ownerId: user.id,
        });
        res.status(201).json({
          project,
          importedFiles: imported.importedFiles,
          skippedFiles: imported.skippedFiles,
        });
      } catch (err) {
        removeProjectDirs(config.dataDir, projectId);
        throw err;
      }
    }),
  );

  app.get(
    '/api/projects/:id',
    asyncHandler(async (req, res) => {
      const { user, projectId } = requireProjectAccess(req, 'read');
      const detail = db.getProjectForUser(projectId, user.id);
      if (!detail) {
        throw new HttpError(404, '项目不存在', 'PROJECT_NOT_FOUND');
      }
      res.json(detail);
    }),
  );

  app.patch(
    '/api/projects/:id',
    asyncHandler(async (req, res) => {
      const { user, projectId } = requireProjectAccess(req, 'edit');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const patch: Partial<{
        name: string;
        description: string;
        mainFile: string;
        engine: CompileEngine;
      }> = {};

      if (typeof body.name === 'string') {
        const trimmed = body.name.trim().slice(0, 120);
        if (!trimmed) throw new HttpError(400, '项目名称不能为空');
        patch.name = trimmed;
      }
      if (typeof body.description === 'string') {
        patch.description = body.description.trim().slice(0, 500);
      }
      if (typeof body.mainFile === 'string') {
        patch.mainFile = normalizeProjectRelPath(body.mainFile);
      }
      if (typeof body.engine === 'string') {
        if (!VALID_ENGINES.has(body.engine as CompileEngine)) {
          throw new HttpError(400, `不支持的编译引擎: ${body.engine}`);
        }
        patch.engine = body.engine as CompileEngine;
      }

      const updated = db.updateProject(projectId, user.id, patch);
      if (!updated) {
        throw new HttpError(404, '项目不存在');
      }
      res.json({ project: updated });
    }),
  );

  app.delete(
    '/api/projects/:id',
    asyncHandler(async (req, res) => {
      const { projectId } = requireProjectAccess(req, 'owner');
      collab.closeProjectConnections(projectId);
      db.deleteProject(projectId);
      removeProjectDirs(config.dataDir, projectId);
      res.json({ ok: true });
    }),
  );

  app.get(
    '/api/projects/:id/export-zip',
    asyncHandler(async (req, res) => {
      const { user, projectId, srcDir } = requireProjectAccess(req, 'read');
      await collab.flushProjectDocumentsToDisk(projectId);
      const detail = db.getProjectForUser(projectId, user.id);
      const rawBase = (detail?.project.name || projectId).replace(/[\r\n/\\]/g, '_').trim() || projectId;
      const fullFileName = `${rawBase}.zip`;
      const asciiFileName =
        fullFileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\;]/g, '_') || `${projectId}.zip`;
      const encodedFileName = encodeURIComponent(fullFileName);
      const zipBuf = exportProjectZip(srcDir);

      res.setHeader('Content-Type', 'application/zip');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${asciiFileName}"; filename*=UTF-8''${encodedFileName}`,
      );
      res.setHeader('Content-Length', String(zipBuf.byteLength));
      res.send(zipBuf);
    }),
  );

  app.get(
    '/api/projects/:id/invites',
    asyncHandler(async (req, res) => {
      const { projectId } = requireProjectAccess(req, 'edit');
      const invites = db.listInvites(projectId);
      res.json({ invites });
    }),
  );

  app.post(
    '/api/projects/:id/invites',
    asyncHandler(async (req, res) => {
      const { user, projectId } = requireProjectAccess(req, 'edit');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const rawRole = typeof body.role === 'string' ? body.role.trim() : 'editor';
      if (!VALID_INVITE_ROLES.has(rawRole as Exclude<ProjectMemberRole, 'owner'>)) {
        throw new HttpError(400, `非法的邀请角色: ${rawRole}`);
      }
      const expiresInHours =
        typeof body.expiresInHours === 'number' ? body.expiresInHours : undefined;
      const maxUses = typeof body.maxUses === 'number' ? body.maxUses : undefined;

      const invite = db.createInvite(projectId, user.id, {
        role: rawRole as Exclude<ProjectMemberRole, 'owner'>,
        expiresInHours,
        maxUses,
      });
      res.status(201).json({ invite });
    }),
  );

  app.post(
    '/api/invites/:token/accept',
    asyncHandler(async (req, res) => {
      const user = requireAuth(req);
      const token = paramStr(req.params.token).trim();
      if (!token) {
        throw new HttpError(400, '缺少邀请令牌');
      }
      const result = db.acceptInvite(token, user.id);
      if (!result.ok) {
        throw new HttpError(result.status, result.error);
      }
      res.json({
        ok: true,
        projectId: result.projectId,
        role: result.role,
        project: result.project,
        alreadyMember: result.alreadyMember,
      });
    }),
  );

  // =========================================================================
  // 4. Files, Outline & BibTeX Keys
  // =========================================================================

  app.get(
    '/api/projects/:id/files',
    asyncHandler(async (req, res) => {
      const { projectId, srcDir } = requireProjectAccess(req, 'read');
      await collab.flushProjectDocumentsToDisk(projectId);
      const files = listProjectFiles(srcDir);
      res.json({ files });
    }),
  );

  app.get(
    '/api/projects/:id/file',
    asyncHandler(async (req, res) => {
      const { projectId, srcDir } = requireProjectAccess(req, 'read');
      const rawPath = queryStr(req.query.path);
      const { relPath, absPath } = resolveInsideWorkspace(srcDir, rawPath);

      if (!fs.existsSync(absPath)) {
        throw new HttpError(404, `文件不存在: ${relPath}`, 'FILE_NOT_FOUND');
      }
      const stat = fs.lstatSync(absPath);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new HttpError(400, `路径不是可读取的文件: ${relPath}`);
      }

      const binary = isLikelyBinaryFile(absPath, relPath);
      if (binary) {
        const buf = fs.readFileSync(absPath);
        res.json({
          path: relPath,
          base64: buf.toString('base64'),
          isBinary: true,
          size: buf.byteLength,
          mtimeMs: stat.mtimeMs,
        });
        return;
      }

      const liveText = collab.getLiveTextIfLoaded(projectId, relPath);
      const content = liveText !== null ? liveText : fs.readFileSync(absPath, 'utf8');
      res.json({
        path: relPath,
        content,
        isBinary: false,
        size: Buffer.byteLength(content, 'utf8'),
        mtimeMs: stat.mtimeMs,
      });
    }),
  );

  app.put(
    '/api/projects/:id/file',
    asyncHandler(async (req, res) => {
      const { projectId, srcDir } = requireProjectAccess(req, 'edit');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const rawPath = typeof body.path === 'string' ? body.path : '';
      const { relPath, absPath } = resolveInsideWorkspace(srcDir, rawPath);

      if (body.kind === 'dir') {
        fs.mkdirSync(absPath, { recursive: true });
        db.touchProject(projectId);
        res.json({ ok: true, path: relPath });
        return;
      }

      if (typeof body.base64 === 'string') {
        const buf = decodeBase64Strict(body.base64, MAX_SINGLE_FILE_BYTES);
        const hasNullByte = buf.subarray(0, 512).includes(0);
        const treatAsBinary = isBinaryFilePath(relPath) || body.isBinary === true || hasNullByte;
        if (!treatAsBinary) {
          const utf8Text = buf.toString('utf8');
          await collab.patchLiveDocument(projectId, relPath, utf8Text);
        } else {
          await collab.deleteLiveDocument(projectId, relPath);
          fs.mkdirSync(path.dirname(absPath), { recursive: true });
          fs.writeFileSync(absPath, buf);
        }
        db.touchProject(projectId);
        res.json({ ok: true, path: relPath });
        return;
      }

      if (isBinaryFilePath(relPath) && body.isBinary === true) {
        throw new HttpError(400, '写入二进制文件请提供 base64 字段');
      }

      const content = typeof body.content === 'string' ? body.content : '';
      if (Buffer.byteLength(content, 'utf8') > MAX_SINGLE_FILE_BYTES) {
        throw new HttpError(413, '文本文件体积超出允许上限');
      }

      await collab.patchLiveDocument(projectId, relPath, content);
      db.touchProject(projectId);
      res.json({ ok: true, path: relPath });
    }),
  );

  app.post(
    '/api/projects/:id/files/rename',
    asyncHandler(async (req, res) => {
      const { user, projectId, srcDir } = requireProjectAccess(req, 'edit');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const rawFrom =
        typeof body.fromPath === 'string'
          ? body.fromPath
          : typeof body.oldPath === 'string'
            ? body.oldPath
            : '';
      const rawTo =
        typeof body.toPath === 'string'
          ? body.toPath
          : typeof body.newPath === 'string'
            ? body.newPath
            : '';

      const from = resolveInsideWorkspace(srcDir, rawFrom);
      const to = resolveInsideWorkspace(srcDir, rawTo);

      if (to.relPath === from.relPath || to.relPath.startsWith(`${from.relPath}/`)) {
        throw new HttpError(400, '不能将目录移动到自身或其子目录中', 'INVALID_RENAME_TARGET');
      }

      if (!fs.existsSync(from.absPath)) {
        throw new HttpError(404, `源文件不存在: ${from.relPath}`);
      }
      if (fs.existsSync(to.absPath)) {
        throw new HttpError(409, `目标路径已存在: ${to.relPath}`);
      }

      // Flush pending Yjs edits for source path/dir BEFORE moving on filesystem
      await collab.flushPathOrDirToDisk(projectId, from.relPath);

      // Rename on filesystem FIRST; only mutate live Yjs state and DB metadata if FS rename succeeds!
      fs.mkdirSync(path.dirname(to.absPath), { recursive: true });
      fs.renameSync(from.absPath, to.absPath);

      await collab.renameLiveDocument(projectId, from.relPath, to.relPath);
      db.renameCommentThreadPaths(projectId, from.relPath, to.relPath);

      const detail = db.getProjectForUser(projectId, user.id);
      if (detail) {
        const curMain = detail.project.mainFile;
        if (curMain === from.relPath) {
          db.updateProject(projectId, user.id, { mainFile: to.relPath });
        } else if (curMain.startsWith(`${from.relPath}/`)) {
          db.updateProject(projectId, user.id, {
            mainFile: `${to.relPath}/${curMain.slice(from.relPath.length + 1)}`,
          });
        } else {
          db.touchProject(projectId);
        }
      } else {
        db.touchProject(projectId);
      }

      res.json({ ok: true, fromPath: from.relPath, toPath: to.relPath });
    }),
  );

  app.delete(
    '/api/projects/:id/file',
    asyncHandler(async (req, res) => {
      const { projectId, srcDir } = requireProjectAccess(req, 'edit');
      const rawPath = queryStr(req.query.path);
      const { relPath, absPath } = resolveInsideWorkspace(srcDir, rawPath);

      if (!fs.existsSync(absPath)) {
        throw new HttpError(404, `文件或目录不存在: ${relPath}`);
      }

      await collab.deleteLiveDocument(projectId, relPath);
      fs.rmSync(absPath, { recursive: true, force: true });
      db.touchProject(projectId);
      res.json({ ok: true });
    }),
  );

  app.get(
    '/api/projects/:id/outline',
    asyncHandler(async (req, res) => {
      const { user, projectId, srcDir } = requireProjectAccess(req, 'read');
      await collab.flushProjectDocumentsToDisk(projectId);
      const detail = db.getProjectForUser(projectId, user.id);
      const mainFile = detail?.project.mainFile ?? 'main.tex';

      try {
        const resolved = resolveInsideWorkspace(srcDir, mainFile);
        if (!fs.existsSync(resolved.absPath)) {
          res.json({ items: [] });
          return;
        }
        const items = formatHub.extractOutline(srcDir, resolved.relPath);
        res.json({ items });
      } catch {
        res.json({ items: [] });
      }
    }),
  );

  app.get(
    '/api/projects/:id/bib-keys',
    asyncHandler(async (req, res) => {
      const { projectId, srcDir } = requireProjectAccess(req, 'read');
      await collab.flushProjectDocumentsToDisk(projectId);
      const data = extractBibKeysAndLabels(srcDir);
      res.json(data);
    }),
  );

  // =========================================================================
  // 5. Compilation, PDF Range Streaming & SyncTeX
  // =========================================================================

  app.post(
    '/api/projects/:id/compile',
    asyncHandler(async (req, res) => {
      const { user, projectId, srcDir, buildDir } = requireProjectAccess(req, 'edit');
      const detail = db.getProjectForUser(projectId, user.id);
      if (!detail) {
        throw new HttpError(404, '项目不存在');
      }

      const body = (req.body ?? {}) as Record<string, unknown>;
      let engine: CompileEngine = detail.project.engine;
      if (typeof body.engine === 'string' && body.engine.trim()) {
        if (!VALID_ENGINES.has(body.engine.trim() as CompileEngine)) {
          throw new HttpError(400, `不支持的编译引擎: ${body.engine}`);
        }
        engine = body.engine.trim() as CompileEngine;
      }

      let mainFile = detail.project.mainFile;
      if (typeof body.mainFile === 'string' && body.mainFile.trim()) {
        mainFile = normalizeProjectRelPath(body.mainFile);
      }

      // Flush every open collaborative Yjs document for this project to disk before compiling
      await collab.flushProjectDocumentsToDisk(projectId);
      db.updateProjectCompileStatus(projectId, 'compiling');

      let result;
      try {
        result = await compileCoordinator.compile({
          projectId,
          workspaceDir: srcDir,
          buildDir,
          mainFile,
          engine,
        });
      } catch (err) {
        db.updateProjectCompileStatus(projectId, 'error');
        throw err;
      }

      db.saveCompileRun(result);
      res.json({ result });
    }),
  );

  app.get(
    '/api/projects/:id/compile/latest',
    asyncHandler(async (req, res) => {
      const { user, projectId, buildDir } = requireProjectAccess(req, 'read');
      const latest = db.getLatestCompileRun(projectId);
      if (!latest) {
        res.json({ result: null });
        return;
      }
      const detail = db.getProjectForUser(projectId, user.id);
      const mainFile = latest.mainFile || detail?.project.mainFile || 'main.tex';
      const pdfPath = compileCoordinator.findPdfPath(buildDir, mainFile);
      const synctexPath = compileCoordinator.findSyncTeXPath(buildDir, mainFile);
      res.json({
        result: {
          ...latest,
          pdfReady: Boolean(pdfPath),
          pdfSize: pdfPath ? fs.statSync(pdfPath).size : 0,
          synctexReady: Boolean(synctexPath),
        },
      });
    }),
  );

  const handlePdfStream = asyncHandler(async (req, res) => {
    const { user, projectId, buildDir } = requireProjectAccess(req, 'read');
    const detail = db.getProjectForUser(projectId, user.id);
    const latest = db.getLatestCompileRun(projectId);
    const mainFile = latest?.mainFile || detail?.project.mainFile || 'main.tex';
    const pdfPath = compileCoordinator.findPdfPath(buildDir, mainFile);
    if (!pdfPath) {
      throw new HttpError(404, '尚未生成 PDF 文件，请先编译项目', 'PDF_NOT_FOUND');
    }
    streamPdfWithRanges(req, res, pdfPath);
  });

  app.get('/api/projects/:id/pdf', handlePdfStream);
  app.head('/api/projects/:id/pdf', handlePdfStream);

  app.get(
    '/api/projects/:id/synctex/forward',
    asyncHandler(async (req, res) => {
      const { user, projectId, buildDir } = requireProjectAccess(req, 'read');
      const rawFile = queryStr(req.query.file);
      const rawLine = queryStr(req.query.line);
      if (!rawFile) {
        throw new HttpError(400, '缺少 file 参数');
      }
      const safeFile = normalizeProjectRelPath(rawFile);
      const line = Number.parseInt(rawLine, 10);
      if (!Number.isFinite(line) || line < 1) {
        throw new HttpError(400, '无效的 line 行号参数');
      }

      const detail = db.getProjectForUser(projectId, user.id);
      const latest = db.getLatestCompileRun(projectId);
      const mainFile = latest?.mainFile || detail?.project.mainFile || 'main.tex';
      const result = compileCoordinator.synctexForward(buildDir, mainFile, safeFile, line);
      res.json(result);
    }),
  );

  app.get(
    '/api/projects/:id/synctex/inverse',
    asyncHandler(async (req, res) => {
      const { user, projectId, buildDir } = requireProjectAccess(req, 'read');
      const page = Number.parseInt(queryStr(req.query.page), 10);
      const x = Number.parseFloat(queryStr(req.query.x));
      const y = Number.parseFloat(queryStr(req.query.y));
      if (!Number.isFinite(page) || page < 1 || !Number.isFinite(x) || !Number.isFinite(y)) {
        throw new HttpError(400, '无效的 SyncTeX 坐标参数 (page/x/y)');
      }

      const detail = db.getProjectForUser(projectId, user.id);
      const latest = db.getLatestCompileRun(projectId);
      const mainFile = latest?.mainFile || detail?.project.mainFile || 'main.tex';
      const result = compileCoordinator.synctexInverse(buildDir, mainFile, page, x, y);
      res.json(result);
    }),
  );

  // =========================================================================
  // 6. Per-User BYOK & Global Fallback AI Fixer
  // =========================================================================

  const resolveAiProbeConfig = (req: AuthedRequest) => {
    const user = requireCookieAuth(req);
    const allowPrivateNetwork = allowPrivateAiHostsForUser(user);
    const rawBody = (req.body ?? {}) as Record<string, unknown>;
    let scope: AiConfigScope | undefined;
    if (rawBody.scope !== undefined) {
      if (rawBody.scope === 'personal' || rawBody.scope === 'global') {
        scope = rawBody.scope;
      } else {
        throw new HttpError(400, `无效的 AI 配置作用域: ${String(rawBody.scope)}`, 'INVALID_SCOPE');
      }
    }

    const { scope: _strippedScope, ...restOverride } = rawBody;
    const override = restOverride as Partial<AiProviderConfig>;

    let baseCfg: Partial<AiProviderConfig>;
    if (scope === 'global') {
      requireAdmin(req);
      baseCfg = getGlobalRawAiConfig();
    } else if (scope === 'personal') {
      // Strictly personal config ONLY — never inherits admin's global/env apiKey
      baseCfg = getUserRawAiConfig(user.id);
    } else if (user.role === 'admin') {
      const personal = db.getUserAiConfig(user.id);
      if (personal && typeof personal.apiKey === 'string' && personal.apiKey.trim()) {
        baseCfg = personal;
      } else {
        baseCfg = getGlobalRawAiConfig();
      }
    } else {
      // Non-admin with omitted scope: strictly personal config ONLY — never inherits admin's key
      baseCfg = getUserRawAiConfig(user.id);
    }

    const resolved = resolveAiConfig(baseCfg, override, { allowPrivateNetwork });
    return { resolved, allowPrivateNetwork };
  };

  app.get(
    '/api/ai/config',
    asyncHandler(async (req, res) => {
      const user = requireCookieAuth(req);
      res.json(buildAiConfigOverview(user));
    }),
  );

  app.put(
    '/api/ai/config/me',
    asyncHandler(async (req, res) => {
      const user = requireCookieAuth(req);
      const allowPrivateNetwork = allowPrivateAiHostsForUser(user);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const existing = db.getUserAiConfig(user.id) ?? {};
      const next: Partial<AiProviderConfig> = { ...existing };

      const previousOrigin = extractOriginSafe(existing.baseUrl || DEFAULT_DEEPSEEK_BASE_URL);
      const hasExplicitBaseUrl =
        typeof body.baseUrl === 'string' && body.baseUrl.trim().length > 0;
      const hasExplicitApiKey = typeof body.apiKey === 'string' && body.apiKey.trim().length > 0;

      if (hasExplicitBaseUrl) {
        next.baseUrl = normalizeOpenAiBaseUrl(body.baseUrl as string, { allowPrivateNetwork });
      }
      if (hasExplicitApiKey) {
        next.apiKey = (body.apiKey as string).trim();
      }
      const nextOrigin = extractOriginSafe(next.baseUrl || DEFAULT_DEEPSEEK_BASE_URL);
      if (hasExplicitBaseUrl && previousOrigin !== nextOrigin && !hasExplicitApiKey) {
        delete next.apiKey;
      }

      if (typeof body.model === 'string' && body.model.trim()) {
        next.model = body.model.trim();
      }
      if (typeof body.reasonerModel === 'string' && body.reasonerModel.trim()) {
        next.reasonerModel = body.reasonerModel.trim();
      }
      if (typeof body.timeoutMs === 'number' && Number.isFinite(body.timeoutMs)) {
        next.timeoutMs = body.timeoutMs;
      }

      // Validate personal config cleanly before persisting (never merges global/env secrets)
      resolveAiConfig(undefined, next, { allowPrivateNetwork });
      db.setUserAiConfig(user.id, next);
      res.json(buildAiConfigOverview(user));
    }),
  );

  app.delete(
    '/api/ai/config/me',
    asyncHandler(async (req, res) => {
      const user = requireCookieAuth(req);
      db.deleteUserAiConfig(user.id);
      res.json({ ok: true, ...buildAiConfigOverview(user) });
    }),
  );

  app.put(
    '/api/ai/config',
    asyncHandler(async (req, res) => {
      const user = requireAdmin(req);
      const allowPrivateNetwork = allowPrivateAiHostsForUser(user);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const existing = readSavedAiConfig();
      const next: Partial<AiProviderConfig> = { ...existing };

      const previousOrigin = extractOriginSafe(existing.baseUrl || DEFAULT_DEEPSEEK_BASE_URL);
      const hasExplicitBaseUrl =
        typeof body.baseUrl === 'string' && body.baseUrl.trim().length > 0;
      const hasExplicitApiKey = typeof body.apiKey === 'string' && body.apiKey.trim().length > 0;

      if (hasExplicitBaseUrl) {
        next.baseUrl = normalizeOpenAiBaseUrl(body.baseUrl as string, { allowPrivateNetwork });
      }
      if (hasExplicitApiKey) {
        next.apiKey = (body.apiKey as string).trim();
      }
      const nextOrigin = extractOriginSafe(next.baseUrl || DEFAULT_DEEPSEEK_BASE_URL);
      if (hasExplicitBaseUrl && previousOrigin !== nextOrigin && !hasExplicitApiKey) {
        delete next.apiKey;
      }

      if (typeof body.model === 'string' && body.model.trim()) {
        next.model = body.model.trim();
      }
      if (typeof body.reasonerModel === 'string' && body.reasonerModel.trim()) {
        next.reasonerModel = body.reasonerModel.trim();
      }
      if (typeof body.timeoutMs === 'number' && Number.isFinite(body.timeoutMs)) {
        next.timeoutMs = body.timeoutMs;
      }

      // Validate merged configuration before persisting
      resolveAiConfig(config.envAiConfig, next, { allowPrivateNetwork });
      db.setGlobalAiConfig(next);
      res.json(buildAiConfigOverview(user));
    }),
  );

  app.post(
    '/api/ai/test',
    asyncHandler(async (req, res) => {
      const { resolved: effectiveInput, allowPrivateNetwork } = resolveAiProbeConfig(req);
      const testRes = await testAiConnection(effectiveInput, {
        fetchImpl: config.aiFetchImpl,
        allowPrivateNetwork,
      });
      res.json({
        ok: testRes.ok,
        latencyMs: testRes.latencyMs,
        model: effectiveInput.model,
        message: testRes.messageZh,
        ...(testRes.ok ? {} : { error: testRes.messageZh }),
      });
    }),
  );

  app.post(
    '/api/ai/models',
    asyncHandler(async (req, res) => {
      const { resolved: effectiveInput, allowPrivateNetwork } = resolveAiProbeConfig(req);
      const listRes = await listAiModels(effectiveInput, {
        fetchImpl: config.aiFetchImpl,
        allowPrivateNetwork,
      });
      res.json({
        ok: listRes.ok,
        models: listRes.models,
        normalizedBaseUrl: listRes.normalizedBaseUrl,
        latencyMs: listRes.latencyMs,
        message: listRes.messageZh,
        ...(listRes.ok ? {} : { error: listRes.messageZh }),
      });
    }),
  );

  app.post(
    '/api/projects/:id/ai/fix',
    asyncHandler(async (req, res) => {
      const { user } = requireProjectAccess(req, 'edit');
      const allowPrivateNetwork = allowPrivateAiHostsForUser(user);
      const rawPayload = (req.body ?? {}) as AiFixRequest;
      if (
        !rawPayload ||
        typeof rawPayload.sourceCode !== 'string' ||
        typeof rawPayload.filePath !== 'string'
      ) {
        throw new HttpError(400, 'AI 修复请求缺少 filePath 或 sourceCode');
      }
      normalizeProjectRelPath(rawPayload.filePath);

      const effective = resolveEffectiveAiForUser(user.id);
      // Only allow providerOverride for Cookie-authenticated admin OR user using their own personal key.
      // Never allow members on global fallback or Bearer sync-tokens to supply providerOverride.
      const allowOverride =
        req.authMethod === 'cookie' &&
        (user.role === 'admin' || effective.effectiveSource === 'personal');
      const safePayload: AiFixRequest = allowOverride
        ? rawPayload
        : { ...rawPayload, providerOverride: undefined };

      const response = await fixLatexWithAi(safePayload, effective.raw, {
        fetchImpl: config.aiFetchImpl,
        allowPrivateNetwork,
      });
      res.json(response);
    }),
  );

  // =========================================================================
  // 7. Four-Layer Academic Format Hub
  // =========================================================================

  app.post(
    '/api/projects/:id/format/export',
    asyncHandler(async (req, res) => {
      const { user, projectId, role, srcDir, buildDir } = requireProjectAccess(req, 'read');
      if (canEdit(role)) {
        await collab.flushProjectDocumentsToDisk(projectId);
      }

      const detail = db.getProjectForUser(projectId, user.id);
      if (!detail) {
        throw new HttpError(404, '项目不存在');
      }

      const body = (req.body ?? {}) as {
        sourceScope?: 'project' | 'file';
        sourceFile?: string;
        targetFormat?: FormatLayer;
        options?: ConvertOptions;
      };

      const targetFormat = body.targetFormat;
      if (!targetFormat || !VALID_FORMAT_LAYERS.has(targetFormat)) {
        throw new HttpError(400, `不支持的目标导出格式: ${String(targetFormat)}`);
      }

      const sourceScope = body.sourceScope === 'file' ? 'file' : 'project';
      const chosenSourceRel =
        sourceScope === 'file' && body.sourceFile
          ? resolveInsideWorkspace(srcDir, body.sourceFile).relPath
          : resolveInsideWorkspace(srcDir, detail.project.mainFile).relPath;

      const sourceAbs = resolveInsideWorkspace(srcDir, chosenSourceRel).absPath;
      if (!fs.existsSync(sourceAbs)) {
        throw new HttpError(404, `导出源文件不存在: ${chosenSourceRel}`);
      }

      const inputFormat = detectFormatFromFileName(chosenSourceRel);
      const convOptions: ConvertOptions = {
        ...(body.options ?? {}),
        flattenInputs:
          sourceScope === 'project' ? (body.options?.flattenInputs ?? true) : false,
      };

      // Special PDF export path:
      // - Read-only members (viewer/commenter) MUST NEVER trigger LaTeX compilation; they may only download existing PDF.
      // - Editors/owners compiling non-main files or MD/TXT/DOCX compile in an isolated temp dir (never clobbering _build/main.pdf).
      if (targetFormat === 'pdf') {
        if (inputFormat === 'pdf') {
          const buf = fs.readFileSync(sourceAbs);
          const artifact: ConvertOutputArtifact = {
            format: 'pdf',
            fileName: path.posix.basename(chosenSourceRel),
            mimeType: 'application/pdf',
            base64: buf.toString('base64'),
            byteLength: buf.byteLength,
            warnings: [],
          };
          res.json({ artifact });
          return;
        }

        if (!canEdit(role)) {
          const existingPdfPath = compileCoordinator.findPdfPath(buildDir, detail.project.mainFile);
          if (!existingPdfPath) {
            throw new HttpError(
              404,
              '项目尚未编译 PDF，请等待编辑者先执行编译',
              'PDF_NOT_READY',
            );
          }
          const pdfBuf = fs.readFileSync(existingPdfPath);
          const stem = path.posix.basename(
            detail.project.mainFile,
            path.posix.extname(detail.project.mainFile),
          );
          const artifact: ConvertOutputArtifact = {
            format: 'pdf',
            fileName: `${stem}.pdf`,
            mimeType: 'application/pdf',
            base64: pdfBuf.toString('base64'),
            byteLength: pdfBuf.byteLength,
            warnings: [],
          };
          res.json({ artifact });
          return;
        }

        if (inputFormat === 'tex') {
          const isSharedProjectMain =
            sourceScope === 'project' && chosenSourceRel === detail.project.mainFile;
          if (isSharedProjectMain) {
            const compileRes = await compileCoordinator.compile({
              projectId,
              workspaceDir: srcDir,
              buildDir,
              mainFile: chosenSourceRel,
              engine: detail.project.engine,
            });
            if (!compileRes.pdfReady) {
              throw new HttpError(
                400,
                compileRes.compilerNote ||
                  `无法导出 PDF：LaTeX 编译发现 ${compileRes.errorCount} 个错误`,
              );
            }
            const pdfPath = compileCoordinator.findPdfPath(buildDir, chosenSourceRel);
            if (!pdfPath) {
              throw new HttpError(500, '编译完成但未找到 PDF 产物');
            }
            const pdfBuf = fs.readFileSync(pdfPath);
            const stem = path.posix.basename(chosenSourceRel, path.posix.extname(chosenSourceRel));
            const artifact: ConvertOutputArtifact = {
              format: 'pdf',
              fileName: `${stem}.pdf`,
              mimeType: 'application/pdf',
              base64: pdfBuf.toString('base64'),
              byteLength: pdfBuf.byteLength,
              warnings:
                compileRes.warningCount > 0 ? [`编译产生 ${compileRes.warningCount} 条警告`] : [],
            };
            res.json({ artifact });
            return;
          }

          // Isolated build dir for single non-main .tex file so shared _build/main.pdf stays untouched
          const tmpBuild = fs.mkdtempSync(path.join(os.tmpdir(), 'novatex-single-tex-pdf-'));
          try {
            const compileRes = await compileCoordinator.compile({
              projectId,
              workspaceDir: srcDir,
              buildDir: tmpBuild,
              mainFile: chosenSourceRel,
              engine: detail.project.engine,
            });
            const pdfPath = compileCoordinator.findPdfPath(tmpBuild, chosenSourceRel);
            if (!compileRes.pdfReady || !pdfPath) {
              throw new HttpError(
                400,
                compileRes.compilerNote ||
                  `无法导出 PDF：LaTeX 编译发现 ${compileRes.errorCount} 个错误`,
              );
            }
            const pdfBuf = fs.readFileSync(pdfPath);
            const stem = path.posix.basename(chosenSourceRel, path.posix.extname(chosenSourceRel));
            const artifact: ConvertOutputArtifact = {
              format: 'pdf',
              fileName: `${stem}.pdf`,
              mimeType: 'application/pdf',
              base64: pdfBuf.toString('base64'),
              byteLength: pdfBuf.byteLength,
              warnings:
                compileRes.warningCount > 0 ? [`编译产生 ${compileRes.warningCount} 条警告`] : [],
            };
            res.json({ artifact });
            return;
          } finally {
            fs.rmSync(tmpBuild, { recursive: true, force: true });
          }
        }

        // MD / TXT / DOCX -> standalone LaTeX -> compiled PDF in isolated temp workspace
        const validatedExportTemplate: AcademicTemplateId =
          typeof convOptions.template === 'string' &&
          VALID_TEMPLATES.has(convOptions.template as AcademicTemplateId)
            ? (convOptions.template as AcademicTemplateId)
            : convOptions.template !== undefined
              ? 'clean-article'
              : 'chinese-ctex';
        const texArtifact = await formatHub.convert({
          inputFormat,
          outputFormat: 'tex',
          workspaceRoot: srcDir,
          sourceFilePath: chosenSourceRel,
          options: {
            ...convOptions,
            bodyOnly: false,
            template: validatedExportTemplate,
          },
        });

        const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'novatex-pdf-export-'));
        try {
          const tmpSrc = path.join(tmpRoot, 'src');
          const tmpBuild = path.join(tmpRoot, 'build');
          fs.mkdirSync(tmpSrc, { recursive: true });
          fs.writeFileSync(path.join(tmpSrc, 'export.tex'), texArtifact.text ?? '', 'utf8');

          const compileRes = await compileCoordinator.compile({
            projectId,
            workspaceDir: tmpSrc,
            buildDir: tmpBuild,
            mainFile: 'export.tex',
            engine: detail.project.engine,
          });
          const pdfPath = compileCoordinator.findPdfPath(tmpBuild, 'export.tex');
          if (!compileRes.pdfReady || !pdfPath) {
            throw new HttpError(
              400,
              compileRes.compilerNote || '转换为 PDF 时 LaTeX 编译失败',
            );
          }
          const pdfBuf = fs.readFileSync(pdfPath);
          const stem = path.posix.basename(chosenSourceRel, path.posix.extname(chosenSourceRel));
          const artifact: ConvertOutputArtifact = {
            format: 'pdf',
            fileName: `${stem}.pdf`,
            mimeType: 'application/pdf',
            base64: pdfBuf.toString('base64'),
            byteLength: pdfBuf.byteLength,
            warnings: [...texArtifact.warnings],
          };
          res.json({ artifact });
          return;
        } finally {
          fs.rmSync(tmpRoot, { recursive: true, force: true });
        }
      }

      const artifact = await formatHub.convert({
        inputFormat,
        outputFormat: targetFormat,
        workspaceRoot: srcDir,
        sourceFilePath: chosenSourceRel,
        options: convOptions,
      });

      res.json({ artifact });
    }),
  );

  app.post(
    '/api/projects/:id/format/import-preview',
    asyncHandler(async (req, res) => {
      const { projectId, srcDir } = requireProjectAccess(req, 'edit');
      const body = (req.body ?? {}) as {
        sourceFormat?: Exclude<FormatLayer, 'tex'>;
        fileName?: string;
        text?: string;
        base64?: string;
        targetMode?: 'merge-tex' | 'new-tex' | 'save-md';
        targetFile?: string;
        options?: ConvertOptions;
      };

      const sourceFormat = body.sourceFormat;
      if (!sourceFormat || !['md', 'docx', 'txt', 'pdf'].includes(sourceFormat)) {
        throw new HttpError(400, `不支持的导入源格式: ${String(sourceFormat)}`);
      }
      const targetMode = body.targetMode ?? 'merge-tex';
      if (!['merge-tex', 'new-tex', 'save-md'].includes(targetMode)) {
        throw new HttpError(400, `不支持的导入目标模式: ${String(targetMode)}`);
      }

      const safeTargetFile = normalizeProjectRelPath(
        body.targetFile || (targetMode === 'save-md' ? 'draft.md' : 'main.tex'),
      );

      let inputContent: string | undefined;
      let inputBuffer: Buffer | undefined;
      if (sourceFormat === 'docx' || sourceFormat === 'pdf') {
        if (typeof body.base64 !== 'string' || !body.base64.trim()) {
          throw new HttpError(400, `导入 .${sourceFormat} 需要提供 base64 文件数据`);
        }
        inputBuffer = decodeBase64Strict(body.base64, MAX_SINGLE_FILE_BYTES);
      } else {
        if (typeof body.text === 'string') {
          inputContent = body.text;
        } else if (typeof body.base64 === 'string' && body.base64.trim()) {
          inputBuffer = decodeBase64Strict(body.base64, MAX_SINGLE_FILE_BYTES);
        } else {
          throw new HttpError(400, '请提供待导入的文本内容');
        }
      }

      const outputFormat: FormatLayer = targetMode === 'save-md' ? 'md' : 'tex';
      const rawPreviewTemplate = body.options?.template;
      const validatedPreviewTemplate: AcademicTemplateId | undefined =
        typeof rawPreviewTemplate === 'string' &&
        VALID_TEMPLATES.has(rawPreviewTemplate as AcademicTemplateId)
          ? (rawPreviewTemplate as AcademicTemplateId)
          : rawPreviewTemplate !== undefined
            ? 'clean-article'
            : targetMode === 'new-tex'
              ? 'chinese-ctex'
              : undefined;
      const convOptions: ConvertOptions = {
        ...(body.options ?? {}),
        preserveCitations: body.options?.preserveCitations ?? true,
        bodyOnly: targetMode === 'merge-tex' ? true : targetMode === 'new-tex' ? false : undefined,
        template: validatedPreviewTemplate,
      };

      // Stage any Pandoc-extracted media into a temporary directory so preview stays side-effect-free
      // while still returning base64 media payloads for `apply-import`.
      const previewMediaStage = fs.mkdtempSync(path.join(os.tmpdir(), 'novatex-preview-media-'));
      try {
        const artifact = await formatHub.convert({
          inputFormat: sourceFormat,
          outputFormat,
          inputContent,
          inputBuffer,
          workspaceRoot: previewMediaStage,
          sourceFilePath: body.fileName || `import.${sourceFormat}`,
          options: convOptions,
        });

        const extractedMedia: Array<{ relativePath: string; byteLength: number; base64?: string }> =
          [];
        for (const item of artifact.extractedMedia ?? []) {
          try {
            const staged = resolveInsideWorkspace(previewMediaStage, item.relativePath);
            const mediaBuf = fs.existsSync(staged.absPath) ? fs.readFileSync(staged.absPath) : null;
            extractedMedia.push({
              relativePath: item.relativePath,
              byteLength: mediaBuf ? mediaBuf.byteLength : item.byteLength,
              ...(mediaBuf ? { base64: mediaBuf.toString('base64') } : {}),
            });
          } catch {
            extractedMedia.push({
              relativePath: item.relativePath,
              byteLength: item.byteLength,
            });
          }
        }

        const warnings = [...artifact.warnings];
        let mergePreview: SectionMergePreview | undefined;
        let generatedCode = artifact.text ?? '';

        if (targetMode === 'merge-tex') {
          const { absPath } = resolveInsideWorkspace(srcDir, safeTargetFile);
          const liveText = collab.getLiveTextIfLoaded(projectId, safeTargetFile);
          const originalCode =
            liveText !== null
              ? liveText
              : fs.existsSync(absPath) && fs.statSync(absPath).isFile()
                ? fs.readFileSync(absPath, 'utf8')
                : '';

          mergePreview = formatHub.previewSectionMerge(
            originalCode,
            generatedCode,
            safeTargetFile,
            'replace-body',
          );
          generatedCode = mergePreview.mergedCode;
          warnings.push(...mergePreview.warnings);
        }

        res.json({
          artifact,
          mergePreview,
          generatedCode,
          targetFile: safeTargetFile,
          extractedMedia,
          warnings,
        });
      } finally {
        fs.rmSync(previewMediaStage, { recursive: true, force: true });
      }
    }),
  );

  app.post(
    '/api/projects/:id/format/apply-import',
    asyncHandler(async (req, res) => {
      const { user, projectId, srcDir } = requireProjectAccess(req, 'edit');
      const body = (req.body ?? {}) as {
        targetFile?: string;
        content?: string;
        extractedMedia?: Array<{ relativePath: string; base64?: string }>;
        commitMessage?: string;
      };

      if (typeof body.targetFile !== 'string' || typeof body.content !== 'string') {
        throw new HttpError(400, '缺少 targetFile 或 content 字段');
      }

      const { relPath: safeTarget } = resolveInsideWorkspace(srcDir, body.targetFile);

      // Write extracted images/media safely inside workspace
      if (Array.isArray(body.extractedMedia)) {
        for (const media of body.extractedMedia) {
          if (!media || typeof media.relativePath !== 'string' || typeof media.base64 !== 'string') {
            continue;
          }
          const dest = resolveInsideWorkspace(srcDir, media.relativePath);
          const buf = decodeBase64Strict(media.base64, MAX_SINGLE_FILE_BYTES);
          fs.mkdirSync(path.dirname(dest.absPath), { recursive: true });
          fs.writeFileSync(dest.absPath, buf);
        }
      }

      await collab.patchLiveDocument(projectId, safeTarget, body.content);
      db.touchProject(projectId);

      if (typeof body.commitMessage === 'string' && body.commitMessage.trim()) {
        await collab.flushProjectDocumentsToDisk(projectId);
        await commitAll(
          srcDir,
          body.commitMessage.trim(),
          user.displayName || user.username,
          true,
        );
      }

      res.json({ ok: true, targetFile: safeTarget });
    }),
  );

  app.post(
    '/api/projects/:id/format/md-compile',
    asyncHandler(async (req, res) => {
      const { user, projectId, srcDir, buildDir } = requireProjectAccess(req, 'edit');
      const detail = db.getProjectForUser(projectId, user.id);
      if (!detail) {
        throw new HttpError(404, '项目不存在', 'PROJECT_NOT_FOUND');
      }

      const body = (req.body ?? {}) as {
        markdown?: unknown;
        targetFile?: unknown;
        engine?: unknown;
        commitMessage?: unknown;
        options?: ConvertOptions;
      };

      if (typeof body.markdown !== 'string') {
        throw new HttpError(400, '缺少 markdown 字符串内容', 'INVALID_MARKDOWN');
      }
      if (Buffer.byteLength(body.markdown, 'utf8') > MAX_SINGLE_FILE_BYTES) {
        throw new HttpError(413, 'Markdown 内容体积超出允许上限', 'FILE_TOO_LARGE');
      }

      let engine: CompileEngine = detail.project.engine;
      if (typeof body.engine === 'string' && body.engine.trim()) {
        if (!VALID_ENGINES.has(body.engine.trim() as CompileEngine)) {
          throw new HttpError(400, `不支持的编译引擎: ${body.engine}`, 'INVALID_ENGINE');
        }
        engine = body.engine.trim() as CompileEngine;
      }

      const rawTarget =
        typeof body.targetFile === 'string' && body.targetFile.trim()
          ? body.targetFile.trim()
          : detail.project.mainFile;
      const { relPath: safeTarget, absPath: targetAbs } = resolveInsideWorkspace(srcDir, rawTarget);
      if (isBinaryFilePath(safeTarget)) {
        throw new HttpError(400, '目标文件不能是二进制文件', 'INVALID_TARGET_FILE');
      }
      if (fs.existsSync(targetAbs)) {
        const st = fs.lstatSync(targetAbs);
        if (st.isSymbolicLink() || !st.isFile()) {
          throw new HttpError(
            400,
            `目标路径不是可写入的文本文件: ${safeTarget}`,
            'INVALID_TARGET_FILE',
          );
        }
        if (isLikelyBinaryFile(targetAbs, safeTarget)) {
          throw new HttpError(400, '目标文件包含二进制内容，禁止覆盖写入', 'INVALID_TARGET_FILE');
        }
      }
      const lowerTarget = safeTarget.toLowerCase();
      if (!lowerTarget.endsWith('.tex') && !lowerTarget.endsWith('.ltx')) {
        throw new HttpError(
          400,
          '目标文件必须为 LaTeX 源码文件（.tex 或 .ltx）',
          'INVALID_TARGET_FILE',
        );
      }

      const rawUserOptions: ConvertOptions =
        body.options && typeof body.options === 'object' && !Array.isArray(body.options)
          ? body.options
          : {};
      const defaultTemplate: AcademicTemplateId =
        engine === 'xelatex' ? 'chinese-ctex' : 'clean-article';
      const validatedTemplate: AcademicTemplateId =
        typeof rawUserOptions.template === 'string' &&
        VALID_TEMPLATES.has(rawUserOptions.template as AcademicTemplateId)
          ? (rawUserOptions.template as AcademicTemplateId)
          : rawUserOptions.template !== undefined
            ? 'clean-article'
            : defaultTemplate;
      const userOptions: ConvertOptions = {
        ...rawUserOptions,
        template: validatedTemplate,
      };

      // Run Pandoc conversion FIRST (potentially slow subprocess) before reading latest live/disk TeX
      // to eliminate race windows with concurrent Yjs collaborator edits.
      const targetExistsInitially =
        collab.getLiveTextIfLoaded(projectId, safeTarget) !== null ||
        (fs.existsSync(targetAbs) && fs.lstatSync(targetAbs).isFile());

      const artifact = await formatHub.convert({
        inputFormat: 'md',
        outputFormat: 'tex',
        inputContent: body.markdown,
        sourceFilePath: 'draft.md',
        options: targetExistsInitially
          ? {
              preserveCitations: true,
              ...userOptions,
              bodyOnly: true,
            }
          : {
              preserveCitations: true,
              ...userOptions,
              bodyOnly: userOptions.bodyOnly ?? false,
            },
      });
      const convertedLatex = artifact.text ?? '';

      // Flush latest collaborative Yjs docs and read freshest target TeX immediately before merging
      await collab.flushProjectDocumentsToDisk(projectId);

      const liveText = collab.getLiveTextIfLoaded(projectId, safeTarget);
      let diskExists = false;
      if (fs.existsSync(targetAbs)) {
        const latestStat = fs.lstatSync(targetAbs);
        if (latestStat.isSymbolicLink() || !latestStat.isFile()) {
          throw new HttpError(
            400,
            `目标路径不是可写入的文本文件: ${safeTarget}`,
            'INVALID_TARGET_FILE',
          );
        }
        if (isLikelyBinaryFile(targetAbs, safeTarget)) {
          throw new HttpError(400, '目标文件包含二进制内容，禁止覆盖写入', 'INVALID_TARGET_FILE');
        }
        diskExists = true;
      }

      let mergedCode: string;
      let mergePreview: SectionMergePreview;
      let warnings: string[];

      if (liveText !== null || diskExists) {
        const existingTex = liveText !== null ? liveText : fs.readFileSync(targetAbs, 'utf8');
        mergePreview = formatHub.previewSectionMerge(
          existingTex,
          convertedLatex,
          safeTarget,
          'replace-body',
        );
        mergedCode = mergePreview.mergedCode;
        warnings = [...artifact.warnings, ...mergePreview.warnings];
      } else {
        mergedCode = convertedLatex;
        mergePreview = formatHub.previewSectionMerge('', mergedCode, safeTarget, 'replace-file');
        warnings = [...artifact.warnings, ...mergePreview.warnings];
      }

      await collab.patchLiveDocument(projectId, safeTarget, mergedCode);
      await collab.flushProjectDocumentsToDisk(projectId);
      db.touchProject(projectId);

      if (typeof body.commitMessage === 'string' && body.commitMessage.trim()) {
        await commitAll(
          srcDir,
          body.commitMessage.trim(),
          user.displayName || user.username,
          true,
        );
      }

      db.updateProjectCompileStatus(projectId, 'compiling');
      let compileResult;
      try {
        compileResult = await compileCoordinator.compile({
          projectId,
          workspaceDir: srcDir,
          buildDir,
          mainFile: detail.project.mainFile,
          engine,
        });
      } catch (err) {
        db.updateProjectCompileStatus(projectId, 'error');
        throw err;
      }
      db.saveCompileRun(compileResult);

      const response: MdCompileResponse = {
        ok: compileResult.ok,
        targetFile: safeTarget,
        mergedCode,
        mergePreview,
        warnings,
        compileResult,
      };
      res.json(response);
    }),
  );

  // =========================================================================
  // 8. Git Version History
  // =========================================================================

  app.get(
    '/api/projects/:id/git/log',
    asyncHandler(async (req, res) => {
      const { srcDir } = requireProjectAccess(req, 'read');
      const limitRaw = Number.parseInt(queryStr(req.query.limit), 10);
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 50;
      const commits = await getLog(srcDir, limit);
      res.json({ commits });
    }),
  );

  app.post(
    '/api/projects/:id/git/commit',
    asyncHandler(async (req, res) => {
      const { user, projectId, srcDir } = requireProjectAccess(req, 'edit');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const message = typeof body.message === 'string' ? body.message.trim() : '';
      if (!message) {
        throw new HttpError(400, '提交备注不能为空');
      }

      await collab.flushProjectDocumentsToDisk(projectId);
      const commit = await commitAll(srcDir, message, user.displayName || user.username, true);
      db.touchProject(projectId);
      res.status(201).json({ commit });
    }),
  );

  app.get(
    '/api/projects/:id/git/diff',
    asyncHandler(async (req, res) => {
      const { srcDir } = requireProjectAccess(req, 'read');
      const fromRef = queryStr(req.query.from);
      const toRef = queryStr(req.query.to) || 'HEAD';
      if (!fromRef) {
        throw new HttpError(400, '缺少起始提交哈希 from 参数');
      }
      const diff = await getDiff(srcDir, fromRef, toRef);
      res.json(diff);
    }),
  );

  app.post(
    '/api/projects/:id/git/restore',
    asyncHandler(async (req, res) => {
      const { user, projectId, srcDir } = requireProjectAccess(req, 'edit');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const rawHash =
        (typeof body.hash === 'string' && body.hash.trim()) ||
        (typeof body.commitHash === 'string' && body.commitHash.trim()) ||
        (typeof body.ref === 'string' && body.ref.trim()) ||
        '';
      if (!rawHash) {
        throw new HttpError(400, '缺少目标提交哈希');
      }

      await collab.flushProjectDocumentsToDisk(projectId);
      const restored = await restoreCommit(srcDir, rawHash, user.displayName || user.username);

      // Refresh live Yjs rooms & snapshots to match restored files on disk
      for (const rel of restored.restoredTextFiles) {
        try {
          const { absPath } = resolveInsideWorkspace(srcDir, rel);
          if (fs.existsSync(absPath) && fs.statSync(absPath).isFile()) {
            const content = fs.readFileSync(absPath, 'utf8');
            await collab.patchLiveDocument(projectId, rel, content);
          }
        } catch {
          // skip unreadable or invalid files
        }
      }
      for (const delRel of restored.deletedFiles) {
        try {
          await collab.deleteLiveDocument(projectId, delRel);
        } catch {
          // ignore
        }
      }

      db.touchProject(projectId);
      res.json({ ok: true, commit: restored.commit });
    }),
  );

  // =========================================================================
  // 9. Source Comments
  // =========================================================================

  app.get(
    '/api/projects/:id/comments',
    asyncHandler(async (req, res) => {
      const { projectId } = requireProjectAccess(req, 'read');
      const rawFile = queryStr(req.query.file).trim();
      const filePath = rawFile ? normalizeProjectRelPath(rawFile) : undefined;
      const threads = db.listCommentThreads(projectId, filePath);
      res.json({ threads });
    }),
  );

  app.post(
    '/api/projects/:id/comments',
    asyncHandler(async (req, res) => {
      const { user, projectId } = requireProjectAccess(req, 'comment');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const rawFilePath = typeof body.filePath === 'string' ? body.filePath : '';
      const safeFilePath = normalizeProjectRelPath(rawFilePath);
      const lineNumber = Number(body.lineNumber);
      const quote = typeof body.quote === 'string' ? body.quote : '';
      const commentBody = typeof body.body === 'string' ? body.body.trim() : '';

      if (!Number.isFinite(lineNumber) || lineNumber < 1) {
        throw new HttpError(400, '无效的评论行号');
      }
      if (!commentBody) {
        throw new HttpError(400, '评论内容不能为空');
      }

      const thread = db.createCommentThread(projectId, user.id, {
        filePath: safeFilePath,
        lineNumber,
        quote,
        body: commentBody,
      });
      res.status(201).json({ thread });
    }),
  );

  app.post(
    '/api/projects/:id/comments/:threadId/reply',
    asyncHandler(async (req, res) => {
      const { user, projectId } = requireProjectAccess(req, 'comment');
      const threadId = paramStr(req.params.threadId);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const replyBody = typeof body.body === 'string' ? body.body.trim() : '';
      if (!replyBody) {
        throw new HttpError(400, '回复内容不能为空');
      }

      const thread = db.replyCommentThread(projectId, threadId, user.id, replyBody);
      if (!thread) {
        throw new HttpError(404, '评论主题不存在');
      }
      res.status(201).json({ thread });
    }),
  );

  app.patch(
    '/api/projects/:id/comments/:threadId',
    asyncHandler(async (req, res) => {
      const { projectId } = requireProjectAccess(req, 'comment');
      const threadId = paramStr(req.params.threadId);
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (typeof body.resolved !== 'boolean') {
        throw new HttpError(400, '缺少布尔类型 resolved 字段');
      }

      const thread = db.updateCommentThreadResolved(projectId, threadId, body.resolved);
      if (!thread) {
        throw new HttpError(404, '评论主题不存在');
      }
      res.json({ thread });
    }),
  );

  // Unknown `/api/*` routes return clean JSON 404
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'API 接口不存在', code: 'NOT_FOUND' });
  });

  // =========================================================================
  // 10. Built Frontend Static Assets & SPA Fallback
  // =========================================================================

  const indexHtmlPath = path.join(config.webDistDir, 'index.html');
  if (fs.existsSync(config.webDistDir) && fs.existsSync(indexHtmlPath)) {
    app.use(express.static(config.webDistDir, { index: false }));
    app.use((req, res, next) => {
      if (
        req.method !== 'GET' ||
        req.path.startsWith('/api') ||
        req.path.startsWith('/collab')
      ) {
        next();
        return;
      }
      res.sendFile(indexHtmlPath);
    });
  }

  // =========================================================================
  // 11. Centralized Safe Error Handler (never leaks stack traces or secrets)
  // =========================================================================

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) {
      return;
    }

    if (err instanceof HttpError) {
      if (err.status === 429) {
        res.setHeader('Retry-After', String(Math.ceil(config.authRateLimitWindowMs / 1000)));
      }
      res.status(err.status).json({
        error: err.message,
        ...(err.code ? { code: err.code } : {}),
      });
      return;
    }

    if (err instanceof PathSecurityError) {
      res.status(400).json({ error: err.message, code: err.code });
      return;
    }

    if (err instanceof GitOperationError) {
      res.status(err.status).json({ error: err.message, code: 'GIT_ERROR' });
      return;
    }

    if (err instanceof AiConfigError) {
      res.status(400).json({ error: err.messageZh, code: err.code });
      return;
    }

    if (err instanceof AiFixerError) {
      const status =
        err.code === 'MISSING_API_KEY' ||
        err.code === 'INVALID_CONFIG' ||
        err.code === 'INVALID_REQUEST'
          ? 400
          : err.code === 'TIMEOUT'
            ? 504
            : err.code === 'HTTP_AUTH_ERROR'
              ? 401
              : err.code === 'HTTP_RATE_LIMIT'
                ? 429
                : 502;
      res.status(status).json({ error: err.messageZh, code: err.code });
      return;
    }

    // Express JSON parser / payload too large errors
    if (
      typeof err === 'object' &&
      err !== null &&
      'status' in err &&
      typeof (err as { status?: unknown }).status === 'number'
    ) {
      const status = (err as { status: number }).status;
      if (status >= 400 && status < 500) {
        res.status(status).json({
          error: status === 413 ? '请求体体积过大' : '请求格式无效',
          code: status === 413 ? 'PAYLOAD_TOO_LARGE' : 'BAD_REQUEST',
        });
        return;
      }
    }

    const msg = err instanceof Error ? err.message : '服务器内部错误';
    console.error('[novatex-server] unhandled error:', msg);
    res.status(500).json({ error: '服务器内部错误，请稍后重试', code: 'INTERNAL_ERROR' });
  });

  // =========================================================================
  // 12. Single-Port HTTP + Hocuspocus `/collab` WebSocket Upgrade Server
  // =========================================================================

  const httpServer = http.createServer(app);

  httpServer.on('upgrade', (request: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    let pathname = '/';
    try {
      pathname = new URL(request.url || '/', 'http://localhost').pathname;
    } catch {
      socket.destroy();
      return;
    }

    if (pathname === '/collab' || pathname.startsWith('/collab/')) {
      collab.handleUpgrade(request, socket, head);
    } else {
      socket.destroy();
    }
  });

  let closed = false;

  const start = (): Promise<{ host: string; port: number; url: string }> => {
    return new Promise((resolve, reject) => {
      const onError = (err: Error) => {
        httpServer.off('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        httpServer.off('error', onError);
        const addr = httpServer.address();
        const actualPort =
          addr && typeof addr === 'object' ? addr.port : config.port;
        const actualHost =
          addr && typeof addr === 'object' && addr.address ? addr.address : config.host;
        resolve({
          host: actualHost,
          port: actualPort,
          url: `http://${actualHost === '::' || actualHost === '0.0.0.0' ? '127.0.0.1' : actualHost}:${actualPort}`,
        });
      };
      httpServer.once('error', onError);
      httpServer.once('listening', onListening);
      httpServer.listen(config.port, config.host);
    });
  };

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;

    await collab.close();

    if (httpServer.listening) {
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
        // Node 18.2+ immediately drops idle keep-alive sockets on shutdown
        if (typeof httpServer.closeIdleConnections === 'function') {
          httpServer.closeIdleConnections();
        }
      });
    }

    db.close();
  };

  return {
    app,
    httpServer,
    hocuspocus: collab.hocuspocus,
    db,
    config,
    collab,
    start,
    close,
  };
}
