# Security Policy

## Supported Versions

Security fixes are maintained on the latest active release line on `main`:

| Version | Supported |
| --- | --- |
| `0.1.x` (`main`) | Yes |
| `< 0.1.0` | No |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues, pull requests, or discussions.**

Instead, please report them privately via [GitHub Security Advisories](https://github.com/KennyMcSimpson/NovaTeX/security/advisories/new) on this repository. Please include:

- A clear description of the vulnerability and its security impact (e.g., sandbox escape, SSRF, credential leakage, authorization bypass, or archive traversal).
- Step-by-step reproduction steps or a minimal proof of concept.
- Affected package(s), API route(s), or deployment configuration (local embedded sandbox vs. remote `apps/worker`, default single-user mode vs. opt-in `ENABLE_COLLAB=true`).
- Any suggested mitigations or patches.

We aim to acknowledge reports within **72 hours** and provide an assessment or remediation timeline within **7 days**. Coordinated disclosure is appreciated so local and self-hosted users can update before technical details become public.

---

## Security Architecture & Defense-in-Depth Controls

NovaTeX is built for **local-first execution** (single Node.js process bound to `127.0.0.1` by default, zero external databases, multi-user collaboration disabled by default) and hardens every trust boundary for **optional private self-hosted deployment** (behind a TLS reverse proxy, with closed public registration). Because LaTeX compilation and user-configured AI endpoints are inherently high-risk surfaces, NovaTeX enforces explicit defense-in-depth controls across every package:

### 1. Hardened TeX Live Compilation Sandbox (`packages/compiler`)
- **No Shell Execution:** All TeX, BibTeX/Biber, qpdf, Pandoc, and Git subprocesses are spawned strictly with `shell: false` and explicit argument arrays.
- **Disabled Shell Escape & Restricted File I/O:** Every compile invocation passes `-no-shell-escape`, `-interaction=nonstopmode`, and `-file-line-error`, and writes an isolated per-job `texmf.cnf` setting:
  - `shell_escape = f`
  - `shell_escape_commands = none` (overrides system restricted-shell-escape allowlists)
  - `openin_any = p` and `openout_any = p`
- **Strict Environment Allowlist:** Child TeX processes receive only a minimal OS/locale allowlist (`SAFE_TEX_ENV_ALLOWLIST`) plus job-local `TMP`/`TEMP`/`TEXMFCNF`. Server secrets (`SESSION_SECRET`, `AI_API_KEY`, `COMPILER_SHARED_SECRET`, `ADMIN_PASSWORD`, etc.) are never inherited by compiler subprocesses.
- **Dangerous File & Engine Blocks:**
  - `.latexmkrc`, `latexmkrc`, `texmf.cnf`, `.env`, and `.git` (case-insensitive) are blocked from upload, ZIP import, sync, and compilation staging.
  - `mainFile` is restricted to `.tex`/`.ltx`, rejects leading `-` or `&` flag/format injection, and is invoked with an explicit `./` prefix; `biber` receives `--` before job arguments.
  - `lualatex` (`\directlua` surface) is **disabled by default** (`ALLOW_LUALATEX=false`) and returns `LUALATEX_DISABLED` unless explicitly enabled by the administrator.
- **Resource & Timeout Bounds:** Single-concurrency compile queue by default (`COMPILE_MAX_CONCURRENCY=1`) and a hard process-tree timeout (`COMPILE_TIMEOUT_MS=60000`). Workspaces are staged into isolated ASCII-only temporary directories and cleaned up after each job.

### 2. Optional Isolated Compile Worker (`apps/worker`)
- **Fail-Closed Startup Guard:** Binding `apps/worker` to any non-loopback address (`0.0.0.0`, `::`, LAN IP) without `COMPILER_SHARED_SECRET` throws at startup and refuses to listen.
- **Pre-Body HMAC-SHA256 & Anti-Replay:** Requests to `POST /compile` require `x-novatex-timestamp` and `x-novatex-signature` (HMAC-SHA256 over `${timestamp}.${rawBody}`, verified with `crypto.timingSafeEqual`). Header format, ±5-minute timestamp skew, and an in-memory TTL replay cache (`HmacReplayCache`) are checked **before** buffering/parsing the JSON payload.
- **Archive Safety Limits:** Incoming ZIP payloads are validated against path traversal (zip-slip), forbidden filenames (`.latexmkrc`, `.git`), maximum file count, and maximum uncompressed size (zip-bomb defense) before extraction, and every job directory is deleted in `finally`.

### 3. Per-User BYOK Encryption & Credential Hygiene (`apps/server`, `packages/ai-fixer`)
- **AES-256-GCM Encryption at Rest:** Both per-user BYOK configs (`user_ai_configs`) and admin site fallback configs (`app_settings.ai_config`) encrypt stored API keys with AES-256-GCM (`enc:v1:<iv>.<tag>.<ciphertext>`) using a 256-bit key derived from `SESSION_SECRET` via HKDF-SHA256.
- **Zero Plaintext Exposure:** Public/UI API responses expose only `hasApiKey: boolean` — raw API keys are never returned over HTTP or WebSocket. Inside `@novatex/ai-fixer`, resolved secrets are stored in an unenumerable `WeakMap` vault invisible to `Object.keys`, spread cloning, or `JSON.stringify`, and scrubbed from error strings.
- **Cross-Origin Key Clearing:** Updating `baseUrl` to a different origin without explicitly supplying a new `apiKey` clears the saved key so credentials cannot be exfiltrated to a third-party endpoint.
- **Per-User Isolation:** Non-admin accounts can only inspect, test, fetch `/models`, or run repairs against their own personal BYOK configuration (or fall back silently to the site default without ever reading its key).

### 4. Outbound SSRF, DNS Rebinding & Redirect Guards (`packages/ai-fixer`)
- **Strict Public-Network Default:** All user-supplied AI `baseUrl` targets undergo URL normalization (`http:`/`https:` only, no embedded credentials, query strings, or fragments) and **async DNS resolution validation** (`validateResolvedAiHost`) across config saves, `/models` lookups, connection tests, and repair requests.
- **Comprehensive Blocked Ranges:** Blocks loopback (`127.0.0.0/8`, `::1`, `localhost`), RFC 1918 private LANs (`10/8`, `172.16/12`, `192.168/16`), CGNAT (`100.64/10`), IPv6 ULA (`fc00::/7`), link-local / cloud IMDS (`169.254.0.0/16`, `100.100.100.200`, `fe80::/10`, `metadata.google.internal`, `metadata.goog`), unspecified/multicast/reserved ranges, IPv4-mapped/NAT64/6to4 IPv6 wrappers, and obfuscated octal/hex/integer/shorthand IPv4 notations.
- **No Redirect Following:** All outbound AI `fetch` calls enforce `redirect: "error"` to block HTTP 30x redirect SSRF chains.
- **Opt-In Private Hosts (Admin Only):** Self-hosted local models (e.g., Ollama on loopback/LAN) are only reachable when the administrator explicitly sets `ALLOW_PRIVATE_AI_HOSTS=true` in the server environment, and even then only for `admin` accounts; cloud metadata, link-local, multicast, and `0.0.0.0/8` remain unconditionally blocked.

### 5. Authentication, Opt-In Multi-User Boundaries, CSRF & Path Safety (`apps/server`, `packages/shared`)
- **Server-Only Registration & Opt-In Multi-User Lock:** `ALLOW_PUBLIC_REGISTER` defaults to `false` and is read strictly from server-side environment / `.env` (there is no web endpoint to toggle public registration). Real-time multi-user collaboration features are opt-in (`ENABLE_COLLAB=true`, disabled by default for local-first single-user studios).
- **Password & Session Security:** Passwords are hashed with `crypto.scrypt` (16-byte random salt, 64-byte key) and verified with `crypto.timingSafeEqual`. Session cookies set `HttpOnly`, `SameSite=Lax`, and `Secure` (when served over HTTPS / `X-Forwarded-Proto: https`). Changing a password revokes other active sessions.
- **Token Scoping:**
  - When opt-in collaboration is enabled, `collabToken` (2-hour TTL) is accepted **only** on WebSocket `/collab` upgrades, never on HTTP REST endpoints, and is revoked on logout.
  - Personal Bearer `sync-token` values (used by `novatex-sync`) are stored as SHA-256 hashes, restricted to project file/sync operations, and blocked from admin, AI-config, password-change, and token-management endpoints (`403`).
- **CSRF & Rate Limiting:** State-changing cookie-authenticated requests (`POST`, `PUT`, `PATCH`, `DELETE`) enforce `Origin` validation against `PUBLIC_ORIGIN` / `Host`. Auth endpoints apply sliding-window per-IP and per-username rate limiting (`429`).
- **Project RBAC & Workspace Confinement:** Project roles (`owner`, `editor`, `commenter`, `viewer`) are enforced server-side across REST and opt-in WebSocket endpoints (`readOnly` enforced server-side for `viewer`/`commenter`). `normalizeProjectRelPath` and `resolveInsideWorkspace` block `..` traversal, absolute/UNC paths, NUL bytes, Windows reserved device names, and symlink/dangling-symlink escapes.

---

## Self-Hosting Hardening Checklist

When deploying NovaTeX beyond `127.0.0.1`:

1. Keep `ALLOW_PUBLIC_REGISTER=false` and leave `ENABLE_COLLAB` unset unless you explicitly require opt-in multi-user rooms (in which case onboard members strictly via expiring, scoped project invites).
2. Terminate TLS at a reverse proxy (Nginx / Caddy), set `PUBLIC_ORIGIN=https://<your-domain>`, and bind the Node server to `HOST=127.0.0.1`.
3. Set a high-entropy `SESSION_SECRET` (or protect `DATA_DIR/.session-secret` with `0600` permissions) and back up `DATA_DIR` securely.
4. Keep `ALLOW_LUALATEX=false` and leave `ALLOW_PRIVATE_AI_HOSTS` unset unless strictly required for an admin-only trusted local LLM.
5. For untrusted multi-user deployments, run `apps/worker` in an isolated container/VM with a dedicated `COMPILER_SHARED_SECRET`, restricted egress firewall rules, and OS-level memory/CPU cgroups.

---

## Out-of-Scope / User-Controlled Risks

- Security and data handling of third-party AI providers or relay services configured by users via BYOK.
- Compromised host OS accounts with direct filesystem access to `DATA_DIR`, `.env`, or `.session-secret`.
- Denial-of-service from intentionally abusive TeX macros when running local compilation without OS-level container/cgroup limits (mitigated by single-concurrency queueing and the 60s process-tree timeout, and best isolated via `apps/worker`).
