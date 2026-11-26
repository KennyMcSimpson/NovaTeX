import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import type { AiFixRequest, CompileDiagnostic } from '@novatex/shared';
import {
  AiConfigError,
  AiFixerError,
  DEFAULT_AI_TIMEOUT_MS,
  DEFAULT_DEEPSEEK_BASE_URL,
  DEFAULT_DEEPSEEK_MODEL,
  DEFAULT_DEEPSEEK_REASONER_MODEL,
  buildAiPrompt,
  createAiFixerClient,
  extractJsonFixPayload,
  fixLatexWithAi,
  listAiModels,
  normalizeOpenAiBaseUrl,
  readAiConfigFromEnv,
  resolveAiConfig,
  sanitizeAiConfig,
  testAiConnection,
  validateAiBaseUrl,
  validateResolvedAiHost,
  type DnsLookupFn,
} from '../src/index.js';
import {
  STRUCTURAL_FULL_FILE_MAX_LINES,
  extractTargetWindow,
  findLatexMathRanges,
  findLatexTableRanges,
} from '../src/prompts.js';

interface CapturedFetchCall {
  url: string;
  init: RequestInit | undefined;
  body: Record<string, unknown>;
}

function createMockFetch(
  handler: (call: CapturedFetchCall) => Promise<Response> | Response,
): { fetchImpl: typeof fetch; calls: CapturedFetchCall[] } {
  const calls: CapturedFetchCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const rawBody = typeof init?.body === 'string' ? init.body : '{}';
    const body = JSON.parse(rawBody) as Record<string, unknown>;
    const call: CapturedFetchCall = { url, init, body };
    calls.push(call);
    return handler(call);
  };
  return { fetchImpl, calls };
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('@novatex/ai-fixer config & SSRF protection', () => {
  it('resolves DeepSeek defaults and never leaks raw apiKey in public view', () => {
    const empty = resolveAiConfig();
    expect(empty).toEqual({
      baseUrl: DEFAULT_DEEPSEEK_BASE_URL,
      hasApiKey: false,
      model: DEFAULT_DEEPSEEK_MODEL,
      reasonerModel: DEFAULT_DEEPSEEK_REASONER_MODEL,
      timeoutMs: DEFAULT_AI_TIMEOUT_MS,
    });

    const secret = 'sk-deepseek-super-secret-987654321';
    const fromEnv = resolveAiConfig({
      AI_BASE_URL: 'https://api.deepseek.com/v1/',
      AI_API_KEY: secret,
      AI_MODEL: 'deepseek-chat',
      AI_REASONER_MODEL: 'deepseek-reasoner',
      AI_TIMEOUT_MS: '60000',
    });

    expect(fromEnv.baseUrl).toBe('https://api.deepseek.com/v1');
    expect(fromEnv.hasApiKey).toBe(true);
    expect(fromEnv.timeoutMs).toBe(60_000);

    // Zero API key leak across every reflection / serialization surface
    expect('apiKey' in fromEnv).toBe(false);
    expect(Object.keys(fromEnv)).not.toContain('apiKey');
    expect(Object.getOwnPropertyNames(fromEnv)).not.toContain('apiKey');
    expect(Object.getOwnPropertySymbols(fromEnv)).toHaveLength(0);
    expect(JSON.stringify(fromEnv)).not.toContain(secret);
    expect(JSON.stringify({ ...fromEnv })).not.toContain(secret);

    // Empty override.apiKey must NOT erase saved apiKey
    const merged = resolveAiConfig(fromEnv, {
      model: 'deepseek-chat-v3',
      apiKey: '   ',
    });
    expect(merged.model).toBe('deepseek-chat-v3');
    expect(merged.hasApiKey).toBe(true);
    expect(JSON.stringify(merged)).not.toContain(secret);

    const sanitized = sanitizeAiConfig({
      baseUrl: DEFAULT_DEEPSEEK_BASE_URL,
      apiKey: secret,
      model: DEFAULT_DEEPSEEK_MODEL,
      reasonerModel: DEFAULT_DEEPSEEK_REASONER_MODEL,
      timeoutMs: DEFAULT_AI_TIMEOUT_MS,
    });
    expect(sanitized.hasApiKey).toBe(true);
    expect('apiKey' in sanitized).toBe(false);
    expect(JSON.stringify(sanitized)).not.toContain(secret);

    const envPartial = readAiConfigFromEnv({
      DEEPSEEK_API_KEY: 'sk-fallback',
      DEEPSEEK_BASE_URL: 'https://api.deepseek.com/v1',
    });
    expect(envPartial.apiKey).toBe('sk-fallback');
    expect(envPartial.baseUrl).toBe('https://api.deepseek.com/v1');
  });

  it('blocks SSRF cloud metadata, loopback, private LAN, and invalid protocols by default while permitting opt-in private endpoints', () => {
    const allowedPublic = [
      'https://api.deepseek.com/v1',
      'https://api.deepseek.com/v1/',
      'https://api.openai.com/v1',
      'https://[2606:4700::1111]/v1',
    ];
    for (const url of allowedPublic) {
      expect(() => validateAiBaseUrl(url), `should allow public ${url}`).not.toThrow();
    }

    const blockedByDefault = [
      '',
      'not-a-url',
      'file:///etc/passwd',
      'ftp://api.deepseek.com/v1',
      'javascript:alert(1)',
      'https://user:pass@api.deepseek.com/v1',
      'https://api.deepseek.com/v1?foo=bar',
      'https://api.deepseek.com/v1#frag',
      // All 10 mandatory loopback / private / CGNAT / ULA targets blocked by default:
      'http://127.0.0.1:8080/v1',
      'http://localhost:11434/v1',
      'http://[::1]:8080/v1',
      'http://[::ffff:127.0.0.1]:8080/v1',
      'http://10.0.0.1/v1',
      'http://172.16.0.5/v1',
      'http://192.168.1.1/v1',
      'http://100.64.0.1/v1',
      'http://[fc00::1]/v1',
      'http://[fd12:3456::1]/v1',
      // Private / internal hostnames
      'http://sub.localhost:11434/v1',
      'http://ollama.local:11434/v1',
      'http://llm.internal/v1',
      // Octal / hex / decimal integer / shorthand IPv4 notations (with and without trailing dot)
      'http://0177.0.0.1/v1',
      'http://0177.0.0.1./v1',
      'http://0x7f000001/v1',
      'http://0x7f000001./v1',
      'http://2130706433/v1',
      'http://127.1/v1',
      'http://0x0a000001/v1',
      'http://012.0.0.1/v1',
      // Special-purpose / reserved / benchmark / multicast IPv4 & IPv6
      'http://192.0.0.1/v1',
      'http://192.0.2.1/v1',
      'http://198.18.0.1/v1',
      'http://224.0.0.1/v1',
      'http://240.0.0.1/v1',
      'http://[ff02::1]/v1',
      // IPv6 wrapping private IPv4 (::ffff, 64:ff9b::, 2002:: 6to4)
      'http://[::ffff:10.0.0.1]/v1',
      'http://[::ffff:192.168.1.1]/v1',
      'http://[64:ff9b::0a00:0001]/v1',
      'http://[2002:0a00:0001::1]/v1',
      'http://[2002:7f00:0001::1]/v1',
      // Cloud metadata & unspecified ranges
      'http://169.254.169.254/latest/meta-data',
      'http://169.254.169.254./v1',
      'http://169.254.170.2/v2/credentials',
      'http://0xa9fea9fe/v1',
      'http://2852039166/v1',
      'http://[::ffff:169.254.169.254]/v1',
      'http://[::ffff:0:169.254.169.254]/v1',
      'http://[::ffff:0:1]/v1',
      'http://[::ffff:0.0.0.1]/v1',
      'http://[::ffff:0:127.0.0.1]/v1',
      'http://[64:ff9b::a9fe:a9fe]/v1',
      'http://[64:ff9b:1::a9fe:a9fe]/v1',
      'http://[64:ff9b:1:dead::1]/v1',
      'http://[fe80::1]/v1',
      'http://[fd00:ec2::254]/v1',
      'http://100.100.100.200/latest/meta-data',
      'http://metadata.google.internal/computeMetadata/v1',
      'http://metadata.goog/v1',
      'http://0.0.0.0:8080/v1',
      'http://0.0.0.1/v1',
      'http://0.123.45.67/v1',
      'http://[::]:8080/v1',
    ];
    for (const url of blockedByDefault) {
      expect(() => validateAiBaseUrl(url), `should block ${url} by default`).toThrow(AiConfigError);
    }

    // Opt-in allowPrivateNetwork: true allows loopback/LAN Ollama while STILL blocking cloud metadata
    const allowedWithOptIn = [
      'http://localhost:11434/v1',
      'http://127.0.0.1:8080/v1',
      'http://[::1]:8080/v1',
      'http://192.168.1.50:11434/v1',
      'http://10.0.0.5:11434/v1',
    ];
    for (const url of allowedWithOptIn) {
      expect(
        () => validateAiBaseUrl(url, { allowPrivateNetwork: true }),
        `should allow ${url} when allowPrivateNetwork=true`,
      ).not.toThrow();
    }

    const alwaysBlockedEvenWithOptIn = [
      'http://169.254.169.254/latest/meta-data',
      'http://100.100.100.200/latest/meta-data',
      'http://metadata.google.internal/computeMetadata/v1',
      'http://[fd00:ec2::254]/v1',
      'http://[fe80::1]/v1',
      'http://[::ffff:169.254.169.254]/v1',
      'http://0.0.0.0:8080/v1',
      'http://[::]:8080/v1',
      'http://[ff02::1]/v1',
    ];
    for (const url of alwaysBlockedEvenWithOptIn) {
      expect(
        () => validateAiBaseUrl(url, { allowPrivateNetwork: true }),
        `should ALWAYS block metadata/unspecified ${url}`,
      ).toThrow(AiConfigError);
    }
  });

  it('blocks DNS-rebinding / .nip.io domains resolving to metadata, 0.0.0.0/8, NAT64, loopback, or RFC1918/ULA private IPs', async () => {
    const blockedCases: Array<{
      url: string;
      records: Array<{ address: string; family: number }>;
    }> = [
      {
        url: 'https://169.254.169.254.nip.io/v1',
        records: [{ address: '169.254.169.254', family: 4 }],
      },
      {
        url: 'https://127.0.0.1.nip.io/v1',
        records: [{ address: '127.0.0.1', family: 4 }],
      },
      {
        url: 'https://rfc1918.example.com/v1',
        records: [{ address: '10.0.0.5', family: 4 }],
      },
      {
        url: 'https://lan-172.example.com/v1',
        records: [{ address: '172.16.0.5', family: 4 }],
      },
      {
        url: 'https://lan-192.example.com/v1',
        records: [{ address: '192.168.1.1', family: 4 }],
      },
      {
        url: 'https://cgnat.example.com/v1',
        records: [{ address: '100.64.0.1', family: 4 }],
      },
      {
        url: 'https://ula6.example.com/v1',
        records: [{ address: 'fd12:3456::1', family: 6 }],
      },
      {
        url: 'https://zero.nip.io/v1',
        records: [{ address: '0.0.0.1', family: 4 }],
      },
      {
        url: 'https://rebind-mixed.example.com/v1',
        records: [
          { address: '93.184.216.34', family: 4 },
          { address: '64:ff9b:1::a9fe:a9fe', family: 6 },
        ],
      },
      {
        url: 'https://loopback6.example.com/v1',
        records: [{ address: '::1', family: 6 }],
      },
      {
        url: 'https://mapped-loopback.example.com/v1',
        records: [{ address: '::ffff:127.0.0.1', family: 6 }],
      },
    ];

    for (const tc of blockedCases) {
      const lookupImpl: DnsLookupFn = async () => tc.records;
      const mockFetch = createMockFetch(() => jsonResponse({}));

      await expect(
        validateResolvedAiHost(tc.url, lookupImpl),
        `validateResolvedAiHost should block ${tc.url}`,
      ).rejects.toThrow(AiConfigError);

      await expect(
        fixLatexWithAi(
          { mode: 'diagnose-and-fix', filePath: 'main.tex', sourceCode: 'hello' },
          { baseUrl: tc.url, apiKey: 'sk-dns-test' },
          { fetchImpl: mockFetch.fetchImpl, lookupImpl },
        ),
        `fixLatexWithAi should block ${tc.url}`,
      ).rejects.toMatchObject({
        name: 'AiFixerError',
        code: 'INVALID_CONFIG',
      });

      const connRes = await testAiConnection(
        { baseUrl: tc.url, apiKey: 'sk-dns-test' },
        { fetchImpl: mockFetch.fetchImpl, lookupImpl },
      );
      expect(connRes.ok, `testAiConnection should block ${tc.url}`).toBe(false);
      expect(connRes.messageZh).toContain('安全拦截');
      expect(mockFetch.calls).toHaveLength(0);
    }

    // Public IP resolution succeeds
    const publicLookup: DnsLookupFn = async () => [{ address: '104.18.26.120', family: 4 }];
    await expect(
      validateResolvedAiHost('https://api.deepseek.com/v1', publicLookup),
    ).resolves.toBeUndefined();

    // Default rejects explicit localhost / loopback BEFORE any DNS lookup
    let lookupCount = 0;
    const countingLookup: DnsLookupFn = async () => {
      lookupCount++;
      return [{ address: '127.0.0.1', family: 4 }];
    };
    await expect(
      validateResolvedAiHost('http://localhost:11434/v1', countingLookup),
    ).rejects.toThrow(AiConfigError);
    await expect(
      validateResolvedAiHost('http://127.0.0.1:8080/v1', countingLookup),
    ).rejects.toThrow(AiConfigError);
    await expect(
      validateResolvedAiHost('http://[::1]:8080/v1', countingLookup),
    ).rejects.toThrow(AiConfigError);
    expect(lookupCount).toBe(0);

    // Explicit opt-in { allowPrivateNetwork: true } allows localhost / 127.0.0.1 / [::1] and skips DNS lookup
    await validateResolvedAiHost('http://localhost:11434/v1', countingLookup, {
      allowPrivateNetwork: true,
    });
    await validateResolvedAiHost('http://127.0.0.1:8080/v1', countingLookup, {
      allowPrivateNetwork: true,
    });
    await validateResolvedAiHost('http://[::1]:8080/v1', countingLookup, {
      allowPrivateNetwork: true,
    });
    expect(lookupCount).toBe(0);
  });

  it('enforces redirect: "error" and blocks HTTP 307 redirect SSRF (both mocked and real HTTP server)', async () => {
    // 1. Verify init.redirect === 'error' and mock 307 / redirect TypeError rejection
    const mock307 = createMockFetch(
      () =>
        new Response('', {
          status: 307,
          headers: { Location: 'http://169.254.169.254/latest/meta-data' },
        }),
    );

    await expect(
      fixLatexWithAi(
        { mode: 'diagnose-and-fix', filePath: 'main.tex', sourceCode: 'hello' },
        { apiKey: 'sk-redir-test' },
        { fetchImpl: mock307.fetchImpl },
      ),
    ).rejects.toMatchObject({
      code: 'REDIRECT_BLOCKED',
      messageZh: expect.stringContaining('安全策略已拦截 AI 接口重定向请求'),
    });
    expect(mock307.calls[0]?.init?.redirect).toBe('error');

    const conn307 = await testAiConnection(
      { apiKey: 'sk-redir-test' },
      { fetchImpl: mock307.fetchImpl },
    );
    expect(conn307.ok).toBe(false);
    expect(conn307.messageZh).toContain('安全策略已拦截 AI 接口重定向请求');
    expect(mock307.calls[1]?.init?.redirect).toBe('error');

    // 2. End-to-end verification against real local HTTP 307 server using native Node fetch
    let secretTargetHits = 0;
    const secretServer = http.createServer((_req, res) => {
      secretTargetHits++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ secret: 'SHOULD_NEVER_BE_REACHED' }));
    });
    await new Promise<void>((resolve) => secretServer.listen(0, '127.0.0.1', resolve));
    const secretPort = (secretServer.address() as AddressInfo).port;

    const redirectServer = http.createServer((_req, res) => {
      res.writeHead(307, { Location: `http://127.0.0.1:${secretPort}/secret` });
      res.end();
    });
    await new Promise<void>((resolve) => redirectServer.listen(0, '127.0.0.1', resolve));
    const redirectPort = (redirectServer.address() as AddressInfo).port;

    try {
      const baseUrl = `http://127.0.0.1:${redirectPort}/v1`;

      // Default strictly rejects loopback before connecting
      await expect(
        fixLatexWithAi(
          { mode: 'diagnose-and-fix', filePath: 'main.tex', sourceCode: 'hello' },
          { baseUrl, apiKey: 'sk-real-redir' },
        ),
      ).rejects.toMatchObject({
        code: 'INVALID_CONFIG',
      });

      // Even when allowPrivateNetwork=true, HTTP 307 redirects are still blocked
      await expect(
        fixLatexWithAi(
          { mode: 'diagnose-and-fix', filePath: 'main.tex', sourceCode: 'hello' },
          { baseUrl, apiKey: 'sk-real-redir' },
          { allowPrivateNetwork: true },
        ),
      ).rejects.toMatchObject({
        code: 'REDIRECT_BLOCKED',
        messageZh: expect.stringContaining('安全策略已拦截 AI 接口重定向请求'),
      });

      const realConnRes = await testAiConnection(
        { baseUrl, apiKey: 'sk-real-redir' },
        { allowPrivateNetwork: true },
      );
      expect(realConnRes.ok).toBe(false);
      expect(realConnRes.messageZh).toContain('安全策略已拦截 AI 接口重定向请求');
      expect(secretTargetHits).toBe(0);
    } finally {
      await new Promise<void>((resolve) => redirectServer.close(() => resolve()));
      await new Promise<void>((resolve) => secretServer.close(() => resolve()));
    }
  });
});

describe('@novatex/ai-fixer deepseek-chat & deepseek-reasoner', () => {
  it('fixes compile errors with mocked deepseek-chat and produces Chinese report + unified diff', async () => {
    const sourceCode = [
      '\\documentclass{article}',
      '\\begin{document}',
      'The accuracy reached 95% on the validation split.',
      '\\begin{equation}',
      '  E = mc^2',
      '\\end{document}',
    ].join('\n');

    const fixedCode = [
      '\\documentclass{article}',
      '\\begin{document}',
      'The accuracy reached 95\\% on the validation split.',
      '\\begin{equation}',
      '  E = mc^2',
      '\\end{equation}',
      '\\end{document}',
    ].join('\n');

    const diagnostics: CompileDiagnostic[] = [
      {
        id: 'd1',
        file: 'main.tex',
        line: 6,
        severity: 'error',
        code: 'ENV_MISMATCH',
        titleZh: '环境未闭合',
        explanationZh: '\\begin{equation} 缺少对应的 \\end{equation}',
        quickFixHintZh: '补充 \\end{equation}',
        rawMessage: '! LaTeX Error: \\begin{equation} on input line 4 ended by \\end{document}.',
      },
    ];

    const { fetchImpl, calls } = createMockFetch(() =>
      jsonResponse({
        model: 'deepseek-chat',
        choices: [
          {
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: JSON.stringify({
                summaryZh: '补全了缺失的 \\end{equation} 并转义正文中的百分号。',
                rootCauseZh: '第 4 行开启的 equation 环境未闭合，且第 3 行 95% 未转义导致后半句被注释。',
                actionsTakenZh: ['第 3 行将 95% 转义为 95\\%', '第 6 行前补齐 \\end{equation}'],
                patchedCode: fixedCode,
                warningsZh: [],
              }),
            },
          },
        ],
        usage: { prompt_tokens: 320, completion_tokens: 110, total_tokens: 430 },
      }),
    );

    const res = await fixLatexWithAi(
      {
        mode: 'diagnose-and-fix',
        filePath: 'main.tex',
        sourceCode,
        diagnostics,
        rawLogExcerpt: '! LaTeX Error: \\begin{equation} on input line 4 ended by \\end{document}.',
      },
      { apiKey: 'sk-test-chat-key' },
      { fetchImpl },
    );

    expect(calls).toHaveLength(1);
    const reqCall = calls[0]!;
    expect(reqCall.url).toBe('https://api.deepseek.com/v1/chat/completions');
    expect((reqCall.init?.headers as Record<string, string>).Authorization).toBe(
      'Bearer sk-test-chat-key',
    );
    expect(reqCall.body.model).toBe('deepseek-chat');
    expect(reqCall.body.temperature).toBe(0.1);
    expect(reqCall.body.response_format).toEqual({ type: 'json_object' });

    const messages = reqCall.body.messages as Array<{ role: string; content: string }>;
    expect(messages[0]?.content).toContain('STRICT ANTI-REWRITE GUARDRAIL');
    expect(messages[0]?.content).toContain('严禁润色');

    expect(res.ok).toBe(true);
    expect(res.mode).toBe('diagnose-and-fix');
    expect(res.modelUsed).toBe('deepseek-chat');
    expect(res.summaryZh).toContain('\\end{equation}');
    expect(res.rootCauseZh).toContain('equation');
    expect(res.actionsTakenZh).toHaveLength(2);
    expect(res.patchedCode).toBe(fixedCode);
    expect(res.diff.additions).toBe(2);
    expect(res.diff.deletions).toBe(1);
    expect(res.diff.unifiedDiff).toContain('--- a/main.tex');
    expect(res.diff.unifiedDiff).toContain('+++ b/main.tex');
    expect(res.diff.unifiedDiff).toContain('-The accuracy reached 95% on the validation split.');
    expect(res.diff.unifiedDiff).toContain('+The accuracy reached 95\\% on the validation split.');
    expect(res.diff.unifiedDiff).toContain('+\\end{equation}');
    expect(res.usage).toEqual({ promptTokens: 320, completionTokens: 110, totalTokens: 430 });
  });

  it('switches to deepseek-reasoner, omits temperature/response_format, and parses fenced JSON cleanly', async () => {
    const sourceCode = [
      '\\documentclass{article}',
      '\\begin{document}',
      'Result: \\frac{a+b}{c',
      '\\end{document}',
    ].join('\n');

    const fixedCode = [
      '\\documentclass{article}',
      '\\begin{document}',
      'Result: $\\frac{a+b}{c}$',
      '\\end{document}',
    ].join('\n');

    const fencedPayload = [
      '以下是修复后的结构化 JSON：',
      '```json',
      JSON.stringify(
        {
          summaryZh: '补全了缺失的右花括号并添加行内数学定界符。',
          rootCauseZh: '\\frac 未置于数学模式且缺少闭合花括号。',
          actionsTakenZh: ['使用 $...$ 包裹 \\frac{a+b}{c} 并补全右花括号'],
          patchedCode: fixedCode,
          warningsZh: [],
        },
        null,
        2,
      ),
      '```',
    ].join('\n');

    const { fetchImpl, calls } = createMockFetch(() =>
      jsonResponse({
        model: 'deepseek-reasoner',
        choices: [
          {
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              reasoning_content: 'Let me trace the braces around \\frac{a+b}{c ... missing } and math mode.',
              content: fencedPayload,
            },
          },
        ],
      }),
    );

    const res = await fixLatexWithAi(
      {
        mode: 'diagnose-and-fix',
        filePath: 'paper.tex',
        sourceCode,
        useReasoner: true,
      },
      { apiKey: 'sk-reasoner-key' },
      { fetchImpl },
    );

    expect(calls).toHaveLength(1);
    const reqBody = calls[0]!.body;
    expect(reqBody.model).toBe('deepseek-reasoner');
    expect('temperature' in reqBody).toBe(false);
    expect('response_format' in reqBody).toBe(false);

    expect(res.ok).toBe(true);
    expect(res.modelUsed).toBe('deepseek-reasoner');
    expect(res.patchedCode).toBe(fixedCode);
    expect(res.diff.additions).toBe(1);
    expect(res.diff.deletions).toBe(1);

    // Also test <think>...</think> wrapper extraction and prose-wrapped JSON with nested LaTeX braces
    const withThink = extractJsonFixPayload(
      `<think>Checking braces...</think>\n\`\`\`json\n{"summaryZh":"ok","rootCauseZh":"brace","actionsTakenZh":[],"patchedCode":"x","warningsZh":[]}\n\`\`\``,
    );
    expect(withThink.patchedCode).toBe('x');

    const proseWrapped = extractJsonFixPayload(
      `Here is the JSON fix:\n{"summaryZh":"修复引号与花括号","rootCauseZh":"括号","actionsTakenZh":["修复"],"patchedCode":"\\\\textbf{a \\"b\\" {c}}","warningsZh":[]}\nDone.`,
    );
    expect(proseWrapped.patchedCode).toBe('\\textbf{a "b" {c}}');
  });
});

describe('@novatex/ai-fixer windowed surgical splice on long files', () => {
  it('sends only ±60-line window around line 220 + preamble on a 400-line file and splices without touching lines 1-150 or 300-400', async () => {
    const lines: string[] = [];
    lines.push('\\documentclass[conference]{IEEEtran}'); // line 1
    lines.push('\\usepackage{amsmath}'); // line 2
    lines.push('\\usepackage{booktabs}'); // line 3
    lines.push('\\begin{document}'); // line 4

    for (let ln = 5; ln <= 400; ln++) {
      if (ln === 220) {
        lines.push('Line 220 broken macro: \\textbf{unclosed bold text');
      } else {
        lines.push(`Line ${ln} original academic prose marker_L${ln}.`);
      }
    }
    expect(lines).toHaveLength(400);
    const sourceCode = lines.join('\n');

    const diagnostics: CompileDiagnostic[] = [
      {
        id: 'err-220',
        file: 'thesis.tex',
        line: 220,
        severity: 'error',
        code: 'UNCLOSED_BRACE',
        titleZh: '缺少闭合花括号',
        explanationZh: '第 220 行 \\textbf{ 未闭合',
        quickFixHintZh: '补充 }',
        rawMessage: '! File ended while scanning use of \\textbf.',
      },
    ];

    const request: AiFixRequest = {
      mode: 'diagnose-and-fix',
      filePath: 'thesis.tex',
      sourceCode,
      diagnostics,
    };

    const built = buildAiPrompt(request);
    expect(built.window.isWindowed).toBe(true);
    expect(built.window.startLine).toBe(160);
    expect(built.window.endLine).toBe(280);
    expect(built.window.preambleContext).toContain('\\documentclass[conference]{IEEEtran}');
    expect(built.window.preambleContext).toContain('\\begin{document}');

    // Verify lines 50..150 and lines 300..400 are NOT included in the prompt payload
    expect(built.userPrompt).not.toContain('marker_L100');
    expect(built.userPrompt).not.toContain('marker_L150');
    expect(built.userPrompt).not.toContain('marker_L300');
    expect(built.userPrompt).not.toContain('marker_L399');
    expect(built.userPrompt).toContain('Line 220 broken macro');

    // Mock AI returns repaired window (160..280) with an extra trailing newline (common LLM artifact)
    const repairedWindowLines = lines.slice(159, 280);
    repairedWindowLines[220 - 160] = 'Line 220 broken macro: \\textbf{unclosed bold text}';
    const repairedWindowText = `${repairedWindowLines.join('\n')}\n`;

    const { fetchImpl } = createMockFetch(() =>
      jsonResponse({
        model: 'deepseek-chat',
        choices: [
          {
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: JSON.stringify({
                summaryZh: '补全了第 220 行 \\textbf 的闭合花括号。',
                rootCauseZh: '第 220 行缺少右花括号 }。',
                actionsTakenZh: ['第 220 行末尾补全 }'],
                patchedCode: repairedWindowText,
                warningsZh: [],
              }),
            },
          },
        ],
      }),
    );

    const res = await fixLatexWithAi(request, { apiKey: 'sk-window-key' }, { fetchImpl });

    expect(res.ok).toBe(true);
    const patchedLines = res.patchedCode.split('\n');
    expect(patchedLines).toHaveLength(400);

    // Lines 1..150 completely untouched
    expect(patchedLines.slice(0, 150)).toEqual(lines.slice(0, 150));
    // Lines 300..400 completely untouched
    expect(patchedLines.slice(299, 400)).toEqual(lines.slice(299, 400));
    // Line 220 surgically fixed
    expect(patchedLines[219]).toBe('Line 220 broken macro: \\textbf{unclosed bold text}');
    expect(res.diff.additions).toBe(1);
    expect(res.diff.deletions).toBe(1);
  });

  it('respects explicit selectionRange and preserves CRLF line endings', async () => {
    const crlfSource = [
      '\\documentclass{article}',
      '\\usepackage{booktabs}',
      '\\begin{document}',
      'Intro paragraph must stay identical.',
      '\\begin{tabular}{|c|c|}',
      '\\hline',
      'Model & Acc \\\\',
      '\\hline',
      'Ours & 94.2 \\\\',
      '\\hline',
      '\\end{tabular}',
      'Conclusion paragraph must stay identical.',
      '\\end{document}',
    ].join('\r\n');

    const repairedTable = [
      '\\begin{tabular}{cc}',
      '\\toprule',
      'Model & Acc \\\\',
      '\\midrule',
      'Ours & 94.2 \\\\',
      '\\bottomrule',
      '\\end{tabular}',
    ].join('\n');

    const { fetchImpl } = createMockFetch(() =>
      jsonResponse({
        model: 'deepseek-chat',
        choices: [
          {
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: JSON.stringify({
                summaryZh: '已整理为 booktabs 三线表。',
                rootCauseZh: '原表格包含多余竖线和 \\hline。',
                actionsTakenZh: ['替换为 \\toprule/\\midrule/\\bottomrule'],
                patchedCode: repairedTable,
                warningsZh: [],
              }),
            },
          },
        ],
      }),
    );

    const res = await fixLatexWithAi(
      {
        mode: 'format-table',
        filePath: 'results.tex',
        sourceCode: crlfSource,
        selectionRange: { startLine: 5, endLine: 11 },
      },
      { apiKey: 'sk-sel-key' },
      { fetchImpl },
    );

    expect(res.ok).toBe(true);
    expect(res.patchedCode).toContain('\r\n');
    expect(res.patchedCode).toContain('Intro paragraph must stay identical.');
    expect(res.patchedCode).toContain('Conclusion paragraph must stay identical.');
    expect(res.patchedCode).toContain('\\toprule');
    expect(res.patchedCode).toContain('\\midrule');
    expect(res.patchedCode).toContain('\\bottomrule');
  });
});

describe('@novatex/ai-fixer anti-truncation safeguard', () => {
  it('rejects a hallucinated response that deletes >60% of a paper without wiping original code', async () => {
    const paperLines = [
      '\\documentclass{article}',
      '\\begin{document}',
      ...Array.from({ length: 30 }, (_, i) => `Section paragraph line ${i + 1} with empirical value ${i * 3.14}.`),
      '\\end{document}',
    ];
    const sourceCode = paperLines.join('\n'); // 33 lines

    // Hallucinated truncated output: only 4 lines (~88% deleted!)
    const truncatedOutput = [
      '\\documentclass{article}',
      '\\begin{document}',
      '% ... rest omitted ...',
      '\\end{document}',
    ].join('\n');

    const { fetchImpl } = createMockFetch(() =>
      jsonResponse({
        model: 'deepseek-chat',
        choices: [
          {
            finish_reason: 'length',
            message: {
              role: 'assistant',
              content: JSON.stringify({
                summaryZh: '已修复。',
                rootCauseZh: '格式问题。',
                actionsTakenZh: ['精简输出'],
                patchedCode: truncatedOutput,
                warningsZh: [],
              }),
            },
          },
        ],
      }),
    );

    const res = await fixLatexWithAi(
      { mode: 'diagnose-and-fix', filePath: 'full.tex', sourceCode },
      { apiKey: 'sk-safe-key' },
      { fetchImpl },
    );

    expect(res.ok).toBe(false);
    expect(res.patchedCode).toBe(sourceCode);
    expect(res.diff.additions).toBe(0);
    expect(res.diff.deletions).toBe(0);
    expect(res.warningsZh?.some((w) => w.includes('反截断保护'))).toBe(true);
    expect(res.warningsZh?.some((w) => w.includes('finish_reason=length'))).toBe(true);
  });

  it('rejects empty or fence-only blank patchedCode on non-empty input', async () => {
    const sourceCode = '\\documentclass{article}\n\\begin{document}\nHello.\n\\end{document}';

    const { fetchImpl } = createMockFetch(() =>
      jsonResponse({
        model: 'deepseek-chat',
        choices: [
          {
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: JSON.stringify({
                summaryZh: '空输出',
                rootCauseZh: '',
                actionsTakenZh: [],
                patchedCode: '```latex\n   \n```',
                warningsZh: [],
              }),
            },
          },
        ],
      }),
    );

    const res = await fixLatexWithAi(
      { mode: 'cleanup-conversion', filePath: 'empty-test.tex', sourceCode },
      { apiKey: 'sk-safe-key' },
      { fetchImpl },
    );

    expect(res.ok).toBe(false);
    expect(res.patchedCode).toBe(sourceCode);
    expect(res.warningsZh?.[0]).toContain('反截断保护');
  });

  it('rejects >60% truncation inside an editable window on a 400-line file', async () => {
    const lines = [
      '\\documentclass{article}',
      '\\begin{document}',
      ...Array.from({ length: 397 }, (_, i) => `Body line ${i + 3} content.`),
      '\\end{document}',
    ];
    const sourceCode = lines.join('\n');

    const { fetchImpl } = createMockFetch(() =>
      jsonResponse({
        model: 'deepseek-chat',
        choices: [
          {
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: JSON.stringify({
                summaryZh: '已修复第 220 行。',
                rootCauseZh: '语法错',
                actionsTakenZh: ['截断窗口'],
                patchedCode: 'Body line 220 fixed only.\n% omitted remaining 120 lines',
                warningsZh: [],
              }),
            },
          },
        ],
      }),
    );

    const res = await fixLatexWithAi(
      {
        mode: 'diagnose-and-fix',
        filePath: 'long.tex',
        sourceCode,
        diagnostics: [
          {
            id: 'e1',
            file: 'long.tex',
            line: 220,
            severity: 'error',
            code: 'ERR',
            titleZh: '报错',
            explanationZh: '报错',
            quickFixHintZh: '修复',
            rawMessage: 'err',
          },
        ],
      },
      { apiKey: 'sk-win-trunc' },
      { fetchImpl },
    );

    expect(res.ok).toBe(false);
    expect(res.patchedCode).toBe(sourceCode);
    expect(res.diff.additions).toBe(0);
    expect(res.diff.deletions).toBe(0);
    expect(res.warningsZh?.some((w) => w.includes('反截断保护'))).toBe(true);
  });
});

describe('@novatex/ai-fixer format modes, connection test & error handling', () => {
  it('supports format-table, format-math, and cleanup-conversion modes with mode-specific prompts', async () => {
    const cases: Array<{
      mode: 'format-table' | 'format-math' | 'cleanup-conversion';
      expectedSystemKeyword: string;
      sourceCode: string;
      patchedCode: string;
    }> = [
      {
        mode: 'format-table',
        expectedSystemKeyword: '\\toprule',
        sourceCode: '\\begin{tabular}{|l|r|}\n\\hline\nMethod & F1 \\\\\n\\hline\nBase & 81.2 \\\\\n\\hline\n\\end{tabular}',
        patchedCode: '\\begin{tabular}{lr}\n\\toprule\nMethod & F1 \\\\\n\\midrule\nBase & 81.2 \\\\\n\\bottomrule\n\\end{tabular}',
      },
      {
        mode: 'format-math',
        expectedSystemKeyword: 'align',
        sourceCode: '\\begin{eqnarray}\n y = ax + b \\\\\n z = cx + d\n\\end{eqnarray}',
        patchedCode: '\\begin{align}\n y &= ax + b \\\\\n z &= cx + d\n\\end{align}',
      },
      {
        mode: 'cleanup-conversion',
        expectedSystemKeyword: '\\tightlist',
        sourceCode: '\\begin{itemize}\n\\tightlist\n\\item First finding.\n\\item Second finding.\n\\end{itemize}',
        patchedCode: '\\begin{itemize}\n\\item First finding.\n\\item Second finding.\n\\end{itemize}',
      },
    ];

    for (const tc of cases) {
      const { fetchImpl, calls } = createMockFetch(() =>
        jsonResponse({
          model: 'deepseek-chat',
          choices: [
            {
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content: JSON.stringify({
                  summaryZh: `完成 ${tc.mode}`,
                  rootCauseZh: '原始格式待整理',
                  actionsTakenZh: ['执行最小格式化整理'],
                  patchedCode: tc.patchedCode,
                  warningsZh: [],
                }),
              },
            },
          ],
        }),
      );

      const res = await fixLatexWithAi(
        { mode: tc.mode, filePath: 'section.tex', sourceCode: tc.sourceCode },
        { apiKey: 'sk-format-key' },
        { fetchImpl },
      );

      const sysMsg = (calls[0]!.body.messages as Array<{ content: string }>)[0]!.content;
      expect(sysMsg).toContain(tc.expectedSystemKeyword);
      expect(sysMsg).toContain('STRICT ANTI-REWRITE GUARDRAIL');
      expect(res.ok).toBe(true);
      expect(res.mode).toBe(tc.mode);
      expect(res.patchedCode).toBe(tc.patchedCode);
      expect(res.diff.unifiedDiff.length).toBeGreaterThan(0);
    }
  });

  it('handles missing API key, HTTP 401 (with secret redaction), HTTP 429, timeout, and empty reasoner content', async () => {
    // 1. Missing API key
    await expect(
      fixLatexWithAi(
        { mode: 'diagnose-and-fix', filePath: 'main.tex', sourceCode: 'hello' },
        {},
      ),
    ).rejects.toMatchObject({
      name: 'AiFixerError',
      code: 'MISSING_API_KEY',
    });

    // 2. HTTP 401 — also verify echoed API key is redacted!
    const secretKey = 'sk-must-never-appear-in-errors-401';
    const mock401 = createMockFetch(() =>
      jsonResponse({ error: { message: `Invalid key: ${secretKey}` } }, 401),
    );
    try {
      await fixLatexWithAi(
        { mode: 'diagnose-and-fix', filePath: 'main.tex', sourceCode: 'hello' },
        { apiKey: secretKey },
        { fetchImpl: mock401.fetchImpl },
      );
      expect.fail('Expected HTTP 401 error');
    } catch (err) {
      expect(err).toBeInstanceOf(AiFixerError);
      const aiErr = err as AiFixerError;
      expect(aiErr.code).toBe('HTTP_AUTH_ERROR');
      expect(aiErr.status).toBe(401);
      expect(aiErr.messageZh).not.toContain(secretKey);
      expect(aiErr.messageZh).toContain('[REDACTED]');
    }

    // 3. HTTP 429 rate limit
    const mock429 = createMockFetch(() =>
      jsonResponse({ error: { message: 'Rate limit exceeded' } }, 429),
    );
    await expect(
      fixLatexWithAi(
        { mode: 'diagnose-and-fix', filePath: 'main.tex', sourceCode: 'hello' },
        { apiKey: 'sk-rate-key' },
        { fetchImpl: mock429.fetchImpl },
      ),
    ).rejects.toMatchObject({
      code: 'HTTP_RATE_LIMIT',
      status: 429,
    });

    // 4. Timeout via AbortController
    const slowFetch: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        });
      });

    await expect(
      fixLatexWithAi(
        { mode: 'diagnose-and-fix', filePath: 'main.tex', sourceCode: 'hello' },
        { apiKey: 'sk-timeout-key', timeoutMs: 35 },
        { fetchImpl: slowFetch },
      ),
    ).rejects.toMatchObject({
      code: 'TIMEOUT',
    });

    // 5. Reasoner returns only reasoning_content with empty content
    const mockEmptyContent = createMockFetch(() =>
      jsonResponse({
        model: 'deepseek-reasoner',
        choices: [
          {
            finish_reason: 'length',
            message: {
              role: 'assistant',
              reasoning_content: 'thinking forever...',
              content: '',
            },
          },
        ],
      }),
    );
    await expect(
      fixLatexWithAi(
        { mode: 'diagnose-and-fix', filePath: 'main.tex', sourceCode: 'hello', useReasoner: true },
        { apiKey: 'sk-r1-key' },
        { fetchImpl: mockEmptyContent.fetchImpl },
      ),
    ).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });
    // 6. Per-request SSRF override is blocked before any network call
    const mockNeverCalled = createMockFetch(() => jsonResponse({}));
    await expect(
      fixLatexWithAi(
        {
          mode: 'diagnose-and-fix',
          filePath: 'main.tex',
          sourceCode: 'hello',
          providerOverride: { baseUrl: 'http://169.254.169.254/latest/meta-data' },
        },
        { apiKey: 'sk-valid' },
        { fetchImpl: mockNeverCalled.fetchImpl },
      ),
    ).rejects.toMatchObject({
      code: 'INVALID_CONFIG',
    });
    expect(mockNeverCalled.calls).toHaveLength(0);
  });

  it('testAiConnection reports ok/latency on success and clean Chinese errors on failure', async () => {
    // Missing key
    const missing = await testAiConnection({});
    expect(missing.ok).toBe(false);
    expect(missing.latencyMs).toBe(0);
    expect(missing.messageZh).toContain('API Key');

    // SSRF blocked
    const ssrf = await testAiConnection({
      baseUrl: 'http://169.254.169.254/latest',
      apiKey: 'sk-any',
    });
    expect(ssrf.ok).toBe(false);
    expect(ssrf.messageZh).toContain('安全拦截');

    // Success via client factory (opt-in allowPrivateNetwork for local Ollama)
    const mockOk = createMockFetch(() =>
      jsonResponse({
        id: 'chatcmpl-ping',
        model: 'deepseek-chat',
        choices: [{ message: { role: 'assistant', content: 'OK' } }],
      }),
    );
    // Default blocks loopback before fetch
    const blockedLocal = await testAiConnection(
      { baseUrl: 'http://127.0.0.1:18080/v1', apiKey: 'sk-local-test' },
      { fetchImpl: mockOk.fetchImpl },
    );
    expect(blockedLocal.ok).toBe(false);
    expect(blockedLocal.messageZh).toContain('安全拦截');
    expect(mockOk.calls).toHaveLength(0);

    const client = createAiFixerClient(
      { baseUrl: 'http://127.0.0.1:18080/v1', apiKey: 'sk-local-test' },
      { fetchImpl: mockOk.fetchImpl, allowPrivateNetwork: true },
    );
    expect(client.getPublicConfig().hasApiKey).toBe(true);
    expect('apiKey' in client.getPublicConfig()).toBe(false);

    const okRes = await client.testConnection();
    expect(okRes.ok).toBe(true);
    expect(okRes.latencyMs).toBeGreaterThanOrEqual(0);
    expect(okRes.messageZh).toContain('连接成功');
    expect(mockOk.calls[0]!.url).toBe('http://127.0.0.1:18080/v1/chat/completions');

    // Non-JSON HTML upstream error keeps safe redaction and compact truncation
    const secretHtmlKey = 'sk-html-secret-should-redact';
    const mockHtml502 = createMockFetch(
      () =>
        new Response(
          `<!DOCTYPE html><html><head><title>502 Bad Gateway</title></head><body><h1>502 Bad Gateway</h1><p>Key ${secretHtmlKey} ${'noise '.repeat(80)}</p></body></html>`,
          { status: 502, headers: { 'Content-Type': 'text/html' } },
        ),
    );
    const htmlErr = await testAiConnection(
      { apiKey: secretHtmlKey },
      { fetchImpl: mockHtml502.fetchImpl },
    );
    expect(htmlErr.ok).toBe(false);
    expect(htmlErr.messageZh).toContain('502');
    expect(htmlErr.messageZh).not.toContain(secretHtmlKey);
    expect(htmlErr.messageZh).not.toContain('<html>');
    expect(htmlErr.messageZh.length).toBeLessThan(220);

    // HTTP 401 via testAiConnection
    const mockUnauthorized = createMockFetch(() =>
      jsonResponse({ error: { message: 'Bad auth' } }, 401),
    );
    const badAuth = await testAiConnection(
      { apiKey: 'sk-bad' },
      { fetchImpl: mockUnauthorized.fetchImpl },
    );
    expect(badAuth.ok).toBe(false);
    expect(badAuth.messageZh).toContain('401');

    // Timeout via testAiConnection
    const slowFetch: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        });
      });
    const timedOut = await testAiConnection(
      { apiKey: 'sk-slow', timeoutMs: 30 },
      { fetchImpl: slowFetch },
    );
    expect(timedOut.ok).toBe(false);
    expect(timedOut.messageZh).toContain('超时');
  });
});

describe('@novatex/ai-fixer relay normalization, model listing & response_format fallback', () => {
  it('normalizeOpenAiBaseUrl appends /v1 for bare relay origins, keeps explicit paths, and rejects SSRF hosts', () => {
    expect(normalizeOpenAiBaseUrl('https://relay.example.com')).toBe('https://relay.example.com/v1');
    expect(normalizeOpenAiBaseUrl('https://relay.example.com/')).toBe('https://relay.example.com/v1');
    expect(normalizeOpenAiBaseUrl('https://api.deepseek.com/v1')).toBe('https://api.deepseek.com/v1');
    expect(normalizeOpenAiBaseUrl('https://api.deepseek.com/v1/')).toBe('https://api.deepseek.com/v1');
    expect(normalizeOpenAiBaseUrl('https://gateway.example.com/api/v1')).toBe('https://gateway.example.com/api/v1');
    expect(normalizeOpenAiBaseUrl('https://gateway.example.com/api/v1/')).toBe('https://gateway.example.com/api/v1');

    // resolveAiConfig applies normalizeOpenAiBaseUrl automatically
    const resolvedBare = resolveAiConfig({
      baseUrl: 'https://relay.example.com',
      apiKey: 'sk-relay-bare',
    });
    expect(resolvedBare.baseUrl).toBe('https://relay.example.com/v1');

    const ssrfBlocked = [
      'http://169.254.169.254',
      'http://169.254.169.254/latest/meta-data',
      'http://metadata.google.internal',
      'http://[::ffff:169.254.169.254]',
      'http://0.0.0.0:8080',
      'file:///etc/passwd',
      'https://user:pass@relay.example.com',
    ];
    for (const url of ssrfBlocked) {
      expect(() => normalizeOpenAiBaseUrl(url), `should reject ${url}`).toThrow(AiConfigError);
    }
  });

  it('listAiModels parses { data: [{ id }] }, prioritizes DeepSeek/Flash models, and enforces redirect/SSRF/DNS/key checks', async () => {
    // 1. Missing API key returns clean Chinese failure without calling fetch
    const neverFetch = createMockFetch(() => jsonResponse({ data: [] }));
    const missingKeyRes = await listAiModels(
      { baseUrl: 'https://relay.example.com' },
      { fetchImpl: neverFetch.fetchImpl },
    );
    expect(missingKeyRes.ok).toBe(false);
    expect(missingKeyRes.models).toEqual([]);
    expect(missingKeyRes.normalizedBaseUrl).toBe('https://relay.example.com/v1');
    expect(missingKeyRes.messageZh).toContain('API Key');
    expect(neverFetch.calls).toHaveLength(0);

    // 2. Static SSRF rejection before fetch (metadata + private/loopback blocked by default)
    for (const blockedUrl of ['http://169.254.169.254', 'http://127.0.0.1:11434', 'http://10.0.0.1:8000']) {
      const ssrfRes = await listAiModels(
        { baseUrl: blockedUrl, apiKey: 'sk-any' },
        { fetchImpl: neverFetch.fetchImpl },
      );
      expect(ssrfRes.ok, `listAiModels should block ${blockedUrl}`).toBe(false);
      expect(ssrfRes.models).toEqual([]);
      expect(ssrfRes.messageZh).toContain('安全拦截');
      expect(neverFetch.calls).toHaveLength(0);
    }

    // Opt-in allowPrivateNetwork lets listAiModels reach local Ollama
    const mockLocalOllama = createMockFetch(() =>
      jsonResponse({ data: [{ id: 'qwen2.5-coder:14b' }] }),
    );
    const localListRes = await listAiModels(
      { baseUrl: 'http://localhost:11434', apiKey: 'ollama' },
      { fetchImpl: mockLocalOllama.fetchImpl, allowPrivateNetwork: true },
    );
    expect(localListRes.ok).toBe(true);
    expect(localListRes.normalizedBaseUrl).toBe('http://localhost:11434/v1');
    expect(localListRes.models).toEqual(['qwen2.5-coder:14b']);

    // 3. DNS-rebinding SSRF rejection before fetch
    const evilDnsLookup: DnsLookupFn = async () => [{ address: '169.254.169.254', family: 4 }];
    const dnsBlockedRes = await listAiModels(
      { baseUrl: 'https://rebind.nip.io', apiKey: 'sk-any' },
      { fetchImpl: neverFetch.fetchImpl, lookupImpl: evilDnsLookup },
    );
    expect(dnsBlockedRes.ok).toBe(false);
    expect(dnsBlockedRes.models).toEqual([]);
    expect(dnsBlockedRes.messageZh).toContain('安全拦截');
    expect(neverFetch.calls).toHaveLength(0);

    // 4. Parses { data: [{ id }] }, deduplicates, sorts DeepSeek -> Flash/Reasoner -> others, enforces redirect: 'error'
    const publicDnsLookup: DnsLookupFn = async () => [{ address: '104.21.10.20', family: 4 }];
    const mockModels = createMockFetch(() =>
      jsonResponse({
        object: 'list',
        data: [
          { id: 'gpt-4o' },
          { id: 'claude-3-7-sonnet' },
          { id: 'gemini-2.5-flash' },
          { id: 'trae-cn/volc/deepseek-v4-1-flash' },
          { id: 'deepseek-chat' },
          { id: 'deepseek-chat' },
          { id: '   ' },
        ],
      }),
    );

    const listRes = await listAiModels(
      { baseUrl: 'https://relay.example.com', apiKey: 'sk-relay-list-key' },
      { fetchImpl: mockModels.fetchImpl, lookupImpl: publicDnsLookup },
    );
    expect(listRes.ok).toBe(true);
    expect(listRes.normalizedBaseUrl).toBe('https://relay.example.com/v1');
    expect(listRes.models).toEqual([
      'deepseek-chat',
      'trae-cn/volc/deepseek-v4-1-flash',
      'gemini-2.5-flash',
      'claude-3-7-sonnet',
      'gpt-4o',
    ]);
    expect(mockModels.calls).toHaveLength(1);
    expect(mockModels.calls[0]?.url).toBe('https://relay.example.com/v1/models');
    expect(mockModels.calls[0]?.init?.method).toBe('GET');
    expect(mockModels.calls[0]?.init?.redirect).toBe('error');
    expect((mockModels.calls[0]?.init?.headers as Record<string, string>).Authorization).toBe(
      'Bearer sk-relay-list-key',
    );

    // 5. HTTP 307 redirect is blocked
    const mock307 = createMockFetch(
      () =>
        new Response('', {
          status: 307,
          headers: { Location: 'http://169.254.169.254/latest/meta-data' },
        }),
    );
    const redirRes = await listAiModels(
      { baseUrl: 'https://relay.example.com', apiKey: 'sk-redir' },
      { fetchImpl: mock307.fetchImpl },
    );
    expect(redirRes.ok).toBe(false);
    expect(redirRes.models).toEqual([]);
    expect(redirRes.messageZh).toContain('安全策略已拦截 AI 接口重定向请求');
    expect(mock307.calls[0]?.init?.redirect).toBe('error');
  });

  it('fixLatexWithAi retries ONCE without response_format when a relay rejects json_object with HTTP 400 or 422', async () => {
    const sourceCode = '\\documentclass{article}\n\\begin{document}\nHello \\textbfx{world}.\n\\end{document}';
    const fixedCode = '\\documentclass{article}\n\\begin{document}\nHello \\textbf{world}.\n\\end{document}';

    for (const rejectStatus of [400, 422] as const) {
      let attempt = 0;
      const { fetchImpl, calls } = createMockFetch((call) => {
        attempt++;
        if (attempt === 1) {
          expect(call.body.response_format).toEqual({ type: 'json_object' });
          return jsonResponse(
            { error: { message: 'response_format json_object is not supported on this channel' } },
            rejectStatus,
          );
        }
        expect('response_format' in call.body).toBe(false);
        return jsonResponse({
          model: 'trae-cn/volc/deepseek-v4-1-flash',
          choices: [
            {
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content: [
                  '<think>Checking undefined control sequence \\textbfx...</think>',
                  '```json',
                  JSON.stringify({
                    summaryZh: '已将拼写错误的 \\textbfx 更正为 \\textbf。',
                    rootCauseZh: '宏命令名称多写了字符 x。',
                    actionsTakenZh: ['将 \\textbfx 替换为 \\textbf'],
                    patchedCode: fixedCode,
                    warningsZh: [],
                  }),
                  '```',
                ].join('\n'),
              },
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 60, total_tokens: 160 },
        });
      });

      const res = await fixLatexWithAi(
        { mode: 'diagnose-and-fix', filePath: 'main.tex', sourceCode },
        {
          baseUrl: 'https://relay.example.com',
          apiKey: 'sk-relay-fallback-key',
          model: 'trae-cn/volc/deepseek-v4-1-flash',
        },
        { fetchImpl },
      );

      expect(calls).toHaveLength(2);
      expect(calls[0]?.url).toBe('https://relay.example.com/v1/chat/completions');
      expect(calls[1]?.url).toBe('https://relay.example.com/v1/chat/completions');
      expect(calls[0]?.init?.redirect).toBe('error');
      expect(calls[1]?.init?.redirect).toBe('error');
      expect(calls[0]?.body.response_format).toEqual({ type: 'json_object' });
      expect('response_format' in calls[1]!.body).toBe(false);
      expect(calls[1]?.body.temperature).toBe(0.1);
      expect(res.ok).toBe(true);
      expect(res.modelUsed).toBe('trae-cn/volc/deepseek-v4-1-flash');
      expect(res.patchedCode).toBe(fixedCode);
      expect(res.diff.additions).toBe(1);
      expect(res.diff.deletions).toBe(1);
    }

    // Negative control 1: if retry ALSO returns 400, stops after 2 calls and throws HTTP_ERROR(400)
    const doubleFail = createMockFetch(() =>
      jsonResponse({ error: { message: 'Invalid model id' } }, 400),
    );
    await expect(
      fixLatexWithAi(
        { mode: 'diagnose-and-fix', filePath: 'main.tex', sourceCode },
        { baseUrl: 'https://relay.example.com', apiKey: 'sk-fail', model: 'bad-model' },
        { fetchImpl: doubleFail.fetchImpl },
      ),
    ).rejects.toMatchObject({
      code: 'HTTP_ERROR',
      status: 400,
    });
    expect(doubleFail.calls).toHaveLength(2);

    // Negative control 2: when reasoner mode omits response_format, HTTP 400 does NOT trigger retry
    const reasonerFail = createMockFetch(() =>
      jsonResponse({ error: { message: 'Bad request' } }, 400),
    );
    await expect(
      fixLatexWithAi(
        { mode: 'diagnose-and-fix', filePath: 'main.tex', sourceCode, useReasoner: true },
        { baseUrl: 'https://relay.example.com', apiKey: 'sk-r1' },
        { fetchImpl: reasonerFail.fetchImpl },
      ),
    ).rejects.toMatchObject({
      code: 'HTTP_ERROR',
      status: 400,
    });
    expect(reasonerFail.calls).toHaveLength(1);

    // Negative control 3: redirect on the retry attempt is still blocked with REDIRECT_BLOCKED
    let redirAttempt = 0;
    const retryRedir = createMockFetch(() => {
      redirAttempt++;
      if (redirAttempt === 1) {
        return jsonResponse({ error: { message: 'unsupported response_format' } }, 400);
      }
      return new Response('', {
        status: 307,
        headers: { Location: 'http://169.254.169.254/latest/meta-data' },
      });
    });
    await expect(
      fixLatexWithAi(
        { mode: 'diagnose-and-fix', filePath: 'main.tex', sourceCode },
        { baseUrl: 'https://relay.example.com', apiKey: 'sk-redir-retry' },
        { fetchImpl: retryRedir.fetchImpl },
      ),
    ).rejects.toMatchObject({
      code: 'REDIRECT_BLOCKED',
    });
    expect(retryRedir.calls).toHaveLength(2);

    // Negative control 4: DNS rebinding between attempt 1 and retry is blocked before 2nd fetch
    let dnsCalls = 0;
    const rebindingDns: DnsLookupFn = async () => {
      dnsCalls++;
      return dnsCalls === 1
        ? [{ address: '104.21.10.20', family: 4 }]
        : [{ address: '169.254.169.254', family: 4 }];
    };
    const rebindFetch = createMockFetch(() =>
      jsonResponse({ error: { message: 'unsupported response_format' } }, 400),
    );
    await expect(
      fixLatexWithAi(
        { mode: 'diagnose-and-fix', filePath: 'main.tex', sourceCode },
        { baseUrl: 'https://rebind-retry.example', apiKey: 'sk-rebind' },
        { fetchImpl: rebindFetch.fetchImpl, lookupImpl: rebindingDns },
      ),
    ).rejects.toMatchObject({
      code: 'INVALID_CONFIG',
    });
    expect(rebindFetch.calls).toHaveLength(1);
  });
});

describe('@novatex/ai-fixer smart auto-locate table & math scanners + windowing', () => {
  it('findLatexTableRanges detects nested table+tabular, standalone tabularx/longtable/sidewaystable, ignores comments, and handles unclosed tables gracefully', () => {
    const lines = [
      '\\documentclass{article}', // 1
      '\\begin{document}', // 2
      '% \\begin{table}', // 3 (commented out — must be ignored)
      '% \\end{table}', // 4
      'Intro prose with 95\\% accuracy.', // 5
      '\\begin{table}[htbp]', // 6
      '  \\centering', // 7
      '  \\caption{Main results}', // 8
      '  \\begin{tabular}{|c|c|}', // 9
      '    \\hline', // 10
      '    A & 95\\% \\\\ % \\end{tabular} commented tail', // 11
      '    \\hline', // 12
      '  \\end{tabular}', // 13
      '\\end{table}', // 14
      'Some prose between tables.', // 15
      '\\begin{tabularx}{\\linewidth}{lX}', // 16
      '  Metric & Description \\\\', // 17
      '\\end{tabularx}', // 18
      '\\begin{longtable}{cc}', // 19
      '  X & Y \\\\', // 20
      '\\end{longtable}', // 21
      '\\begin{sidewaystable*}', // 22
      '  \\begin{threeparttable}', // 23
      '    \\begin{tabular}{cc}', // 24
      '      1 & 2 \\\\', // 25
      '    \\end{tabular}', // 26
      '  \\end{threeparttable}', // 27
      '\\end{sidewaystable*}', // 28
      'Broken unclosed table below:', // 29
      '\\begin{tabular}{ccc}', // 30
      '  Model & Acc & F1 \\\\', // 31
      '  Ours & 94.1 & 93.8 \\\\', // 32
      '', // 33
      '\\section{Conclusion}', // 34
      'Final discussion paragraph.', // 35
      '\\end{document}', // 36
    ];

    const ranges = findLatexTableRanges(lines);
    expect(ranges).toEqual([
      { startLine: 6, endLine: 14 }, // nested table + tabular merged into one clean range
      { startLine: 16, endLine: 18 }, // standalone tabularx
      { startLine: 19, endLine: 21 }, // adjacent separate longtable NOT merged with tabularx
      { startLine: 22, endLine: 28 }, // sidewaystable* + threeparttable + tabular merged
      { startLine: 30, endLine: 32 }, // unclosed tabular bounded before \section{Conclusion}
    ]);

    // Unclosed \begin{tabular} with no \section or \end{document} caps at +40 lines
    const unclosedNoSectionLines = [
      '\\begin{document}', // 1
      '\\begin{tabular}{cc}', // 2
      ...Array.from({ length: 60 }, (_, idx) => `Row or trailing prose line ${idx + 3}`),
    ];
    expect(findLatexTableRanges(unclosedNoSectionLines)).toEqual([
      { startLine: 2, endLine: 42 },
    ]);

    // Unclosed inner \begin{tabular} inside closed \begin{table} merges cleanly to \end{table}
    const unclosedInnerLines = [
      '\\begin{table}[t]', // 1
      '  \\begin{tabular}{cc}', // 2
      '    A & B \\\\', // 3
      '\\end{table}', // 4
    ];
    expect(findLatexTableRanges(unclosedInnerLines)).toEqual([{ startLine: 1, endLine: 4 }]);
  });

  it('findLatexMathRanges detects equation/align*/\\[...\\]/$$...$$, ignores \\\\[4pt] & \\$50, handles unclosed align, and catches diagnostic-hit inline $...$', () => {
    const lines = [
      '\\documentclass{article}', // 1
      '\\begin{document}', // 2
      'The budget is \\$50 and table break is a & b \\\\[4pt]', // 3 (must NOT trigger math!)
      '\\begin{equation}', // 4
      '  E = mc^2', // 5
      '\\end{equation}', // 6
      'Prose with healthy inline $x + y = z$ should not be scanned without diagnostics.', // 7
      '\\begin{align*}', // 8
      '  a &= b + c \\\\[4pt]', // 9
      '  d &= e + f', // 10
      '\\end{align*}', // 11
      'Single-line bracket: \\[ f(x) = x^2 \\]', // 12
      'Multi-line bracket:', // 13
      '\\[', // 14
      '  g(x) = \\sin(x)', // 15
      '\\]', // 16
      'Single-line double dollar: $$h(x) = 1$$', // 17
      '$$', // 18
      '  k(x) = \\log(x)', // 19
      '$$', // 20
      'Prose line 21', // 21
      'Prose line 22', // 22
      'Prose line 23', // 23
      'Broken inline formula here: $\\frac{a}{b + c$ fails.', // 24
      'Prose line 25', // 25
      'Prose line 26', // 26
      'Prose line 27', // 27
      'Prose line 28', // 28
      'Prose line 29', // 29
      '\\begin{align}', // 30 (unclosed!)
      '  u &= v + w \\\\', // 31
      '  p &= q + r', // 32
      '\\subsection{Next}', // 33
      '\\end{document}', // 34
    ];

    // Without diagnostics: only display math blocks (including unclosed align)
    expect(findLatexMathRanges(lines)).toEqual([
      { startLine: 4, endLine: 6 },
      { startLine: 8, endLine: 11 },
      { startLine: 12, endLine: 12 },
      { startLine: 14, endLine: 16 },
      { startLine: 17, endLine: 17 },
      { startLine: 18, endLine: 20 },
      { startLine: 30, endLine: 32 },
    ]);

    // With diagnostic hitting inline math at line 24 -> includes 24 ± 3 = [21, 27]
    // Diagnostic on line 3 (escaped \$50 & \\[4pt]) must NOT add a math range!
    const diags: CompileDiagnostic[] = [
      {
        id: 'd-inline',
        file: 'paper.tex',
        line: 24,
        severity: 'error',
        code: 'UNCLOSED_BRACE',
        titleZh: '花括号未闭合',
        explanationZh: '行内公式缺少 }',
        quickFixHintZh: '补齐 }',
        rawMessage: '! Missing } inserted.',
      },
      {
        id: 'd-escaped',
        file: 'paper.tex',
        line: 3,
        severity: 'warning',
        code: 'OVERFULL',
        titleZh: '行溢出',
        explanationZh: '纯文本含转义美元符',
        quickFixHintZh: '忽略',
        rawMessage: 'Overfull \\hbox',
      },
    ];

    expect(findLatexMathRanges(lines, diags, 'paper.tex')).toEqual([
      { startLine: 4, endLine: 6 },
      { startLine: 8, endLine: 11 },
      { startLine: 12, endLine: 12 },
      { startLine: 14, endLine: 16 },
      { startLine: 17, endLine: 17 },
      { startLine: 18, endLine: 20 },
      { startLine: 21, endLine: 27 }, // diagnostic-hit inline $...$ ± 3 lines
      { startLine: 30, endLine: 32 },
    ]);

    // Unclosed `\[` before a section and another valid `\[ ... \]` stays cleanly bounded
    const unclosedBracketLines = [
      '\\begin{document}', // 1
      '\\[ a = b', // 2 (unclosed!)
      '  + c', // 3
      '\\section{Later}', // 4
      '\\[ y = 2 \\]', // 5
      '\\end{document}', // 6
    ];
    expect(findLatexMathRanges(unclosedBracketLines)).toEqual([
      { startLine: 2, endLine: 3 },
      { startLine: 5, endLine: 5 },
    ]);
  });

  it('extractTargetWindow preserves strict selectionRange precedence over whole-file auto-scan', () => {
    const lines = [
      '\\documentclass{article}', // 1
      '\\usepackage{booktabs}', // 2
      '\\begin{document}', // 3
      '\\begin{table}[t]', // 4
      '  \\begin{tabular}{cc}', // 5
      '    A & B \\\\', // 6
      '  \\end{tabular}', // 7
      '\\end{table}', // 8
      'Prose between tables.', // 9
      '\\begin{table}[b]', // 10
      '  \\begin{tabular}{cc}', // 11
      '    C & D \\\\', // 12
      '  \\end{tabular}', // 13
      '\\end{table}', // 14
      '\\end{document}', // 15
    ];

    const built = buildAiPrompt({
      mode: 'format-table',
      filePath: 'tables.tex',
      sourceCode: lines.join('\n'),
      selectionRange: { startLine: 10, endLine: 14 },
      diagnostics: [
        {
          id: 't1',
          file: 'tables.tex',
          line: 6,
          severity: 'error',
          code: 'EXTRA_ALIGN_TAB',
          titleZh: '列数超界',
          explanationZh: '第 6 行多余 &',
          quickFixHintZh: '删除多余 &',
          rawMessage: '! Extra alignment tab has been changed to \\cr.',
        },
      ],
    });

    expect(built.window.isWindowed).toBe(true);
    expect(built.window.startLine).toBe(10);
    expect(built.window.endLine).toBe(14);
    expect(built.window.detectedBlocks).toBeUndefined();
    expect(built.userPrompt).not.toContain('自动扫描定位指令');
    expect(built.userPrompt).toContain('C & D');
    expect(built.userPrompt).not.toContain('A & B');
  });

  it('whole-file auto-scan (<= 400 lines, even > 250 lines) sends full file, lists detected ranges, and includes diagnostics + rawLogExcerpt for format-table & format-math', () => {
    expect(STRUCTURAL_FULL_FILE_MAX_LINES).toBe(400);

    // Build a 320-line file (> 250 generic threshold, <= 400 structural full-file threshold)
    const lines: string[] = [
      '\\documentclass{article}', // 1
      '\\usepackage{amsmath}', // 2
      '\\usepackage{booktabs}', // 3
      '\\begin{document}', // 4
    ];
    for (let ln = 5; ln <= 320; ln++) {
      if (ln === 25) lines.push('\\begin{table}[t]');
      else if (ln === 26) lines.push('  \\begin{tabular}{|c|c|}');
      else if (ln === 27) lines.push('    Method & Acc & Extra \\\\');
      else if (ln === 28) lines.push('  \\end{tabular}');
      else if (ln === 29) lines.push('\\end{table}');
      else if (ln === 180) lines.push('\\begin{tabularx}{\\linewidth}{lX}');
      else if (ln === 181) lines.push('  Item & 95% unescaped \\\\');
      else if (ln === 182) lines.push('\\end{tabularx}');
      else if (ln === 240) lines.push('\\begin{align}');
      else if (ln === 241) lines.push('  y &= \\left( a + b');
      else if (ln === 242) lines.push('\\end{align}');
      else if (ln === 320) lines.push('\\end{document}');
      else lines.push(`Academic prose line ${ln}.`);
    }
    expect(lines).toHaveLength(320);

    const tableDiag: CompileDiagnostic = {
      id: 'tab-err',
      file: 'manuscript.tex',
      line: 27,
      severity: 'error',
      code: 'EXTRA_ALIGN_TAB',
      titleZh: '表格列数超出',
      explanationZh: '第 27 行出现多余的 &',
      quickFixHintZh: '核对列格式',
      rawMessage: '! Extra alignment tab has been changed to \\cr.',
    };

    const tablePrompt = buildAiPrompt({
      mode: 'format-table',
      filePath: 'manuscript.tex',
      sourceCode: lines.join('\n'),
      diagnostics: [tableDiag],
      rawLogExcerpt: '! Extra alignment tab has been changed to \\cr.\nl.27 Method & Acc & Extra \\\\',
    });

    expect(tablePrompt.window.isWindowed).toBe(false);
    expect(tablePrompt.window.startLine).toBe(1);
    expect(tablePrompt.window.endLine).toBe(320);
    expect(tablePrompt.window.detectedBlocks).toEqual([
      { startLine: 25, endLine: 29 },
      { startLine: 180, endLine: 182 },
    ]);
    expect(tablePrompt.systemPrompt).toContain('修复表格相关的编译与语法错误');
    expect(tablePrompt.systemPrompt).toContain('100% 逐字原样不动');
    expect(tablePrompt.userPrompt).toContain('已自动扫描整篇文件，发现 2 处表格区域：第 25–29 行、第 180–182 行');
    expect(tablePrompt.userPrompt).toContain('CompileDiagnostics');
    expect(tablePrompt.userPrompt).toContain('Extra alignment tab');
    expect(tablePrompt.userPrompt).toContain('Raw Log Excerpt');

    const mathDiag: CompileDiagnostic = {
      id: 'math-err',
      file: 'manuscript.tex',
      line: 241,
      severity: 'error',
      code: 'MISMATCHED_DELIM',
      titleZh: '定界符不配对',
      explanationZh: '缺少 \\right)',
      quickFixHintZh: '补齐 \\right)',
      rawMessage: '! Extra }, or forgotten \\right.',
    };

    const mathPrompt = buildAiPrompt({
      mode: 'format-math',
      filePath: 'manuscript.tex',
      sourceCode: lines.join('\n'),
      diagnostics: [mathDiag],
      rawLogExcerpt: '! Extra }, or forgotten \\right.\nl.241 y &= \\left( a + b',
    });

    expect(mathPrompt.window.isWindowed).toBe(false);
    expect(mathPrompt.window.detectedBlocks).toEqual([{ startLine: 240, endLine: 242 }]);
    expect(mathPrompt.systemPrompt).toContain('修复公式相关的编译与语法错误');
    expect(mathPrompt.userPrompt).toContain('已自动扫描整篇文件，发现 1 处数学公式区域：第 240–242 行');
    expect(mathPrompt.userPrompt).toContain('CompileDiagnostics');
    expect(mathPrompt.userPrompt).toContain('forgotten \\right.');
    expect(mathPrompt.userPrompt).toContain('Raw Log Excerpt');
  });

  it('long file (> 400 lines) with diagnostic hitting a table at line 380 auto-centers editable window on that table + preamble and splices cleanly', async () => {
    const lines: string[] = [
      '\\documentclass[conference]{IEEEtran}', // 1
      '\\usepackage{booktabs}', // 2
      '\\usepackage{amsmath}', // 3
      '\\begin{document}', // 4
    ];

    for (let ln = 5; ln <= 500; ln++) {
      if (ln === 50) lines.push('\\begin{table}[t]');
      else if (ln === 51) lines.push('  \\begin{tabular}{cc}');
      else if (ln === 52) lines.push('    EarlyTable & 10.0 \\\\');
      else if (ln === 53) lines.push('  \\end{tabular}');
      else if (ln === 54) lines.push('\\end{table}');
      else if (ln === 375) lines.push('\\begin{table}[htbp]');
      else if (ln === 376) lines.push('  \\centering');
      else if (ln === 377) lines.push('  \\begin{tabular}{|c|c|}');
      else if (ln === 378) lines.push('    \\hline');
      else if (ln === 379) lines.push('    Method & Score \\\\');
      else if (ln === 380) lines.push('    Ours & 96.4 & BROKEN_EXTRA_COL \\\\');
      else if (ln === 381) lines.push('    \\hline');
      else if (ln === 382) lines.push('  \\end{tabular}');
      else if (ln === 383) lines.push('\\end{table}');
      else if (ln === 460) lines.push('\\begin{table}[b]');
      else if (ln === 461) lines.push('  \\begin{tabular}{cc}');
      else if (ln === 462) lines.push('    LateTable & 20.0 \\\\');
      else if (ln === 463) lines.push('  \\end{tabular}');
      else if (ln === 464) lines.push('\\end{table}');
      else if (ln === 500) lines.push('\\end{document}');
      else lines.push(`Long manuscript line ${ln} marker_L${ln}.`);
    }
    expect(lines).toHaveLength(500);
    const sourceCode = lines.join('\n');

    const request: AiFixRequest = {
      mode: 'format-table',
      filePath: 'thesis.tex',
      sourceCode,
      diagnostics: [
        {
          id: 'err-380',
          file: 'thesis.tex',
          line: 380,
          severity: 'error',
          code: 'EXTRA_ALIGN_TAB',
          titleZh: '表格列数超出',
          explanationZh: '第 380 行多出一个 &',
          quickFixHintZh: '删除多余列或补充列格式',
          rawMessage: '! Extra alignment tab has been changed to \\cr.',
        },
      ],
    };

    const built = buildAiPrompt(request);
    expect(built.window.isWindowed).toBe(true);
    // Table is lines 375..383 -> ±10 padding => 365..393
    expect(built.window.startLine).toBe(365);
    expect(built.window.endLine).toBe(393);
    expect(built.window.diagnosticFocused).toBe(true);
    expect(built.window.hasOmittedOutsideBlocks).toBe(true);
    expect(built.window.focusedBlocks).toEqual([{ startLine: 375, endLine: 383 }]);
    expect(built.window.preambleContext).toContain('\\usepackage{booktabs}');
    expect(built.window.preambleRange).toEqual({ startLine: 1, endLine: 4 });
    expect(built.userPrompt).toContain('BROKEN_EXTRA_COL');
    expect(built.userPrompt).not.toContain('EarlyTable');
    expect(built.userPrompt).not.toContain('LateTable');
    expect(built.userPrompt).toContain('第 375–383 行');

    // End-to-end splice via fixLatexWithAi leaves lines 1..364 and 394..500 untouched
    const repairedWindowLines = lines.slice(364, 393);
    repairedWindowLines[380 - 365] = '    Ours & 96.4 \\\\';
    const { fetchImpl } = createMockFetch(() =>
      jsonResponse({
        model: 'deepseek-chat',
        choices: [
          {
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: JSON.stringify({
                summaryZh: '已修复第 380 行多余的列分隔符。',
                rootCauseZh: '第 380 行比列声明多出一列。',
                actionsTakenZh: ['移除多余的 & BROKEN_EXTRA_COL'],
                patchedCode: repairedWindowLines.join('\n'),
                warningsZh: [],
              }),
            },
          },
        ],
      }),
    );

    const res = await fixLatexWithAi(request, { apiKey: 'sk-long-table-key' }, { fetchImpl });
    expect(res.ok).toBe(true);
    const patchedLines = res.patchedCode.split('\n');
    expect(patchedLines).toHaveLength(500);
    expect(patchedLines.slice(0, 364)).toEqual(lines.slice(0, 364));
    expect(patchedLines.slice(393)).toEqual(lines.slice(393));
    expect(patchedLines[379]).toBe('    Ours & 96.4 \\\\');
  });

  it('long file (> 400 lines) handles unclosed table diagnostics (on input line N), non-diagnostic clustering (<= 260 vs > 260 lines), and inline math diagnostic focusing', () => {
    // 1. Unclosed table at line 376 whose LaTeX error is reported at \end{document} (line 450)
    const unclosedLines: string[] = [
      '\\documentclass{article}',
      '\\begin{document}',
      ...Array.from({ length: 447 }, (_, i) => {
        const ln = i + 3;
        if (ln === 30) return '\\begin{tabular}{cc}';
        if (ln === 31) return '  A & B \\\\';
        if (ln === 32) return '\\end{tabular}';
        if (ln === 376) return '\\begin{tabular}{cc}';
        if (ln === 377) return '  Broken & Unclosed \\\\';
        if (ln === 382) return '\\section{Discussion}';
        return `Body line ${ln}.`;
      }),
      '\\end{document}',
    ];
    expect(unclosedLines).toHaveLength(450);

    const unclosedWindow = extractTargetWindow({
      mode: 'format-table',
      filePath: 'unclosed.tex',
      sourceCode: unclosedLines.join('\n'),
      diagnostics: [
        {
          id: 'eof-err',
          file: 'unclosed.tex',
          line: 450,
          severity: 'error',
          code: 'ENV_MISMATCH',
          titleZh: '环境未闭合',
          explanationZh: 'tabular 未闭合',
          quickFixHintZh: '补齐 \\end{tabular}',
          rawMessage: '! LaTeX Error: \\begin{tabular} on input line 376 ended by \\end{document}.',
        },
      ],
    });
    expect(unclosedWindow.isWindowed).toBe(true);
    expect(unclosedWindow.diagnosticFocused).toBe(true);
    expect(unclosedWindow.startLine).toBe(366);
    expect(unclosedWindow.endLine).toBe(391);
    expect(unclosedWindow.editableCode).toContain('Broken & Unclosed');

    // Also without any diagnostics at all, an unclosed table at line 376 is NEVER silently dropped
    const unclosedNoDiagWindow = extractTargetWindow({
      mode: 'format-table',
      filePath: 'unclosed.tex',
      sourceCode: unclosedLines.join('\n'),
    });
    expect(unclosedNoDiagWindow.isWindowed).toBe(true);
    expect(unclosedNoDiagWindow.editableCode).toContain('Broken & Unclosed');

    // 2. Long file (> 400 lines) with NO diagnostics & closed blocks spread > 260 lines:
    //    focuses on first cluster within 260 lines and mentions omitted blocks in prompt.
    const spreadMathLines: string[] = [
      '\\documentclass{article}',
      '\\usepackage{amsmath}',
      '\\begin{document}',
      ...Array.from({ length: 456 }, (_, i) => {
        const ln = i + 4;
        if (ln === 40) return '\\begin{equation}';
        if (ln === 41) return '  a = b';
        if (ln === 42) return '\\end{equation}';
        if (ln === 120) return '\\begin{equation}';
        if (ln === 121) return '  c = d';
        if (ln === 122) return '\\end{equation}';
        if (ln === 410) return '\\begin{equation}';
        if (ln === 411) return '  z = w';
        if (ln === 412) return '\\end{equation}';
        return `Math paper line ${ln}.`;
      }),
      '\\end{document}',
    ];
    const spreadBuilt = buildAiPrompt({
      mode: 'format-math',
      filePath: 'math.tex',
      sourceCode: spreadMathLines.join('\n'),
    });
    expect(spreadBuilt.window.isWindowed).toBe(true);
    expect(spreadBuilt.window.startLine).toBe(30);
    expect(spreadBuilt.window.endLine).toBe(132);
    expect(spreadBuilt.window.focusedBlocks).toEqual([
      { startLine: 40, endLine: 42 },
      { startLine: 120, endLine: 122 },
    ]);
    expect(spreadBuilt.window.hasOmittedOutsideBlocks).toBe(true);
    expect(spreadBuilt.userPrompt).toContain('超过 260 行');

    // 3. Long file (> 400 lines) with diagnostic hitting inline `$...$` at line 380
    const inlineDiagLines = [...spreadMathLines];
    inlineDiagLines[379] = 'Here the inline loss $\\mathcal{L} = \\frac{1}{N$ is broken.';
    const inlineWindow = extractTargetWindow({
      mode: 'format-math',
      filePath: 'math.tex',
      sourceCode: inlineDiagLines.join('\n'),
      diagnostics: [
        {
          id: 'inline-380',
          file: 'math.tex',
          line: 380,
          severity: 'error',
          code: 'UNCLOSED_BRACE',
          titleZh: '公式缺少右括号',
          explanationZh: '第 380 行行内公式语法错误',
          quickFixHintZh: '补全 }',
          rawMessage: '! Missing } inserted.',
        },
      ],
    });
    expect(inlineWindow.isWindowed).toBe(true);
    expect(inlineWindow.diagnosticFocused).toBe(true);
    // Inline range is 377..383 -> ±10 padding => 367..393
    expect(inlineWindow.startLine).toBe(367);
    expect(inlineWindow.endLine).toBe(393);
    expect(inlineWindow.editableCode).toContain('\\frac{1}{N$');

    // 4. Long file (> 400 lines) with NO diagnostics & combined block span <= 260 lines:
    //    covers ALL detected blocks (±10 padding) + preamble with hasOmittedOutsideBlocks = false.
    const compactLongLines: string[] = [
      '\\documentclass{article}',
      '\\usepackage{booktabs}',
      '\\begin{document}',
      ...Array.from({ length: 446 }, (_, i) => {
        const ln = i + 4;
        if (ln === 100) return '\\begin{tabular}{cc}';
        if (ln === 101) return '  First & 1 \\\\';
        if (ln === 102) return '\\end{tabular}';
        if (ln === 290) return '\\begin{tabular}{cc}';
        if (ln === 291) return '  Second & 2 \\\\';
        if (ln === 292) return '\\end{tabular}';
        return `Compact span prose ${ln}.`;
      }),
      '\\end{document}',
    ];
    const compactWindow = extractTargetWindow({
      mode: 'format-table',
      filePath: 'compact.tex',
      sourceCode: compactLongLines.join('\n'),
    });
    expect(compactWindow.isWindowed).toBe(true);
    expect(compactWindow.startLine).toBe(90);
    expect(compactWindow.endLine).toBe(302);
    expect(compactWindow.hasOmittedOutsideBlocks).toBe(false);
    expect(compactWindow.focusedBlocks).toEqual([
      { startLine: 100, endLine: 102 },
      { startLine: 290, endLine: 292 },
    ]);
    expect(compactWindow.preambleContext).toContain('\\usepackage{booktabs}');
  });

  it('eliminates polynomial ReDoS on adversarial \\begin{ repetition (< 50ms for 20,000 repeats)', () => {
    const adversarialLine = '\\begin{'.repeat(20_000);
    const longUnclosedName = `\\begin{${'a'.repeat(50_000)}`;

    const t0 = performance.now();
    const tableRanges = findLatexTableRanges([adversarialLine, longUnclosedName]);
    const tableElapsedMs = performance.now() - t0;

    const t1 = performance.now();
    const mathRanges = findLatexMathRanges([adversarialLine, longUnclosedName]);
    const mathElapsedMs = performance.now() - t1;

    expect(tableRanges).toEqual([]);
    expect(mathRanges).toEqual([]);
    expect(tableElapsedMs).toBeLessThan(50);
    expect(mathElapsedMs).toBeLessThan(50);
  });

  it('terminates unclosed $$ and \\[ cleanly at \\section boundaries without swallowing body text across a 420-line doc', () => {
    const lines: string[] = [
      '\\documentclass{article}', // 1
      '\\usepackage{amsmath}', // 2
      '\\begin{document}', // 3
    ];
    for (let ln = 4; ln <= 420; ln++) {
      if (ln === 20) lines.push('$$');
      else if (ln === 21) lines.push('  E = mc^2 + \\alpha');
      else if (ln === 22) lines.push('');
      else if (ln === 25) lines.push('\\section{Methods}');
      else if (ln === 401) lines.push('$$');
      else if (ln === 402) lines.push('  \\mathcal{L}(\\theta) = \\sum_{i=1}^N \\ell_i');
      else if (ln === 403) lines.push('$$');
      else if (ln === 420) lines.push('\\end{document}');
      else lines.push(`Body prose line ${ln}.`);
    }
    expect(lines).toHaveLength(420);

    const ranges = findLatexMathRanges(lines);
    expect(ranges).toEqual([
      { startLine: 20, endLine: 24 },
      { startLine: 401, endLine: 403 },
    ]);

    // Verify extractTargetWindow focuses tightly on the unclosed block rather than swallowing [20..401]
    const win = extractTargetWindow({
      mode: 'format-math',
      filePath: 'manuscript.tex',
      sourceCode: lines.join('\n'),
    });
    expect(win.isWindowed).toBe(true);
    expect(win.focusedBlocks).toEqual([{ startLine: 20, endLine: 24 }]);
    expect(win.startLine).toBe(10);
    expect(win.endLine).toBe(34);
    expect(win.hasOmittedOutsideBlocks).toBe(true);

    // Also verify unclosed `\[` across `\section` does not swallow a distant stray `\]` or later block
    const bracketLines = [
      '\\begin{document}', // 1
      '\\[', // 2
      '  x = 1', // 3
      '\\section{Results}', // 4
      'Regular prose line.', // 5
      '\\]', // 6 (stray closing bracket after section must NOT pair with line 2)
      '\\[ y = 2 \\]', // 7
      '\\end{document}', // 8
    ];
    expect(findLatexMathRanges(bracketLines)).toEqual([
      { startLine: 2, endLine: 3 },
      { startLine: 7, endLine: 7 },
    ]);
  });
});
