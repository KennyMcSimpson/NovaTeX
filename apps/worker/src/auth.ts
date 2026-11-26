import crypto from 'node:crypto';

export const DEFAULT_REPLAY_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
export const DEFAULT_REPLAY_CACHE_MAX_ENTRIES = 10_000;
export const SIGNATURE_HEADER = 'x-novatex-signature';
export const TIMESTAMP_HEADER = 'x-novatex-timestamp';

const HEX_64_RE = /^[0-9a-f]{64}$/i;

/**
 * In-memory TTL replay cache keyed by `${timestamp}:${signatureHex}`.
 * Prevents identical valid signed requests from being replayed within the 5-minute window.
 */
export class HmacReplayCache {
  private readonly entries = new Map<string, number>();
  private readonly maxEntries: number;

  constructor(maxEntries = DEFAULT_REPLAY_CACHE_MAX_ENTRIES) {
    this.maxEntries = Math.max(100, Math.trunc(maxEntries));
  }

  private prune(nowMs: number): void {
    for (const [key, expiresAt] of this.entries) {
      if (expiresAt <= nowMs) {
        this.entries.delete(key);
      }
    }
    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) break;
      this.entries.delete(oldestKey);
    }
  }

  has(key: string, nowMs = Date.now()): boolean {
    const expiresAt = this.entries.get(key);
    if (expiresAt === undefined) return false;
    if (expiresAt <= nowMs) {
      this.entries.delete(key);
      return false;
    }
    return true;
  }

  record(key: string, ttlMs: number, nowMs = Date.now()): void {
    this.prune(nowMs);
    this.entries.set(key, nowMs + Math.max(1000, ttlMs));
    if (this.entries.size > this.maxEntries) {
      this.prune(nowMs);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}

/**
 * Compute HMAC-SHA256 hex digest over `${timestamp}.${rawBody}`.
 */
export function computeHmacSignature(
  secret: string,
  timestamp: string,
  rawBody: Buffer | string,
): string {
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(`${timestamp}.`, 'utf8');
  if (Buffer.isBuffer(rawBody)) {
    hmac.update(rawBody);
  } else {
    hmac.update(rawBody, 'utf8');
  }
  return hmac.digest('hex');
}

export interface ValidateHmacHeadersOptions {
  timestampHeader?: string;
  signatureHeader?: string;
  nowMs?: number;
  maxSkewMs?: number;
  replayCache?: HmacReplayCache;
}

export interface ValidateHmacHeadersResult {
  ok: boolean;
  reason?: string;
  normalizedTs?: string;
  normalizedSigHex?: string;
  replayKey?: string;
}

/**
 * Cheap pre-body header validation (run BEFORE buffering/parsing large request bodies).
 * Verifies presence, syntax, ±5-minute timestamp window, and replay-cache rejection.
 */
export function validateHmacHeadersPreBody(
  opts: ValidateHmacHeadersOptions,
): ValidateHmacHeadersResult {
  const { timestampHeader, signatureHeader, replayCache } = opts;
  const nowMs = opts.nowMs ?? Date.now();
  const maxSkewMs = opts.maxSkewMs ?? DEFAULT_REPLAY_WINDOW_MS;

  if (!timestampHeader || !signatureHeader) {
    return { ok: false, reason: 'Missing authentication headers' };
  }

  const tsTrimmed = timestampHeader.trim();
  if (!/^\d{10,16}$/.test(tsTrimmed)) {
    return { ok: false, reason: 'Invalid timestamp format' };
  }

  const parsedNum = Number(tsTrimmed);
  if (!Number.isFinite(parsedNum)) {
    return { ok: false, reason: 'Invalid timestamp value' };
  }

  // Accept Unix seconds (10 digits) or Unix milliseconds (13+ digits)
  const tsMs = parsedNum < 1e12 ? parsedNum * 1000 : parsedNum;
  if (Math.abs(nowMs - tsMs) > maxSkewMs) {
    return { ok: false, reason: 'Request timestamp outside replay window' };
  }

  let providedHex = signatureHeader.trim();
  if (providedHex.toLowerCase().startsWith('sha256=')) {
    providedHex = providedHex.slice(7).trim();
  }

  if (!HEX_64_RE.test(providedHex)) {
    return { ok: false, reason: 'Malformed signature format' };
  }

  const normalizedSigHex = providedHex.toLowerCase();
  const replayKey = `${tsTrimmed}:${normalizedSigHex}`;

  if (replayCache && replayCache.has(replayKey, nowMs)) {
    return { ok: false, reason: 'Replayed request signature' };
  }

  return {
    ok: true,
    normalizedTs: tsTrimmed,
    normalizedSigHex,
    replayKey,
  };
}

export interface VerifyHmacOptions {
  secret: string;
  timestampHeader?: string;
  signatureHeader?: string;
  rawBody: Buffer;
  nowMs?: number;
  maxSkewMs?: number;
  replayCache?: HmacReplayCache;
}

export interface VerifyHmacResult {
  ok: boolean;
  reason?: string;
}

/**
 * Verify `x-novatex-signature` + `x-novatex-timestamp` using `crypto.timingSafeEqual`,
 * enforce the ±5-minute timestamp window, and reject/record replayed signatures.
 */
export function verifyHmacSignature(opts: VerifyHmacOptions): VerifyHmacResult {
  const { secret, timestampHeader, signatureHeader, rawBody, replayCache } = opts;
  const nowMs = opts.nowMs ?? Date.now();
  const maxSkewMs = opts.maxSkewMs ?? DEFAULT_REPLAY_WINDOW_MS;

  const headerCheck = validateHmacHeadersPreBody({
    timestampHeader,
    signatureHeader,
    nowMs,
    maxSkewMs,
    replayCache,
  });
  if (!headerCheck.ok || !headerCheck.normalizedTs || !headerCheck.normalizedSigHex) {
    return { ok: false, reason: headerCheck.reason ?? 'Invalid authentication headers' };
  }

  const expectedHex = computeHmacSignature(secret, headerCheck.normalizedTs, rawBody);
  const providedBuf = Buffer.from(headerCheck.normalizedSigHex, 'hex');
  const expectedBuf = Buffer.from(expectedHex.toLowerCase(), 'hex');

  if (providedBuf.length !== expectedBuf.length) {
    return { ok: false, reason: 'Invalid signature' };
  }

  if (!crypto.timingSafeEqual(providedBuf, expectedBuf)) {
    return { ok: false, reason: 'Invalid signature' };
  }

  if (replayCache && headerCheck.replayKey) {
    if (replayCache.has(headerCheck.replayKey, nowMs)) {
      return { ok: false, reason: 'Replayed request signature' };
    }
    replayCache.record(headerCheck.replayKey, maxSkewMs, nowMs);
  }

  return { ok: true };
}
