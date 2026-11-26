import dns from 'node:dns/promises';
import type { AiProviderConfig } from '@novatex/shared';

export const DEFAULT_DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1';
export const DEFAULT_DEEPSEEK_MODEL = 'deepseek-chat';
export const DEFAULT_DEEPSEEK_REASONER_MODEL = 'deepseek-reasoner';
export const DEFAULT_AI_TIMEOUT_MS = 45_000;
export const MIN_AI_TIMEOUT_MS = 10;
export const MAX_AI_TIMEOUT_MS = 300_000;

/**
 * Sanitized public AI configuration returned to UI/API callers.
 * Intentionally omits raw `apiKey` and replaces it with `hasApiKey: boolean`.
 */
export interface AiProviderPublicConfig {
  baseUrl: string;
  hasApiKey: boolean;
  model: string;
  reasonerModel: string;
  timeoutMs: number;
}

/**
 * Environment-variable shape matching NovaTeX `.env.example` (plus DeepSeek fallbacks).
 */
export interface AiEnvConfig {
  AI_BASE_URL?: string;
  AI_API_KEY?: string;
  AI_MODEL?: string;
  AI_REASONER_MODEL?: string;
  AI_TIMEOUT_MS?: string;
  DEEPSEEK_BASE_URL?: string;
  DEEPSEEK_API_KEY?: string;
  DEEPSEEK_MODEL?: string;
  DEEPSEEK_REASONER_MODEL?: string;
}

export type AiConfigInput =
  | Partial<AiProviderConfig>
  | AiProviderPublicConfig
  | AiEnvConfig
  | Record<string, string | number | boolean | undefined>
  | undefined;

export class AiConfigError extends Error {
  readonly code = 'INVALID_CONFIG' as const;
  readonly messageZh: string;

  constructor(messageZh: string) {
    super(messageZh);
    this.name = 'AiConfigError';
    this.messageZh = messageZh;
  }
}

/**
 * Internal-only vault associating resolved public config objects with their raw API key.
 * Because WeakMap entries are completely invisible to Object.keys, JSON.stringify,
 * util.inspect, spread cloning, and Symbol reflection, raw API keys cannot accidentally
 * leak when a resolved config object is serialized or logged.
 */
const resolvedSecretVault = new WeakMap<AiProviderPublicConfig, string>();

export interface DnsLookupAddress {
  address: string;
  family: number;
}

export type DnsLookupFn = (
  hostname: string,
  options: { all: true },
) => Promise<DnsLookupAddress[]>;

export interface AiNetworkValidationOptions {
  /**
   * When true, permits loopback and private-network (RFC1918/CGNAT/ULA) hosts
   * such as self-hosted local Ollama. Cloud metadata, link-local, multicast,
   * and unspecified addresses remain unconditionally blocked.
   * Defaults strictly to false (public-network only).
   */
  allowPrivateNetwork?: boolean;
}

const BLOCKED_METADATA_HOSTS = new Set([
  'metadata.google.internal',
  'metadata.goog',
  'metadata.azure.internal',
  'metadata.tencentyun.com',
  'instance-data',
  'instance-data.ec2.internal',
  'metadata',
]);

function isBlockedMetadataHost(normalizedHost: string): boolean {
  return (
    BLOCKED_METADATA_HOSTS.has(normalizedHost) ||
    normalizedHost.endsWith('.metadata.google.internal') ||
    normalizedHost.endsWith('.metadata.goog')
  );
}

function isBlockedPrivateHostname(normalizedHost: string): boolean {
  return (
    normalizedHost === 'localhost' ||
    normalizedHost.endsWith('.localhost') ||
    normalizedHost.endsWith('.local') ||
    normalizedHost.endsWith('.internal')
  );
}

function parseIpv4Part(part: string): number | null {
  if (part.length === 0) return null;
  if (/^0[xX][0-9a-fA-F]+$/.test(part)) {
    const n = Number.parseInt(part.slice(2), 16);
    return Number.isSafeInteger(n) && n >= 0 ? n : null;
  }
  if (/^0[0-7]+$/.test(part)) {
    const n = Number.parseInt(part, 8);
    return Number.isSafeInteger(n) && n >= 0 ? n : null;
  }
  if (/^(?:0|[1-9]\d*)$/.test(part)) {
    const n = Number(part);
    return Number.isSafeInteger(n) && n >= 0 ? n : null;
  }
  return null;
}

/**
 * Parses an IPv4 literal in standard dotted-quad, shorthand (e.g. `127.1`),
 * octal (`0177.0.0.1`), hex (`0x7f000001`), or decimal integer (`2130706433`)
 * form into canonical 4 octets `[a, b, c, d]`.
 */
function parseIpv4Octets(host: string): [number, number, number, number] | null {
  const parts = host.split('.');
  if (parts.length < 1 || parts.length > 4) return null;

  const nums: number[] = [];
  for (const part of parts) {
    const n = parseIpv4Part(part);
    if (n === null) return null;
    nums.push(n);
  }

  for (let i = 0; i < nums.length - 1; i++) {
    if (nums[i]! > 255) return null;
  }

  const last = nums[nums.length - 1]!;
  const maxLast = 256 ** (5 - parts.length);
  if (last >= maxLast) return null;

  let ipv4Int = last;
  for (let i = 0; i < nums.length - 1; i++) {
    ipv4Int += nums[i]! * 256 ** (3 - i);
  }

  return [
    (ipv4Int >>> 24) & 0xff,
    (ipv4Int >>> 16) & 0xff,
    (ipv4Int >>> 8) & 0xff,
    ipv4Int & 0xff,
  ];
}

function isIpv4Literal(host: string): boolean {
  return parseIpv4Octets(host) !== null;
}

function isBlockedIpv4(host: string, opts: AiNetworkValidationOptions = {}): boolean {
  const octets = parseIpv4Octets(host);
  if (!octets) return false;
  const [a, b, c, d] = octets;

  // Unconditionally blocked even when allowPrivateNetwork is true:
  // Entire "this network" 0.0.0.0/8 range (e.g. 0.0.0.0, 0.0.0.1)
  if (a === 0) return true;
  // Cloud metadata / link-local range 169.254.0.0/16 (AWS/GCP/Azure/Alibaba IMDS)
  if (a === 169 && b === 254) return true;
  // Alibaba Cloud metadata endpoint
  if (a === 100 && b === 100 && c === 100 && d === 200) return true;
  // Multicast 224.0.0.0/4 & reserved/broadcast 240.0.0.0/4
  if (a >= 224) return true;

  if (opts.allowPrivateNetwork === true) {
    return false;
  }

  // Strict public-network mode (default): block ALL non-public IPv4 ranges
  // RFC1918 private networks: 10.0.0.0/8
  if (a === 10) return true;
  // CGNAT / shared address space: 100.64.0.0/10
  if (a === 100 && b >= 64 && b <= 127) return true;
  // Loopback: 127.0.0.0/8
  if (a === 127) return true;
  // RFC1918 private networks: 172.16.0.0/12
  if (a === 172 && b >= 16 && b <= 31) return true;
  // IETF protocol assignments 192.0.0.0/24 & TEST-NET-1 192.0.2.0/24
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
  // RFC1918 private networks: 192.168.0.0/16
  if (a === 192 && b === 168) return true;
  // Benchmarking: 198.18.0.0/15
  if (a === 198 && (b === 18 || b === 19)) return true;
  // TEST-NET-2 198.51.100.0/24 & TEST-NET-3 203.0.113.0/24
  if ((a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)) {
    return true;
  }

  return false;
}

/**
 * Parses an IPv6 address (with optional dotted-quad IPv4 tail and optional %zone)
 * into its canonical 8 16-bit hextets. Returns null if malformed.
 */
function parseIpv6Hextets(rawIpv6: string): number[] | null {
  // Strip IPv6 zone identifier if present (e.g. fe80::1%eth0)
  let clean = rawIpv6.trim().split('%')[0]!.toLowerCase();
  if (!clean) return null;

  // Convert trailing dotted-quad IPv4 (e.g. ::ffff:169.254.169.254 or 64:ff9b::169.254.169.254)
  // into two 16-bit hex groups before splitting on '::'.
  const v4Tail = clean.match(/^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4Tail?.[1] && v4Tail[2]) {
    const octets = parseIpv4Octets(v4Tail[2]);
    if (!octets) return null;
    const [a, b, c, d] = octets;
    const hi = ((a << 8) | b).toString(16);
    const lo = ((c << 8) | d).toString(16);
    clean = `${v4Tail[1]}${hi}:${lo}`;
  }

  const doubleColonParts = clean.split('::');
  if (doubleColonParts.length > 2) return null;

  let groupStrings: string[];
  if (doubleColonParts.length === 2) {
    const left = doubleColonParts[0] ? doubleColonParts[0].split(':') : [];
    const right = doubleColonParts[1] ? doubleColonParts[1].split(':') : [];
    const missing = 8 - left.length - right.length;
    if (missing < 1) return null;
    groupStrings = [...left, ...Array<string>(missing).fill('0'), ...right];
  } else {
    groupStrings = clean.split(':');
    if (groupStrings.length !== 8) return null;
  }

  const hextets: number[] = [];
  for (const g of groupStrings) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    hextets.push(parseInt(g, 16));
  }
  return hextets;
}

function hextetsToIpv4(hi: number, lo: number): string {
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

function isBlockedIpv6(rawIpv6: string, opts: AiNetworkValidationOptions = {}): boolean {
  const h = parseIpv6Hextets(rawIpv6);
  if (!h) return true; // Fail closed on unparseable IPv6 literal

  const [g0, g1, g2, g3, g4, g5, g6, g7] = h as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const allowPrivate = opts.allowPrivateNetwork === true;

  // Unspecified address :: (always blocked)
  if (
    g0 === 0 &&
    g1 === 0 &&
    g2 === 0 &&
    g3 === 0 &&
    g4 === 0 &&
    g5 === 0 &&
    g6 === 0 &&
    g7 === 0
  ) {
    return true;
  }

  // Loopback ::1 (blocked unless allowPrivateNetwork is explicitly true)
  if (
    g0 === 0 &&
    g1 === 0 &&
    g2 === 0 &&
    g3 === 0 &&
    g4 === 0 &&
    g5 === 0 &&
    g6 === 0 &&
    g7 === 1
  ) {
    return !allowPrivate;
  }

  // IPv6 link-local fe80::/10 (fe80..febf) — always blocked
  if ((g0 & 0xffc0) === 0xfe80) {
    return true;
  }

  // Deprecated site-local fec0::/10 — blocked in public-only mode
  if (!allowPrivate && (g0 & 0xffc0) === 0xfec0) {
    return true;
  }

  // Multicast ff00::/8 — always blocked
  if ((g0 & 0xff00) === 0xff00) {
    return true;
  }

  // AWS IPv6 IMDS fd00:ec2::254 — always blocked
  if (
    g0 === 0xfd00 &&
    g1 === 0x0ec2 &&
    g2 === 0 &&
    g3 === 0 &&
    g4 === 0 &&
    g5 === 0 &&
    g6 === 0 &&
    g7 === 0x0254
  ) {
    return true;
  }

  // Unique Local Addresses (ULA) fc00::/7 (fc00..fdff) — blocked in public-only mode
  if (!allowPrivate && (g0 & 0xfe00) === 0xfc00) {
    return true;
  }

  // Documentation prefix 2001:db8::/32 — blocked in public-only mode
  if (!allowPrivate && g0 === 0x2001 && g1 === 0x0db8) {
    return true;
  }

  // Teredo tunneling 2001:0000::/32
  if (g0 === 0x2001 && g1 === 0x0000) {
    if (!allowPrivate) return true;
    const serverV4 = hextetsToIpv4(g2, g3);
    const clientV4 = hextetsToIpv4(g6 ^ 0xffff, g7 ^ 0xffff);
    if (isBlockedIpv4(serverV4, opts) || isBlockedIpv4(clientV4, opts)) {
      return true;
    }
  }

  // 6to4 prefix 2002::/16 — inspect embedded IPv4 in hextets g1:g2
  if (g0 === 0x2002) {
    const embeddedV4 = hextetsToIpv4(g1, g2);
    if (isBlockedIpv4(embeddedV4, opts)) {
      return true;
    }
  }

  // NAT64 well-known prefix 64:ff9b::/96 (RFC 6052) — always blocked
  if (g0 === 0x0064 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return true;
  }

  // NAT64 local-use prefix 64:ff9b:1::/48 (RFC 8215, e.g. 64:ff9b:1::a9fe:a9fe) — always blocked
  if (g0 === 0x0064 && g1 === 0xff9b && g2 === 0x0001) {
    return true;
  }

  // SIIT IPv4-translated prefix ::ffff:0:0:0/96 (::ffff:0:*) — always blocked
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0xffff && g5 === 0) {
    return true;
  }

  // IPv4-mapped IPv6 ::ffff:0:0/96 (e.g. ::ffff:169.254.169.254, ::ffff:127.0.0.1, ::ffff:10.0.0.1)
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    const embeddedV4 = hextetsToIpv4(g6, g7);
    if (isBlockedIpv4(embeddedV4, opts)) {
      return true;
    }
  }

  // Deprecated IPv4-compatible IPv6 ::/96 (excluding :: and ::1 handled above)
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    const embeddedV4 = hextetsToIpv4(g6, g7);
    if (isBlockedIpv4(embeddedV4, opts)) {
      return true;
    }
  }

  return false;
}

function isBlockedResolvedIp(address: string, opts: AiNetworkValidationOptions = {}): boolean {
  const clean = address.trim().replace(/^\[|\]$/g, '');
  if (!clean) return true;
  if (clean.includes(':')) {
    return isBlockedIpv6(clean, opts);
  }
  if (!isIpv4Literal(clean)) {
    return true; // Fail closed on unparseable resolved IP
  }
  return isBlockedIpv4(clean, opts);
}

/**
 * Resolves a domain via DNS and verifies that EVERY returned IPv4/IPv6 address
 * passes the strict public-network SSRF policy (or, when `opts.allowPrivateNetwork`
 * is explicitly `true`, stays outside cloud metadata, link-local, multicast, NAT64,
 * and unspecified ranges).
 */
export async function validateResolvedAiHost(
  baseUrl: string,
  lookupImpl?: DnsLookupFn,
  opts?: AiNetworkValidationOptions,
): Promise<void> {
  const allowPrivateNetwork = opts?.allowPrivateNetwork === true;
  const networkOpts: AiNetworkValidationOptions = { allowPrivateNetwork };
  const normalizedUrl = validateAiBaseUrl(baseUrl, networkOpts);
  const parsed = new URL(normalizedUrl);
  const rawHostname = parsed.hostname;
  const cleanHost = rawHostname.replace(/\.+$/, '').toLowerCase();

  // Explicit IP literals (and explicit localhost when allowPrivateNetwork is true)
  // are already validated by validateAiBaseUrl above.
  if (
    (allowPrivateNetwork && cleanHost === 'localhost') ||
    isIpv4Literal(cleanHost) ||
    (cleanHost.startsWith('[') && cleanHost.endsWith(']'))
  ) {
    return;
  }

  const doLookup: DnsLookupFn =
    lookupImpl ?? ((host, lookupOpts) => dns.lookup(host, lookupOpts));

  const records = await doLookup(cleanHost, { all: true });
  if (!Array.isArray(records) || records.length === 0) {
    throw new AiConfigError(
      `安全拦截：未能解析 AI 服务域名 ${rawHostname} 的有效 IP 地址。`,
    );
  }

  for (const record of records) {
    if (
      !record ||
      typeof record.address !== 'string' ||
      isBlockedResolvedIp(record.address, networkOpts)
    ) {
      throw new AiConfigError(
        `安全拦截：AI 服务域名 ${rawHostname} 解析到了受禁地址（${record?.address ?? 'unknown'}），已阻止潜在 SSRF 访问。`,
      );
    }
  }
}

/**
 * Validates and normalizes an OpenAI-compatible AI provider `baseUrl`.
 * - Only allows `http:` and `https:` protocols.
 * - Rejects embedded credentials, query strings, and URL fragments.
 * - Enforces strict public-network SSRF protection by default (`allowPrivateNetwork = false`):
 *   blocks loopback, localhost/*.local/*.internal, RFC1918, CGNAT, ULA, link-local,
 *   cloud metadata, multicast, reserved ranges, and IPv6-wrapped private IPv4 forms.
 * - Callers may pass `{ allowPrivateNetwork: true }` explicitly to allow loopback /
 *   private LAN endpoints (e.g. self-hosted Ollama) while keeping cloud metadata blocked.
 */
export function validateAiBaseUrl(
  rawUrl: string,
  opts?: AiNetworkValidationOptions,
): string {
  const allowPrivateNetwork = opts?.allowPrivateNetwork === true;
  const networkOpts: AiNetworkValidationOptions = { allowPrivateNetwork };

  const trimmed = rawUrl.trim();
  if (!trimmed) {
    throw new AiConfigError('AI Base URL 不能为空。');
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new AiConfigError(`AI Base URL 格式无效：${trimmed}`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new AiConfigError(
      `AI Base URL 仅支持 http 或 https 协议，已拒绝：${parsed.protocol}`,
    );
  }

  if (parsed.username || parsed.password) {
    throw new AiConfigError('AI Base URL 不允许内嵌用户名或密码凭据。');
  }

  if (parsed.search || parsed.hash) {
    throw new AiConfigError('AI Base URL 不允许包含查询参数或锚点（#）。');
  }

  const rawHostname = parsed.hostname;
  if (!rawHostname) {
    throw new AiConfigError('AI Base URL 缺少有效主机名。');
  }

  const normalizedHost = rawHostname.replace(/\.+$/, '').toLowerCase();

  if (normalizedHost.startsWith('[') && normalizedHost.endsWith(']')) {
    const ipv6 = normalizedHost.slice(1, -1);
    if (isBlockedIpv6(ipv6, networkOpts)) {
      throw new AiConfigError(
        `安全拦截：AI Base URL 指向受禁的非公网、元数据或保留 IPv6 地址（${rawHostname}）。`,
      );
    }
  } else {
    if (isBlockedMetadataHost(normalizedHost)) {
      throw new AiConfigError(
        `安全拦截：AI Base URL 禁止访问云元数据主机（${rawHostname}）。`,
      );
    }

    if (!allowPrivateNetwork && isBlockedPrivateHostname(normalizedHost)) {
      throw new AiConfigError(
        `安全拦截：AI Base URL 默认禁止访问本地或内网主机（${rawHostname}）。`,
      );
    }

    if (isBlockedIpv4(normalizedHost, networkOpts)) {
      throw new AiConfigError(
        `安全拦截：AI Base URL 禁止访问非公网、内网、云元数据或保留 IPv4 地址（${rawHostname}）。`,
      );
    }
  }

  const cleanPath = parsed.pathname.replace(/\/+$/, '');
  return `${parsed.origin}${cleanPath}`;
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readTimeout(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.min(MAX_AI_TIMEOUT_MS, Math.max(MIN_AI_TIMEOUT_MS, Math.floor(value)));
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.min(MAX_AI_TIMEOUT_MS, Math.max(MIN_AI_TIMEOUT_MS, Math.floor(parsed)));
    }
  }
  return undefined;
}

/**
 * Extracts `Partial<AiProviderConfig>` from an environment-variable dictionary
 * (defaults to `process.env`).
 */
export function readAiConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): Partial<AiProviderConfig> {
  return {
    baseUrl: readNonEmptyString(env.AI_BASE_URL) ?? readNonEmptyString(env.DEEPSEEK_BASE_URL),
    apiKey: readNonEmptyString(env.AI_API_KEY) ?? readNonEmptyString(env.DEEPSEEK_API_KEY),
    model: readNonEmptyString(env.AI_MODEL) ?? readNonEmptyString(env.DEEPSEEK_MODEL),
    reasonerModel:
      readNonEmptyString(env.AI_REASONER_MODEL) ??
      readNonEmptyString(env.DEEPSEEK_REASONER_MODEL),
    timeoutMs: readTimeout(env.AI_TIMEOUT_MS),
  };
}

function extractPartialConfig(input: AiConfigInput): Partial<AiProviderConfig> {
  if (!input || typeof input !== 'object') {
    return {};
  }

  const vaultKey = resolvedSecretVault.get(input as AiProviderPublicConfig);
  const record = input as Record<string, unknown>;

  const baseUrl =
    readNonEmptyString(record.baseUrl) ??
    readNonEmptyString(record.AI_BASE_URL) ??
    readNonEmptyString(record.DEEPSEEK_BASE_URL);
  const apiKey =
    readNonEmptyString(record.apiKey) ??
    vaultKey ??
    readNonEmptyString(record.AI_API_KEY) ??
    readNonEmptyString(record.DEEPSEEK_API_KEY);
  const model =
    readNonEmptyString(record.model) ??
    readNonEmptyString(record.AI_MODEL) ??
    readNonEmptyString(record.DEEPSEEK_MODEL);
  const reasonerModel =
    readNonEmptyString(record.reasonerModel) ??
    readNonEmptyString(record.AI_REASONER_MODEL) ??
    readNonEmptyString(record.DEEPSEEK_REASONER_MODEL);
  const timeoutMs = readTimeout(record.timeoutMs) ?? readTimeout(record.AI_TIMEOUT_MS);

  return {
    baseUrl,
    apiKey,
    model,
    reasonerModel,
    timeoutMs,
  };
}

/**
 * Returns a guaranteed-clean public AI provider configuration object with zero
 * secret material attached.
 */
export function sanitizeAiConfig(config: AiProviderConfig | AiProviderPublicConfig): AiProviderPublicConfig {
  const rawKey =
    readNonEmptyString((config as AiProviderConfig).apiKey) ??
    resolvedSecretVault.get(config as AiProviderPublicConfig);
  return {
    baseUrl: config.baseUrl,
    hasApiKey: Boolean(rawKey || config.hasApiKey),
    model: config.model,
    reasonerModel: config.reasonerModel,
    timeoutMs: config.timeoutMs,
  };
}

/**
 * Auto-appends `/v1` when a user pastes a bare relay origin like `https://relay.example.com`
 * while preserving explicit paths like `/v1`, `/api/v1`, or `/v1beta/openai`.
 */
export function normalizeOpenAiBaseUrl(
  rawUrl: string,
  opts?: AiNetworkValidationOptions,
): string {
  const validated = validateAiBaseUrl(rawUrl, opts);
  const parsed = new URL(validated);
  if (parsed.pathname === '/' || parsed.pathname === '') {
    return `${parsed.origin}/v1`;
  }
  return validated;
}

/**
 * Resolves AI provider config by merging:
 *   defaults -> env/saved config -> optional per-request override.
 * Validates `baseUrl` (HTTP/HTTPS only + strict public-network SSRF protection by default)
 * and returns a sanitized public config object (`hasApiKey: boolean`, NEVER exposes raw `apiKey`).
 */
export function resolveAiConfig(
  envOrSaved?: AiConfigInput,
  override?: Partial<AiProviderConfig>,
  opts?: AiNetworkValidationOptions,
): AiProviderPublicConfig {
  const networkOpts: AiNetworkValidationOptions = {
    allowPrivateNetwork: opts?.allowPrivateNetwork === true,
  };
  const base = extractPartialConfig(envOrSaved);
  const over = extractPartialConfig(override);

  const rawBaseUrl = over.baseUrl ?? base.baseUrl ?? DEFAULT_DEEPSEEK_BASE_URL;
  const baseUrl = normalizeOpenAiBaseUrl(rawBaseUrl, networkOpts);

  // Defense-in-depth: never silently forward a saved apiKey to a different origin via override.baseUrl
  let baseOrigin: string | null = null;
  try {
    baseOrigin = new URL(base.baseUrl ?? DEFAULT_DEEPSEEK_BASE_URL).origin;
  } catch {
    baseOrigin = null;
  }
  const originChanged =
    over.baseUrl !== undefined &&
    (baseOrigin === null || new URL(baseUrl).origin !== baseOrigin);
  const apiKey = over.apiKey ?? (originChanged ? undefined : base.apiKey);
  const model = over.model ?? base.model ?? DEFAULT_DEEPSEEK_MODEL;
  const reasonerModel =
    over.reasonerModel ?? base.reasonerModel ?? DEFAULT_DEEPSEEK_REASONER_MODEL;
  const timeoutMs = over.timeoutMs ?? base.timeoutMs ?? DEFAULT_AI_TIMEOUT_MS;

  const publicConfig: AiProviderPublicConfig = {
    baseUrl,
    hasApiKey: Boolean(apiKey),
    model,
    reasonerModel,
    timeoutMs,
  };

  if (apiKey) {
    resolvedSecretVault.set(publicConfig, apiKey);
  }

  return publicConfig;
}

/**
 * Internal helper used by `client.ts` to read the API key associated with a
 * resolved config without ever exposing `apiKey` on the public object.
 */
export function readResolvedApiKey(config: AiProviderPublicConfig): string | undefined {
  return resolvedSecretVault.get(config);
}

/**
 * Returns true if the target model is a reasoning model (e.g. `deepseek-reasoner`,
 * `deepseek-r1`, `o1`/`o3`/`o4-mini`) that should not receive `temperature` or
 * `response_format: { type: 'json_object' }`.
 */
export function isReasoningModel(model: string): boolean {
  const m = model.trim().toLowerCase();
  return (
    m.includes('reasoner') ||
    m.includes('deepseek-r1') ||
    /^o[134](?:$|-)/.test(m)
  );
}
