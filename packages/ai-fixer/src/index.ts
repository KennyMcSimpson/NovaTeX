export {
  DEFAULT_DEEPSEEK_BASE_URL,
  DEFAULT_DEEPSEEK_MODEL,
  DEFAULT_DEEPSEEK_REASONER_MODEL,
  DEFAULT_AI_TIMEOUT_MS,
  MIN_AI_TIMEOUT_MS,
  MAX_AI_TIMEOUT_MS,
  AiConfigError,
  validateAiBaseUrl,
  normalizeOpenAiBaseUrl,
  validateResolvedAiHost,
  readAiConfigFromEnv,
  sanitizeAiConfig,
  resolveAiConfig,
  isReasoningModel,
} from './config.js';
export type {
  AiProviderPublicConfig,
  AiEnvConfig,
  AiConfigInput,
  DnsLookupAddress,
  DnsLookupFn,
} from './config.js';

export {
  LONG_FILE_LINE_THRESHOLD,
  STRUCTURAL_FULL_FILE_MAX_LINES,
  WINDOW_LINE_RADIUS,
  PREAMBLE_MAX_LINES,
  MAX_LOG_EXCERPT_CHARS,
  MAX_DIAGNOSTICS_IN_PROMPT,
  findLatexTableRanges,
  findLatexMathRanges,
  extractTargetWindow,
  splicePatchedWindow,
  buildAiPrompt,
} from './prompts.js';
export type { LatexLineRange, PreparedPromptWindow, BuiltAiPrompt } from './prompts.js';

export {
  ANTI_TRUNCATION_MAX_DROP_RATIO,
  ANTI_TRUNCATION_MIN_LINES_FOR_RATIO,
  AiFixerError,
  extractJsonFixPayload,
  validatePatchedCodeSafety,
  fixLatexWithAi,
  testAiConnection,
  listAiModels,
  createAiFixerClient,
} from './client.js';
export type {
  AiFixerErrorCode,
  AiCallOptions,
  AiConnectionTestResult,
  AiModelsListResult,
  ParsedAiFixPayload,
  SafetyValidationResult,
  AiFixerClient,
} from './client.js';
