import {
  computeLineDiff,
  type AiFixMode,
  type AiFixRequest,
  type AiFixResponse,
} from '@novatex/shared';
import {
  AiConfigError,
  isReasoningModel,
  readResolvedApiKey,
  resolveAiConfig,
  validateResolvedAiHost,
  type AiConfigInput,
  type AiProviderPublicConfig,
  type DnsLookupFn,
} from './config.js';
import {
  buildAiPrompt,
  splicePatchedWindow,
  stripOuterCodeFenceIfAccidental,
  type PreparedPromptWindow,
} from './prompts.js';

/**
 * Maximum allowed line drop fraction before anti-truncation safeguard rejects a
 * response (strictly > 60% line disappearance triggers protection).
 */
export const ANTI_TRUNCATION_MAX_DROP_RATIO = 0.6;
export const ANTI_TRUNCATION_MIN_LINES_FOR_RATIO = 5;

const VALID_MODES = new Set<AiFixMode>([
  'diagnose-and-fix',
  'format-table',
  'format-math',
  'cleanup-conversion',
]);

export type AiFixerErrorCode =
  | 'MISSING_API_KEY'
  | 'INVALID_CONFIG'
  | 'INVALID_REQUEST'
  | 'REDIRECT_BLOCKED'
  | 'HTTP_AUTH_ERROR'
  | 'HTTP_RATE_LIMIT'
  | 'HTTP_ERROR'
  | 'TIMEOUT'
  | 'NETWORK_ERROR'
  | 'INVALID_RESPONSE';

export class AiFixerError extends Error {
  readonly code: AiFixerErrorCode;
  readonly status?: number;
  readonly messageZh: string;

  constructor(code: AiFixerErrorCode, messageZh: string, status?: number) {
    super(messageZh);
    this.name = 'AiFixerError';
    this.code = code;
    this.status = status;
    this.messageZh = messageZh;
  }
}

export interface AiCallOptions {
  /** Injectable fetch implementation for deterministic unit testing */
  fetchImpl?: typeof fetch;
  /** Injectable DNS lookup implementation for deterministic SSRF/DNS testing */
  lookupImpl?: DnsLookupFn;
  /** Optional external abort signal */
  signal?: AbortSignal;
  /**
   * Explicitly opt in to loopback/private-network AI endpoints (e.g. local Ollama
   * when server sets ALLOW_PRIVATE_AI_HOSTS=true). Defaults strictly to false.
   */
  allowPrivateNetwork?: boolean;
}

export interface AiConnectionTestResult {
  ok: boolean;
  latencyMs: number;
  messageZh: string;
}

export interface ParsedAiFixPayload {
  summaryZh: string;
  rootCauseZh: string;
  actionsTakenZh: string[];
  patchedCode: string;
  warningsZh: string[];
}

interface ChatCompletionResponseBody {
  model?: unknown;
  choices?: Array<{
    finish_reason?: unknown;
    message?: {
      content?: unknown;
      reasoning_content?: unknown;
    };
  }>;
  usage?: {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    total_tokens?: unknown;
  };
  error?: {
    message?: unknown;
    type?: unknown;
    code?: unknown;
  };
}

const REDIRECT_BLOCKED_MESSAGE_ZH =
  '安全策略已拦截 AI 接口重定向请求，已拒绝跟随外部跳转以防范 SSRF 风险。';

function redactSecret(text: string, secret: string | undefined): string {
  if (!secret || secret.length < 4) return text;
  return text.split(secret).join('[REDACTED]');
}

function isRedirectFetchError(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current != null; depth++) {
    if (current instanceof Error) {
      if (/redirect/i.test(current.message)) {
        return true;
      }
      current = (current as { cause?: unknown }).cause;
    } else if (typeof current === 'string') {
      return /redirect/i.test(current);
    } else {
      break;
    }
  }
  return false;
}

function createLinkedAbortController(
  timeoutMs: number,
  externalSignal?: AbortSignal,
): {
  controller: AbortController;
  didTimeout: () => boolean;
  cleanup: () => void;
} {
  const controller = new AbortController();
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`AI request timed out after ${timeoutMs}ms`));
  }, timeoutMs);

  const onExternalAbort = (): void => {
    controller.abort(externalSignal?.reason);
  };

  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort(externalSignal.reason);
    } else {
      externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
  }

  return {
    controller,
    didTimeout: () => timedOut,
    cleanup: () => {
      clearTimeout(timer);
      if (externalSignal) {
        externalSignal.removeEventListener('abort', onExternalAbort);
      }
    },
  };
}

function tryParseJsonObject(candidate: string): Record<string, unknown> | null {
  const trimmed = candidate.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Extracts balanced top-level `{ ... }` JSON object substrings while respecting
 * JSON string quotes and backslash escapes.
 */
function findBalancedJsonObjects(text: string): string[] {
  const results: string[] = [];
  let inString = false;
  let escaped = false;
  let depth = 0;
  let startIdx = -1;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      if (depth === 0) {
        startIdx = i;
      }
      depth++;
    } else if (ch === '}') {
      if (depth > 0) {
        depth--;
        if (depth === 0 && startIdx >= 0) {
          results.push(text.slice(startIdx, i + 1));
          startIdx = -1;
        }
      }
    }
  }
  return results;
}

function normalizePayloadObject(obj: Record<string, unknown>): ParsedAiFixPayload | null {
  if (typeof obj.patchedCode !== 'string') {
    return null;
  }

  const summaryZh =
    typeof obj.summaryZh === 'string' && obj.summaryZh.trim().length > 0
      ? obj.summaryZh.trim()
      : '已完成 LaTeX 代码修复与整理。';

  const rootCauseZh =
    typeof obj.rootCauseZh === 'string' ? obj.rootCauseZh.trim() : '';

  const actionsTakenZh = Array.isArray(obj.actionsTakenZh)
    ? obj.actionsTakenZh
        .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        .map((s) => s.trim())
    : [];

  const warningsZh = Array.isArray(obj.warningsZh)
    ? obj.warningsZh
        .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        .map((s) => s.trim())
    : [];

  return {
    summaryZh,
    rootCauseZh,
    actionsTakenZh,
    patchedCode: obj.patchedCode,
    warningsZh,
  };
}

/**
 * Robustly extracts structured JSON fix payload from model `content` (supporting
 * plain JSON, ```json fenced blocks, `<think>...</think>` wrappers, and surrounding
 * prose from reasoning models like `deepseek-reasoner`).
 */
export function extractJsonFixPayload(
  rawContent: string,
  reasoningContent?: string,
): ParsedAiFixPayload {
  const trimmed = rawContent.trim();
  if (!trimmed) {
    if (reasoningContent && reasoningContent.trim().length > 0) {
      throw new AiFixerError(
        'INVALID_RESPONSE',
        '推理模型仅返回了思考过程而未输出最终 JSON 修复结果，请缩小修复选区或重试。',
      );
    }
    throw new AiFixerError('INVALID_RESPONSE', 'AI 返回内容为空，未能解析修复结果。');
  }

  // Strip optional <think>...</think> blocks emitted by self-hosted R1 endpoints
  const withoutThink = trimmed.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

  const candidates: string[] = [trimmed];
  if (withoutThink && withoutThink !== trimmed) {
    candidates.push(withoutThink);
  }

  // Extract fenced blocks (prefer ```json blocks first, then any ``` block)
  const fenceRegex = /```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n?```/gi;
  let match: RegExpExecArray | null;
  while ((match = fenceRegex.exec(withoutThink)) !== null) {
    if (match[1]) {
      candidates.push(match[1].trim());
    }
  }

  // Fallback: balanced top-level `{ ... }` objects in text
  for (const objStr of findBalancedJsonObjects(withoutThink)) {
    candidates.push(objStr);
  }

  for (const candidate of candidates) {
    const parsed = tryParseJsonObject(candidate);
    if (!parsed) continue;
    const normalized = normalizePayloadObject(parsed);
    if (normalized) {
      return normalized;
    }
  }

  throw new AiFixerError(
    'INVALID_RESPONSE',
    'AI 返回结果不是合法的结构化 JSON（缺少 patchedCode 字段），请重试或切换模型。',
  );
}

export interface SafetyValidationResult {
  safe: boolean;
  reasonZh?: string;
}

function countLines(text: string): { total: number; nonEmpty: number } {
  const norm = text.replace(/\r\n/g, '\n');
  if (norm.trim().length === 0) {
    return { total: 0, nonEmpty: 0 };
  }
  const stripped = norm.endsWith('\n') ? norm.slice(0, -1) : norm;
  const lines = stripped.split('\n');
  const nonEmpty = lines.filter((l) => l.trim().length > 0).length;
  return { total: lines.length, nonEmpty };
}

/**
 * Validates that the AI's patched output did not wipe or severely truncate the
 * user's LaTeX manuscript (rejects empty output for non-empty source and rejects
 * >60% unexpected line loss on either the editable window or the full document).
 */
export function validatePatchedCodeSafety(
  originalSource: string,
  window: PreparedPromptWindow,
  patchedWindowCode: string,
  finalPatchedCode: string,
): SafetyValidationResult {
  const origWindowStats = countLines(window.editableCode);
  const patchedWindowStats = countLines(patchedWindowCode);

  if (origWindowStats.nonEmpty > 0 && patchedWindowStats.nonEmpty === 0) {
    return {
      safe: false,
      reasonZh:
        '反截断保护已触发：AI 返回了空代码，已自动拦截并保留原始内容以防论文内容丢失。',
    };
  }

  if (origWindowStats.total >= ANTI_TRUNCATION_MIN_LINES_FOR_RATIO) {
    const totalDrop = (origWindowStats.total - patchedWindowStats.total) / origWindowStats.total;
    const nonEmptyDrop =
      origWindowStats.nonEmpty >= ANTI_TRUNCATION_MIN_LINES_FOR_RATIO
        ? (origWindowStats.nonEmpty - patchedWindowStats.nonEmpty) / origWindowStats.nonEmpty
        : 0;
    const worstDrop = Math.max(totalDrop, nonEmptyDrop);
    if (worstDrop > ANTI_TRUNCATION_MAX_DROP_RATIO) {
      const pct = Math.round(worstDrop * 100);
      return {
        safe: false,
        reasonZh: `反截断保护已触发：目标区域原有 ${origWindowStats.total} 行（非空 ${origWindowStats.nonEmpty} 行），AI 输出仅剩 ${patchedWindowStats.total} 行（非空 ${patchedWindowStats.nonEmpty} 行，减少约 ${pct}%，超过 60% 安全阈值）。已自动保留原文件，请缩小选区或启用推理模型重试。`,
      };
    }
  }

  if (window.isWindowed) {
    const origFullStats = countLines(originalSource);
    const finalFullStats = countLines(finalPatchedCode);
    if (origFullStats.nonEmpty > 0 && finalFullStats.nonEmpty === 0) {
      return {
        safe: false,
        reasonZh: '反截断保护已触发：拼接结果为空，已自动保留原文件。',
      };
    }
    if (origFullStats.total >= ANTI_TRUNCATION_MIN_LINES_FOR_RATIO) {
      const fullDrop = (origFullStats.total - finalFullStats.total) / origFullStats.total;
      if (fullDrop > ANTI_TRUNCATION_MAX_DROP_RATIO) {
        const pct = Math.round(fullDrop * 100);
        return {
          safe: false,
          reasonZh: `反截断保护已触发：拼接后全文减少约 ${pct}%（超过 60% 安全阈值），已自动保留原文件。`,
        };
      }
    }
  }

  return { safe: true };
}

function extractUpstreamErrorMessage(
  rawBody: string,
  apiKey: string | undefined,
): string {
  try {
    const parsed = JSON.parse(rawBody) as ChatCompletionResponseBody;
    if (parsed?.error && typeof parsed.error.message === 'string') {
      return redactSecret(parsed.error.message.trim(), apiKey).slice(0, 240);
    }
  } catch {
    // non-JSON error body
  }
  const redacted = redactSecret(rawBody.trim(), apiKey);
  if (!redacted) return '';
  // Keep non-JSON/HTML raw error bodies compact without ReDoS-prone tag stripping
  const bounded = redacted.slice(0, 2048);
  const compact = /^</.test(bounded)
    ? bounded.replace(/<[^<>]*>/g, ' ').replace(/\s+/g, ' ').trim()
    : bounded.replace(/\s+/g, ' ').trim();
  return compact.slice(0, 160);
}

function buildHttpError(
  status: number,
  rawBody: string,
  apiKey: string | undefined,
): AiFixerError {
  const detail = extractUpstreamErrorMessage(rawBody, apiKey);
  const suffix = detail ? `（${detail}）` : '';

  if (status === 401 || status === 403) {
    return new AiFixerError(
      'HTTP_AUTH_ERROR',
      `AI 接口鉴权失败（HTTP ${status}）：请检查 API Key 是否正确或有效${suffix}。`,
      status,
    );
  }
  if (status === 429) {
    return new AiFixerError(
      'HTTP_RATE_LIMIT',
      `AI 接口触发限流或额度不足（HTTP 429）：请稍后重试或检查账户余额${suffix}。`,
      status,
    );
  }
  if (status === 404) {
    return new AiFixerError(
      'HTTP_ERROR',
      `AI 接口地址或模型不存在（HTTP 404）：请检查 Base URL 与模型名${suffix}。`,
      status,
    );
  }
  return new AiFixerError(
    'HTTP_ERROR',
    `AI 服务返回错误（HTTP ${status}）${suffix}。`,
    status,
  );
}

/**
 * Calls the configured DeepSeek / OpenAI-compatible AI provider to perform one of
 * the 4 strictly scoped LaTeX repair/formatting operations, splices windowed edits
 * safely back into `request.sourceCode`, checks anti-truncation safeguards, and
 * computes a line-level red/green unified diff via `@novatex/shared`.
 */
export async function fixLatexWithAi(
  request: AiFixRequest,
  envOrSavedConfig?: AiConfigInput,
  options?: AiCallOptions,
): Promise<AiFixResponse> {
  if (!VALID_MODES.has(request.mode)) {
    throw new AiFixerError(
      'INVALID_REQUEST',
      `不支持的 AI 修复模式：${String(request.mode)}`,
    );
  }

  const networkOpts = { allowPrivateNetwork: options?.allowPrivateNetwork === true };
  let resolved: AiProviderPublicConfig;
  try {
    resolved = resolveAiConfig(envOrSavedConfig, request.providerOverride, networkOpts);
  } catch (err) {
    if (err instanceof AiConfigError) {
      throw new AiFixerError('INVALID_CONFIG', err.messageZh);
    }
    throw err;
  }

  const apiKey = readResolvedApiKey(resolved);
  if (!apiKey) {
    throw new AiFixerError(
      'MISSING_API_KEY',
      '尚未配置 AI API Key：请在设置中填写 DeepSeek 或兼容服务的 API Key（环境变量 AI_API_KEY）。',
    );
  }

  const built = buildAiPrompt(request);
  const targetModel = request.useReasoner ? resolved.reasonerModel : resolved.model;
  const reasoner = Boolean(request.useReasoner) || isReasoningModel(targetModel);

  const payload: Record<string, unknown> = {
    model: targetModel,
    messages: [
      { role: 'system', content: built.systemPrompt },
      { role: 'user', content: built.userPrompt },
    ],
  };

  // DeepSeek R1 / reasoner endpoints ignore or reject temperature and json_object
  if (!reasoner) {
    payload.temperature = 0.1;
    payload.response_format = { type: 'json_object' };
  }

  const fetchFn = options?.fetchImpl ?? globalThis.fetch;
  if (typeof fetchFn !== 'function') {
    throw new AiFixerError('NETWORK_ERROR', '当前运行环境不支持全局 fetch。');
  }

  // Enforce DNS-resolution SSRF check in production and whenever lookupImpl is injected
  const shouldValidateDns = !options?.fetchImpl || Boolean(options?.lookupImpl);
  if (shouldValidateDns) {
    try {
      await validateResolvedAiHost(resolved.baseUrl, options?.lookupImpl, networkOpts);
    } catch (err) {
      if (err instanceof AiConfigError) {
        throw new AiFixerError('INVALID_CONFIG', err.messageZh);
      }
      const rawMsg = err instanceof Error ? err.message : String(err);
      throw new AiFixerError(
        'NETWORK_ERROR',
        `AI 域名解析失败：${redactSecret(rawMsg, apiKey)}`,
      );
    }
  }

  const endpoint = `${resolved.baseUrl.replace(/\/$/, '')}/chat/completions`;
  const { controller, didTimeout, cleanup } = createLinkedAbortController(
    resolved.timeoutMs,
    options?.signal,
  );

  const sendCompletionRequest = async (
    reqPayload: Record<string, unknown>,
  ): Promise<{ response: Response; responseText: string }> => {
    const res = await fetchFn(endpoint, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(reqPayload),
      signal: controller.signal,
    });
    if (res.status >= 300 && res.status < 400) {
      throw new AiFixerError('REDIRECT_BLOCKED', REDIRECT_BLOCKED_MESSAGE_ZH, res.status);
    }
    const text = await res.text();
    return { response: res, responseText: text };
  };

  let response: Response;
  let responseText: string;
  try {
    ({ response, responseText } = await sendCompletionRequest(payload));

    // Some third-party OpenAI-compatible relays (e.g. NewAPI / VolcEngine channels
    // running thinking models) reject `response_format: { type: 'json_object' }`
    // with HTTP 400 or 422. Automatically retry ONCE without `response_format`
    // while keeping the exact same SSRF, redirect: 'error', and timeout guardrails.
    if (
      payload.response_format !== undefined &&
      (response.status === 400 || response.status === 422)
    ) {
      if (shouldValidateDns) {
        try {
          await validateResolvedAiHost(resolved.baseUrl, options?.lookupImpl, networkOpts);
        } catch (err) {
          if (err instanceof AiConfigError) {
            throw new AiFixerError('INVALID_CONFIG', err.messageZh);
          }
          const rawMsg = err instanceof Error ? err.message : String(err);
          throw new AiFixerError(
            'NETWORK_ERROR',
            `AI 域名解析失败：${redactSecret(rawMsg, apiKey)}`,
          );
        }
      }
      const fallbackPayload: Record<string, unknown> = { ...payload };
      delete fallbackPayload.response_format;
      ({ response, responseText } = await sendCompletionRequest(fallbackPayload));
    }
  } catch (err) {
    if (err instanceof AiFixerError) {
      throw err;
    }
    if (isRedirectFetchError(err)) {
      throw new AiFixerError('REDIRECT_BLOCKED', REDIRECT_BLOCKED_MESSAGE_ZH);
    }
    if (didTimeout()) {
      throw new AiFixerError(
        'TIMEOUT',
        `AI 请求超时（超过 ${resolved.timeoutMs} ms），请稍后重试或适当增大超时时间。`,
      );
    }
    const rawMsg = err instanceof Error ? err.message : String(err);
    throw new AiFixerError(
      'NETWORK_ERROR',
      `AI 网络请求失败：${redactSecret(rawMsg, apiKey)}`,
    );
  } finally {
    cleanup();
  }

  if (!response.ok) {
    throw buildHttpError(response.status, responseText, apiKey);
  }

  let body: ChatCompletionResponseBody;
  try {
    body = JSON.parse(responseText) as ChatCompletionResponseBody;
  } catch {
    throw new AiFixerError(
      'INVALID_RESPONSE',
      'AI 服务返回了无法解析的非 JSON 响应体。',
    );
  }

  const firstChoice = Array.isArray(body.choices) ? body.choices[0] : undefined;
  if (!firstChoice || !firstChoice.message) {
    throw new AiFixerError(
      'INVALID_RESPONSE',
      'AI 服务响应缺少 choices[0].message 字段。',
    );
  }

  const rawContent =
    typeof firstChoice.message.content === 'string' ? firstChoice.message.content : '';
  const reasoningContent =
    typeof firstChoice.message.reasoning_content === 'string'
      ? firstChoice.message.reasoning_content
      : undefined;

  const parsed = extractJsonFixPayload(rawContent, reasoningContent);

  const modelUsed =
    typeof body.model === 'string' && body.model.trim().length > 0
      ? body.model.trim()
      : targetModel;

  const usage = body.usage
    ? {
        promptTokens:
          typeof body.usage.prompt_tokens === 'number'
            ? body.usage.prompt_tokens
            : undefined,
        completionTokens:
          typeof body.usage.completion_tokens === 'number'
            ? body.usage.completion_tokens
            : undefined,
        totalTokens:
          typeof body.usage.total_tokens === 'number'
            ? body.usage.total_tokens
            : undefined,
      }
    : undefined;

  const warningsZh = [...parsed.warningsZh];
  if (firstChoice.finish_reason === 'length') {
    warningsZh.push('模型输出触达长度上限（finish_reason=length），请仔细复核改动完整性。');
  }

  const cleanedWindowCode = stripOuterCodeFenceIfAccidental(
    parsed.patchedCode,
    built.window.editableCode,
  );

  const finalPatchedCode = splicePatchedWindow(
    request.sourceCode,
    built.window,
    cleanedWindowCode,
  );

  const safety = validatePatchedCodeSafety(
    request.sourceCode,
    built.window,
    cleanedWindowCode,
    finalPatchedCode,
  );

  if (!safety.safe) {
    const safeReason =
      safety.reasonZh ?? '反截断保护已触发：AI 输出疑似丢失大量原文，已自动拦截。';
    warningsZh.unshift(safeReason);
    return {
      ok: false,
      mode: request.mode,
      modelUsed,
      summaryZh: '安全拦截：AI 返回结果疑似被截断，已保留原文件未做修改。',
      rootCauseZh: parsed.rootCauseZh || safeReason,
      actionsTakenZh: [],
      patchedCode: request.sourceCode,
      diff: computeLineDiff(request.sourceCode, request.sourceCode, request.filePath),
      warningsZh,
      usage,
    };
  }

  const diff = computeLineDiff(request.sourceCode, finalPatchedCode, request.filePath);

  return {
    ok: true,
    mode: request.mode,
    modelUsed,
    summaryZh: parsed.summaryZh,
    rootCauseZh: parsed.rootCauseZh,
    actionsTakenZh: parsed.actionsTakenZh,
    patchedCode: finalPatchedCode,
    diff,
    warningsZh: warningsZh.length > 0 ? warningsZh : undefined,
    usage,
  };
}

/**
 * Tests connectivity, credentials, and model availability for the UI Settings
 * "测试连接" button. Never throws on network/auth/timeout errors; always returns
 * a structured Chinese status object with latency in milliseconds.
 */
export async function testAiConnection(
  config: AiConfigInput,
  options?: AiCallOptions,
): Promise<AiConnectionTestResult> {
  const networkOpts = { allowPrivateNetwork: options?.allowPrivateNetwork === true };
  let resolved: AiProviderPublicConfig;
  try {
    resolved = resolveAiConfig(config, undefined, networkOpts);
  } catch (err) {
    const msg = err instanceof AiConfigError ? err.messageZh : 'AI 配置无效。';
    return { ok: false, latencyMs: 0, messageZh: msg };
  }

  const apiKey = readResolvedApiKey(resolved);
  if (!apiKey) {
    return {
      ok: false,
      latencyMs: 0,
      messageZh: '尚未配置 AI API Key，请先填写后再测试连接。',
    };
  }

  const fetchFn = options?.fetchImpl ?? globalThis.fetch;
  if (typeof fetchFn !== 'function') {
    return {
      ok: false,
      latencyMs: 0,
      messageZh: '当前运行环境不支持全局 fetch。',
    };
  }

  const shouldValidateDns = !options?.fetchImpl || Boolean(options?.lookupImpl);
  if (shouldValidateDns) {
    try {
      await validateResolvedAiHost(resolved.baseUrl, options?.lookupImpl, networkOpts);
    } catch (err) {
      if (err instanceof AiConfigError) {
        return {
          ok: false,
          latencyMs: 0,
          messageZh: err.messageZh,
        };
      }
      const rawMsg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        latencyMs: 0,
        messageZh: `连接失败（域名解析异常）：${redactSecret(rawMsg, apiKey)}`,
      };
    }
  }

  const effectiveTimeoutMs = Math.min(resolved.timeoutMs, 15_000);
  const reasoner = isReasoningModel(resolved.model);
  const bodyPayload: Record<string, unknown> = {
    model: resolved.model,
    messages: [{ role: 'user', content: 'Reply with OK.' }],
    max_tokens: reasoner ? 32 : 8,
  };
  if (!reasoner) {
    bodyPayload.temperature = 0;
  }

  const endpoint = `${resolved.baseUrl.replace(/\/$/, '')}/chat/completions`;
  const { controller, didTimeout, cleanup } = createLinkedAbortController(
    effectiveTimeoutMs,
    options?.signal,
  );

  const startedAt = Date.now();
  try {
    const response = await fetchFn(endpoint, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(bodyPayload),
      signal: controller.signal,
    });
    const latencyMs = Math.max(0, Date.now() - startedAt);

    if (response.status >= 300 && response.status < 400) {
      return {
        ok: false,
        latencyMs,
        messageZh: REDIRECT_BLOCKED_MESSAGE_ZH,
      };
    }

    const text = await response.text();

    if (!response.ok) {
      const httpErr = buildHttpError(response.status, text, apiKey);
      return {
        ok: false,
        latencyMs,
        messageZh: httpErr.messageZh,
      };
    }

    try {
      const parsed = JSON.parse(text) as ChatCompletionResponseBody;
      const reportedModel =
        typeof parsed.model === 'string' && parsed.model.trim()
          ? parsed.model.trim()
          : resolved.model;
      return {
        ok: true,
        latencyMs,
        messageZh: `连接成功（模型：${reportedModel}，耗时 ${latencyMs} ms）。`,
      };
    } catch {
      return {
        ok: false,
        latencyMs,
        messageZh: '接口返回 HTTP 200 但响应不是合法 JSON，请检查 Base URL 是否指向兼容的 OpenAI v1 端点。',
      };
    }
  } catch (err) {
    const latencyMs = Math.max(0, Date.now() - startedAt);
    if (isRedirectFetchError(err)) {
      return {
        ok: false,
        latencyMs,
        messageZh: REDIRECT_BLOCKED_MESSAGE_ZH,
      };
    }
    if (didTimeout()) {
      return {
        ok: false,
        latencyMs,
        messageZh: `连接超时（超过 ${effectiveTimeoutMs} ms），请检查网络或 Base URL。`,
      };
    }
    const rawMsg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      latencyMs,
      messageZh: `连接失败：${redactSecret(rawMsg, apiKey)}`,
    };
  } finally {
    cleanup();
  }
}

export interface AiModelsListResult {
  ok: boolean;
  models: string[];
  normalizedBaseUrl: string;
  latencyMs: number;
  messageZh: string;
}

/**
 * Fetches available OpenAI-compatible model IDs from `${baseUrl}/models`
 * with full SSRF + DNS + redirect='error' protection.
 */
export async function listAiModels(
  config: AiConfigInput,
  options?: AiCallOptions,
): Promise<AiModelsListResult> {
  const networkOpts = { allowPrivateNetwork: options?.allowPrivateNetwork === true };
  let resolved: AiProviderPublicConfig;
  try {
    resolved = resolveAiConfig(config, undefined, networkOpts);
  } catch (err) {
    const msg = err instanceof AiConfigError ? err.messageZh : 'AI 配置无效。';
    return { ok: false, models: [], normalizedBaseUrl: '', latencyMs: 0, messageZh: msg };
  }

  const apiKey = readResolvedApiKey(resolved);
  if (!apiKey) {
    return {
      ok: false,
      models: [],
      normalizedBaseUrl: resolved.baseUrl,
      latencyMs: 0,
      messageZh: '请先填写 API Key 后再拉取模型列表。',
    };
  }

  const fetchFn = options?.fetchImpl ?? globalThis.fetch;
  if (typeof fetchFn !== 'function') {
    return {
      ok: false,
      models: [],
      normalizedBaseUrl: resolved.baseUrl,
      latencyMs: 0,
      messageZh: '当前运行环境不支持全局 fetch。',
    };
  }

  const shouldValidateDns = !options?.fetchImpl || Boolean(options?.lookupImpl);
  if (shouldValidateDns) {
    try {
      await validateResolvedAiHost(resolved.baseUrl, options?.lookupImpl, networkOpts);
    } catch (err) {
      const msg =
        err instanceof AiConfigError
          ? err.messageZh
          : `域名解析异常：${redactSecret(err instanceof Error ? err.message : String(err), apiKey)}`;
      return {
        ok: false,
        models: [],
        normalizedBaseUrl: resolved.baseUrl,
        latencyMs: 0,
        messageZh: msg,
      };
    }
  }

  const effectiveTimeoutMs = Math.min(resolved.timeoutMs, 15_000);
  const endpoint = `${resolved.baseUrl.replace(/\/$/, '')}/models`;
  const { controller, didTimeout, cleanup } = createLinkedAbortController(
    effectiveTimeoutMs,
    options?.signal,
  );
  const startedAt = Date.now();
  try {
    const response = await fetchFn(endpoint, {
      method: 'GET',
      redirect: 'error',
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
    });
    const latencyMs = Math.max(0, Date.now() - startedAt);
    if (response.status >= 300 && response.status < 400) {
      return {
        ok: false,
        models: [],
        normalizedBaseUrl: resolved.baseUrl,
        latencyMs,
        messageZh: REDIRECT_BLOCKED_MESSAGE_ZH,
      };
    }
    const text = await response.text();
    if (!response.ok) {
      const httpErr = buildHttpError(response.status, text, apiKey);
      return {
        ok: false,
        models: [],
        normalizedBaseUrl: resolved.baseUrl,
        latencyMs,
        messageZh: httpErr.messageZh,
      };
    }

    const parsed = JSON.parse(text) as {
      data?: Array<{ id?: unknown }>;
      models?: Array<{ id?: unknown } | string>;
    };
    const rawList = Array.isArray(parsed.data)
      ? parsed.data.map((m) => (typeof m?.id === 'string' ? m.id.trim() : ''))
      : Array.isArray(parsed.models)
        ? parsed.models.map((m) =>
            typeof m === 'string' ? m.trim() : typeof m?.id === 'string' ? m.id.trim() : '',
          )
        : [];
    const unique = Array.from(new Set(rawList.filter(Boolean)));
    // Prioritize DeepSeek / Flash / Reasoner models at the top while keeping alphabetical order within groups
    const score = (id: string): number => {
      const lower = id.toLowerCase();
      if (/deep?seek|deekseek/.test(lower)) return 0;
      if (/flash|reasoner|r1|coder/.test(lower)) return 1;
      return 2;
    };
    unique.sort((a, b) => score(a) - score(b) || a.localeCompare(b));

    return {
      ok: true,
      models: unique,
      normalizedBaseUrl: resolved.baseUrl,
      latencyMs,
      messageZh:
        unique.length > 0
          ? `已拉取 ${unique.length} 个可用模型（耗时 ${latencyMs} ms）。`
          : '接口返回成功，但模型列表为空，请手动输入模型 ID。',
    };
  } catch (err) {
    const latencyMs = Math.max(0, Date.now() - startedAt);
    if (isRedirectFetchError(err)) {
      return {
        ok: false,
        models: [],
        normalizedBaseUrl: resolved.baseUrl,
        latencyMs,
        messageZh: REDIRECT_BLOCKED_MESSAGE_ZH,
      };
    }
    if (didTimeout()) {
      return {
        ok: false,
        models: [],
        normalizedBaseUrl: resolved.baseUrl,
        latencyMs,
        messageZh: `拉取模型超时（超过 ${effectiveTimeoutMs} ms），请检查网络或 Base URL。`,
      };
    }
    const rawMsg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      models: [],
      normalizedBaseUrl: resolved.baseUrl,
      latencyMs,
      messageZh: `拉取模型失败：${redactSecret(rawMsg, apiKey)}`,
    };
  } finally {
    cleanup();
  }
}

export interface AiFixerClient {
  getPublicConfig(override?: AiConfigInput): AiProviderPublicConfig;
  fix(request: AiFixRequest, options?: AiCallOptions): Promise<AiFixResponse>;
  testConnection(override?: AiConfigInput, options?: AiCallOptions): Promise<AiConnectionTestResult>;
}

/**
 * Convenience factory creating a pre-configured AI fixer client bound to saved/env config.
 */
export function createAiFixerClient(
  baseConfig?: AiConfigInput,
  defaultOptions?: AiCallOptions,
): AiFixerClient {
  return {
    getPublicConfig(override?: AiConfigInput): AiProviderPublicConfig {
      return resolveAiConfig(
        baseConfig,
        override as Partial<AiProviderPublicConfig> | undefined,
        { allowPrivateNetwork: defaultOptions?.allowPrivateNetwork === true },
      );
    },
    fix(request: AiFixRequest, options?: AiCallOptions): Promise<AiFixResponse> {
      return fixLatexWithAi(request, baseConfig, {
        ...defaultOptions,
        ...options,
      });
    },
    testConnection(
      override?: AiConfigInput,
      options?: AiCallOptions,
    ): Promise<AiConnectionTestResult> {
      const mergedOptions: AiCallOptions = {
        ...defaultOptions,
        ...options,
      };
      let merged: AiConfigInput;
      try {
        merged = override
          ? resolveAiConfig(baseConfig, override as Record<string, unknown>, {
              allowPrivateNetwork: mergedOptions.allowPrivateNetwork === true,
            })
          : baseConfig;
      } catch (err) {
        const msg = err instanceof AiConfigError ? err.messageZh : 'AI 配置无效。';
        return Promise.resolve({ ok: false, latencyMs: 0, messageZh: msg });
      }
      return testAiConnection(merged, mergedOptions);
    },
  };
}
