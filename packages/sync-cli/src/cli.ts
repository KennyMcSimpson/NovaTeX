#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FormatHub } from '@novatex/format-hub';
import {
  normalizeProjectRelPath,
  type AcademicTemplateId,
  type ConvertOutputArtifact,
  type FormatLayer,
} from '@novatex/shared';
import { NovaTeXSyncClient } from './sync-engine.js';

export type ConvertInputFormat = 'tex' | 'md' | 'docx' | 'txt' | 'pdf';
export type ConvertOutputFormat = 'tex' | 'md' | 'docx' | 'txt';

const VALID_INPUT_FORMATS = new Set<ConvertInputFormat>(['tex', 'md', 'docx', 'txt', 'pdf']);
const VALID_OUTPUT_FORMATS = new Set<ConvertOutputFormat>(['tex', 'md', 'docx', 'txt']);
const VALID_TEMPLATES = new Set<AcademicTemplateId>([
  'chinese-ctex',
  'ieee-conf',
  'clean-article',
]);

export interface PullCliCommand {
  command: 'pull';
  url: string;
  project: string;
  token: string;
  dir: string;
}

export interface WatchCliCommand {
  command: 'watch';
  url: string;
  project: string;
  token: string;
  dir: string;
  name?: string;
  pollIntervalMs?: number;
}

export interface ConvertCliOptions {
  from: ConvertInputFormat;
  to: ConvertOutputFormat;
  input: string;
  output?: string;
  template?: AcademicTemplateId;
  bodyOnly?: boolean;
  bib?: string;
  title?: string;
  mediaDir?: string;
}

export interface ConvertCliCommand extends ConvertCliOptions {
  command: 'convert';
}

export interface HelpCliCommand {
  command: 'help';
}

export type ParsedCliCommand =
  | PullCliCommand
  | WatchCliCommand
  | ConvertCliCommand
  | HelpCliCommand;

export interface ConvertCommandResult {
  artifact: ConvertOutputArtifact;
  outputPath?: string;
}

export function getHelpText(): string {
  return [
    'NovaTeX Local Agent Companion CLI (`novatex-sync`)',
    '面向本地 Agent (Codex / Claude Code / Antigravity) 的双向实时协同与四层学术格式转换工具',
    '',
    '用法 / Usage:',
    '  novatex-sync pull --url <url> --project <id> --token <token> --dir <dir>',
    '    一次性安全拉取远端项目文件到本地目录（自动拦截越界路径与 .latexmkrc / .git）。',
    '    Pull all safe files from a NovaTeX project into a local folder.',
    '',
    '  novatex-sync watch --url <url> --project <id> --token <token> --dir <dir> [--name "Claude Code"] [--poll-ms 15000]',
    '    启动本地目录与 NovaTeX Hocuspocus 协同房间的双向实时同步（最小字符补丁不跳光标 + 防回环保护）。',
    '    Bidirectionally watch & sync local files with live Yjs/Hocuspocus rooms.',
    '',
    '  novatex-sync convert --from <tex|md|docx|txt|pdf> --to <tex|md|docx|txt> --input <path> [options]',
    '    基于 @novatex/format-hub 执行本地四层学术文档格式互转（支持公式、引用、模板与图片提取）。',
    '    Convert between tex / md / docx / txt (and pdf draft intake) locally.',
    '    Options:',
    '      --output <path>                                     输出文件路径（文本格式省略时输出到标准输出）',
    '      --template <chinese-ctex|ieee-conf|clean-article>   生成完整 .tex 时的学术模板',
    '      --body-only                                         转 .tex 时仅输出正文片段，不包裹导言区',
    '      --bib <path>                                        参考文献 .bib 路径（导出 docx 引用渲染）',
    '      --title <text>                                      文档标题（独立导出时生效）',
    '      --media-dir <relDir>                                DOCX 拆图相对目录（默认 media）',
    '',
    '  novatex-sync --help | -h',
    '    显示本帮助信息 / Show this help guide.',
    '',
    '环境变量回退 / Environment fallbacks (for pull/watch):',
    '  NOVATEX_URL, NOVATEX_PROJECT, NOVATEX_TOKEN, NOVATEX_AGENT_NAME',
  ].join('\n');
}

const BOOLEAN_FLAGS = new Set(['help', 'body-only']);

function readFlagMap(args: string[]): { flags: Map<string, string | boolean>; positional: string[] } {
  const flags = new Map<string, string | boolean>();
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const raw = args[i]!;
    if (raw === '--help' || raw === '-h') {
      flags.set('help', true);
      continue;
    }
    if (raw.startsWith('--')) {
      const eqIdx = raw.indexOf('=');
      if (eqIdx !== -1) {
        const key = raw.slice(2, eqIdx);
        const value = raw.slice(eqIdx + 1);
        flags.set(key, BOOLEAN_FLAGS.has(key) ? value !== 'false' && value !== '0' : value);
      } else {
        const key = raw.slice(2);
        if (BOOLEAN_FLAGS.has(key)) {
          flags.set(key, true);
          continue;
        }
        const next = args[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags.set(key, next);
          i++;
        } else {
          flags.set(key, true);
        }
      }
      continue;
    }
    positional.push(raw);
  }

  return { flags, positional };
}

function getStringFlag(flags: Map<string, string | boolean>, key: string): string | undefined {
  const val = flags.get(key);
  if (typeof val === 'string' && val.trim().length > 0) {
    return val.trim();
  }
  return undefined;
}

function requireStringFlag(
  flags: Map<string, string | boolean>,
  key: string,
  envFallback?: string,
): string {
  const value = getStringFlag(flags, key) ?? (envFallback ? process.env[envFallback]?.trim() : undefined);
  if (!value) {
    throw new Error(`缺少必填参数 --${key}${envFallback ? `（或环境变量 ${envFallback}）` : ''}`);
  }
  return value;
}

/**
 * Parse CLI argv into a strongly typed command descriptor.
 */
export function parseCliArgs(argv: string[]): ParsedCliCommand {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    return { command: 'help' };
  }

  const subcommand = argv[0]!.toLowerCase();
  if (subcommand === 'help') {
    return { command: 'help' };
  }

  const { flags } = readFlagMap(argv.slice(1));
  if (flags.get('help') === true) {
    return { command: 'help' };
  }

  if (subcommand === 'pull') {
    return {
      command: 'pull',
      url: requireStringFlag(flags, 'url', 'NOVATEX_URL'),
      project: requireStringFlag(flags, 'project', 'NOVATEX_PROJECT'),
      token: requireStringFlag(flags, 'token', 'NOVATEX_TOKEN'),
      dir: requireStringFlag(flags, 'dir'),
    };
  }

  if (subcommand === 'watch') {
    const pollRaw = getStringFlag(flags, 'poll-ms');
    let pollIntervalMs: number | undefined;
    if (pollRaw !== undefined) {
      const parsed = Number(pollRaw);
      if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error(`--poll-ms 必须是非负整数，当前值: ${pollRaw}`);
      }
      pollIntervalMs = parsed;
    }

    return {
      command: 'watch',
      url: requireStringFlag(flags, 'url', 'NOVATEX_URL'),
      project: requireStringFlag(flags, 'project', 'NOVATEX_PROJECT'),
      token: requireStringFlag(flags, 'token', 'NOVATEX_TOKEN'),
      dir: requireStringFlag(flags, 'dir'),
      name: getStringFlag(flags, 'name') ?? process.env.NOVATEX_AGENT_NAME?.trim(),
      pollIntervalMs,
    };
  }

  if (subcommand === 'convert') {
    const fromRaw = requireStringFlag(flags, 'from').toLowerCase() as ConvertInputFormat;
    const toRaw = requireStringFlag(flags, 'to').toLowerCase() as ConvertOutputFormat;
    if (!VALID_INPUT_FORMATS.has(fromRaw)) {
      throw new Error(`不支持的输入格式 --from ${fromRaw}，可选: tex | md | docx | txt | pdf`);
    }
    if (!VALID_OUTPUT_FORMATS.has(toRaw)) {
      throw new Error(`不支持的输出格式 --to ${toRaw}，可选: tex | md | docx | txt`);
    }

    const templateRaw = getStringFlag(flags, 'template') as AcademicTemplateId | undefined;
    if (templateRaw !== undefined && !VALID_TEMPLATES.has(templateRaw)) {
      throw new Error(
        `不支持的学术模板 --template ${templateRaw}，可选: chinese-ctex | ieee-conf | clean-article`,
      );
    }

    const bodyOnly = flags.get('body-only') === true;

    return {
      command: 'convert',
      from: fromRaw,
      to: toRaw,
      input: requireStringFlag(flags, 'input'),
      output: getStringFlag(flags, 'output'),
      template: templateRaw,
      bodyOnly,
      bib: getStringFlag(flags, 'bib'),
      title: getStringFlag(flags, 'title'),
      mediaDir: getStringFlag(flags, 'media-dir'),
    };
  }

  throw new Error(`未知子命令 "${subcommand}"。运行 \`novatex-sync --help\` 查看用法。`);
}

function findSharedAncestor(pathA: string, pathB: string): string | null {
  const dirA = path.resolve(path.dirname(pathA));
  const dirB = path.resolve(path.dirname(pathB));
  const rootA = path.parse(dirA).root;
  const rootB = path.parse(dirB).root;
  if (rootA.toLowerCase() !== rootB.toLowerCase()) {
    return null;
  }

  const partsA = dirA.slice(rootA.length).split(/[\\/]+/).filter(Boolean);
  const partsB = dirB.slice(rootB.length).split(/[\\/]+/).filter(Boolean);
  const shared: string[] = [];
  const limit = Math.min(partsA.length, partsB.length);
  for (let i = 0; i < limit; i++) {
    const a = partsA[i]!;
    const b = partsB[i]!;
    if (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b) {
      shared.push(a);
    } else {
      break;
    }
  }
  return path.join(rootA, ...shared);
}

function resolveCliPath(rawPath: string): string {
  const baseCwd = process.env.INIT_CWD?.trim() || process.cwd();
  return path.resolve(baseCwd, rawPath);
}

/**
 * Execute a local document conversion via `@novatex/format-hub`.
 */
export async function runConvertCommand(
  opts: ConvertCliOptions,
  hub: FormatHub = new FormatHub(),
): Promise<ConvertCommandResult> {
  const absInput = resolveCliPath(opts.input);
  if (!fs.existsSync(absInput) || !fs.statSync(absInput).isFile()) {
    throw new Error(`输入文件不存在: ${absInput}`);
  }

  let workspaceRoot = path.dirname(absInput);
  let bibRelPath: string | undefined;

  if (opts.bib) {
    const absBib = resolveCliPath(opts.bib);
    if (!fs.existsSync(absBib) || !fs.statSync(absBib).isFile()) {
      throw new Error(`指定的参考文献文件不存在: ${absBib}`);
    }
    const ancestor = findSharedAncestor(absInput, absBib);
    if (ancestor) {
      const candidateInputRel = path.relative(ancestor, absInput).replace(/\\/g, '/');
      const candidateBibRel = path.relative(ancestor, absBib).replace(/\\/g, '/');
      try {
        normalizeProjectRelPath(candidateInputRel);
        bibRelPath = normalizeProjectRelPath(candidateBibRel);
        workspaceRoot = ancestor;
      } catch {
        // Fallback if paths violate project-relative constraints (e.g. >200 chars)
      }
    }
  }

  const rawSourceRel = path.relative(workspaceRoot, absInput).replace(/\\/g, '/');
  let safeSourceRel: string | undefined;
  try {
    safeSourceRel = normalizeProjectRelPath(rawSourceRel);
  } catch {
    safeSourceRel = undefined;
  }

  const isBinaryInput = opts.from === 'docx' || opts.from === 'pdf';
  const bodyOnly = opts.bodyOnly === true;

  const artifact = await hub.convert({
    inputFormat: opts.from as FormatLayer,
    outputFormat: opts.to as FormatLayer,
    workspaceRoot,
    sourceFilePath: safeSourceRel,
    ...(isBinaryInput
      ? { inputBuffer: fs.readFileSync(absInput) }
      : opts.from === 'tex' && safeSourceRel
        ? {}
        : { inputContent: fs.readFileSync(absInput, 'utf8') }),
    options: {
      preserveCitations: true,
      bodyOnly,
      template: opts.template ?? 'clean-article',
      bibFile: bibRelPath,
      title: opts.title,
      mediaDir: opts.mediaDir,
    },
  });

  let outputPath: string | undefined;
  if (opts.output) {
    outputPath = resolveCliPath(opts.output);
  } else if (opts.to === 'docx') {
    const parsed = path.parse(absInput);
    outputPath = path.join(parsed.dir, `${parsed.name}.docx`);
  }

  if (outputPath) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    if (artifact.base64 !== undefined) {
      fs.writeFileSync(outputPath, Buffer.from(artifact.base64, 'base64'));
    } else {
      fs.writeFileSync(outputPath, artifact.text ?? '', 'utf8');
    }
  }

  return { artifact, outputPath };
}

/**
 * Main CLI runner. Returns exit code (0 on success, 1 on error).
 */
export async function runCli(argv: string[] = process.argv.slice(2)): Promise<number> {
  try {
    const parsed = parseCliArgs(argv);

    if (parsed.command === 'help') {
      console.log(getHelpText());
      return 0;
    }

    if (parsed.command === 'pull') {
      const localDir = resolveCliPath(parsed.dir);
      const client = new NovaTeXSyncClient({
        serverUrl: parsed.url,
        projectId: parsed.project,
        token: parsed.token,
        localDir,
      });
      const result = await client.pullAll();
      console.log(
        `拉取完成 / Pull complete: ${result.downloaded.length} downloaded, ${result.skipped.length} skipped -> ${localDir}`,
      );
      return 0;
    }

    if (parsed.command === 'watch') {
      const localDir = resolveCliPath(parsed.dir);
      const client = new NovaTeXSyncClient({
        serverUrl: parsed.url,
        projectId: parsed.project,
        token: parsed.token,
        localDir,
        agentName: parsed.name,
        pollIntervalMs: parsed.pollIntervalMs,
      });

      await client.start();

      await new Promise<void>((resolve) => {
        let shuttingDown = false;
        const shutdown = async (signal: string) => {
          if (shuttingDown) return;
          shuttingDown = true;
          console.log(`\n[novatex-sync] 收到 ${signal}，正在清理连接与监听器...`);
          try {
            await client.stop();
          } finally {
            resolve();
          }
        };
        process.once('SIGINT', () => void shutdown('SIGINT'));
        process.once('SIGTERM', () => void shutdown('SIGTERM'));
      });
      return 0;
    }

    const result = await runConvertCommand(parsed);
    if (result.outputPath) {
      console.log(
        `转换完成 / Converted (${parsed.from} -> ${parsed.to}): ${result.outputPath} (${result.artifact.byteLength} B)`,
      );
      if (result.artifact.warnings.length > 0) {
        for (const w of result.artifact.warnings) {
          console.warn(`[novatex-sync] WARN: ${w}`);
        }
      }
    } else if (result.artifact.text !== undefined) {
      process.stdout.write(result.artifact.text);
      if (!result.artifact.text.endsWith('\n')) {
        process.stdout.write('\n');
      }
    }
    return 0;
  } catch (err) {
    console.error(`[novatex-sync] 错误 / Error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

function isExecutedDirectly(): boolean {
  const invoked = process.argv[1];
  if (!invoked) return false;
  try {
    const selfPath = fs.realpathSync(fileURLToPath(import.meta.url));
    const entryPath = fs.realpathSync(path.resolve(invoked));
    return selfPath === entryPath;
  } catch {
    return false;
  }
}

if (isExecutedDirectly()) {
  void runCli(process.argv.slice(2)).then((code) => {
    if (code !== 0) {
      process.exitCode = code;
    }
  });
}
