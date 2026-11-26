import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AiConfigOverview,
  AiConfigScope,
  AiProviderConfig,
  SystemCapabilities,
  UserPublic,
} from '@novatex/shared';
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  CheckCircle2,
  ClipboardPaste,
  Copy,
  Cpu,
  Dices,
  Eye,
  EyeOff,
  Globe,
  KeyRound,
  Loader2,
  PlugZap,
  RefreshCw,
  Save,
  Search,
  Server,
  Settings,
  ShieldCheck,
  Sparkles,
  Terminal,
  Trash2,
  X,
  XCircle,
} from 'lucide-react';
import { api } from '../api.ts';
import { useLocale, type UiLocale } from '../i18n.ts';

export type SettingsSection = 'my-ai' | 'local-sync' | 'account' | 'admin-global' | 'environment';

export interface SettingsPageProps {
  initialSection: SettingsSection;
  user: UserPublic;
  capabilities: SystemCapabilities | null;
  activeProjectId?: string | null;
  onBack: () => void;
  onRefreshCapabilities: () => void;
  onNotify: (kind: 'success' | 'error' | 'info', message: string) => void;
}

type ModelFieldTarget = 'model' | 'reasonerModel';

interface SavedAiSnapshot {
  baseUrl: string;
  model: string;
  reasonerModel: string;
  timeoutMs: number;
}

interface ParsedConnectionJson {
  url?: string;
  key?: string;
  model?: string;
  reasonerModel?: string;
}

type PendingNavigationAction =
  | { type: 'back' }
  | { type: 'switch'; section: SettingsSection };

type SyncAgentPreset = 'Codex' | 'Claude Code' | 'Antigravity';

const DEFAULT_BASE_URL = 'https://api.deepseek.com/v1';
const DEFAULT_MODEL = 'deepseek-chat';
const DEFAULT_REASONER_MODEL = 'deepseek-reasoner';
const DEFAULT_TIMEOUT_MS = 45000;
const OPENAI_BASE_URL = 'https://api.openai.com/v1';

const EMPTY_SNAPSHOT: SavedAiSnapshot = {
  baseUrl: DEFAULT_BASE_URL,
  model: DEFAULT_MODEL,
  reasonerModel: DEFAULT_REASONER_MODEL,
  timeoutMs: DEFAULT_TIMEOUT_MS,
};

/**
 * Normalizes bare http(s) origins like `https://your-relay.example` -> `https://your-relay.example/v1`
 * while preserving explicit API paths such as `/v1` or `/api/v1`.
 */
function normalizeClientBaseUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return trimmed;
    }
    const cleanPath = parsed.pathname.replace(/\/+$/, '');
    if (!cleanPath || cleanPath === '/') {
      return `${parsed.origin}/v1`;
    }
    return `${parsed.origin}${cleanPath}`;
  } catch {
    return trimmed;
  }
}

/**
 * Extracts normalized lowercase http(s) origin for provider-switch detection,
 * normalizing bare domains without a scheme (e.g. `your-relay.example/v1`).
 */
function extractClientOrigin(rawUrl: string): string | null {
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;
  const candidate = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    return parsed.origin.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Returns the `/v1`-appended preview URL ONLY when the user typed a bare http(s) origin.
 */
function getBareOriginPreview(rawUrl: string): string | null {
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    if (parsed.pathname === '' || parsed.pathname === '/') {
      return `${parsed.origin}/v1`;
    }
    return null;
  } catch {
    return null;
  }
}

function readStringField(
  record: Record<string, unknown>,
  lowerMap: Map<string, unknown>,
  keys: string[],
): string | undefined {
  for (const k of keys) {
    const direct = record[k];
    if (typeof direct === 'string' && direct.trim()) {
      return direct.trim();
    }
    const ci = lowerMap.get(k.toLowerCase());
    if (typeof ci === 'string' && ci.trim()) {
      return ci.trim();
    }
  }
  return undefined;
}

function extractConnectionFields(obj: Record<string, unknown>): ParsedConnectionJson | null {
  const lowerMap = new Map<string, unknown>();
  for (const [k, v] of Object.entries(obj)) {
    lowerMap.set(k.toLowerCase(), v);
  }

  const rawUrl = readStringField(obj, lowerMap, [
    'url',
    'baseUrl',
    'base_url',
    'baseURL',
    'endpoint',
    'apiBase',
    'api_base',
    'apiUrl',
    'api_url',
    'host',
  ]);
  const key = readStringField(obj, lowerMap, [
    'key',
    'apiKey',
    'api_key',
    'token',
    'secret',
    'access_token',
  ]);
  const model = readStringField(obj, lowerMap, [
    'model',
    'defaultModel',
    'default_model',
    'modelId',
    'model_id',
  ]);
  const reasonerModel = readStringField(obj, lowerMap, [
    'reasonerModel',
    'reasoner_model',
    'reasoningModel',
    'reasoning_model',
  ]);

  if (rawUrl || key) {
    return {
      url: rawUrl ? normalizeClientBaseUrl(rawUrl) : undefined,
      key,
      model,
      reasonerModel,
    };
  }

  // Fallback for wrapped payloads like { data: { url, key } } or { config: { ... } }
  for (const wrapperKey of ['data', 'config', 'channel', 'connection']) {
    const nested = obj[wrapperKey];
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      const inner = extractConnectionFields(nested as Record<string, unknown>);
      if (inner) return inner;
    }
  }

  return null;
}

/**
 * Parses NewAPI / OneAPI / OpenAI-compatible JSON connection snippets such as:
 * `{"_type":"newapi_channel_conn","key":"sk-...","url":"https://your-relay.example/v1"}`
 */
function tryParseConnectionJson(rawText: string): ParsedConnectionJson | null {
  const trimmed = rawText.trim();
  if (!trimmed || !trimmed.includes('{') || !trimmed.includes('}')) {
    return null;
  }

  const candidates: string[] = [trimmed];

  // Unwrap optional ```json ... ``` markdown fence
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch?.[1]) {
    candidates.push(fenceMatch[1].trim());
  }

  // Extract outermost {...} substring if surrounded by extra text
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const extracted = extractConnectionFields(parsed as Record<string, unknown>);
        if (extracted) return extracted;
      }
    } catch {
      // Retry once after stripping trailing commas before } or ]
      try {
        const cleaned = candidate.replace(/,\s*([}\]])/g, '$1');
        const parsed: unknown = JSON.parse(cleaned);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const extracted = extractConnectionFields(parsed as Record<string, unknown>);
          if (extracted) return extracted;
        }
      } catch {
        // Ignore non-JSON candidate
      }
    }
  }

  return null;
}

function isDeepSeekModelId(id: string): boolean {
  return /deep?seek|deekseek/i.test(id);
}

function snapshotFromConfig(cfg: AiProviderConfig | undefined | null): SavedAiSnapshot {
  const baseUrl = cfg?.baseUrl?.trim() || DEFAULT_BASE_URL;
  const model = cfg?.model?.trim() || DEFAULT_MODEL;
  const reasonerModel = cfg?.reasonerModel?.trim() || DEFAULT_REASONER_MODEL;
  const timeoutMs =
    typeof cfg?.timeoutMs === 'number' && Number.isFinite(cfg.timeoutMs) && cfg.timeoutMs > 0
      ? Math.round(cfg.timeoutMs)
      : DEFAULT_TIMEOUT_MS;
  return { baseUrl, model, reasonerModel, timeoutMs };
}

function getUserInitial(user: UserPublic): string {
  const text = (user.displayName || user.username || '?').trim();
  return text.slice(0, 1).toUpperCase();
}

function formatCreatedAt(iso: string | undefined, locale: UiLocale): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(locale === 'en' ? 'en-US' : 'zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

function generateStrongPassword(): string {
  const sets = [
    'ABCDEFGHJKLMNPQRSTUVWXYZ',
    'abcdefghijkmnopqrstuvwxyz',
    '23456789',
    '!@#$%^&*-_',
  ];
  const all = sets.join('');
  const bytes = new Uint32Array(18);
  window.crypto.getRandomValues(bytes);
  const chars: string[] = [];

  for (let i = 0; i < sets.length; i++) {
    const set = sets[i]!;
    const rand = bytes[i] ?? 0;
    chars.push(set[rand % set.length]!);
  }
  for (let i = sets.length; i < 18; i++) {
    const rand = bytes[i] ?? 0;
    chars.push(all[rand % all.length]!);
  }

  // Fisher-Yates shuffle
  const shuf = new Uint32Array(chars.length);
  window.crypto.getRandomValues(shuf);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = (shuf[i] ?? 0) % (i + 1);
    const tmp = chars[i]!;
    chars[i] = chars[j]!;
    chars[j] = tmp;
  }

  return chars.join('');
}

interface UseAiScopeFormOptions {
  scope: AiConfigScope;
  disabled?: boolean;
  onOverviewUpdated: (next: AiConfigOverview) => void;
  onRefreshCapabilities: () => void;
  onNotify: (kind: 'success' | 'error' | 'info', message: string) => void;
}

interface AiScopeFormController {
  scope: AiConfigScope;
  baseUrl: string;
  setBaseUrl: React.Dispatch<React.SetStateAction<string>>;
  apiKey: string;
  setApiKey: React.Dispatch<React.SetStateAction<string>>;
  showApiKey: boolean;
  setShowApiKey: React.Dispatch<React.SetStateAction<boolean>>;
  hasApiKey: boolean;
  originChanged: boolean;
  model: string;
  setModel: React.Dispatch<React.SetStateAction<string>>;
  reasonerModel: string;
  setReasonerModel: React.Dispatch<React.SetStateAction<string>>;
  timeoutInput: string;
  setTimeoutInput: React.Dispatch<React.SetStateAction<string>>;
  isDirty: boolean;

  smartPasteText: string;
  smartPasteNotice: string | null;
  smartPasteError: string | null;
  smartPasteRef: React.RefObject<HTMLInputElement | null>;

  modelsList: string[];
  filteredModels: string[];
  fetchingModels: boolean;
  modelsError: string | null;
  modelsMeta: { count: number; latencyMs?: number } | null;
  modelsNotice: string | null;
  modelSearch: string;
  setModelSearch: React.Dispatch<React.SetStateAction<string>>;
  activeModelTarget: ModelFieldTarget;
  setActiveModelTarget: React.Dispatch<React.SetStateAction<ModelFieldTarget>>;

  saving: boolean;
  justSaved: boolean;
  testing: boolean;
  testResult: { ok: boolean; message: string } | null;
  error: string | null;

  hydrate: (cfg: AiProviderConfig | undefined | null) => void;
  resetToSaved: () => void;
  handleFetchModels: (overrideUrl?: string, overrideKey?: string) => Promise<void>;
  handleFieldSmartPaste: (e: React.ClipboardEvent<HTMLInputElement>) => void;
  handleSmartPasteInputPaste: (e: React.ClipboardEvent<HTMLInputElement>) => void;
  handleSmartPasteChange: (value: string) => void;
  handleSmartPasteManualParse: () => void;
  handleApplyPreset: (preset: 'deepseek' | 'openai' | 'relay') => void;
  handleSave: () => Promise<void>;
  handleTest: () => Promise<void>;
}

function useAiScopeForm({
  scope,
  disabled = false,
  onOverviewUpdated,
  onRefreshCapabilities,
  onNotify,
}: UseAiScopeFormOptions): AiScopeFormController {
  const { tr } = useLocale();
  const trRef = useRef(tr);
  trRef.current = tr;

  const [baseUrl, setBaseUrl] = useState(DEFAULT_BASE_URL);
  const [apiKey, setApiKey] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [hasApiKey, setHasApiKey] = useState(false);
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [reasonerModel, setReasonerModel] = useState(DEFAULT_REASONER_MODEL);
  const [timeoutInput, setTimeoutInput] = useState(String(DEFAULT_TIMEOUT_MS));
  const [savedSnapshot, setSavedSnapshot] = useState<SavedAiSnapshot>(EMPTY_SNAPSHOT);
  const [hydrated, setHydrated] = useState(false);

  const [smartPasteText, setSmartPasteText] = useState('');
  const [smartPasteNotice, setSmartPasteNotice] = useState<string | null>(null);
  const [smartPasteError, setSmartPasteError] = useState<string | null>(null);
  const smartPasteRef = useRef<HTMLInputElement | null>(null);

  const [modelsList, setModelsList] = useState<string[]>([]);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [modelsMeta, setModelsMeta] = useState<{ count: number; latencyMs?: number } | null>(null);
  const [modelsNotice, setModelsNotice] = useState<string | null>(null);
  const [modelSearch, setModelSearch] = useState('');
  const [activeModelTarget, setActiveModelTarget] = useState<ModelFieldTarget>('model');

  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchSeqRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      fetchSeqRef.current += 1;
    };
  }, []);

  const parsedTimeoutMs = useMemo(() => {
    const trimmed = timeoutInput.trim();
    if (!trimmed) return DEFAULT_TIMEOUT_MS;
    const n = Number(trimmed);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : DEFAULT_TIMEOUT_MS;
  }, [timeoutInput]);

  const originChanged = useMemo(() => {
    if (!hasApiKey) return false;
    return extractClientOrigin(baseUrl) !== extractClientOrigin(savedSnapshot.baseUrl);
  }, [hasApiKey, baseUrl, savedSnapshot.baseUrl]);

  const isDirty = useMemo(() => {
    if (disabled || !hydrated) return false;
    return (
      baseUrl.trim() !== savedSnapshot.baseUrl.trim() ||
      normalizeClientBaseUrl(baseUrl) !== normalizeClientBaseUrl(savedSnapshot.baseUrl) ||
      apiKey.trim().length > 0 ||
      model.trim() !== savedSnapshot.model.trim() ||
      reasonerModel.trim() !== savedSnapshot.reasonerModel.trim() ||
      parsedTimeoutMs !== savedSnapshot.timeoutMs
    );
  }, [disabled, hydrated, baseUrl, apiKey, model, reasonerModel, parsedTimeoutMs, savedSnapshot]);

  useEffect(() => {
    if (isDirty && justSaved) {
      setJustSaved(false);
    }
  }, [isDirty, justSaved]);

  const hydrate = useCallback((cfg: AiProviderConfig | undefined | null) => {
    const snap = snapshotFromConfig(cfg);
    setBaseUrl(snap.baseUrl);
    setModel(snap.model);
    setReasonerModel(snap.reasonerModel);
    setTimeoutInput(String(snap.timeoutMs));
    setHasApiKey(Boolean(cfg?.hasApiKey));
    setApiKey('');
    setShowApiKey(false);
    setSavedSnapshot(snap);
    setHydrated(true);
    setError(null);
    setTestResult(null);
    setSmartPasteText('');
    setSmartPasteNotice(null);
    setSmartPasteError(null);
    setModelsList([]);
    setModelsMeta(null);
    setModelSearch('');
    setModelsError(null);
    setModelsNotice(null);
    setJustSaved(false);
  }, []);

  const resetToSaved = useCallback(() => {
    fetchSeqRef.current += 1;
    setBaseUrl(savedSnapshot.baseUrl);
    setModel(savedSnapshot.model);
    setReasonerModel(savedSnapshot.reasonerModel);
    setTimeoutInput(String(savedSnapshot.timeoutMs));
    setApiKey('');
    setShowApiKey(false);
    setSmartPasteText('');
    setSmartPasteNotice(null);
    setSmartPasteError(null);
    setError(null);
    setTestResult(null);
    setFetchingModels(false);
  }, [savedSnapshot]);

  const buildPayload = useCallback(
    (override?: { baseUrl?: string; apiKey?: string }): Partial<AiProviderConfig> => {
      const effectiveBaseUrl = (override?.baseUrl ?? baseUrl).trim() || DEFAULT_BASE_URL;
      const effectiveKey = (override?.apiKey ?? apiKey).trim();
      const payload: Partial<AiProviderConfig> = {
        baseUrl: normalizeClientBaseUrl(effectiveBaseUrl) || DEFAULT_BASE_URL,
        model: model.trim() || DEFAULT_MODEL,
        reasonerModel: reasonerModel.trim() || DEFAULT_REASONER_MODEL,
        timeoutMs: parsedTimeoutMs,
      };
      if (effectiveKey) {
        payload.apiKey = effectiveKey;
      }
      return payload;
    },
    [baseUrl, apiKey, model, reasonerModel, parsedTimeoutMs],
  );

  const handleFetchModels = useCallback(
    async (overrideUrl?: string, overrideKey?: string) => {
      if (disabled) return;
      const seq = ++fetchSeqRef.current;
      setFetchingModels(true);
      setModelsError(null);
      setModelsNotice(null);
      try {
        const payload = buildPayload({
          baseUrl: overrideUrl,
          apiKey: overrideKey,
        });
        const res = await api.fetchAiModels({ ...payload, scope });
        if (!mountedRef.current || seq !== fetchSeqRef.current) return;

        if (res.ok) {
          const list = Array.isArray(res.models) ? res.models : [];
          setModelsList(list);
          setModelsMeta({ count: list.length, latencyMs: res.latencyMs });
          setModelSearch('');
          if (res.normalizedBaseUrl) {
            const currentTrimmed = (overrideUrl ?? baseUrl).trim();
            if (
              currentTrimmed &&
              normalizeClientBaseUrl(currentTrimmed) === res.normalizedBaseUrl &&
              currentTrimmed !== res.normalizedBaseUrl
            ) {
              setBaseUrl(res.normalizedBaseUrl);
            }
          }
          if (list.length === 0) {
            setModelsNotice(
              res.message ||
                trRef.current(
                  'Endpoint responded OK, but the model list is empty. You can type a model ID manually.',
                  '接口返回成功，但模型列表为空，可直接手动填写模型 ID。',
                ),
            );
          }
        } else {
          setModelsError(
            res.error ||
              res.message ||
              trRef.current(
                'Failed to fetch models. Check your Base URL and API Key.',
                '拉取可用模型失败，请检查地址与 API Key。',
              ),
          );
        }
      } catch (err: unknown) {
        if (!mountedRef.current || seq !== fetchSeqRef.current) return;
        setModelsError(
          err instanceof Error
            ? err.message
            : trRef.current('Model fetch request failed', '拉取可用模型请求失败'),
        );
      } finally {
        if (mountedRef.current && seq === fetchSeqRef.current) {
          setFetchingModels(false);
          setSmartPasteNotice((prev) =>
            prev
              ? prev
                  .replace(/ — fetching available models…$/, '')
                  .replace(/，正在自动拉取可用模型…$/, '')
              : prev,
          );
        }
      }
    },
    [disabled, buildPayload, scope, baseUrl],
  );

  const applyParsedConnection = useCallback(
    (parsed: ParsedConnectionJson) => {
      const nextUrl = parsed.url ? normalizeClientBaseUrl(parsed.url) : baseUrl.trim();
      const nextKey = parsed.key ?? apiKey.trim();

      if (parsed.url) {
        setBaseUrl(nextUrl);
      }
      if (parsed.key) {
        setApiKey(parsed.key);
      }
      if (parsed.model) {
        setModel(parsed.model);
      }
      if (parsed.reasonerModel) {
        setReasonerModel(parsed.reasonerModel);
      }

      setSmartPasteText('');
      setSmartPasteError(null);
      setError(null);
      setTestResult(null);

      const partsEn: string[] = [];
      const partsZh: string[] = [];
      if (parsed.url) {
        partsEn.push(`URL ${nextUrl}`);
        partsZh.push(`地址 ${nextUrl}`);
      }
      if (parsed.key) {
        partsEn.push('API Key');
        partsZh.push('API Key');
      }
      if (parsed.model) {
        partsEn.push(`Model ${parsed.model}`);
        partsZh.push(`模型 ${parsed.model}`);
      }

      setSmartPasteNotice(
        parsed.url && parsed.key
          ? trRef.current(
              `Parsed relay config & filled URL + API key (${nextUrl}) — fetching available models…`,
              `已识别中转站配置并自动填入地址与密钥（${nextUrl}），正在自动拉取可用模型…`,
            )
          : trRef.current(
              `Parsed & filled: ${partsEn.join(', ')}`,
              `已识别并自动填入：${partsZh.join('、')}`,
            ),
      );

      if (parsed.url || parsed.key) {
        void handleFetchModels(nextUrl, nextKey);
      }
    },
    [baseUrl, apiKey, handleFetchModels],
  );

  const handleFieldSmartPaste = useCallback(
    (e: React.ClipboardEvent<HTMLInputElement>) => {
      if (disabled) return;
      const text = e.clipboardData.getData('text');
      const parsed = tryParseConnectionJson(text);
      if (parsed) {
        e.preventDefault();
        applyParsedConnection(parsed);
      }
    },
    [disabled, applyParsedConnection],
  );

  const handleSmartPasteInputPaste = useCallback(
    (e: React.ClipboardEvent<HTMLInputElement>) => {
      if (disabled) return;
      const text = e.clipboardData.getData('text');
      const parsed = tryParseConnectionJson(text);
      if (parsed) {
        e.preventDefault();
        applyParsedConnection(parsed);
      }
    },
    [disabled, applyParsedConnection],
  );

  const handleSmartPasteChange = useCallback(
    (value: string) => {
      setSmartPasteText(value);
      setSmartPasteError(null);
      const trimmed = value.trim();
      if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        const parsed = tryParseConnectionJson(trimmed);
        if (parsed) {
          applyParsedConnection(parsed);
        }
      }
    },
    [applyParsedConnection],
  );

  const handleSmartPasteManualParse = useCallback(() => {
    const parsed = tryParseConnectionJson(smartPasteText);
    if (parsed) {
      applyParsedConnection(parsed);
    } else {
      setSmartPasteError(
        trRef.current(
          'No valid connection JSON detected. Paste JSON containing url and key fields (e.g. {"url":"https://...","key":"sk-..."}).',
          '未识别到有效的连接 JSON，请粘贴包含 url 与 key 字段的 JSON（如 {"url":"https://...","key":"sk-..."}）。',
        ),
      );
    }
  }, [smartPasteText, applyParsedConnection]);

  const handleApplyPreset = useCallback(
    (preset: 'deepseek' | 'openai' | 'relay') => {
      if (disabled) return;
      setError(null);
      setTestResult(null);
      setSmartPasteError(null);

      if (preset === 'deepseek') {
        setBaseUrl(DEFAULT_BASE_URL);
        setModel(DEFAULT_MODEL);
        setReasonerModel(DEFAULT_REASONER_MODEL);
        setModelsList([]);
        setModelsMeta(null);
        setModelsError(null);
        setModelsNotice(null);
        setSmartPasteNotice(null);
        return;
      }

      if (preset === 'openai') {
        setBaseUrl(OPENAI_BASE_URL);
        setModel('gpt-4.1-mini');
        setReasonerModel('o4-mini');
        setModelsList([]);
        setModelsMeta(null);
        setModelsError(null);
        setModelsNotice(null);
        setSmartPasteNotice(null);
        return;
      }

      // NewAPI / Custom Relay: focus Smart Paste box for zero-friction paste
      setSmartPasteNotice(null);
      smartPasteRef.current?.focus();
      smartPasteRef.current?.select();
    },
    [disabled],
  );

  const handleSave = useCallback(async () => {
    if (disabled) return;
    setSaving(true);
    setError(null);
    try {
      const payload = buildPayload();
      const updated =
        scope === 'personal'
          ? await api.saveMyAiConfig(payload)
          : await api.saveGlobalAiConfig(payload);
      if (!mountedRef.current) return;

      const savedCfg = scope === 'personal' ? updated.personal : updated.global;
      const snap = snapshotFromConfig(savedCfg);
      setBaseUrl(snap.baseUrl);
      setModel(snap.model);
      setReasonerModel(snap.reasonerModel);
      setTimeoutInput(String(snap.timeoutMs));
      setHasApiKey(Boolean(savedCfg?.hasApiKey));
      setApiKey('');
      setShowApiKey(false);
      setSavedSnapshot(snap);
      setHydrated(true);
      setJustSaved(true);

      onOverviewUpdated(updated);
      onRefreshCapabilities();
      onNotify(
        'success',
        scope === 'personal'
          ? trRef.current(
              'Personal AI configuration saved securely and activated.',
              '你的个人 AI 引擎配置已安全保存并立即生效',
            )
          : trRef.current(
              'Site default AI configuration saved securely.',
              '站长全局默认 AI 配置已安全保存',
            ),
      );
    } catch (err: unknown) {
      if (!mountedRef.current) return;
      setError(
        err instanceof Error
          ? err.message
          : trRef.current('Failed to save configuration', '保存配置失败'),
      );
    } finally {
      if (mountedRef.current) {
        setSaving(false);
      }
    }
  }, [disabled, buildPayload, scope, onOverviewUpdated, onRefreshCapabilities, onNotify]);

  const handleTest = useCallback(async () => {
    if (disabled) return;
    setTesting(true);
    setTestResult(null);
    setError(null);
    try {
      const res = await api.testAiConfig({ ...buildPayload(), scope });
      if (!mountedRef.current) return;
      if (res.ok) {
        setTestResult({
          ok: true,
          message:
            res.message ||
            trRef.current(
              `Connection succeeded! Model ${res.model ?? model}${res.latencyMs ? ` · ${res.latencyMs} ms` : ''}`,
              `连接成功！模型 ${res.model ?? model}${res.latencyMs ? ` · 耗时 ${res.latencyMs} ms` : ''}`,
            ),
        });
      } else {
        setTestResult({
          ok: false,
          message:
            res.error ||
            res.message ||
            trRef.current('Connection test failed', '连接测试未通过'),
        });
      }
    } catch (err: unknown) {
      if (!mountedRef.current) return;
      setTestResult({
        ok: false,
        message:
          err instanceof Error
            ? err.message
            : trRef.current('Connection test request failed', '测试请求失败'),
      });
    } finally {
      if (mountedRef.current) {
        setTesting(false);
      }
    }
  }, [disabled, buildPayload, scope, model]);

  const filteredModels = useMemo(() => {
    const q = modelSearch.trim().toLowerCase();
    if (!q) return modelsList;
    const terms = q.split(/\s+/).filter(Boolean);
    return modelsList.filter((id) => {
      const lower = id.toLowerCase();
      return terms.every((t) => lower.includes(t));
    });
  }, [modelsList, modelSearch]);

  return {
    scope,
    baseUrl,
    setBaseUrl,
    apiKey,
    setApiKey,
    showApiKey,
    setShowApiKey,
    hasApiKey,
    originChanged,
    model,
    setModel,
    reasonerModel,
    setReasonerModel,
    timeoutInput,
    setTimeoutInput,
    isDirty,
    smartPasteText,
    smartPasteNotice,
    smartPasteError,
    smartPasteRef,
    modelsList,
    filteredModels,
    fetchingModels,
    modelsError,
    modelsMeta,
    modelsNotice,
    modelSearch,
    setModelSearch,
    activeModelTarget,
    setActiveModelTarget,
    saving,
    justSaved,
    testing,
    testResult,
    error,
    hydrate,
    resetToSaved,
    handleFetchModels,
    handleFieldSmartPaste,
    handleSmartPasteInputPaste,
    handleSmartPasteChange,
    handleSmartPasteManualParse,
    handleApplyPreset,
    handleSave,
    handleTest,
  };
}

interface AiConfigFieldsProps {
  form: AiScopeFormController;
  idPrefix: string;
  loading: boolean;
  savedKeyLabel: string;
  emptyKeyPlaceholder: string;
  savedKeyPlaceholder: string;
}

const AiConfigFields: React.FC<AiConfigFieldsProps> = ({
  form,
  idPrefix,
  loading,
  savedKeyLabel,
  emptyKeyPlaceholder,
  savedKeyPlaceholder,
}) => {
  const { locale, tr } = useLocale();
  const isDeepSeekPreset = /api\.deepseek\.com/i.test(form.baseUrl);
  const isOpenAiPreset = /api\.openai\.com/i.test(form.baseUrl);
  const isRelayPreset = !isDeepSeekPreset && !isOpenAiPreset && form.baseUrl.trim().length > 0;
  const bareOriginPreview = getBareOriginPreview(form.baseUrl);

  return (
    <>
      {form.error && <div className="alert alert-danger">{form.error}</div>}
      {form.testResult && (
        <div
          className={`alert ${form.testResult.ok ? 'alert-success' : 'alert-danger'}`}
          style={{ display: 'flex', alignItems: 'center', gap: 8 }}
        >
          {form.testResult.ok ? (
            <CheckCircle2 size={15} style={{ flexShrink: 0 }} />
          ) : (
            <XCircle size={15} style={{ flexShrink: 0 }} />
          )}
          <span>{form.testResult.message}</span>
        </div>
      )}

      {/* Smart Paste One-Click Importer */}
      <div className={`smart-paste-card ${form.smartPasteNotice ? 'parsed' : ''}`}>
        <div className="smart-paste-header">
          <span className="smart-paste-title">
            <ClipboardPaste size={13} style={{ color: 'var(--ai-accent)' }} />
            {tr(
              'Smart JSON Paste (NewAPI / OneAPI Connection JSON)',
              '智能识别一键填表（支持 NewAPI / OneAPI 连接 JSON）',
            )}
          </span>
          <span className="field-hint">
            {tr(
              'Also works when pasted into Base URL or API Key fields',
              '直接粘贴到下方地址或密钥框也可自动识别',
            )}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input
            ref={form.smartPasteRef}
            type="text"
            className="input"
            style={{ flex: 1, minWidth: 0, fontFamily: 'var(--font-mono)', fontSize: 12 }}
            disabled={loading}
            value={form.smartPasteText}
            onPaste={form.handleSmartPasteInputPaste}
            onChange={(e) => form.handleSmartPasteChange(e.target.value)}
            placeholder={tr(
              'Paste NewAPI / OneAPI JSON (e.g. {"_type":"newapi_channel_conn","key":"sk-...","url":"https://..."}) to auto-fill & fetch models',
              '粘贴 NewAPI / OneAPI 连接 JSON（如 {"_type":"newapi_channel_conn","key":"sk-...","url":"https://..."}）一键自动填表并拉取模型',
            )}
            autoComplete="off"
            spellCheck={false}
          />
          {form.smartPasteText.trim().length > 0 && (
            <button
              type="button"
              className="btn btn-ai btn-sm"
              disabled={loading}
              onClick={form.handleSmartPasteManualParse}
            >
              {tr('Parse & Fill', '识别填入')}
            </button>
          )}
        </div>
        {form.smartPasteNotice && (
          <div
            className="alert alert-success"
            style={{
              marginTop: 8,
              marginBottom: 0,
              display: 'flex',
              alignItems: 'center',
              gap: 7,
              padding: '7px 10px',
              fontSize: 12,
            }}
          >
            <CheckCircle2 size={14} style={{ flexShrink: 0 }} />
            <span>{form.smartPasteNotice}</span>
          </div>
        )}
        {form.smartPasteError && (
          <div
            className="alert alert-danger"
            style={{
              marginTop: 8,
              marginBottom: 0,
              padding: '7px 10px',
              fontSize: 12,
            }}
          >
            {form.smartPasteError}
          </div>
        )}
      </div>

      {/* Quick Provider Presets */}
      <div className="field" style={{ marginBottom: 14 }}>
        <label className="field-label">{tr('Provider Presets', '快捷服务商预设')}</label>
        <div className="preset-row" style={{ marginBottom: 0 }}>
          <button
            type="button"
            disabled={loading}
            className={`preset-chip ${isDeepSeekPreset ? 'active' : ''}`}
            onClick={() => form.handleApplyPreset('deepseek')}
          >
            {tr('DeepSeek', 'DeepSeek 官方')}
          </button>
          <button
            type="button"
            disabled={loading}
            className={`preset-chip ${isOpenAiPreset ? 'active' : ''}`}
            onClick={() => form.handleApplyPreset('openai')}
          >
            {tr('OpenAI', 'OpenAI 官方')}
          </button>
          <button
            type="button"
            disabled={loading}
            className={`preset-chip ${isRelayPreset ? 'active' : ''}`}
            onClick={() => form.handleApplyPreset('relay')}
          >
            {tr('NewAPI / Custom Relay', 'NewAPI / 自定义中转站')}
          </button>
        </div>
      </div>

      {/* Base URL */}
      <div className="field">
        <label className="field-label" htmlFor={`${idPrefix}-base-url`}>
          {tr('API Base URL (OpenAI-Compatible)', 'API Base URL（OpenAI 兼容接口）')}
        </label>
        <input
          id={`${idPrefix}-base-url`}
          className="input"
          style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5 }}
          disabled={loading}
          value={form.baseUrl}
          onPaste={form.handleFieldSmartPaste}
          onChange={(e) => form.setBaseUrl(e.target.value)}
          placeholder={tr(
            'https://api.deepseek.com/v1 or https://your-relay.example/v1',
            'https://api.deepseek.com/v1 或 https://your-relay.example/v1',
          )}
          autoComplete="off"
          spellCheck={false}
        />
        {bareOriginPreview && (
          <span className="field-hint">
            {locale === 'en' ? (
              <>
                Auto-appends <code>/v1</code> on save/request → <code>{bareOriginPreview}</code>
              </>
            ) : (
              <>
                保存/请求时自动补全 <code>/v1</code> → <code>{bareOriginPreview}</code>
              </>
            )}
          </span>
        )}
      </div>

      {/* API Key */}
      <div className="field">
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
            flexWrap: 'wrap',
          }}
        >
          <label className="field-label" htmlFor={`${idPrefix}-api-key`}>
            {tr(
              'API Key (encrypted at rest on server, never echoed back)',
              'API Key（服务端只写加密存储，永不明文回显）',
            )}
          </label>
          {form.apiKey.trim() ? (
            <span className="pill pill-ai">{tr('New key entered (unsaved)', '已填入新密钥（待保存）')}</span>
          ) : form.originChanged ? (
            <span className="pill pill-warning">
              {tr('Endpoint changed · enter new API Key', '已切换服务商地址 · 请填入新 API Key')}
            </span>
          ) : form.hasApiKey ? (
            <span className="pill pill-success">{savedKeyLabel}</span>
          ) : null}
        </div>
        <div className="input-group">
          <input
            id={`${idPrefix}-api-key`}
            type={form.showApiKey ? 'text' : 'password'}
            className="input"
            style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5 }}
            disabled={loading}
            value={form.apiKey}
            onPaste={form.handleFieldSmartPaste}
            onChange={(e) => form.setApiKey(e.target.value)}
            placeholder={
              form.originChanged
                ? tr(
                    'Endpoint changed — enter new API Key (sk-...) or paste connection JSON',
                    '已切换服务商地址，请填入新 API Key（sk-...）或粘贴连接 JSON',
                  )
                : form.hasApiKey
                  ? savedKeyPlaceholder
                  : emptyKeyPlaceholder
            }
            autoComplete="new-password"
            spellCheck={false}
          />
          <button
            type="button"
            className="input-addon-btn"
            disabled={loading}
            aria-label={form.showApiKey ? tr('Hide API Key', '隐藏 API Key') : tr('Show API Key', '显示 API Key')}
            title={
              form.showApiKey
                ? tr('Hide API Key', '隐藏 API Key')
                : tr('Show entered API Key', '显示当前输入的 API Key')
            }
            onClick={() => form.setShowApiKey((v) => !v)}
          >
            {form.showApiKey ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        </div>
      </div>

      {/* Live Model Fetcher & Picker */}
      <div className="field" style={{ marginBottom: 14 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
            marginBottom: 4,
            flexWrap: 'wrap',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span className="field-label">
              {tr('Models (fetch live list or type any ID)', '模型配置（支持在线拉取点选或手动输入）')}
            </span>
            {form.modelsMeta && form.modelsMeta.count > 0 && (
              <span className="pill pill-success">
                {tr(
                  `${form.modelsMeta.count} models`,
                  `已拉取 ${form.modelsMeta.count} 个模型`,
                )}
                {typeof form.modelsMeta.latencyMs === 'number'
                  ? ` · ${form.modelsMeta.latencyMs}ms`
                  : ''}
              </span>
            )}
          </div>
          <button
            type="button"
            className="btn btn-ai btn-sm"
            disabled={form.fetchingModels || loading}
            onClick={() => void form.handleFetchModels()}
          >
            {form.fetchingModels ? (
              <Loader2 size={13} className="spin" />
            ) : (
              <RefreshCw size={13} />
            )}
            {form.fetchingModels ? tr('Fetching…', '正在拉取模型…') : tr('Fetch Models', '拉取可用模型')}
          </button>
        </div>

        <div className="form-grid-2">
          <div className="field" style={{ marginBottom: 0 }}>
            <label
              className="field-label"
              htmlFor={`${idPrefix}-model`}
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
            >
              <span>{tr('Default Fix Model', '默认修复模型')}</span>
              {form.modelsList.length > 0 && form.activeModelTarget === 'model' && (
                <span style={{ fontSize: 11, color: 'var(--accent)', fontWeight: 500 }}>
                  {tr('Click a model below to fill', '点击下方模型填入此项')}
                </span>
              )}
            </label>
            <input
              id={`${idPrefix}-model`}
              className="input"
              style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5 }}
              disabled={loading}
              value={form.model}
              onFocus={() => form.setActiveModelTarget('model')}
              onChange={(e) => form.setModel(e.target.value)}
              placeholder="deepseek-chat"
              spellCheck={false}
            />
          </div>

          <div className="field" style={{ marginBottom: 0 }}>
            <label
              className="field-label"
              htmlFor={`${idPrefix}-reasoner`}
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
            >
              <span>{tr('Reasoning Model (Cascade Errors)', '深度推理模型（级联报错）')}</span>
              {form.modelsList.length > 0 && form.activeModelTarget === 'reasonerModel' && (
                <span style={{ fontSize: 11, color: 'var(--ai-accent)', fontWeight: 500 }}>
                  {tr('Click a model below to fill', '点击下方模型填入此项')}
                </span>
              )}
            </label>
            <input
              id={`${idPrefix}-reasoner`}
              className="input"
              style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5 }}
              disabled={loading}
              value={form.reasonerModel}
              onFocus={() => form.setActiveModelTarget('reasonerModel')}
              onChange={(e) => form.setReasonerModel(e.target.value)}
              placeholder="deepseek-reasoner"
              spellCheck={false}
            />
          </div>
        </div>

        {form.modelsError && (
          <div
            className="alert alert-danger"
            style={{ marginTop: 8, marginBottom: 0, padding: '7px 10px', fontSize: 12 }}
          >
            {form.modelsError}
          </div>
        )}

        {form.modelsNotice && (
          <div
            className="alert alert-warning"
            style={{ marginTop: 8, marginBottom: 0, padding: '7px 10px', fontSize: 12 }}
          >
            {form.modelsNotice}
          </div>
        )}

        {form.modelsList.length > 0 && (
          <div className="model-picker-panel">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  flex: 1,
                  minWidth: 0,
                  gap: 6,
                }}
              >
                <Search size={13} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
                <input
                  type="text"
                  className="input"
                  style={{
                    flex: 1,
                    minWidth: 0,
                    padding: '5px 8px',
                    fontSize: 12,
                  }}
                  value={form.modelSearch}
                  onChange={(e) => form.setModelSearch(e.target.value)}
                  placeholder={tr(
                    'Filter models, e.g. deepseek / flash / reasoner…',
                    '筛选模型，如 deepseek / flash / reasoner...',
                  )}
                />
                {form.modelSearch && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-icon-sm"
                    aria-label={tr('Clear filter', '清空筛选')}
                    onClick={() => form.setModelSearch('')}
                  >
                    <X size={12} />
                  </button>
                )}
              </div>
              <span className="field-hint" style={{ whiteSpace: 'nowrap' }}>
                {form.filteredModels.length} / {form.modelsList.length}
              </span>
            </div>

            {form.filteredModels.length === 0 ? (
              <div className="field-hint" style={{ padding: '10px 6px', textAlign: 'center' }}>
                {tr(
                  `No models matching "${form.modelSearch}". You can type any model ID directly above.`,
                  `未找到匹配「${form.modelSearch}」的模型，可直接在上方输入框手动输入任意模型 ID。`,
                )}
              </div>
            ) : (
              <div className="model-picker-list">
                {form.filteredModels.map((id) => {
                  const isDefault = id === form.model.trim();
                  const isReasoner = id === form.reasonerModel.trim();
                  const isDeepSeek = isDeepSeekModelId(id);

                  return (
                    <div
                      key={id}
                      className={`model-option ${isDefault || isReasoner ? 'active' : ''} ${
                        isDeepSeek ? 'is-deepseek' : ''
                      }`}
                      role="button"
                      tabIndex={0}
                      title={
                        form.activeModelTarget === 'model'
                          ? tr('Click to set as Default Fix Model', '点击填入默认修复模型')
                          : tr('Click to set as Reasoning Model', '点击填入深度推理模型')
                      }
                      onClick={() => {
                        if (form.activeModelTarget === 'reasonerModel') {
                          form.setReasonerModel(id);
                        } else {
                          form.setModel(id);
                        }
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          if (form.activeModelTarget === 'reasonerModel') {
                            form.setReasonerModel(id);
                          } else {
                            form.setModel(id);
                          }
                        }
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 6,
                          minWidth: 0,
                          flex: 1,
                        }}
                      >
                        <span
                          style={{
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {id}
                        </span>
                        {isDeepSeek && <span className="model-tag-ds">DeepSeek</span>}
                      </div>
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 4,
                          flexShrink: 0,
                        }}
                      >
                        <button
                          type="button"
                          className={`btn btn-xs ${isDefault ? 'btn-primary' : 'btn-ghost'}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            form.setModel(id);
                          }}
                        >
                          {isDefault ? (
                            <>
                              <Check size={11} />
                              {tr('Default', '默认')}
                            </>
                          ) : (
                            tr('Set Default', '设为默认')
                          )}
                        </button>
                        <button
                          type="button"
                          className={`btn btn-xs ${isReasoner ? 'btn-ai' : 'btn-ghost'}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            form.setReasonerModel(id);
                          }}
                        >
                          {isReasoner ? (
                            <>
                              <Check size={11} />
                              {tr('Reasoner', '推理')}
                            </>
                          ) : (
                            tr('Set Reasoner', '设为推理')
                          )}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Request Timeout Row */}
      <div className="settings-row">
        <div>
          <label
            className="field-label"
            htmlFor={`${idPrefix}-timeout`}
            style={{ display: 'block' }}
          >
            {tr('Request Timeout (ms)', '请求超时（毫秒）')}
          </label>
          <span className="field-hint">
            {tr(
              'Default 45000 ms; 60000–120000 ms recommended for reasoning models',
              '默认 45000 ms，深度推理模型建议 60000–120000 ms',
            )}
          </span>
        </div>
        <input
          id={`${idPrefix}-timeout`}
          type="number"
          className="input"
          style={{ width: 136, fontFamily: 'var(--font-mono)', fontSize: 12.5 }}
          disabled={loading}
          min={5000}
          max={180000}
          step={1000}
          value={form.timeoutInput}
          onChange={(e) => form.setTimeoutInput(e.target.value)}
        />
      </div>
    </>
  );
};

export const SettingsPage: React.FC<SettingsPageProps> = ({
  initialSection,
  user,
  capabilities,
  activeProjectId,
  onBack,
  onRefreshCapabilities,
  onNotify,
}) => {
  const { locale, tr } = useLocale();
  const trRef = useRef(tr);
  trRef.current = tr;

  const isAdmin = user.role === 'admin';
  const safeInitialSection: SettingsSection =
    initialSection === 'admin-global' && !isAdmin ? 'my-ai' : initialSection;

  const [activeSection, setActiveSection] = useState<SettingsSection>(safeInitialSection);
  const [pendingAction, setPendingAction] = useState<PendingNavigationAction | null>(null);

  // Shared AI Config Overview & Open-Registration state
  const [overview, setOverview] = useState<AiConfigOverview | null>(null);
  const [loadingOverview, setLoadingOverview] = useState(true);
  const [overviewError, setOverviewError] = useState<string | null>(null);

  // Personal config delete confirmation state
  const [confirmDeletePersonal, setConfirmDeletePersonal] = useState(false);
  const [deletingPersonal, setDeletingPersonal] = useState(false);

  // Local AI Sync (CLI) token & snippet state
  const [syncTokenLabel, setSyncTokenLabel] = useState('local-agent');
  const [syncAgentPreset, setSyncAgentPreset] = useState<SyncAgentPreset>('Claude Code');
  const [creatingSyncToken, setCreatingSyncToken] = useState(false);
  const [syncTokenError, setSyncTokenError] = useState<string | null>(null);
  const [generatedSyncToken, setGeneratedSyncToken] = useState<{
    token: string;
    label: string;
    createdAt?: string;
  } | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const copyTimerRef = useRef<number | null>(null);

  // Server registration policy (read-only from .env ALLOW_PUBLIC_REGISTER)
  const [allowPublicRegister, setAllowPublicRegister] = useState<boolean>(
    Boolean(capabilities?.auth?.allowPublicRegister),
  );

  // Account password form state
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');
  const [showCurrentPwd, setShowCurrentPwd] = useState(false);
  const [showNewPwd, setShowNewPwd] = useState(false);
  const [showConfirmPwd, setShowConfirmPwd] = useState(false);
  const [changingPwd, setChangingPwd] = useState(false);
  const [pwdError, setPwdError] = useState<string | null>(null);
  const [pwdSuccess, setPwdSuccess] = useState<string | null>(null);
  const [generatedPwdHint, setGeneratedPwdHint] = useState<string | null>(null);

  // Environment refresh spinner state
  const [refreshingCaps, setRefreshingCaps] = useState(false);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  const handleCopyText = useCallback(
    (id: string, text: string, successEn: string, successZh: string) => {
      void navigator.clipboard
        .writeText(text)
        .then(() => {
          setCopiedId(id);
          if (copyTimerRef.current !== null) {
            window.clearTimeout(copyTimerRef.current);
          }
          copyTimerRef.current = window.setTimeout(() => {
            setCopiedId((curr) => (curr === id ? null : curr));
          }, 1800);
          onNotify('success', trRef.current(successEn, successZh));
        })
        .catch(() => {
          onNotify(
            'error',
            trRef.current(
              'Copy failed — please select and copy manually',
              '复制失败，请手动选中复制',
            ),
          );
        });
    },
    [onNotify],
  );

  const handleCreateSyncToken = async (e: React.FormEvent) => {
    e.preventDefault();
    if (creatingSyncToken) return;
    setCreatingSyncToken(true);
    setSyncTokenError(null);
    const label = syncTokenLabel.trim() || 'local-agent';
    try {
      const res = await api.createSyncToken(label);
      setGeneratedSyncToken({
        token: res.token,
        label: res.label || label,
        createdAt: res.createdAt,
      });
      onNotify(
        'success',
        trRef.current(
          'Personal sync token generated — copy it now, it is shown only once.',
          '个人同步令牌已生成——仅展示一次，请立即复制保存。',
        ),
      );
    } catch (err: unknown) {
      const msg =
        err instanceof Error
          ? err.message
          : trRef.current('Failed to generate sync token', '生成同步令牌失败');
      setSyncTokenError(msg);
      onNotify('error', msg);
    } finally {
      setCreatingSyncToken(false);
    }
  };

  const handleOverviewUpdated = useCallback((next: AiConfigOverview) => {
    setOverview(next);
    setAllowPublicRegister(Boolean(next.allowPublicRegister));
  }, []);

  const personalForm = useAiScopeForm({
    scope: 'personal',
    disabled: false,
    onOverviewUpdated: handleOverviewUpdated,
    onRefreshCapabilities,
    onNotify,
  });

  const globalForm = useAiScopeForm({
    scope: 'global',
    disabled: !isAdmin,
    onOverviewUpdated: handleOverviewUpdated,
    onRefreshCapabilities,
    onNotify,
  });

  const hydratePersonalRef = useRef(personalForm.hydrate);
  hydratePersonalRef.current = personalForm.hydrate;
  const hydrateGlobalRef = useRef(globalForm.hydrate);
  hydrateGlobalRef.current = globalForm.hydrate;

  // Keep activeSection synced when opened to a specific section from topbar account menu
  useEffect(() => {
    const target: SettingsSection =
      initialSection === 'admin-global' && !isAdmin ? 'my-ai' : initialSection;
    setActiveSection(target);
    setPendingAction(null);
    setConfirmDeletePersonal(false);
  }, [initialSection, isAdmin]);

  // Load AI Config Overview on mount
  const loadOverview = useCallback(async () => {
    setLoadingOverview(true);
    setOverviewError(null);
    try {
      const data = await api.getAiConfigOverview();
      setOverview(data);
      setAllowPublicRegister(Boolean(data.allowPublicRegister));
      hydratePersonalRef.current(data.personal);
      hydrateGlobalRef.current(data.global);
    } catch (err: unknown) {
      setOverviewError(
        err instanceof Error
          ? err.message
          : trRef.current('Failed to load AI and site settings', '加载 AI 与站点配置失败'),
      );
    } finally {
      setLoadingOverview(false);
    }
  }, []);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  const anyDirty = personalForm.isDirty || (isAdmin && globalForm.isDirty);

  const isCurrentSectionDirty =
    (activeSection === 'my-ai' && personalForm.isDirty) ||
    (activeSection === 'admin-global' && isAdmin && globalForm.isDirty);

  // Auto-clear pending guard if user saved or reverted edits manually
  useEffect(() => {
    if (!pendingAction) return;
    if (pendingAction.type === 'back' && !anyDirty) {
      setPendingAction(null);
    } else if (pendingAction.type === 'switch' && !isCurrentSectionDirty) {
      setPendingAction(null);
    }
  }, [pendingAction, anyDirty, isCurrentSectionDirty]);

  const requestBack = useCallback(() => {
    if (anyDirty) {
      setPendingAction({ type: 'back' });
      return;
    }
    setPendingAction(null);
    onBack();
  }, [anyDirty, onBack]);

  const requestSectionSwitch = useCallback(
    (nextSection: SettingsSection) => {
      if (nextSection === activeSection) return;
      if (nextSection === 'admin-global' && !isAdmin) return;
      if (isCurrentSectionDirty) {
        setPendingAction({ type: 'switch', section: nextSection });
        return;
      }
      setPendingAction(null);
      setConfirmDeletePersonal(false);
      setActiveSection(nextSection);
    },
    [activeSection, isAdmin, isCurrentSectionDirty],
  );

  const handleConfirmDiscardAndLeave = useCallback(() => {
    const action = pendingAction;
    setPendingAction(null);
    setConfirmDeletePersonal(false);

    if (!action || action.type === 'back') {
      if (personalForm.isDirty) personalForm.resetToSaved();
      if (globalForm.isDirty) globalForm.resetToSaved();
      onBack();
      return;
    }

    if (activeSection === 'my-ai' && personalForm.isDirty) {
      personalForm.resetToSaved();
    } else if (activeSection === 'admin-global' && globalForm.isDirty) {
      globalForm.resetToSaved();
    }
    setActiveSection(action.section);
  }, [pendingAction, activeSection, personalForm, globalForm, onBack]);

  const handleStayAndSave = useCallback(() => {
    setPendingAction(null);
    if (personalForm.isDirty && activeSection !== 'my-ai') {
      setActiveSection('my-ai');
    } else if (isAdmin && globalForm.isDirty && activeSection !== 'admin-global') {
      setActiveSection('admin-global');
    }
  }, [personalForm.isDirty, globalForm.isDirty, isAdmin, activeSection]);

  // Escape key returns to workbench (with unsaved guard, IME-safe)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        e.stopPropagation();
        if (confirmDeletePersonal) {
          setConfirmDeletePersonal(false);
          return;
        }
        if (pendingAction) {
          setPendingAction(null);
          return;
        }
        requestBack();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [confirmDeletePersonal, pendingAction, requestBack]);

  const handleDeletePersonalConfig = async () => {
    setDeletingPersonal(true);
    try {
      const res = await api.deleteMyAiConfig();
      setOverview(res);
      setAllowPublicRegister(Boolean(res.allowPublicRegister));
      personalForm.hydrate(res.personal);
      setConfirmDeletePersonal(false);
      onRefreshCapabilities();
      onNotify(
        'success',
        trRef.current(
          'Personal AI config cleared. Falling back to site default engine.',
          '已清空个人 AI 配置，将自动回退使用站点默认引擎',
        ),
      );
    } catch (err: unknown) {
      onNotify(
        'error',
        err instanceof Error
          ? err.message
          : trRef.current('Failed to clear personal AI config', '清空个人 AI 配置失败'),
      );
    } finally {
      setDeletingPersonal(false);
    }
  };

  const handleGenerateStrongPassword = () => {
    const pwd = generateStrongPassword();
    setNewPassword(pwd);
    setConfirmNewPassword(pwd);
    setGeneratedPwdHint(pwd);
    setPwdError(null);
    setPwdSuccess(null);
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPwdError(null);
    setPwdSuccess(null);

    if (!currentPassword || !newPassword) {
      setPwdError(trRef.current('Please enter your current and new password.', '请填写当前密码与新密码'));
      return;
    }
    if (newPassword.length < 6 || newPassword.length > 128) {
      setPwdError(trRef.current('New password must be 6–128 characters.', '新密码长度需在 6–128 位之间'));
      return;
    }
    if (newPassword !== confirmNewPassword) {
      setPwdError(trRef.current('New passwords do not match.', '两次输入的新密码不一致'));
      return;
    }

    setChangingPwd(true);
    try {
      await api.changePassword({ currentPassword, newPassword });
      setCurrentPassword('');
      setNewPassword('');
      setConfirmNewPassword('');
      setShowCurrentPwd(false);
      setShowNewPwd(false);
      setShowConfirmPwd(false);
      setGeneratedPwdHint(null);
      const okMsg = trRef.current(
        'Password updated. Sessions on other devices have been signed out automatically.',
        '登录密码已更新，其余旧设备登录态已自动失效。',
      );
      setPwdSuccess(okMsg);
      onNotify('success', okMsg);
    } catch (err: unknown) {
      setPwdError(
        err instanceof Error
          ? err.message
          : trRef.current('Failed to update password', '修改密码失败'),
      );
    } finally {
      setChangingPwd(false);
    }
  };

  const handleRefreshEnv = () => {
    setRefreshingCaps(true);
    onRefreshCapabilities();
    onNotify('info', trRef.current('Refreshing backend runtime checks…', '正在刷新后端运行环境检测…'));
    window.setTimeout(() => setRefreshingCaps(false), 600);
  };

  const effectiveSource = overview?.effectiveSource ?? 'none';
  const joinedDate = formatCreatedAt(user.createdAt, locale);

  const serverOrigin =
    typeof window !== 'undefined' && window.location?.origin
      ? window.location.origin
      : 'http://localhost:3000';
  const projectArg = activeProjectId || '<PROJECT_ID>';
  const tokenArg = generatedSyncToken?.token || '<YOUR_SYNC_TOKEN>';

  const watchCliSnippet = `npx novatex-sync watch --url "${serverOrigin}" --project "${projectArg}" --token "${tokenArg}" --dir ./paper --name "${syncAgentPreset}"`;
  const convertMdToTexSnippet =
    'npx novatex-sync convert --from md --to tex --input draft.md --output main.tex --template ieee-conf';
  const convertTexToDocxSnippet =
    'npx novatex-sync convert --from tex --to docx --input main.tex --output submission.docx';

  return (
    <div className="settings-page">
      {/* Dedicated Topbar */}
      <header className="settings-topbar">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={requestBack}
            title={tr('Back to Studio (Esc)', '返回工作台（Esc）')}
          >
            <ArrowLeft size={14} />
            <span>{tr('Back to Studio', '返回工作台')}</span>
          </button>
          <span
            aria-hidden="true"
            style={{
              width: 1,
              height: 16,
              background: 'var(--border)',
              flexShrink: 0,
            }}
          />
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 7,
              fontWeight: 600,
              fontSize: 13.5,
              color: 'var(--text-primary)',
              minWidth: 0,
            }}
          >
            <Settings size={15} style={{ color: 'var(--accent)', flexShrink: 0 }} />
            <span>{tr('Settings', '设置中心')}</span>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          {anyDirty && (
            <span className="dirty-indicator" style={{ marginRight: 4 }}>
              {tr('Unsaved changes', '有未保存的配置修改')}
            </span>
          )}
          <span className={`pill ${isAdmin ? 'pill-accent' : ''}`}>
            {isAdmin ? tr('Admin', '站长 / 管理员') : tr('Member', '成员')}
          </span>
          <span
            className="field-hint"
            style={{ fontSize: 11.5, whiteSpace: 'nowrap' }}
            title={tr('Press Esc to return to Studio', '按 Esc 快捷返回工作台')}
          >
            {tr('Esc to return', 'Esc 返回')}
          </span>
        </div>
      </header>

      {/* Unsaved-Changes Inline Confirmation Bar */}
      {pendingAction && anyDirty && (
        <div
          className="alert alert-warning"
          role="alert"
          style={{
            margin: '12px auto 0',
            width: 'calc(100% - 32px)',
            maxWidth: 1060,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 500 }}>
            <AlertTriangle size={15} style={{ flexShrink: 0 }} />
            <span>
              {pendingAction.type === 'back'
                ? tr(
                    'You have unsaved configuration changes. Leaving now will discard them.',
                    '你有未保存的配置修改，返回工作台后将丢失当前填写内容',
                  )
                : tr(
                    'You have unsaved configuration changes. Switching sections will discard them.',
                    '你有未保存的配置修改，切换设置页后将丢失当前填写内容',
                  )}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button
              type="button"
              className="btn btn-danger btn-xs"
              onClick={handleConfirmDiscardAndLeave}
            >
              {tr('Discard & Leave', '放弃并离开')}
            </button>
            <button
              type="button"
              className="btn btn-primary btn-xs"
              onClick={handleStayAndSave}
            >
              {tr('Stay & Save', '留下来保存')}
            </button>
          </div>
        </div>
      )}

      {/* Linear / Vercel 2-Column Shell */}
      <div className="settings-shell">
        {/* Left Navigation Sidebar */}
        <aside className="settings-sidebar" aria-label={tr('Settings navigation', '设置导航')}>
          <div className="settings-sidebar-group">
            <div className="settings-sidebar-label">{tr('Personal', '个人设置')}</div>
            <button
              type="button"
              className={`settings-sidebar-item ${activeSection === 'my-ai' ? 'active' : ''}`}
              aria-current={activeSection === 'my-ai' ? 'page' : undefined}
              onClick={() => requestSectionSwitch('my-ai')}
            >
              <Sparkles size={15} style={{ flexShrink: 0 }} />
              <span style={{ flex: 1, textAlign: 'left' }}>{tr('My AI Engine', '我的 AI 引擎')}</span>
              {personalForm.isDirty && (
                <span
                  aria-label={tr('Unsaved changes', '有未保存修改')}
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: 999,
                    background: 'var(--warning)',
                    flexShrink: 0,
                  }}
                />
              )}
            </button>

            <button
              type="button"
              className={`settings-sidebar-item ${activeSection === 'local-sync' ? 'active' : ''}`}
              aria-current={activeSection === 'local-sync' ? 'page' : undefined}
              onClick={() => requestSectionSwitch('local-sync')}
            >
              <Terminal size={15} style={{ flexShrink: 0 }} />
              <span style={{ flex: 1, textAlign: 'left' }}>
                {tr('Local AI Sync (CLI)', '本地 AI 同步 (CLI)')}
              </span>
            </button>

            <button
              type="button"
              className={`settings-sidebar-item ${activeSection === 'account' ? 'active' : ''}`}
              aria-current={activeSection === 'account' ? 'page' : undefined}
              onClick={() => requestSectionSwitch('account')}
            >
              <ShieldCheck size={15} style={{ flexShrink: 0 }} />
              <span style={{ flex: 1, textAlign: 'left' }}>
                {tr('Account & Security', '账号与安全')}
              </span>
            </button>
          </div>

          <div className="settings-sidebar-group">
            <div className="settings-sidebar-label">{tr('Site & System', '站点与系统')}</div>
            {isAdmin && (
              <button
                type="button"
                className={`settings-sidebar-item ${activeSection === 'admin-global' ? 'active' : ''}`}
                aria-current={activeSection === 'admin-global' ? 'page' : undefined}
                onClick={() => requestSectionSwitch('admin-global')}
              >
                <Globe size={15} style={{ flexShrink: 0 }} />
                <span style={{ flex: 1, textAlign: 'left' }}>
                  {tr('Site Default AI', '全局默认 AI')}
                </span>
                {globalForm.isDirty && (
                  <span
                    aria-label={tr('Unsaved changes', '有未保存修改')}
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: 999,
                      background: 'var(--warning)',
                      flexShrink: 0,
                    }}
                  />
                )}
              </button>
            )}

            <button
              type="button"
              className={`settings-sidebar-item ${activeSection === 'environment' ? 'active' : ''}`}
              aria-current={activeSection === 'environment' ? 'page' : undefined}
              onClick={() => requestSectionSwitch('environment')}
            >
              <Cpu size={15} style={{ flexShrink: 0 }} />
              <span style={{ flex: 1, textAlign: 'left' }}>
                {tr('Environment', '运行环境诊断')}
              </span>
            </button>
          </div>
        </aside>

        {/* Right Main Content */}
        <main className="settings-content">
          {/* ============================================================
              SECTION 1: My AI Engine (Every logged-in user BYOK)
             ============================================================ */}
          {activeSection === 'my-ai' && (
            <div>
              <div className="settings-header">
                <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, letterSpacing: '-0.02em' }}>
                  {tr('My AI Engine', '我的 AI 引擎')}
                </h1>
                <p className="field-hint" style={{ margin: '4px 0 0', fontSize: 13 }}>
                  {tr(
                    'Configure your own DeepSeek or OpenAI-compatible API key (private to your account, encrypted on the server). Scoped strictly to compile diagnostics, table/math repair, and format cleanup — never ghostwrites your prose.',
                    '每位用户均可配置自己的 DeepSeek 或 OpenAI 兼容中转站 API Key（仅自己可见、服务端加密存储）。仅用于编译报错诊断、表格/公式修复与格式清洗，绝不自动替写正文。',
                  )}
                </p>
              </div>

              {/* Effective AI Source Status Pill */}
              {!loadingOverview && !overviewError && overview && (
                <div style={{ marginBottom: 16 }}>
                  {effectiveSource === 'personal' && (
                    <div className="source-pill personal pill-success">
                      <CheckCircle2 size={14} style={{ flexShrink: 0 }} />
                      <span>{tr('Active: Your personal API key', '当前生效：你的个人专属 API')}</span>
                    </div>
                  )}
                  {effectiveSource === 'global' && (
                    <div className="source-pill global pill-accent">
                      <Globe size={14} style={{ flexShrink: 0 }} />
                      <span>
                        {tr(
                          `Active: Site default (${overview.global.model || DEFAULT_MODEL}) · enter your own key anytime to override`,
                          `当前生效：站长全局默认（${overview.global.model || DEFAULT_MODEL}）· 你随时可填写自己的 Key 覆盖`,
                        )}
                      </span>
                    </div>
                  )}
                  {effectiveSource === 'env' && (
                    <div className="source-pill global pill-accent">
                      <Server size={14} style={{ flexShrink: 0 }} />
                      <span>
                        {tr(
                          `Active: Server environment default (${overview.config.model || DEFAULT_MODEL}) · enter your own key anytime to override`,
                          `当前生效：站点默认环境变量（${overview.config.model || DEFAULT_MODEL}）· 你随时可填写自己的 Key 覆盖`,
                        )}
                      </span>
                    </div>
                  )}
                  {effectiveSource === 'none' && (
                    <div className="source-pill none pill-warning">
                      <AlertTriangle size={14} style={{ flexShrink: 0 }} />
                      <span>{tr('No active AI API key configured yet', '尚未配置可用 AI 密钥')}</span>
                    </div>
                  )}
                </div>
              )}

              {overviewError && (
                <div
                  className="alert alert-danger"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 10,
                    flexWrap: 'wrap',
                  }}
                >
                  <span>{overviewError}</span>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => void loadOverview()}
                  >
                    <RefreshCw size={13} />
                    {tr('Reload', '重新加载')}
                  </button>
                </div>
              )}

              <section className="settings-card">
                {loadingOverview ? (
                  <div
                    style={{
                      padding: '28px 12px',
                      color: 'var(--text-muted)',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                    }}
                  >
                    <Loader2 size={15} className="spin" />{' '}
                    {tr('Loading your AI configuration…', '正在加载你的 AI 引擎配置…')}
                  </div>
                ) : (
                  <AiConfigFields
                    form={personalForm}
                    idPrefix="settings-personal-ai"
                    loading={loadingOverview}
                    savedKeyLabel={tr('✓ Personal key stored securely', '✓ 已安全保存个人密钥')}
                    emptyKeyPlaceholder={tr(
                      'Enter sk-... or paste a NewAPI / OneAPI connection JSON',
                      '输入你的 sk-... 或直接粘贴 NewAPI 连接 JSON',
                    )}
                    savedKeyPlaceholder={tr(
                      'Personal key saved (leave blank to keep; enter a new key or paste JSON to replace)',
                      '已保存个人密钥（留空保持不变；输入新密钥或粘贴 JSON 可覆盖）',
                    )}
                  />
                )}
              </section>

              {/* Sticky / Bottom Footer Bar for My AI */}
              <div className="settings-footer-bar">
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: '1 1 200px', minWidth: 0 }}>
                  {personalForm.isDirty ? (
                    <span className="dirty-indicator">
                      {tr('Unsaved configuration changes', '有未保存的配置修改')}
                    </span>
                  ) : personalForm.justSaved ? (
                    <span
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 5,
                        fontSize: 12,
                        color: 'var(--success)',
                        fontWeight: 500,
                      }}
                    >
                      <CheckCircle2 size={13} />{' '}
                      {tr('Personal AI configuration saved', '已保存你的个人 AI 配置')}
                    </span>
                  ) : personalForm.hasApiKey ? (
                    <span className="field-hint">
                      {tr('Your personal AI engine is active', '当前已启用你的个人专属 AI 配置')}
                    </span>
                  ) : (
                    <span className="field-hint">
                      {tr(
                        'Without a personal key, requests fall back to the site default engine',
                        '未设置个人密钥时，将自动回退使用站点全局默认配置',
                      )}
                    </span>
                  )}
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, flexWrap: 'nowrap' }}>
                  {personalForm.hasApiKey &&
                    (confirmDeletePersonal ? (
                      <div
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 6,
                          padding: '3px 8px',
                          borderRadius: 'var(--radius-sm)',
                          background: 'var(--danger-soft)',
                          border: '1px solid var(--danger-border)',
                        }}
                      >
                        <span style={{ fontSize: 12, color: 'var(--danger)', fontWeight: 500 }}>
                          {tr('Clear personal key?', '确认清空个人密钥？')}
                        </span>
                        <button
                          type="button"
                          className="btn btn-danger btn-xs"
                          disabled={deletingPersonal}
                          onClick={() => void handleDeletePersonalConfig()}
                        >
                          {deletingPersonal ? (
                            <Loader2 size={12} className="spin" />
                          ) : (
                            <Trash2 size={12} />
                          )}
                          {tr('Confirm Clear', '确认清空')}
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost btn-xs"
                          disabled={deletingPersonal}
                          onClick={() => setConfirmDeletePersonal(false)}
                        >
                          {tr('Cancel', '取消')}
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-danger"
                        disabled={loadingOverview || deletingPersonal || personalForm.saving}
                        onClick={() => setConfirmDeletePersonal(true)}
                      >
                        <Trash2 size={13} />
                        {tr('Clear Personal Key', '清空个人配置')}
                      </button>
                    ))}

                  <button
                    type="button"
                    className="btn"
                    disabled={personalForm.testing || loadingOverview}
                    onClick={() => void personalForm.handleTest()}
                  >
                    {personalForm.testing ? (
                      <Loader2 size={14} className="spin" />
                    ) : (
                      <PlugZap size={14} />
                    )}
                    {tr('Test Connection', '测试连接')}
                  </button>

                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={personalForm.saving || loadingOverview}
                    onClick={() => void personalForm.handleSave()}
                  >
                    {personalForm.saving ? (
                      <Loader2 size={14} className="spin" />
                    ) : (
                      <Save size={14} />
                    )}
                    {tr('Save Configuration', '保存我的配置')}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* ============================================================
              SECTION 2: Local AI Sync (CLI)
             ============================================================ */}
          {activeSection === 'local-sync' && (
            <div>
              <div className="settings-header">
                <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, letterSpacing: '-0.02em' }}>
                  {tr('Local AI Sync (CLI)', '本地 AI 同步 (CLI)')}
                </h1>
                <p className="field-hint" style={{ margin: '4px 0 0', fontSize: 13 }}>
                  {tr(
                    'Connect local AI coding agents (Codex, Claude Code, Antigravity) or your local IDE directly to this NovaTeX workspace for bidirectional live sync and offline multi-format conversion.',
                    '将本机 AI 编程代理（Codex、Claude Code、Antigravity）或本地编辑器直连至当前 NovaTeX 实例，实现文件双向实时同步与本地多格式转换。',
                  )}
                </p>
              </div>

              {/* Card 1: Personal Sync Token Generator */}
              <section className="settings-card">
                <div className="settings-card-header" style={{ marginBottom: 10 }}>
                  <div>
                    <h2
                      className="settings-card-title"
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}
                    >
                      <KeyRound size={15} style={{ color: 'var(--accent)' }} />
                      <span>{tr('Personal Sync Token', '个人同步令牌')}</span>
                    </h2>
                    <p className="settings-card-desc">
                      {tr(
                        'Issue a scoped Bearer token for novatex-sync CLI. Once created, the token is displayed once and auto-filled into the commands below.',
                        '签发专用于 novatex-sync CLI 的个人同步令牌。生成后仅展示一次，并会自动填入下方即复制即用的 CLI 命令。',
                      )}
                    </p>
                  </div>
                </div>

                {syncTokenError && <div className="alert alert-danger">{syncTokenError}</div>}

                <form
                  onSubmit={(e) => void handleCreateSyncToken(e)}
                  style={{
                    display: 'flex',
                    alignItems: 'flex-end',
                    gap: 10,
                    flexWrap: 'wrap',
                  }}
                >
                  <div className="field" style={{ flex: 1, minWidth: 200, marginBottom: 0 }}>
                    <label className="field-label" htmlFor="settings-sync-token-label">
                      {tr('Token Label', '令牌备注名称')}
                    </label>
                    <input
                      id="settings-sync-token-label"
                      type="text"
                      className="input"
                      style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5 }}
                      value={syncTokenLabel}
                      onChange={(e) => setSyncTokenLabel(e.target.value)}
                      placeholder={tr('e.g. claude-code / codex-laptop', '例如 claude-code / codex-laptop')}
                      disabled={creatingSyncToken}
                      maxLength={64}
                      spellCheck={false}
                    />
                  </div>
                  <button
                    type="submit"
                    className="btn btn-primary"
                    style={{ height: 34 }}
                    disabled={creatingSyncToken}
                  >
                    {creatingSyncToken ? (
                      <Loader2 size={14} className="spin" />
                    ) : (
                      <KeyRound size={14} />
                    )}
                    {creatingSyncToken
                      ? tr('Generating…', '正在生成…')
                      : tr('Generate Sync Token', '生成个人同步令牌')}
                  </button>
                </form>

                {generatedSyncToken && (
                  <div
                    className="alert alert-success"
                    style={{
                      marginTop: 14,
                      marginBottom: 0,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 8,
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 8,
                        flexWrap: 'wrap',
                      }}
                    >
                      <span
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 6,
                          fontWeight: 600,
                          fontSize: 12.5,
                        }}
                      >
                        <CheckCircle2 size={14} style={{ flexShrink: 0 }} />
                        {tr(
                          `Token "${generatedSyncToken.label}" created — shown once only`,
                          `令牌「${generatedSyncToken.label}」已生成——仅本次展示`,
                        )}
                      </span>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() =>
                          handleCopyText(
                            'sync-token',
                            generatedSyncToken.token,
                            'Sync token copied to clipboard',
                            '已复制同步令牌',
                          )
                        }
                      >
                        {copiedId === 'sync-token' ? <Check size={12} /> : <Copy size={12} />}
                        {copiedId === 'sync-token' ? tr('Copied', '已复制') : tr('Copy Token', '复制令牌')}
                      </button>
                    </div>
                    <div
                      className="code-block"
                      style={{
                        background: 'var(--bg-surface)',
                        color: 'var(--text-primary)',
                        padding: '8px 10px',
                        fontSize: 12,
                      }}
                    >
                      {generatedSyncToken.token}
                    </div>
                  </div>
                )}
              </section>

              {/* Card 2: Ready-to-Copy CLI Commands */}
              <section className="settings-card">
                <div className="settings-card-header" style={{ marginBottom: 12, flexWrap: 'wrap' }}>
                  <div>
                    <h2
                      className="settings-card-title"
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}
                    >
                      <Terminal size={15} style={{ color: 'var(--accent)' }} />
                      <span>{tr('Ready-to-Copy CLI Commands', '一键复制 CLI 同步与转换命令')}</span>
                    </h2>
                    <p className="settings-card-desc">
                      {tr(
                        'Pre-filled with your current NovaTeX server URL and active project ID.',
                        '已自动填入当前 NovaTeX 服务地址与活跃项目 ID。',
                      )}
                    </p>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <span className="pill" style={{ fontFamily: 'var(--font-mono)' }}>
                      {serverOrigin}
                    </span>
                    <span
                      className={`pill ${activeProjectId ? 'pill-accent' : ''}`}
                      style={{ fontFamily: 'var(--font-mono)' }}
                    >
                      {tr('Project:', '项目:')} {projectArg}
                    </span>
                  </div>
                </div>

                {/* Agent Preset Selector */}
                <div className="field" style={{ marginBottom: 14 }}>
                  <label className="field-label">
                    {tr('Local AI Agent Identity (--name)', '本地 AI 代理标识（--name）')}
                  </label>
                  <div className="preset-row" style={{ marginBottom: 0 }}>
                    {(['Claude Code', 'Codex', 'Antigravity'] as const).map((agentName) => (
                      <button
                        key={agentName}
                        type="button"
                        className={`preset-chip ${syncAgentPreset === agentName ? 'active' : ''}`}
                        onClick={() => setSyncAgentPreset(agentName)}
                      >
                        {agentName}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Snippet 1: novatex-sync watch */}
                <div style={{ marginBottom: 16 }}>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 8,
                      marginBottom: 6,
                      flexWrap: 'wrap',
                    }}
                  >
                    <div>
                      <span className="field-label" style={{ display: 'block' }}>
                        {tr('1. Bidirectional Live Watch (novatex-sync watch)', '1. 双向实时文件监听同步（novatex-sync watch）')}
                      </span>
                      <span className="field-hint">
                        {tr(
                          'Let Codex / Claude Code / Antigravity edit local .tex files while NovaTeX syncs live without jumping your cursor.',
                          '让 Codex / Claude Code / Antigravity 直接编辑本地 .tex 文件，NovaTeX 实时最小补丁同步并编译预览 PDF。',
                        )}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() =>
                        handleCopyText(
                          'cli-watch',
                          watchCliSnippet,
                          'Copied novatex-sync watch command',
                          '已复制 novatex-sync watch 命令',
                        )
                      }
                    >
                      {copiedId === 'cli-watch' ? <Check size={12} /> : <Copy size={12} />}
                      {copiedId === 'cli-watch' ? tr('Copied', '已复制') : tr('Copy', '复制')}
                    </button>
                  </div>
                  <pre className="code-block" style={{ margin: 0 }}>
                    {watchCliSnippet}
                  </pre>
                </div>

                {/* Snippet 2: novatex-sync convert (MD -> TeX) */}
                <div style={{ marginBottom: 16 }}>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 8,
                      marginBottom: 6,
                      flexWrap: 'wrap',
                    }}
                  >
                    <div>
                      <span className="field-label" style={{ display: 'block' }}>
                        {tr(
                          '2. Local Format Conversion (novatex-sync convert)',
                          '2. 本地多格式无损转换（novatex-sync convert）',
                        )}
                      </span>
                      <span className="field-hint">
                        {tr(
                          'Convert Markdown / Word / TXT / PDF drafts locally into clean LaTeX with equations & templates preserved.',
                          '在本地终端将 Markdown / Word / TXT / PDF 草稿转换为干净 LaTeX，保留数学公式与学术模板。',
                        )}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() =>
                        handleCopyText(
                          'cli-convert-md',
                          convertMdToTexSnippet,
                          'Copied novatex-sync convert command',
                          '已复制 novatex-sync convert 命令',
                        )
                      }
                    >
                      {copiedId === 'cli-convert-md' ? <Check size={12} /> : <Copy size={12} />}
                      {copiedId === 'cli-convert-md' ? tr('Copied', '已复制') : tr('Copy', '复制')}
                    </button>
                  </div>
                  <pre className="code-block" style={{ margin: 0 }}>
                    {convertMdToTexSnippet}
                  </pre>
                </div>

                {/* Snippet 3: novatex-sync convert (TeX -> DOCX) */}
                <div>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 8,
                      marginBottom: 6,
                      flexWrap: 'wrap',
                    }}
                  >
                    <div>
                      <span className="field-label" style={{ display: 'block' }}>
                        {tr(
                          '3. Export LaTeX to Native-OMML Word (.docx)',
                          '3. 将本地 LaTeX 导出为原生公式 Word (.docx)',
                        )}
                      </span>
                      <span className="field-hint">
                        {tr(
                          'Handy for course submissions, lab templates, or automated CI build scripts.',
                          '适合课程提交、实验报告模板或本地自动化脚本一键导出。',
                        )}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() =>
                        handleCopyText(
                          'cli-convert-docx',
                          convertTexToDocxSnippet,
                          'Copied LaTeX → DOCX command',
                          '已复制 LaTeX → DOCX 命令',
                        )
                      }
                    >
                      {copiedId === 'cli-convert-docx' ? <Check size={12} /> : <Copy size={12} />}
                      {copiedId === 'cli-convert-docx' ? tr('Copied', '已复制') : tr('Copy', '复制')}
                    </button>
                  </div>
                  <pre className="code-block" style={{ margin: 0 }}>
                    {convertTexToDocxSnippet}
                  </pre>
                </div>
              </section>
            </div>
          )}

          {/* ============================================================
              SECTION 3: Account & Security (Strictly separated from AI settings!)
             ============================================================ */}
          {activeSection === 'account' && (
            <div>
              <div className="settings-header">
                <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, letterSpacing: '-0.02em' }}>
                  {tr('Account & Security', '账号与安全')}
                </h1>
                <p className="field-hint" style={{ margin: '4px 0 0', fontSize: 13 }}>
                  {tr(
                    'Review your account details and independently manage your login password and device sessions.',
                    '查看当前登录账号信息，并独立管理你的登录密码与设备会话安全。',
                  )}
                </p>
              </div>

              {/* Card 1: Profile Summary */}
              <section className="settings-card">
                <div className="settings-row" style={{ borderTop: 'none', paddingTop: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 14, minWidth: 0 }}>
                    <div
                      aria-hidden="true"
                      style={{
                        width: 48,
                        height: 48,
                        borderRadius: 999,
                        background: user.color || 'var(--accent)',
                        color: '#ffffff',
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: 18,
                        fontWeight: 700,
                        flexShrink: 0,
                        boxShadow: 'var(--shadow-sm)',
                      }}
                    >
                      {getUserInitial(user)}
                    </div>
                    <div style={{ minWidth: 0 }}>
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          flexWrap: 'wrap',
                        }}
                      >
                        <strong style={{ fontSize: 15, color: 'var(--text-primary)' }}>
                          {user.displayName}
                        </strong>
                        <span className={`pill ${isAdmin ? 'pill-accent' : ''}`}>
                          {isAdmin ? tr('Admin', '站长 / 管理员') : tr('Member', '成员')}
                        </span>
                      </div>
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 10,
                          marginTop: 3,
                          flexWrap: 'wrap',
                        }}
                      >
                        <span
                          style={{
                            fontFamily: 'var(--font-mono)',
                            fontSize: 12.5,
                            color: 'var(--text-muted)',
                          }}
                        >
                          @{user.username}
                        </span>
                        {joinedDate && (
                          <span className="field-hint">
                            {tr(`Joined ${joinedDate}`, `注册于 ${joinedDate}`)}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </section>

              {/* Card 2: Password Change Form */}
              <section className="settings-card">
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 10,
                    marginBottom: 8,
                    flexWrap: 'wrap',
                  }}
                >
                  <div
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 7,
                      fontWeight: 600,
                      fontSize: 14,
                    }}
                  >
                    <KeyRound size={15} style={{ color: 'var(--accent)' }} />
                    <span>{tr('Change Password', '修改登录密码')}</span>
                  </div>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={handleGenerateStrongPassword}
                    title={tr(
                      'Generate an 18-character high-entropy password locally via crypto.getRandomValues',
                      '在浏览器本地通过 crypto.getRandomValues 生成 18 位高熵随机强密码',
                    )}
                  >
                    <Dices size={13} />
                    {tr('Generate 18-Char Strong Password', '生成 18 位随机强密码')}
                  </button>
                </div>

                <p className="field-hint" style={{ margin: '0 0 14px' }}>
                  {tr(
                    'Updating your password does not affect your project files or personal AI configuration. Active sessions on other devices will be revoked automatically.',
                    '更换独立强密码不会影响你的项目文件与个人 AI 配置；更新成功后，其他旧设备的登录态会自动失效。',
                  )}
                </p>

                {pwdError && <div className="alert alert-danger">{pwdError}</div>}

                {pwdSuccess && (
                  <div
                    className="alert alert-success"
                    style={{ display: 'flex', alignItems: 'center', gap: 8 }}
                  >
                    <CheckCircle2 size={15} style={{ flexShrink: 0 }} />
                    <span>{pwdSuccess}</span>
                  </div>
                )}

                {generatedPwdHint && (
                  <div
                    className="alert alert-accent"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 10,
                      flexWrap: 'wrap',
                    }}
                  >
                    <span
                      style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 12,
                        wordBreak: 'break-all',
                      }}
                    >
                      {tr(
                        'Generated 18-char password (copy and save first): ',
                        '已生成 18 位随机强密码（请先复制保存）：',
                      )}
                      <strong>{generatedPwdHint}</strong>
                    </span>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() =>
                        handleCopyText(
                          'gen-pwd',
                          generatedPwdHint,
                          'Strong password copied',
                          '已复制新强密码',
                        )
                      }
                    >
                      {copiedId === 'gen-pwd' ? <Check size={12} /> : <Copy size={12} />}
                      {copiedId === 'gen-pwd' ? tr('Copied', '已复制') : tr('Copy', '复制')}
                    </button>
                  </div>
                )}

                <form onSubmit={(e) => void handleChangePassword(e)}>
                  <div className="field">
                    <label className="field-label" htmlFor="settings-page-current-pwd">
                      {tr('Current Password', '当前密码')}
                    </label>
                    <div className="input-group">
                      <input
                        id="settings-page-current-pwd"
                        type={showCurrentPwd ? 'text' : 'password'}
                        className="input"
                        autoComplete="current-password"
                        placeholder={tr('Enter current password', '输入当前登录密码')}
                        value={currentPassword}
                        onChange={(e) => setCurrentPassword(e.target.value)}
                      />
                      <button
                        type="button"
                        className="input-addon-btn"
                        aria-label={
                          showCurrentPwd
                            ? tr('Hide current password', '隐藏当前密码')
                            : tr('Show current password', '显示当前密码')
                        }
                        title={
                          showCurrentPwd
                            ? tr('Hide current password', '隐藏当前密码')
                            : tr('Show current password', '显示当前密码')
                        }
                        onClick={() => setShowCurrentPwd((v) => !v)}
                      >
                        {showCurrentPwd ? <EyeOff size={14} /> : <Eye size={14} />}
                      </button>
                    </div>
                  </div>

                  <div className="form-grid-2">
                    <div className="field">
                      <label className="field-label" htmlFor="settings-page-new-pwd">
                        {tr('New Password (6–128 chars)', '新密码（6–128 位）')}
                      </label>
                      <div className="input-group">
                        <input
                          id="settings-page-new-pwd"
                          type={showNewPwd ? 'text' : 'password'}
                          className="input"
                          autoComplete="new-password"
                          placeholder={tr('Enter new strong password', '输入全新强密码')}
                          value={newPassword}
                          onChange={(e) => setNewPassword(e.target.value)}
                        />
                        <button
                          type="button"
                          className="input-addon-btn"
                          aria-label={
                            showNewPwd
                              ? tr('Hide new password', '隐藏新密码')
                              : tr('Show new password', '显示新密码')
                          }
                          title={
                            showNewPwd
                              ? tr('Hide new password', '隐藏新密码')
                              : tr('Show new password', '显示新密码')
                          }
                          onClick={() => setShowNewPwd((v) => !v)}
                        >
                          {showNewPwd ? <EyeOff size={14} /> : <Eye size={14} />}
                        </button>
                      </div>
                    </div>

                    <div className="field">
                      <label className="field-label" htmlFor="settings-page-confirm-pwd">
                        {tr('Confirm New Password', '确认新密码')}
                      </label>
                      <div className="input-group">
                        <input
                          id="settings-page-confirm-pwd"
                          type={showConfirmPwd ? 'text' : 'password'}
                          className="input"
                          autoComplete="new-password"
                          placeholder={tr('Re-enter new password', '再次输入新密码')}
                          value={confirmNewPassword}
                          onChange={(e) => setConfirmNewPassword(e.target.value)}
                        />
                        <button
                          type="button"
                          className="input-addon-btn"
                          aria-label={
                            showConfirmPwd
                              ? tr('Hide confirm password', '隐藏确认密码')
                              : tr('Show confirm password', '显示确认密码')
                          }
                          title={
                            showConfirmPwd
                              ? tr('Hide confirm password', '隐藏确认密码')
                              : tr('Show confirm password', '显示确认密码')
                          }
                          onClick={() => setShowConfirmPwd((v) => !v)}
                        >
                          {showConfirmPwd ? <EyeOff size={14} /> : <Eye size={14} />}
                        </button>
                      </div>
                    </div>
                  </div>

                  <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 6 }}>
                    <button
                      type="submit"
                      className="btn btn-primary"
                      disabled={
                        changingPwd || !currentPassword || !newPassword || !confirmNewPassword
                      }
                    >
                      {changingPwd ? (
                        <Loader2 size={14} className="spin" />
                      ) : (
                        <KeyRound size={14} />
                      )}
                      {tr('Update Password', '更新登录密码')}
                    </button>
                  </div>
                </form>
              </section>
            </div>
          )}

          {/* ============================================================
              SECTION 4: Site Default AI (Admin Only)
             ============================================================ */}
          {activeSection === 'admin-global' && isAdmin && (
            <div>
              <div className="settings-header">
                <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, letterSpacing: '-0.02em' }}>
                  {tr('Site Default AI', '全局默认 AI（站长）')}
                </h1>
                <p className="field-hint" style={{ margin: '4px 0 0', fontSize: 13 }}>
                  {locale === 'en' ? (
                    <>
                      Maintain the site-wide fallback AI engine. Registration policy is read-only
                      from server <code>.env</code> and cannot be modified from the browser.
                    </>
                  ) : (
                    <>
                      维护本站全局默认 AI 兜底引擎；注册策略严格由服务器 <code>.env</code>{' '}
                      控制，无法从网页误触修改。
                    </>
                  )}
                </p>
              </div>

              {overviewError && (
                <div
                  className="alert alert-danger"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 10,
                    flexWrap: 'wrap',
                  }}
                >
                  <span>{overviewError}</span>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => void loadOverview()}
                  >
                    <RefreshCw size={13} />
                    {tr('Reload', '重新加载')}
                  </button>
                </div>
              )}

              {/* Card 1: Read-Only Server Registration Policy Status */}
              <section className="settings-card">
                <div className="settings-row" style={{ borderTop: 'none', paddingTop: 0 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        marginBottom: 4,
                        flexWrap: 'wrap',
                      }}
                    >
                      <strong style={{ fontSize: 14, color: 'var(--text-primary)' }}>
                        {tr(
                          'Site Registration Policy (Read-Only from .env)',
                          '站点注册策略（仅环境变量只读）',
                        )}
                      </strong>
                      <span
                        className={`pill ${allowPublicRegister ? 'pill-warning' : 'pill-success'}`}
                      >
                        {allowPublicRegister
                          ? tr('Public Registration Open', '允许公开注册')
                          : tr('Invite-Only (Private)', '仅邀请链接注册（私密安全）')}
                      </span>
                    </div>
                    <p className="field-hint" style={{ margin: 0 }}>
                      {locale === 'en' ? (
                        <>
                          Controlled strictly by <code>ALLOW_PUBLIC_REGISTER</code> in server{' '}
                          <code>.env</code> to prevent accidental public exposure. Use project
                          invite links when granting workspace access.
                        </>
                      ) : (
                        <>
                          为防止公网暴露与误触风险，注册开关严格由服务器 <code>.env</code> 中的{' '}
                          <code>ALLOW_PUBLIC_REGISTER</code> 控制，网页端不可切换。需要邀请成员加入项目时，请直接在项目顶栏生成专属邀请链接。
                        </>
                      )}
                    </p>
                  </div>
                </div>
              </section>

              {/* Card 2: Site-Wide Global Fallback AI Config */}
              <section className="settings-card">
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 8,
                    marginBottom: 6,
                    flexWrap: 'wrap',
                  }}
                >
                  <div
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 7,
                      fontWeight: 600,
                      fontSize: 14,
                    }}
                  >
                    <Sparkles size={15} style={{ color: 'var(--ai-accent)' }} />
                    <span>{tr('Site Fallback AI Configuration', '站长全局默认 AI 兜底配置')}</span>
                  </div>
                  {globalForm.apiKey.trim() ? (
                    <span className="pill pill-ai">
                      {tr('New key entered (unsaved)', '已填入新密钥（待保存）')}
                    </span>
                  ) : globalForm.originChanged ? (
                    <span className="pill pill-warning">
                      {tr('Endpoint changed · enter new API Key', '已切换服务商地址 · 请填入新 API Key')}
                    </span>
                  ) : globalForm.hasApiKey ? (
                    <span className="pill pill-success">
                      {tr('✓ Site key stored securely', '✓ 已安全保存全局密钥')}
                    </span>
                  ) : (
                    <span className="pill pill-warning">
                      {tr('No site key configured', '尚未配置全局密钥')}
                    </span>
                  )}
                </div>

                <p className="field-hint" style={{ margin: '0 0 14px' }}>
                  {tr(
                    'Used as the fallback when a member has not configured a personal API key. Personal keys always take precedence.',
                    '当其他成员尚未填写自己的个人 API Key 时，默认使用此站长兜底配置；一旦成员填了自己的 Key，将优先使用他自己的配置。',
                  )}
                </p>

                {loadingOverview ? (
                  <div
                    style={{
                      padding: '24px 12px',
                      color: 'var(--text-muted)',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                    }}
                  >
                    <Loader2 size={15} className="spin" />{' '}
                    {tr('Loading site default AI configuration…', '正在加载全局默认 AI 配置…')}
                  </div>
                ) : (
                  <AiConfigFields
                    form={globalForm}
                    idPrefix="settings-global-ai"
                    loading={loadingOverview}
                    savedKeyLabel={tr('✓ Site key stored securely', '✓ 已安全保存全局密钥')}
                    emptyKeyPlaceholder={tr(
                      'Enter fallback sk-... or paste a NewAPI / OneAPI connection JSON',
                      '输入站点兜底 sk-... 或直接粘贴 NewAPI 连接 JSON',
                    )}
                    savedKeyPlaceholder={tr(
                      'Site key saved (leave blank to keep; enter a new key or paste JSON to replace)',
                      '已保存全局密钥（留空保持不变；输入新密钥或粘贴 JSON 可覆盖）',
                    )}
                  />
                )}
              </section>

              {/* Footer Bar for Global Fallback AI */}
              <div className="settings-footer-bar">
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: '1 1 200px', minWidth: 0 }}>
                  {globalForm.isDirty ? (
                    <span className="dirty-indicator">
                      {tr('Unsaved configuration changes', '有未保存的配置修改')}
                    </span>
                  ) : globalForm.justSaved ? (
                    <span
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 5,
                        fontSize: 12,
                        color: 'var(--success)',
                        fontWeight: 500,
                      }}
                    >
                      <CheckCircle2 size={13} />{' '}
                      {tr('Site default configuration saved', '已保存全局默认配置')}
                    </span>
                  ) : globalForm.hasApiKey ? (
                    <span className="field-hint">
                      {tr('Site fallback configuration is active', '站长全局默认配置已生效')}
                    </span>
                  ) : (
                    <span className="field-hint">
                      {tr('No site fallback key configured yet', '尚未设置全局默认兜底密钥')}
                    </span>
                  )}
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, flexWrap: 'nowrap' }}>
                  <button
                    type="button"
                    className="btn"
                    disabled={globalForm.testing || loadingOverview}
                    onClick={() => void globalForm.handleTest()}
                  >
                    {globalForm.testing ? (
                      <Loader2 size={14} className="spin" />
                    ) : (
                      <PlugZap size={14} />
                    )}
                    {tr('Test Connection', '测试连接')}
                  </button>

                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={globalForm.saving || loadingOverview}
                    onClick={() => void globalForm.handleSave()}
                  >
                    {globalForm.saving ? (
                      <Loader2 size={14} className="spin" />
                    ) : (
                      <Save size={14} />
                    )}
                    {tr('Save Configuration', '保存全局默认')}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* ============================================================
              SECTION 5: Environment
             ============================================================ */}
          {activeSection === 'environment' && (
            <div>
              <div
                className="settings-header"
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  justifyContent: 'space-between',
                  gap: 12,
                  flexWrap: 'wrap',
                }}
              >
                <div>
                  <h1
                    style={{ margin: 0, fontSize: 20, fontWeight: 700, letterSpacing: '-0.02em' }}
                  >
                    {tr('Environment', '运行环境诊断')}
                  </h1>
                  <p className="field-hint" style={{ margin: '4px 0 0', fontSize: 13 }}>
                    {tr(
                      'Inspect backend TeX compilers, Pandoc format converter, qpdf linearization, and Node.js runtime status.',
                      '查看后端 TeX 编译引擎、Pandoc 格式互转、qpdf 线性化加速与 Node.js 运行时状态。',
                    )}
                  </p>
                </div>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={handleRefreshEnv}
                  disabled={refreshingCaps}
                >
                  <RefreshCw size={13} className={refreshingCaps ? 'spin' : undefined} />
                  {tr('Refresh Checks', '刷新检测')}
                </button>
              </div>

              <section className="settings-card">
                {capabilities ? (
                  <div className="form-grid-2">
                    <div
                      style={{
                        padding: '13px 15px',
                        borderRadius: 'var(--radius-md)',
                        border: '1px solid var(--border)',
                        background: 'var(--bg-elevated)',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 5,
                      }}
                    >
                      <span className="field-hint">{tr('Compiler Mode', '编译模式')}</span>
                      <strong style={{ fontSize: 13.5, color: 'var(--text-primary)' }}>
                        {capabilities.compiler.mode === 'remote'
                          ? tr('Remote Worker Node', '远端 Worker 节点')
                          : tr('Local Direct', '本机直连')}
                      </strong>
                      {capabilities.compiler.texBinDir && (
                        <span
                          className="field-hint"
                          style={{
                            fontFamily: 'var(--font-mono)',
                            fontSize: 11,
                            wordBreak: 'break-all',
                          }}
                        >
                          {capabilities.compiler.texBinDir}
                        </span>
                      )}
                    </div>

                    <div
                      style={{
                        padding: '13px 15px',
                        borderRadius: 'var(--radius-md)',
                        border: '1px solid var(--border)',
                        background: 'var(--bg-elevated)',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 5,
                      }}
                    >
                      <span className="field-hint">{tr('TeX Engines', 'TeX 引擎列表')}</span>
                      <div>
                        {capabilities.compiler.available ? (
                          <span className="pill pill-success">
                            {capabilities.compiler.engines.join(' / ')}
                          </span>
                        ) : (
                          <span className="pill pill-warning">
                            {tr('TeX Live not detected', '未检测到 TeX Live')}
                          </span>
                        )}
                      </div>
                    </div>

                    <div
                      style={{
                        padding: '13px 15px',
                        borderRadius: 'var(--radius-md)',
                        border: '1px solid var(--border)',
                        background: 'var(--bg-elevated)',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 5,
                      }}
                    >
                      <span className="field-hint">{tr('Pandoc Version', 'Pandoc 版本')}</span>
                      <div>
                        {capabilities.pandoc.available ? (
                          <span className="pill pill-success">
                            {capabilities.pandoc.version
                              ? `v${capabilities.pandoc.version}`
                              : tr('Installed', '已安装')}
                          </span>
                        ) : (
                          <span className="pill pill-warning">
                            {tr('Not installed', '未安装')}
                          </span>
                        )}
                      </div>
                    </div>

                    <div
                      style={{
                        padding: '13px 15px',
                        borderRadius: 'var(--radius-md)',
                        border: '1px solid var(--border)',
                        background: 'var(--bg-elevated)',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 5,
                      }}
                    >
                      <span className="field-hint">{tr('qpdf Linearization', 'qpdf 线性化')}</span>
                      <div>
                        <span
                          className={`pill ${
                            capabilities.compiler.hasQpdf ? 'pill-success' : 'pill-warning'
                          }`}
                        >
                          {capabilities.compiler.hasQpdf
                            ? tr('Range streaming enabled', '已启用 Range 加速')
                            : tr('Not installed', '未安装')}
                        </span>
                      </div>
                    </div>

                    <div
                      style={{
                        padding: '13px 15px',
                        borderRadius: 'var(--radius-md)',
                        border: '1px solid var(--border)',
                        background: 'var(--bg-elevated)',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 5,
                      }}
                    >
                      <span className="field-hint">{tr('Toolchain', '工具链')}</span>
                      <div style={{ fontSize: 12.5, fontFamily: 'var(--font-mono)' }}>
                        latexmk {capabilities.compiler.hasLatexmk ? '✓' : '×'} · bibtex{' '}
                        {capabilities.compiler.hasBibtex ? '✓' : '×'} · biber{' '}
                        {capabilities.compiler.hasBiber ? '✓' : '×'}
                      </div>
                    </div>

                    <div
                      style={{
                        padding: '13px 15px',
                        borderRadius: 'var(--radius-md)',
                        border: '1px solid var(--border)',
                        background: 'var(--bg-elevated)',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 5,
                      }}
                    >
                      <span className="field-hint">{tr('Node.js Version', 'Node.js 版本')}</span>
                      <code style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5 }}>
                        {capabilities.nodeVersion}
                      </code>
                    </div>
                  </div>
                ) : (
                  <div
                    style={{
                      padding: '28px 12px',
                      color: 'var(--text-muted)',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                    }}
                  >
                    <Loader2 size={15} className="spin" />{' '}
                    {tr('Checking runtime environment…', '正在获取系统运行状态…')}
                  </div>
                )}
              </section>
            </div>
          )}
        </main>
      </div>
    </div>
  );
};
