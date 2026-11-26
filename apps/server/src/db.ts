import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import type {
  AiProviderConfig,
  CommentMessage,
  CommentThread,
  CompileEngine,
  CompileResult,
  ProjectInvite,
  ProjectMemberInfo,
  ProjectMemberRole,
  ProjectSummary,
  UserPublic,
  UserRole,
} from '@novatex/shared';

const scryptAsync = promisify(crypto.scrypt);
const DUMMY_PASSWORD_HASH = `scrypt:${'0'.repeat(32)}:${'0'.repeat(128)}`;

const USER_COLORS = [
  '#2563eb',
  '#059669',
  '#d97706',
  '#7c3aed',
  '#db2777',
  '#0891b2',
  '#dc2626',
  '#4f46e5',
];

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const COLLAB_TOKEN_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

const ROLE_RANK: Record<ProjectMemberRole, number> = {
  viewer: 1,
  commenter: 2,
  editor: 3,
  owner: 4,
};

function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const derived = (await scryptAsync(password, salt, 64)) as Buffer;
  return `scrypt:${salt.toString('hex')}:${derived.toString('hex')}`;
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const parts = storedHash.split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') {
    return false;
  }
  const saltHex = parts[1]!;
  const hashHex = parts[2]!;
  if (!/^[0-9a-f]+$/i.test(saltHex) || !/^[0-9a-f]+$/i.test(hashHex)) {
    return false;
  }
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = (await scryptAsync(password, salt, expected.length)) as Buffer;
  if (actual.length !== expected.length) {
    return false;
  }
  return crypto.timingSafeEqual(actual, expected);
}

function pickUserColor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return USER_COLORS[hash % USER_COLORS.length]!;
}

function rowToUserPublic(row: Record<string, unknown>): UserPublic {
  return {
    id: String(row.id),
    username: String(row.username),
    displayName: String(row.display_name),
    role: row.role as UserRole,
    color: String(row.color),
    createdAt: String(row.created_at),
  };
}

function rowToProjectSummary(row: Record<string, unknown>, role: ProjectMemberRole): ProjectSummary {
  return {
    id: String(row.id),
    name: String(row.name),
    description: String(row.description ?? ''),
    mainFile: String(row.main_file ?? 'main.tex'),
    engine: (row.engine as CompileEngine) || 'xelatex',
    ownerId: String(row.owner_id),
    role,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    lastCompileStatus: (row.last_compile_status as ProjectSummary['lastCompileStatus']) ?? 'idle',
    lastCompiledAt: row.last_compiled_at ? String(row.last_compiled_at) : null,
  };
}

function rowToInvite(row: Record<string, unknown>): ProjectInvite {
  return {
    token: String(row.token),
    projectId: String(row.project_id),
    role: row.role as ProjectMemberRole,
    expiresAt: String(row.expires_at),
    maxUses: Number(row.max_uses),
    usedCount: Number(row.used_count),
    createdAt: String(row.created_at),
  };
}

export class NovaTeXDatabase {
  private readonly db: DatabaseSync;
  private readonly sessionSecret: string;
  private readonly aiEncryptionKey: Buffer;
  private closed = false;

  constructor(dbPath: string, sessionSecret: string) {
    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.sessionSecret = sessionSecret;
    this.aiEncryptionKey = Buffer.from(
      crypto.hkdfSync(
        'sha256',
        Buffer.from(sessionSecret, 'utf8'),
        Buffer.from('novatex-ai-key-salt-v1', 'utf8'),
        Buffer.from('aes-256-gcm', 'utf8'),
        32,
      ),
    );
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        display_name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('admin', 'member')),
        color TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

      CREATE TABLE IF NOT EXISTS sync_tokens (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        label TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_used_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_sync_tokens_user ON sync_tokens(user_id);

      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        main_file TEXT NOT NULL DEFAULT 'main.tex',
        engine TEXT NOT NULL DEFAULT 'xelatex' CHECK(engine IN ('xelatex', 'pdflatex', 'lualatex')),
        owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        last_compile_status TEXT NOT NULL DEFAULT 'idle',
        last_compiled_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS project_members (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK(role IN ('owner', 'editor', 'commenter', 'viewer')),
        joined_at TEXT NOT NULL,
        PRIMARY KEY (project_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_project_members_user ON project_members(user_id);

      CREATE TABLE IF NOT EXISTS project_invites (
        token TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK(role IN ('editor', 'commenter', 'viewer')),
        expires_at TEXT NOT NULL,
        max_uses INTEGER NOT NULL DEFAULT 10,
        used_count INTEGER NOT NULL DEFAULT 0,
        created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_project_invites_project ON project_invites(project_id);

      CREATE TABLE IF NOT EXISTS yjs_documents (
        doc_name TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        rel_path TEXT NOT NULL,
        state BLOB NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_yjs_documents_project ON yjs_documents(project_id);

      CREATE TABLE IF NOT EXISTS compile_runs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        ok INTEGER NOT NULL,
        engine TEXT NOT NULL,
        main_file TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        exit_code INTEGER NOT NULL,
        pdf_ready INTEGER NOT NULL,
        pdf_size INTEGER NOT NULL,
        synctex_ready INTEGER NOT NULL,
        linearized INTEGER NOT NULL,
        error_count INTEGER NOT NULL,
        warning_count INTEGER NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_compile_runs_project_time ON compile_runs(project_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS comment_threads (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        file_path TEXT NOT NULL,
        line_number INTEGER NOT NULL,
        quote TEXT NOT NULL DEFAULT '',
        resolved INTEGER NOT NULL DEFAULT 0,
        created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_comment_threads_project_file ON comment_threads(project_id, file_path);

      CREATE TABLE IF NOT EXISTS comment_messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES comment_threads(id) ON DELETE CASCADE,
        author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_comment_messages_thread ON comment_messages(thread_id);

      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS user_ai_configs (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        config_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  close(): void {
    if (!this.closed) {
      this.closed = true;
      this.db.close();
    }
  }

  // -------------------------------------------------------------------------
  // Users & Authentication
  // -------------------------------------------------------------------------

  getUserCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS cnt FROM users').get() as
      | { cnt?: number }
      | undefined;
    return Number(row?.cnt ?? 0);
  }

  getUserById(id: string): UserPublic | null {
    const row = this.db
      .prepare('SELECT id, username, display_name, role, color, created_at FROM users WHERE id = ?')
      .get(id);
    return row ? rowToUserPublic(row) : null;
  }

  getUserByUsername(username: string): UserPublic | null {
    const row = this.db
      .prepare(
        'SELECT id, username, display_name, role, color, created_at FROM users WHERE username = ?',
      )
      .get(username);
    return row ? rowToUserPublic(row) : null;
  }

  async createUser(params: {
    username: string;
    displayName: string;
    password: string;
    role: UserRole;
  }): Promise<UserPublic> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const color = pickUserColor(params.username);
    const passwordHash = await hashPassword(params.password);

    this.db
      .prepare(
        `INSERT INTO users (id, username, display_name, password_hash, role, color, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, params.username, params.displayName, passwordHash, params.role, color, now);

    return {
      id,
      username: params.username,
      displayName: params.displayName,
      role: params.role,
      color,
      createdAt: now,
    };
  }

  deleteUser(id: string): void {
    this.db.prepare('DELETE FROM users WHERE id = ?').run(id);
  }

  async updateUserPassword(
    userId: string,
    newPassword: string,
    keepSessionId?: string,
  ): Promise<void> {
    const newHash = await hashPassword(newPassword);
    this.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(newHash, userId);
    if (keepSessionId) {
      this.db
        .prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?')
        .run(userId, keepSessionId);
    } else {
      this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    }
  }

  async authenticateUser(username: string, password: string): Promise<UserPublic | null> {
    const row = this.db
      .prepare(
        `SELECT id, username, display_name, password_hash, role, color, created_at
         FROM users WHERE username = ?`,
      )
      .get(username);
    if (!row) {
      // Timing equalization: execute equivalent scrypt work even when user does not exist
      await verifyPassword(password, DUMMY_PASSWORD_HASH);
      return null;
    }
    const ok = await verifyPassword(password, String(row.password_hash));
    if (!ok) {
      return null;
    }
    return rowToUserPublic(row);
  }

  createSession(
    userId: string,
    ttlMs = SESSION_TTL_MS,
  ): { token: string; sessionId: string; expiresAt: string } {
    const rawToken = crypto.randomBytes(32).toString('base64url');
    const sessionId = sha256Hex(rawToken);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMs).toISOString();

    this.db
      .prepare('INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
      .run(sessionId, userId, expiresAt, now.toISOString());

    return { token: rawToken, sessionId, expiresAt };
  }

  getSessionByToken(rawToken: string): { user: UserPublic; sessionId: string } | null {
    if (!rawToken) return null;
    const sessionId = sha256Hex(rawToken);
    const row = this.db
      .prepare(
        `SELECT u.id, u.username, u.display_name, u.role, u.color, u.created_at, s.expires_at
         FROM sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.id = ?`,
      )
      .get(sessionId);

    if (!row) return null;
    if (Date.parse(String(row.expires_at)) <= Date.now()) {
      this.db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
      return null;
    }
    return { user: rowToUserPublic(row), sessionId };
  }

  getUserBySessionToken(rawToken: string): UserPublic | null {
    return this.getSessionByToken(rawToken)?.user ?? null;
  }

  deleteSession(rawToken: string): void {
    if (!rawToken) return;
    const sessionId = sha256Hex(rawToken);
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
  }

  createCollabToken(userId: string, sessionId: string, ttlMs = COLLAB_TOKEN_TTL_MS): string {
    const payload = Buffer.from(
      JSON.stringify({ uid: userId, sid: sessionId, exp: Date.now() + ttlMs }),
      'utf8',
    ).toString('base64url');
    const sig = crypto
      .createHmac('sha256', this.sessionSecret)
      .update(payload, 'utf8')
      .digest('base64url');
    return `${payload}.${sig}`;
  }

  verifyCollabToken(token: string): UserPublic | null {
    if (!token || typeof token !== 'string') return null;
    const dotIdx = token.indexOf('.');
    if (dotIdx <= 0 || dotIdx === token.length - 1) return null;

    const payloadB64 = token.slice(0, dotIdx);
    const providedSig = token.slice(dotIdx + 1);
    const expectedSig = crypto
      .createHmac('sha256', this.sessionSecret)
      .update(payloadB64, 'utf8')
      .digest('base64url');

    const providedBuf = Buffer.from(providedSig, 'utf8');
    const expectedBuf = Buffer.from(expectedSig, 'utf8');
    if (
      providedBuf.length !== expectedBuf.length ||
      !crypto.timingSafeEqual(providedBuf, expectedBuf)
    ) {
      return null;
    }

    try {
      const parsed = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as {
        uid?: unknown;
        sid?: unknown;
        exp?: unknown;
      };
      if (
        typeof parsed.uid !== 'string' ||
        typeof parsed.sid !== 'string' ||
        !parsed.sid ||
        typeof parsed.exp !== 'number'
      ) {
        return null;
      }
      if (parsed.exp <= Date.now()) {
        return null;
      }

      // Bind collabToken to an active, unexpired session so logout immediately revokes all WS tokens
      const row = this.db
        .prepare(
          `SELECT u.id, u.username, u.display_name, u.role, u.color, u.created_at, s.expires_at
           FROM sessions s
           JOIN users u ON u.id = s.user_id
           WHERE s.id = ? AND s.user_id = ?`,
        )
        .get(parsed.sid, parsed.uid);
      if (!row) return null;
      if (Date.parse(String(row.expires_at)) <= Date.now()) {
        this.db.prepare('DELETE FROM sessions WHERE id = ?').run(parsed.sid);
        return null;
      }
      return rowToUserPublic(row);
    } catch {
      return null;
    }
  }

  createSyncToken(
    userId: string,
    label: string,
  ): { id: string; token: string; label: string; createdAt: string } {
    const id = crypto.randomUUID();
    const rawToken = `nvx_${crypto.randomBytes(32).toString('hex')}`;
    const tokenHash = sha256Hex(rawToken);
    const now = new Date().toISOString();
    const safeLabel = label.trim().slice(0, 80) || 'local-agent';

    this.db
      .prepare(
        `INSERT INTO sync_tokens (id, user_id, token_hash, label, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, userId, tokenHash, safeLabel, now);

    return { id, token: rawToken, label: safeLabel, createdAt: now };
  }

  listSyncTokens(
    userId: string,
  ): Array<{ id: string; label: string; createdAt: string; lastUsedAt: string | null }> {
    const rows = this.db
      .prepare(
        `SELECT id, label, created_at, last_used_at
         FROM sync_tokens
         WHERE user_id = ?
         ORDER BY created_at DESC`,
      )
      .all(userId);
    return rows.map((r) => ({
      id: String(r.id),
      label: String(r.label),
      createdAt: String(r.created_at),
      lastUsedAt: r.last_used_at ? String(r.last_used_at) : null,
    }));
  }

  revokeSyncToken(userId: string, tokenId: string): boolean {
    const res = this.db
      .prepare('DELETE FROM sync_tokens WHERE id = ? AND user_id = ?')
      .run(tokenId, userId);
    return Number(res.changes) > 0;
  }

  verifySyncToken(rawToken: string): UserPublic | null {
    if (!rawToken || typeof rawToken !== 'string') return null;
    const tokenHash = sha256Hex(rawToken.trim());
    const row = this.db
      .prepare(
        `SELECT t.id AS token_id, u.id, u.username, u.display_name, u.role, u.color, u.created_at
         FROM sync_tokens t
         JOIN users u ON u.id = t.user_id
         WHERE t.token_hash = ?`,
      )
      .get(tokenHash);
    if (!row) return null;

    this.db
      .prepare('UPDATE sync_tokens SET last_used_at = ? WHERE id = ?')
      .run(new Date().toISOString(), String(row.token_id));
    return rowToUserPublic(row);
  }

  // -------------------------------------------------------------------------
  // Projects, Members & Invites
  // -------------------------------------------------------------------------

  createProject(params: {
    id: string;
    name: string;
    description: string;
    mainFile: string;
    engine: CompileEngine;
    ownerId: string;
  }): ProjectSummary {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO projects
          (id, name, description, main_file, engine, owner_id, last_compile_status, last_compiled_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'idle', NULL, ?, ?)`,
      )
      .run(
        params.id,
        params.name,
        params.description,
        params.mainFile,
        params.engine,
        params.ownerId,
        now,
        now,
      );

    this.db
      .prepare(
        `INSERT INTO project_members (project_id, user_id, role, joined_at)
         VALUES (?, ?, 'owner', ?)`,
      )
      .run(params.id, params.ownerId, now);

    return {
      id: params.id,
      name: params.name,
      description: params.description,
      mainFile: params.mainFile,
      engine: params.engine,
      ownerId: params.ownerId,
      role: 'owner',
      createdAt: now,
      updatedAt: now,
      lastCompileStatus: 'idle',
      lastCompiledAt: null,
    };
  }

  listProjectsForUser(userId: string): ProjectSummary[] {
    const rows = this.db
      .prepare(
        `SELECT p.*, m.role AS member_role
         FROM projects p
         JOIN project_members m ON m.project_id = p.id
         WHERE m.user_id = ?
         ORDER BY p.updated_at DESC`,
      )
      .all(userId);
    return rows.map((row) => rowToProjectSummary(row, row.member_role as ProjectMemberRole));
  }

  getProjectById(projectId: string): ProjectSummary | null {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
    if (!row) return null;
    return rowToProjectSummary(row, 'owner');
  }

  getProjectMemberRole(projectId: string, userId: string): ProjectMemberRole | null {
    const row = this.db
      .prepare('SELECT role FROM project_members WHERE project_id = ? AND user_id = ?')
      .get(projectId, userId);
    return row ? (row.role as ProjectMemberRole) : null;
  }

  getProjectForUser(
    projectId: string,
    userId: string,
  ): { project: ProjectSummary; members: ProjectMemberInfo[] } | null {
    const row = this.db
      .prepare(
        `SELECT p.*, m.role AS member_role
         FROM projects p
         JOIN project_members m ON m.project_id = p.id
         WHERE p.id = ? AND m.user_id = ?`,
      )
      .get(projectId, userId);
    if (!row) return null;

    const memberRows = this.db
      .prepare(
        `SELECT m.user_id, m.role, m.joined_at, u.username, u.display_name, u.color
         FROM project_members m
         JOIN users u ON u.id = m.user_id
         WHERE m.project_id = ?
         ORDER BY CASE m.role
           WHEN 'owner' THEN 0
           WHEN 'editor' THEN 1
           WHEN 'commenter' THEN 2
           ELSE 3
         END, m.joined_at ASC`,
      )
      .all(projectId);

    const members: ProjectMemberInfo[] = memberRows.map((mr) => ({
      userId: String(mr.user_id),
      username: String(mr.username),
      displayName: String(mr.display_name),
      color: String(mr.color),
      role: mr.role as ProjectMemberRole,
      joinedAt: String(mr.joined_at),
    }));

    return {
      project: rowToProjectSummary(row, row.member_role as ProjectMemberRole),
      members,
    };
  }

  updateProject(
    projectId: string,
    userId: string,
    patch: Partial<Pick<ProjectSummary, 'name' | 'description' | 'mainFile' | 'engine'>>,
  ): ProjectSummary | null {
    const existing = this.getProjectForUser(projectId, userId);
    if (!existing) return null;

    const nextName = patch.name !== undefined ? patch.name : existing.project.name;
    const nextDesc =
      patch.description !== undefined ? patch.description : existing.project.description;
    const nextMain = patch.mainFile !== undefined ? patch.mainFile : existing.project.mainFile;
    const nextEngine = patch.engine !== undefined ? patch.engine : existing.project.engine;
    const now = new Date().toISOString();

    this.db
      .prepare(
        `UPDATE projects
         SET name = ?, description = ?, main_file = ?, engine = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(nextName, nextDesc, nextMain, nextEngine, now, projectId);

    return {
      ...existing.project,
      name: nextName,
      description: nextDesc,
      mainFile: nextMain,
      engine: nextEngine,
      updatedAt: now,
    };
  }

  touchProject(projectId: string): void {
    this.db
      .prepare('UPDATE projects SET updated_at = ? WHERE id = ?')
      .run(new Date().toISOString(), projectId);
  }

  updateProjectCompileStatus(
    projectId: string,
    status: NonNullable<ProjectSummary['lastCompileStatus']>,
    compiledAt?: string,
  ): void {
    if (compiledAt) {
      this.db
        .prepare(
          'UPDATE projects SET last_compile_status = ?, last_compiled_at = ?, updated_at = ? WHERE id = ?',
        )
        .run(status, compiledAt, compiledAt, projectId);
    } else {
      this.db
        .prepare('UPDATE projects SET last_compile_status = ? WHERE id = ?')
        .run(status, projectId);
    }
  }

  deleteProject(projectId: string): void {
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);
  }

  createInvite(
    projectId: string,
    createdBy: string,
    opts: {
      role: Exclude<ProjectMemberRole, 'owner'>;
      expiresInHours?: number;
      maxUses?: number;
    },
  ): ProjectInvite {
    const token = crypto.randomBytes(18).toString('base64url');
    const now = new Date();
    const hours =
      typeof opts.expiresInHours === 'number' && opts.expiresInHours > 0
        ? Math.min(24 * 365, opts.expiresInHours)
        : 168;
    const maxUses =
      typeof opts.maxUses === 'number' && opts.maxUses > 0
        ? Math.min(1000, Math.trunc(opts.maxUses))
        : 10;
    const expiresAt = new Date(now.getTime() + hours * 3600 * 1000).toISOString();
    const createdAt = now.toISOString();

    this.db
      .prepare(
        `INSERT INTO project_invites
          (token, project_id, role, expires_at, max_uses, used_count, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
      )
      .run(token, projectId, opts.role, expiresAt, maxUses, createdBy, createdAt);

    return {
      token,
      projectId,
      role: opts.role,
      expiresAt,
      maxUses,
      usedCount: 0,
      createdAt,
    };
  }

  listInvites(projectId: string): ProjectInvite[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM project_invites WHERE project_id = ? ORDER BY created_at DESC',
      )
      .all(projectId);
    return rows.map(rowToInvite);
  }

  getInviteByToken(token: string): ProjectInvite | null {
    const row = this.db.prepare('SELECT * FROM project_invites WHERE token = ?').get(token);
    return row ? rowToInvite(row) : null;
  }

  validateInviteForUse(
    token: string,
  ): { ok: true; invite: ProjectInvite } | { ok: false; error: string } {
    const invite = this.getInviteByToken(token);
    if (!invite) {
      return { ok: false, error: '邀请链接无效或不存在' };
    }
    if (Date.parse(invite.expiresAt) <= Date.now()) {
      return { ok: false, error: '邀请链接已过期' };
    }
    if (invite.usedCount >= invite.maxUses) {
      return { ok: false, error: '邀请链接已达到最大使用次数' };
    }
    return { ok: true, invite };
  }

  acceptInvite(
    token: string,
    userId: string,
  ):
    | {
        ok: true;
        projectId: string;
        role: ProjectMemberRole;
        project: ProjectSummary;
        alreadyMember: boolean;
      }
    | { ok: false; status: number; error: string } {
    const invite = this.getInviteByToken(token);
    if (!invite) {
      return { ok: false, status: 404, error: '邀请链接无效或不存在' };
    }

    const existingRole = this.getProjectMemberRole(invite.projectId, userId);
    if (existingRole && ROLE_RANK[existingRole] >= ROLE_RANK[invite.role]) {
      const detail = this.getProjectForUser(invite.projectId, userId);
      if (!detail) {
        return { ok: false, status: 404, error: '目标项目不存在' };
      }
      return {
        ok: true,
        projectId: invite.projectId,
        role: existingRole,
        project: detail.project,
        alreadyMember: true,
      };
    }

    // Fresh join OR role upgrade (e.g. viewer -> editor): MUST strictly enforce expiry AND atomic usage cap!
    if (new Date(invite.expiresAt).getTime() <= Date.now()) {
      return { ok: false, status: 410, error: '邀请链接已过期' };
    }

    let inTx = false;
    try {
      this.db.exec('BEGIN IMMEDIATE');
      inTx = true;

      const currentRole = this.getProjectMemberRole(invite.projectId, userId);
      if (currentRole && ROLE_RANK[currentRole] >= ROLE_RANK[invite.role]) {
        this.db.exec('ROLLBACK');
        inTx = false;
        const detail = this.getProjectForUser(invite.projectId, userId);
        if (!detail) {
          return { ok: false, status: 404, error: '目标项目不存在' };
        }
        return {
          ok: true,
          projectId: invite.projectId,
          role: currentRole,
          project: detail.project,
          alreadyMember: true,
        };
      }

      const upd = this.db
        .prepare(
          `UPDATE project_invites
           SET used_count = used_count + 1
           WHERE token = ? AND used_count < max_uses`,
        )
        .run(invite.token);

      if (Number(upd.changes) !== 1) {
        this.db.exec('ROLLBACK');
        inTx = false;
        return { ok: false, status: 410, error: '邀请链接使用次数已用尽' };
      }

      if (currentRole) {
        this.db
          .prepare('UPDATE project_members SET role = ? WHERE project_id = ? AND user_id = ?')
          .run(invite.role, invite.projectId, userId);
      } else {
        const now = new Date().toISOString();
        this.db
          .prepare(
            `INSERT INTO project_members (project_id, user_id, role, joined_at)
             VALUES (?, ?, ?, ?)`,
          )
          .run(invite.projectId, userId, invite.role, now);
      }

      this.db.exec('COMMIT');
      inTx = false;
    } catch (err) {
      if (inTx) {
        try {
          this.db.exec('ROLLBACK');
        } catch {
          // ignore rollback failure
        }
      }
      throw err;
    }

    const detail = this.getProjectForUser(invite.projectId, userId);
    if (!detail) {
      return { ok: false, status: 404, error: '目标项目不存在' };
    }

    return {
      ok: true,
      projectId: invite.projectId,
      role: invite.role,
      project: detail.project,
      alreadyMember: false,
    };
  }

  // -------------------------------------------------------------------------
  // Yjs Document Persistence
  // -------------------------------------------------------------------------

  getYjsState(docName: string): Uint8Array | null {
    const row = this.db
      .prepare('SELECT state FROM yjs_documents WHERE doc_name = ?')
      .get(docName);
    if (!row || !row.state) return null;
    const raw = row.state;
    if (raw instanceof Uint8Array) {
      return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
    }
    return null;
  }

  saveYjsState(docName: string, projectId: string, relPath: string, state: Uint8Array): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO yjs_documents (doc_name, project_id, rel_path, state, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(doc_name) DO UPDATE SET
           state = excluded.state,
           updated_at = excluded.updated_at`,
      )
      .run(docName, projectId, relPath, state, now);
  }

  deleteYjsState(docName: string): void {
    this.db.prepare('DELETE FROM yjs_documents WHERE doc_name = ?').run(docName);
  }

  deleteYjsStatesForPathOrDir(projectId: string, relPath: string): void {
    const exactDocName = `${projectId}::${relPath}`;
    const prefix = `${relPath}/`;
    const rows = this.db
      .prepare('SELECT doc_name, rel_path FROM yjs_documents WHERE project_id = ?')
      .all(projectId);
    const delStmt = this.db.prepare('DELETE FROM yjs_documents WHERE doc_name = ?');
    for (const r of rows) {
      const rp = String(r.rel_path);
      const dn = String(r.doc_name);
      if (dn === exactDocName || rp === relPath || rp.startsWith(prefix)) {
        delStmt.run(dn);
      }
    }
  }

  renameYjsStates(projectId: string, fromRel: string, toRel: string): void {
    const prefix = `${fromRel}/`;
    const rows = this.db
      .prepare('SELECT doc_name, rel_path, state, updated_at FROM yjs_documents WHERE project_id = ?')
      .all(projectId);

    for (const r of rows) {
      const oldRel = String(r.rel_path);
      let newRel: string | null = null;
      if (oldRel === fromRel) {
        newRel = toRel;
      } else if (oldRel.startsWith(prefix)) {
        newRel = `${toRel}/${oldRel.slice(prefix.length)}`;
      }
      if (!newRel) continue;

      const oldDocName = String(r.doc_name);
      const newDocName = `${projectId}::${newRel}`;
      const state = r.state as Uint8Array;
      this.db.prepare('DELETE FROM yjs_documents WHERE doc_name = ?').run(oldDocName);
      this.saveYjsState(newDocName, projectId, newRel, state);
    }
  }

  // -------------------------------------------------------------------------
  // Compile Runs
  // -------------------------------------------------------------------------

  saveCompileRun(result: CompileResult): void {
    this.db
      .prepare(
        `INSERT INTO compile_runs (
          id, project_id, ok, engine, main_file, duration_ms, exit_code,
          pdf_ready, pdf_size, synctex_ready, linearized, error_count, warning_count,
          result_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        result.jobId,
        result.projectId,
        result.ok ? 1 : 0,
        result.engine,
        result.mainFile,
        result.durationMs,
        result.exitCode,
        result.pdfReady ? 1 : 0,
        result.pdfSize,
        result.synctexReady ? 1 : 0,
        result.linearized ? 1 : 0,
        result.errorCount,
        result.warningCount,
        JSON.stringify(result),
        result.finishedAt,
      );

    this.updateProjectCompileStatus(
      result.projectId,
      result.ok ? 'success' : 'error',
      result.finishedAt,
    );
  }

  getLatestCompileRun(projectId: string): CompileResult | null {
    const row = this.db
      .prepare(
        `SELECT result_json FROM compile_runs
         WHERE project_id = ?
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .get(projectId);
    if (!row || !row.result_json) return null;
    try {
      return JSON.parse(String(row.result_json)) as CompileResult;
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Comments
  // -------------------------------------------------------------------------

  private loadMessagesForThread(threadId: string): CommentMessage[] {
    const rows = this.db
      .prepare(
        `SELECT m.id, m.thread_id, m.author_id, m.body, m.created_at,
                u.display_name, u.username, u.color
         FROM comment_messages m
         JOIN users u ON u.id = m.author_id
         WHERE m.thread_id = ?
         ORDER BY m.created_at ASC`,
      )
      .all(threadId);
    return rows.map((r) => ({
      id: String(r.id),
      threadId: String(r.thread_id),
      authorId: String(r.author_id),
      authorName: String(r.display_name || r.username),
      authorColor: String(r.color || '#2563eb'),
      body: String(r.body),
      createdAt: String(r.created_at),
    }));
  }

  private hydrateThread(row: Record<string, unknown>): CommentThread {
    const id = String(row.id);
    return {
      id,
      projectId: String(row.project_id),
      filePath: String(row.file_path),
      lineNumber: Number(row.line_number),
      quote: String(row.quote ?? ''),
      resolved: Boolean(row.resolved),
      createdBy: String(row.created_by),
      createdAt: String(row.created_at),
      messages: this.loadMessagesForThread(id),
    };
  }

  listCommentThreads(projectId: string, filePath?: string): CommentThread[] {
    const rows = filePath
      ? this.db
          .prepare(
            `SELECT * FROM comment_threads
             WHERE project_id = ? AND file_path = ?
             ORDER BY created_at DESC`,
          )
          .all(projectId, filePath)
      : this.db
          .prepare(
            `SELECT * FROM comment_threads
             WHERE project_id = ?
             ORDER BY created_at DESC`,
          )
          .all(projectId);
    return rows.map((row) => this.hydrateThread(row));
  }

  getCommentThread(projectId: string, threadId: string): CommentThread | null {
    const row = this.db
      .prepare('SELECT * FROM comment_threads WHERE project_id = ? AND id = ?')
      .get(projectId, threadId);
    return row ? this.hydrateThread(row) : null;
  }

  createCommentThread(
    projectId: string,
    authorId: string,
    payload: { filePath: string; lineNumber: number; quote: string; body: string },
  ): CommentThread {
    const threadId = crypto.randomUUID();
    const messageId = crypto.randomUUID();
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO comment_threads
          (id, project_id, file_path, line_number, quote, resolved, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
      )
      .run(
        threadId,
        projectId,
        payload.filePath,
        Math.max(1, Math.trunc(payload.lineNumber)),
        payload.quote.slice(0, 500),
        authorId,
        now,
      );

    this.db
      .prepare(
        `INSERT INTO comment_messages (id, thread_id, author_id, body, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(messageId, threadId, authorId, payload.body, now);

    return this.getCommentThread(projectId, threadId)!;
  }

  replyCommentThread(
    projectId: string,
    threadId: string,
    authorId: string,
    body: string,
  ): CommentThread | null {
    const existing = this.db
      .prepare('SELECT id FROM comment_threads WHERE project_id = ? AND id = ?')
      .get(projectId, threadId);
    if (!existing) return null;

    const messageId = crypto.randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO comment_messages (id, thread_id, author_id, body, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(messageId, threadId, authorId, body, now);

    return this.getCommentThread(projectId, threadId);
  }

  updateCommentThreadResolved(
    projectId: string,
    threadId: string,
    resolved: boolean,
  ): CommentThread | null {
    const res = this.db
      .prepare('UPDATE comment_threads SET resolved = ? WHERE project_id = ? AND id = ?')
      .run(resolved ? 1 : 0, projectId, threadId);
    if (Number(res.changes) === 0) return null;
    return this.getCommentThread(projectId, threadId);
  }

  renameCommentThreadPaths(projectId: string, fromRel: string, toRel: string): void {
    const prefix = `${fromRel}/`;
    const rows = this.db
      .prepare('SELECT id, file_path FROM comment_threads WHERE project_id = ?')
      .all(projectId);
    const stmt = this.db.prepare('UPDATE comment_threads SET file_path = ? WHERE id = ?');
    for (const r of rows) {
      const oldPath = String(r.file_path);
      if (oldPath === fromRel) {
        stmt.run(toRel, String(r.id));
      } else if (oldPath.startsWith(prefix)) {
        stmt.run(`${toRel}/${oldPath.slice(prefix.length)}`, String(r.id));
      }
    }
  }

  // -------------------------------------------------------------------------
  // App Settings
  // -------------------------------------------------------------------------

  getSetting(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
    return row ? String(row.value) : null;
  }

  setSetting(key: string, value: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO app_settings (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           updated_at = excluded.updated_at`,
      )
      .run(key, value, now);
  }

  // -------------------------------------------------------------------------
  // AI Key Encryption at Rest (AES-256-GCM) & Global / Per-User AI Config
  // -------------------------------------------------------------------------

  encryptSecret(plain: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.aiEncryptionKey, iv);
    const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `enc:v1:${iv.toString('base64url')}.${tag.toString('base64url')}.${ciphertext.toString('base64url')}`;
  }

  decryptSecret(stored: string): string {
    if (!stored.startsWith('enc:v1:')) {
      // Seamless zero-downtime compatibility for legacy plaintext rows
      return stored;
    }
    const payload = stored.slice('enc:v1:'.length);
    const parts = payload.split('.');
    if (parts.length !== 3) {
      throw new Error('Invalid encrypted secret format');
    }
    const [ivB64, tagB64, ctB64] = parts as [string, string, string];
    const iv = Buffer.from(ivB64, 'base64url');
    const tag = Buffer.from(tagB64, 'base64url');
    const ciphertext = Buffer.from(ctB64, 'base64url');
    if (iv.byteLength !== 12 || tag.byteLength !== 16) {
      throw new Error('Invalid encrypted secret IV or authTag length');
    }
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.aiEncryptionKey, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plain.toString('utf8');
  }

  private encryptAiConfigForStorage(
    config: Partial<AiProviderConfig>,
  ): Partial<AiProviderConfig> {
    const out: Partial<AiProviderConfig> = { ...config };
    if (typeof out.apiKey === 'string') {
      const trimmed = out.apiKey.trim();
      if (trimmed) {
        out.apiKey = this.encryptSecret(trimmed);
      } else {
        delete out.apiKey;
      }
    }
    return out;
  }

  private decryptAiConfigFromStorage(
    parsed: Partial<AiProviderConfig>,
  ): Partial<AiProviderConfig> {
    const out: Partial<AiProviderConfig> = { ...parsed };
    if (typeof out.apiKey === 'string') {
      const trimmed = out.apiKey.trim();
      if (!trimmed) {
        delete out.apiKey;
      } else {
        try {
          out.apiKey = this.decryptSecret(trimmed);
        } catch {
          delete out.apiKey;
        }
      }
    }
    return out;
  }

  getGlobalAiConfig(): Partial<AiProviderConfig> {
    const raw = this.getSetting('ai_config');
    if (!raw) return {};
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return {};
      }
      return this.decryptAiConfigFromStorage(parsed as Partial<AiProviderConfig>);
    } catch {
      return {};
    }
  }

  setGlobalAiConfig(config: Partial<AiProviderConfig>): void {
    const encrypted = this.encryptAiConfigForStorage(config);
    this.setSetting('ai_config', JSON.stringify(encrypted));
  }

  getUserAiConfig(userId: string): Partial<AiProviderConfig> | null {
    const row = this.db
      .prepare('SELECT config_json FROM user_ai_configs WHERE user_id = ?')
      .get(userId);
    if (!row || typeof row.config_json !== 'string') return null;
    try {
      const parsed: unknown = JSON.parse(row.config_json);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return null;
      }
      return this.decryptAiConfigFromStorage(parsed as Partial<AiProviderConfig>);
    } catch {
      return null;
    }
  }

  setUserAiConfig(userId: string, config: Partial<AiProviderConfig>): void {
    const now = new Date().toISOString();
    const encrypted = this.encryptAiConfigForStorage(config);
    this.db
      .prepare(
        `INSERT INTO user_ai_configs (user_id, config_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           config_json = excluded.config_json,
           updated_at = excluded.updated_at`,
      )
      .run(userId, JSON.stringify(encrypted), now);
  }

  deleteUserAiConfig(userId: string): void {
    this.db.prepare('DELETE FROM user_ai_configs WHERE user_id = ?').run(userId);
  }
}
