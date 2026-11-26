import type { AiFixMode, AiFixRequest, CompileDiagnostic } from '@novatex/shared';

export const LONG_FILE_LINE_THRESHOLD = 250;
export const WINDOW_LINE_RADIUS = 60;
export const PREAMBLE_MAX_LINES = 40;
export const MAX_LOG_EXCERPT_CHARS = 4_000;
export const MAX_DIAGNOSTICS_IN_PROMPT = 20;
export const STRUCTURAL_FULL_FILE_MAX_LINES = 400;
export const STRUCTURAL_DIAG_PROXIMITY_LINES = 15;
export const STRUCTURAL_WINDOW_PADDING_LINES = 10;
export const STRUCTURAL_MAX_CLUSTER_SPAN_LINES = 260;
export const UNCLOSED_BLOCK_MAX_LINES = 40;
export const INLINE_MATH_DIAG_RADIUS = 3;

export interface LatexLineRange {
  /** 1-based inclusive start line */
  startLine: number;
  /** 1-based inclusive end line */
  endLine: number;
}

export interface PreparedPromptWindow {
  /** Whether a bounded line slice (instead of the full file) is being edited */
  isWindowed: boolean;
  /** 1-based inclusive start line of editable region (or 1 for full file) */
  startLine: number;
  /** 1-based inclusive end line of editable region (or totalLines for full file) */
  endLine: number;
  /** Total logical lines in the full source file */
  totalLines: number;
  /** Exact text of the editable region sent to the model */
  editableCode: string;
  /** Optional read-only preamble context (lines 1..N before startLine) */
  preambleContext?: string;
  /** Line range of the preamble context if included */
  preambleRange?: { startLine: number; endLine: number };
  /** Original line ending detected from sourceCode */
  eol: '\n' | '\r\n';
  /** Whether the full source file ended with a trailing newline */
  hasTrailingNewline: boolean;
  /** Whether the editable slice itself ended with a blank line */
  editableEndsWithBlankLine: boolean;
  /** Auto-detected table/math blocks when scanning without an explicit selectionRange */
  detectedBlocks?: LatexLineRange[];
  /** Subset of detectedBlocks targeted by the active window in structural auto-scan mode */
  focusedBlocks?: LatexLineRange[];
  /** True when long-file structural auto-scan left additional detected blocks outside the window */
  hasOmittedOutsideBlocks?: boolean;
  /** True when long-file structural auto-scan centered on diagnostic-hit block(s) */
  diagnosticFocused?: boolean;
}

export interface BuiltAiPrompt {
  systemPrompt: string;
  userPrompt: string;
  window: PreparedPromptWindow;
}

const ANTI_REWRITE_GUARDRAIL = [
  '【严禁改写学术正文铁律 / STRICT ANTI-REWRITE GUARDRAIL】',
  '1. 你只做最小化、外科手术式的 LaTeX 语法排错或排版格式整理，严禁润色、扩写、缩写、翻译、改写或捏造任何学术正文、论点、实验数据、数字、引用（\\cite{...}）、交叉引用（\\label/\\ref）或公式语义。',
  '2. STRICTLY FORBIDDEN to rewrite, embellish, paraphrase, summarize, translate, or fabricate academic prose, experimental numbers, citations, labels, or scientific claims. Preserve original prose verbatim outside minimal syntax/formatting fixes.',
  '3. 严禁省略或截断代码！绝对不要输出诸如 "% ... 其余内容不变 ..." 或 "... omitted ..." 之类的占位注释，patchedCode 必须是目标范围内完整、可直接替换的代码。',
].join('\n');

const JSON_CONTRACT = [
  '【严格 JSON 输出格式 / STRICT JSON OUTPUT FORMAT】',
  '请仅输出一个合法的 JSON 对象（不要在 JSON 外输出额外解释文字），字段必须严格如下：',
  '{',
  '  "summaryZh": "一句话人话总结修复或整理的内容",',
  '  "rootCauseZh": "简明扼要解释报错或格式问题的根本原因",',
  '  "actionsTakenZh": ["具体改动动作1", "具体改动动作2"],',
  '  "patchedCode": "目标范围内完整的修复后 LaTeX 代码（注意正确转义反斜杠 \\\\ 与换行 \\\\n）",',
  '  "warningsZh": ["可选注意事项，例如需在导言区添加 \\\\usepackage{booktabs}；无则输出空数组 []"]',
  '}',
  '注意：patchedCode 中的所有 LaTeX 反斜杠必须双写转义（例如 "\\\\begin{table}"），以确保整个响应是合法 JSON。',
].join('\n');

const MODE_INSTRUCTIONS: Record<AiFixMode, string> = {
  'diagnose-and-fix': [
    '【当前模式：编译排错修复 (diagnose-and-fix)】',
    '你是 NovaTeX 内置的 LaTeX 编译排错专家。你的唯一任务是根据提供的结构化编译诊断（CompileDiagnostic）与原始编译日志片段，定位并最小化修复导致 LaTeX 编译失败或严重告警的语法/宏包/环境错误。',
    '- 优先解决未定义控制序列、花括号/环境不配对、数学模式缺失、特殊字符未转义（如正文中的 % _ & #）、缺失参数或宏包冲突等直接报错。',
    '- 若错误源于导言区缺少宏包，而当前编辑窗口不包含导言区，请在 warningsZh 中明确提醒用户添加对应 \\usepackage{...}，并在可编辑窗口内完成局部修复。',
    '- 保持未出错的所有段落、公式、表格和注释原样不动。',
  ].join('\n'),
  'format-table': [
    '【当前模式：学术表格排错修复与三线表格式化 (format-table)】',
    '你是 NovaTeX 内置的 LaTeX 学术表格排错与排版专家。你的任务同时涵盖【修复表格相关的编译与语法错误】以及【将残破、混乱或普通竖线表格整理为规范的学术 booktabs 三线表】：',
    '- 【优先排错修复】：当提供编译诊断、日志或表格存在语法破损时，优先修复所有表格错误，包括多余或缺失的列分隔符 `&`、缺失行尾换行 `\\\\`、单元格内未转义的特殊字符（`%`、`_`、`#` 等）、破损的 `\\multicolumn` / `\\multirow` / `\\cmidrule` 参数、未闭合的 `\\begin{table}` / `\\begin{tabular}` / `\\begin{tabularx}` / `\\begin{longtable}` 环境、以及列格式声明与实际列数不匹配等问题。',
    '- 【学术三线表规范化】：使用 \\toprule、\\midrule、\\bottomrule 替代冗余 \\hline，去掉学术论文中不推荐的竖线 |（除非特殊需要），并规范 \\caption 与 \\label 的顺序。',
    '- 【整篇文件自动定位原则】：当未指定选区而扫描整篇文件（或长文件定位窗口）时，请自动定位其中全部表格块，修复所有报错或凌乱的表格，同时保证表格环境之外的所有正文段落、标题、公式、导言区和注释 100% 逐字原样不动。',
    '- 严禁改动表格中的任何实验数值、指标名称、单位、加粗最优值含义或表注文字。',
    '- 如果导言区未加载 booktabs 宏包且导言区不在可编辑窗口内，请在 warningsZh 中提示添加 \\usepackage{booktabs}。',
  ].join('\n'),
  'format-math': [
    '【当前模式：数学公式排错修复与对齐美化 (format-math)】',
    '你是 NovaTeX 内置的 LaTeX 数学公式排错与排版专家。你的任务同时涵盖【修复公式相关的编译与语法错误】以及【规范化与美化多行或复杂 LaTeX 数学公式环境】：',
    '- 【优先排错修复】：当提供编译诊断、日志或公式存在语法破损时，优先修复所有数学公式错误，包括未闭合的 `\\begin{equation}` / `\\begin{align}` / `\\begin{gather}` / `\\[` / `$$`、不配对的 `\\left` / `\\right`（必要时补齐 `\\right.` 或 `\\left.`）、花括号 `{}` 不配对、错误的数学模式触发（如缺失 `$`、正文误用 `_` / `^` / `\\frac` 或数学模式内重复嵌套 `$`）、缺失行尾 `\\\\`、多余或错位的对齐符 `&` 等。',
    '- 【规范对齐与美化】：合理使用 align / align* / equation / split / cases 等 amsmath 环境替代过时的 eqnarray 或断裂的公式块，规范对齐锚点 &、换行 \\\\ 与上下标花括号分组。',
    '- 【整篇文件自动定位原则】：当未指定选区而扫描整篇文件（或长文件定位窗口）时，请自动定位其中全部公式块（含编译诊断命中的行内 `$...$` 公式），修复所有报错或凌乱的公式，同时保证公式区域之外的所有正文段落、标题、表格、导言区和注释 100% 逐字原样不动。',
    '- 严禁改变任何数学符号、变量名、系数、上下标含义、运算符或推导步骤。',
    '- 如果导言区未加载 amsmath 宏包且导言区不在可编辑窗口内，请在 warningsZh 中提示添加 \\usepackage{amsmath}。',
  ].join('\n'),
  'cleanup-conversion': [
    '【当前模式：文档转换残留轻清理 (cleanup-conversion)】',
    '你是 NovaTeX 内置的 Pandoc / Word / Markdown 转 LaTeX 残留清理专家。你的唯一任务是轻度清理格式转换产生的机械冗余与丑陋宏结构。',
    '- 清理典型的转换残留，例如多余的 \\tightlist、冗余 \\def\\labelenumi、不必要的嵌套 minipage / longtable 包装、多余空分组 {}、异常 \\pandocbounded 或破损列宽计算。',
    '- 将转换残留的粗糙表格适度规整为干净可读的 LaTeX 结构，同时保持原有标题层级、图片路径、引用和标签完全不变。',
    '- 绝对禁止重写、删减或润色任何正文句子与段落内容。',
  ].join('\n'),
};

const TABLE_ENV_NAMES = new Set<string>([
  'table',
  'table*',
  'sidewaystable',
  'sidewaystable*',
  'longtable',
  'longtable*',
  'supertabular',
  'supertabular*',
  'threeparttable',
  'tabular',
  'tabular*',
  'tabularx',
  'tabulary',
]);

const MATH_ENV_NAMES = new Set<string>([
  'equation',
  'equation*',
  'align',
  'align*',
  'alignat',
  'alignat*',
  'gather',
  'gather*',
  'multline',
  'multline*',
  'eqnarray',
  'eqnarray*',
  'flalign',
  'flalign*',
  'math',
  'displaymath',
  'subequations',
  'split',
  'aligned',
  'gathered',
  'cases',
]);

const STRUCTURAL_BOUNDARY_REGEX =
  /\\(?:chapter|section|subsection|subsubsection)\b|\\end[ \t]*\{document\}/;

const TABLE_ENV_TOKEN_RE = /\\(begin|end)[ \t]*\{([a-zA-Z*]{1,32})\}/g;
const STICKY_ENV_RE = /\\(begin|end)[ \t]*\{([a-zA-Z*]{1,32})\}/y;

interface InternalBlockRange extends LatexLineRange {
  unclosed: boolean;
}

function stripLatexComment(line: string): string {
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === '%') {
      return line.slice(0, i);
    }
  }
  return line;
}

function hasOddPrecedingBackslashes(text: string, index: number): boolean {
  let count = 0;
  for (let i = index - 1; i >= 0 && text[i] === '\\'; i--) {
    count++;
  }
  return count % 2 === 1;
}

function resolveUnclosedEndLine(lines: string[], startLine: number): number {
  const totalLines = lines.length;
  const maxLine = Math.min(totalLines, startLine + UNCLOSED_BLOCK_MAX_LINES);
  let endLine = maxLine;

  for (let ln = startLine + 1; ln <= maxLine; ln++) {
    const stripped = stripLatexComment(lines[ln - 1] ?? '');
    if (STRUCTURAL_BOUNDARY_REGEX.test(stripped)) {
      endLine = Math.max(startLine, ln - 1);
      break;
    }
  }

  while (endLine > startLine && (lines[endLine - 1] ?? '').trim().length === 0) {
    endLine--;
  }

  return endLine;
}

function mergeDetectedBlocks(blocks: InternalBlockRange[]): InternalBlockRange[] {
  if (blocks.length === 0) return [];
  const sorted = [...blocks].sort((a, b) =>
    a.startLine !== b.startLine ? a.startLine - b.startLine : a.endLine - b.endLine,
  );
  const merged: InternalBlockRange[] = [{ ...sorted[0]! }];

  for (let i = 1; i < sorted.length; i++) {
    const curr = sorted[i]!;
    const prev = merged[merged.length - 1]!;
    if (curr.startLine <= prev.endLine) {
      prev.endLine = Math.max(prev.endLine, curr.endLine);
      prev.unclosed = prev.unclosed || curr.unclosed;
    } else {
      merged.push({ ...curr });
    }
  }

  return merged;
}

function closeEnvOnStack(
  envStack: Array<{ env: string; startLine: number }>,
  envName: string,
  endLine: number,
  out: InternalBlockRange[],
): void {
  for (let idx = envStack.length - 1; idx >= 0; idx--) {
    if (envStack[idx]!.env === envName) {
      // Any unclosed inner environments above the matched outer env are marked unclosed
      for (let innerIdx = envStack.length - 1; innerIdx > idx; innerIdx--) {
        const inner = envStack[innerIdx]!;
        out.push({ startLine: inner.startLine, endLine, unclosed: true });
      }
      const matched = envStack[idx]!;
      out.push({ startLine: matched.startLine, endLine, unclosed: false });
      envStack.length = idx;
      return;
    }
  }
}

function scanLatexTableBlocks(lines: string[]): InternalBlockRange[] {
  if (lines.length === 0) return [];

  const envStack: Array<{ env: string; startLine: number }> = [];
  const rawBlocks: InternalBlockRange[] = [];

  for (let idx = 0; idx < lines.length; idx++) {
    const ln = idx + 1;
    const code = stripLatexComment(lines[idx] ?? '');
    if (!code.includes('\\')) continue;

    TABLE_ENV_TOKEN_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = TABLE_ENV_TOKEN_RE.exec(code)) !== null) {
      if (hasOddPrecedingBackslashes(code, match.index)) {
        continue;
      }
      const kind = match[1];
      const envName = match[2] ?? '';
      if (!TABLE_ENV_NAMES.has(envName)) continue;

      if (kind === 'begin') {
        envStack.push({ env: envName, startLine: ln });
      } else {
        closeEnvOnStack(envStack, envName, ln, rawBlocks);
      }
    }
  }

  for (const unclosed of envStack) {
    rawBlocks.push({
      startLine: unclosed.startLine,
      endLine: resolveUnclosedEndLine(lines, unclosed.startLine),
      unclosed: true,
    });
  }

  return mergeDetectedBlocks(rawBlocks);
}

/**
 * Scans LaTeX lines and returns 1-based inclusive line ranges for all table
 * blocks (`table`, `table*`, `sidewaystable`, `longtable`, `supertabular`,
 * `threeparttable`, and standalone `tabular`/`tabular*`/`tabularx`/`tabulary`).
 * Nested/overlapping blocks are merged into one clean range per logical table,
 * and unclosed `\begin{table}` / `\begin{tabular}` environments are gracefully
 * bounded to the next section/document end or up to +40 lines.
 */
export function findLatexTableRanges(lines: string[]): Array<{ startLine: number; endLine: number }> {
  return scanLatexTableBlocks(lines).map(({ startLine, endLine }) => ({ startLine, endLine }));
}

function lineContainsInlineMath(line: string): boolean {
  const code = stripLatexComment(line);
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (ch === '\\') {
      const next = code[i + 1];
      if (next === '\\' || next === '$') {
        i++;
        continue;
      }
      if (next === '(' || next === ')') {
        return true;
      }
      continue;
    }
    if (ch === '$') {
      if (code[i + 1] === '$') {
        i++;
        continue;
      }
      return true;
    }
  }
  return false;
}

function collectDiagnosticLinesForInlineMath(
  diagnostics: CompileDiagnostic[] | undefined,
  filePath: string | undefined,
  totalLines: number,
): number[] {
  if (!diagnostics || diagnostics.length === 0 || totalLines <= 0) {
    return [];
  }
  const inBounds = diagnostics.filter(
    (d) =>
      typeof d.line === 'number' &&
      Number.isFinite(d.line) &&
      Math.floor(d.line) >= 1 &&
      Math.floor(d.line) <= totalLines,
  );
  if (inBounds.length === 0) return [];

  let pool = inBounds;
  if (filePath && filePath.trim().length > 0) {
    const targetNorm = normalizePathForMatch(filePath);
    const targetBase = basenameOf(filePath);
    const fileMatched = inBounds.filter((d) => {
      const df = normalizePathForMatch(d.file || '');
      return df === targetNorm || (targetBase.length > 0 && basenameOf(df) === targetBase);
    });
    if (fileMatched.length > 0) {
      pool = fileMatched;
    }
  }

  return Array.from(new Set(pool.map((d) => Math.floor(d.line)))).sort((a, b) => a - b);
}

function scanLatexMathBlocks(
  lines: string[],
  diagnostics?: CompileDiagnostic[],
  filePath?: string,
): InternalBlockRange[] {
  if (lines.length === 0) return [];

  const envStack: Array<{ env: string; startLine: number }> = [];
  const rawBlocks: InternalBlockRange[] = [];
  let openBracketStart: number | null = null;
  let openDoubleDollarStart: number | null = null;

  for (let idx = 0; idx < lines.length; idx++) {
    const ln = idx + 1;
    const code = stripLatexComment(lines[idx] ?? '');
    if (code.length === 0) continue;

    // Terminate unclosed `\[` / `$$` before a structural section or `\end{document}` boundary
    // so an unclosed opener never swallows body text or inverts later valid math blocks.
    if (
      (openDoubleDollarStart !== null || openBracketStart !== null) &&
      STRUCTURAL_BOUNDARY_REGEX.test(code)
    ) {
      if (openBracketStart !== null) {
        const boundedEnd = Math.min(
          Math.max(openBracketStart, ln - 1),
          resolveUnclosedEndLine(lines, openBracketStart),
        );
        rawBlocks.push({ startLine: openBracketStart, endLine: boundedEnd, unclosed: true });
        openBracketStart = null;
      }
      if (openDoubleDollarStart !== null) {
        const boundedEnd = Math.min(
          Math.max(openDoubleDollarStart, ln - 1),
          resolveUnclosedEndLine(lines, openDoubleDollarStart),
        );
        rawBlocks.push({
          startLine: openDoubleDollarStart,
          endLine: boundedEnd,
          unclosed: true,
        });
        openDoubleDollarStart = null;
      }
    }

    let i = 0;
    while (i < code.length) {
      const ch = code[i];
      if (ch === '\\') {
        const next = code[i + 1];
        if (next === '\\') {
          // Escaped line break `\\` (e.g. `\\[4pt]` must NOT trigger `\[`)
          i += 2;
          continue;
        }
        if (next === '[') {
          if (openBracketStart !== null) {
            // `\[` cannot nest in LaTeX; a second `\[` means the prior one was unclosed.
            const boundedEnd = Math.min(
              Math.max(openBracketStart, ln - 1),
              resolveUnclosedEndLine(lines, openBracketStart),
            );
            rawBlocks.push({ startLine: openBracketStart, endLine: boundedEnd, unclosed: true });
          }
          openBracketStart = ln;
          i += 2;
          continue;
        }
        if (next === ']') {
          if (openBracketStart !== null) {
            rawBlocks.push({ startLine: openBracketStart, endLine: ln, unclosed: false });
            openBracketStart = null;
          }
          i += 2;
          continue;
        }
        if (next === '$') {
          i += 2;
          continue;
        }
        STICKY_ENV_RE.lastIndex = i;
        const envMatch = STICKY_ENV_RE.exec(code);
        if (envMatch) {
          const kind = envMatch[1];
          const envName = envMatch[2] ?? '';
          if (MATH_ENV_NAMES.has(envName)) {
            if (kind === 'begin') {
              envStack.push({ env: envName, startLine: ln });
            } else {
              closeEnvOnStack(envStack, envName, ln, rawBlocks);
            }
          }
          i = STICKY_ENV_RE.lastIndex;
          continue;
        }
        i += 1;
        continue;
      }

      if (ch === '$' && code[i + 1] === '$') {
        if (openDoubleDollarStart === null) {
          openDoubleDollarStart = ln;
        } else {
          rawBlocks.push({ startLine: openDoubleDollarStart, endLine: ln, unclosed: false });
          openDoubleDollarStart = null;
        }
        i += 2;
        continue;
      }

      i += 1;
    }
  }

  if (openBracketStart !== null) {
    rawBlocks.push({
      startLine: openBracketStart,
      endLine: resolveUnclosedEndLine(lines, openBracketStart),
      unclosed: true,
    });
  }
  if (openDoubleDollarStart !== null) {
    rawBlocks.push({
      startLine: openDoubleDollarStart,
      endLine: resolveUnclosedEndLine(lines, openDoubleDollarStart),
      unclosed: true,
    });
  }
  for (const unclosed of envStack) {
    rawBlocks.push({
      startLine: unclosed.startLine,
      endLine: resolveUnclosedEndLine(lines, unclosed.startLine),
      unclosed: true,
    });
  }

  // If compile diagnostics point to a line containing inline `$...$` (or `\(...\)`),
  // include that line ± 3 lines as a math repair range.
  const diagLines = collectDiagnosticLinesForInlineMath(diagnostics, filePath, lines.length);
  for (const ln of diagLines) {
    if (lineContainsInlineMath(lines[ln - 1] ?? '')) {
      rawBlocks.push({
        startLine: Math.max(1, ln - INLINE_MATH_DIAG_RADIUS),
        endLine: Math.min(lines.length, ln + INLINE_MATH_DIAG_RADIUS),
        unclosed: false,
      });
    }
  }

  return mergeDetectedBlocks(rawBlocks);
}

/**
 * Scans LaTeX lines and returns 1-based inclusive line ranges for all display
 * math environments (`equation`, `align`, `alignat`, `gather`, `multline`,
 * `eqnarray`, `flalign`, `math`, `displaymath` and starred variants), delimited
 * display math blocks (`\[ ... \]`, `$$ ... $$`), unclosed math blocks, and
 * optionally inline `$...$` lines hit by compile diagnostics (± 3 lines).
 */
export function findLatexMathRanges(
  lines: string[],
  diagnostics?: CompileDiagnostic[],
  filePath?: string,
): Array<{ startLine: number; endLine: number }> {
  return scanLatexMathBlocks(lines, diagnostics, filePath).map(({ startLine, endLine }) => ({
    startLine,
    endLine,
  }));
}

function splitLogicalLines(sourceCode: string): {
  lines: string[];
  eol: '\n' | '\r\n';
  hasTrailingNewline: boolean;
} {
  const eol: '\n' | '\r\n' = sourceCode.includes('\r\n') ? '\r\n' : '\n';
  const normalized = sourceCode.replace(/\r\n/g, '\n');
  if (normalized.length === 0) {
    return { lines: [], eol, hasTrailingNewline: false };
  }
  const hasTrailingNewline = normalized.endsWith('\n');
  const body = hasTrailingNewline ? normalized.slice(0, -1) : normalized;
  return {
    lines: body.split('\n'),
    eol,
    hasTrailingNewline,
  };
}

function normalizePathForMatch(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').trim().toLowerCase();
}

function basenameOf(p: string): string {
  const norm = normalizePathForMatch(p);
  const idx = norm.lastIndexOf('/');
  return idx >= 0 ? norm.slice(idx + 1) : norm;
}

function pickDiagnosticTargetLines(
  diagnostics: CompileDiagnostic[] | undefined,
  filePath: string,
  totalLines: number,
): number[] {
  if (!diagnostics || diagnostics.length === 0 || totalLines <= 0) {
    return [];
  }

  const targetNorm = normalizePathForMatch(filePath);
  const targetBase = basenameOf(filePath);

  const withValidLine = diagnostics.filter(
    (d) => typeof d.line === 'number' && Number.isFinite(d.line) && d.line >= 1,
  );
  if (withValidLine.length === 0) return [];

  const fileMatched = withValidLine.filter((d) => {
    const df = normalizePathForMatch(d.file || '');
    return df === targetNorm || (targetBase.length > 0 && basenameOf(df) === targetBase);
  });

  const pool = fileMatched.length > 0 ? fileMatched : withValidLine;
  const errorsOnly = pool.filter((d) => d.severity === 'error');
  const prioritized = errorsOnly.length > 0 ? errorsOnly : pool;

  const lines = prioritized.map((d) => Math.min(totalLines, Math.max(1, Math.floor(d.line))));
  return Array.from(new Set(lines)).sort((a, b) => a - b);
}

function extractStructuralDiagnosticLines(
  diagnostics: CompileDiagnostic[] | undefined,
  filePath: string,
  totalLines: number,
  errorsOnly: boolean,
): number[] {
  if (!diagnostics || diagnostics.length === 0 || totalLines <= 0) {
    return [];
  }

  const targetNorm = normalizePathForMatch(filePath);
  const targetBase = basenameOf(filePath);

  const fileMatched = diagnostics.filter((d) => {
    const df = normalizePathForMatch(d.file || '');
    return df === targetNorm || (targetBase.length > 0 && basenameOf(df) === targetBase);
  });

  const basePool = fileMatched.length > 0 ? fileMatched : diagnostics;
  const filtered = errorsOnly ? basePool.filter((d) => d.severity === 'error') : basePool;
  const lineSet = new Set<number>();

  for (const d of filtered) {
    if (typeof d.line === 'number' && Number.isFinite(d.line) && d.line >= 1) {
      lineSet.add(Math.min(totalLines, Math.max(1, Math.floor(d.line))));
    }
    // Extract referenced opener line from LaTeX unclosed environment diagnostics:
    // e.g. `\begin{tabular} on input line 376 ended by \end{document}.`
    if (typeof d.rawMessage === 'string' && d.rawMessage.length > 0) {
      const refRegex = /\bon input line\s+(\d+)\b/gi;
      let match: RegExpExecArray | null;
      while ((match = refRegex.exec(d.rawMessage)) !== null) {
        const refLine = Number.parseInt(match[1] ?? '', 10);
        if (Number.isFinite(refLine) && refLine >= 1 && refLine <= totalLines) {
          lineSet.add(refLine);
        }
      }
    }
  }

  return Array.from(lineSet).sort((a, b) => a - b);
}

function findBlocksHitByLines(
  blocks: InternalBlockRange[],
  diagLines: number[],
  proximity: number,
): InternalBlockRange[] {
  if (blocks.length === 0 || diagLines.length === 0) return [];
  return blocks.filter((block) =>
    diagLines.some(
      (ln) => ln >= block.startLine - proximity && ln <= block.endLine + proximity,
    ),
  );
}

function selectBlockCluster(
  blocks: InternalBlockRange[],
  maxSpan: number,
): InternalBlockRange[] {
  if (blocks.length === 0) return [];
  const first = blocks[0]!;
  const cluster: InternalBlockRange[] = [first];
  for (let i = 1; i < blocks.length; i++) {
    const candidate = blocks[i]!;
    if (candidate.endLine - first.startLine + 1 <= maxSpan) {
      cluster.push(candidate);
    } else {
      break;
    }
  }
  return cluster;
}

function toPublicRanges(blocks: InternalBlockRange[]): LatexLineRange[] {
  return blocks.map(({ startLine, endLine }) => ({ startLine, endLine }));
}

function extractPreambleContext(
  lines: string[],
  editableStartLine: number,
): { text: string; range: { startLine: number; endLine: number } } | undefined {
  if (editableStartLine <= 1 || lines.length === 0) {
    return undefined;
  }

  const maxCandidateEnd = Math.min(PREAMBLE_MAX_LINES, editableStartLine - 1, lines.length);
  if (maxCandidateEnd < 1) {
    return undefined;
  }

  // If \begin{document} occurs within lines 1..maxCandidateEnd, stop right there so
  // the preamble snippet stays strictly focused on preamble declarations.
  let endLine = maxCandidateEnd;
  for (let i = 0; i < maxCandidateEnd; i++) {
    const line = lines[i] ?? '';
    if (/\\begin\s*\{document\}/.test(line)) {
      endLine = i + 1;
      break;
    }
  }

  const slice = lines.slice(0, endLine);
  return {
    text: slice.join('\n'),
    range: { startLine: 1, endLine },
  };
}

/**
 * Extracts either the full file or a bounded editable line window (+ read-only
 * preamble context) to minimize token consumption and prevent LLM truncation on
 * long LaTeX manuscripts.
 *
 * For `format-table` and `format-math` without an explicit `selectionRange`,
 * performs structural auto-scan across the document:
 * - Files <= 400 lines are sent in full with auto-detected target ranges;
 * - Files > 400 lines center tightly on diagnostic-hit block(s) (±10 padding)
 *   or detected block clusters (<= 260 lines span) + read-only preamble context.
 */
export function extractTargetWindow(request: AiFixRequest): PreparedPromptWindow {
  const { lines, eol, hasTrailingNewline } = splitLogicalLines(request.sourceCode);
  const totalLines = lines.length;

  if (totalLines === 0) {
    return {
      isWindowed: false,
      startLine: 1,
      endLine: 0,
      totalLines: 0,
      editableCode: '',
      eol,
      hasTrailingNewline,
      editableEndsWithBlankLine: false,
    };
  }

  const isStructuralMode = request.mode === 'format-table' || request.mode === 'format-math';

  // 1. Explicit selectionRange always scopes edits strictly to the chosen lines.
  if (request.selectionRange) {
    const rawStart = Math.floor(request.selectionRange.startLine);
    const rawEnd = Math.floor(request.selectionRange.endLine);
    if (Number.isFinite(rawStart) && Number.isFinite(rawEnd)) {
      const startLine = Math.min(totalLines, Math.max(1, Math.min(rawStart, rawEnd)));
      const endLine = Math.min(totalLines, Math.max(1, Math.max(rawStart, rawEnd)));

      if (startLine > 1 || endLine < totalLines) {
        const editableSlice = lines.slice(startLine - 1, endLine);
        const preamble = extractPreambleContext(lines, startLine);
        return {
          isWindowed: true,
          startLine,
          endLine,
          totalLines,
          editableCode: editableSlice.join('\n'),
          preambleContext: preamble?.text,
          preambleRange: preamble?.range,
          eol,
          hasTrailingNewline,
          editableEndsWithBlankLine: editableSlice[editableSlice.length - 1] === '',
        };
      }

      if (isStructuralMode) {
        return {
          isWindowed: false,
          startLine: 1,
          endLine: totalLines,
          totalLines,
          editableCode: lines.join('\n'),
          eol,
          hasTrailingNewline,
          editableEndsWithBlankLine: lines[lines.length - 1] === '',
        };
      }
    }
  }

  // 2. Smart whole-file / structural auto-scan for format-table & format-math
  //    when no explicit selectionRange is provided.
  if (isStructuralMode) {
    const blocks =
      request.mode === 'format-table'
        ? scanLatexTableBlocks(lines)
        : scanLatexMathBlocks(lines, request.diagnostics, request.filePath);
    const publicBlocks = toPublicRanges(blocks);

    if (totalLines <= STRUCTURAL_FULL_FILE_MAX_LINES) {
      return {
        isWindowed: false,
        startLine: 1,
        endLine: totalLines,
        totalLines,
        editableCode: lines.join('\n'),
        eol,
        hasTrailingNewline,
        editableEndsWithBlankLine: lines[lines.length - 1] === '',
        detectedBlocks: publicBlocks,
        focusedBlocks: publicBlocks,
        hasOmittedOutsideBlocks: false,
        diagnosticFocused: false,
      };
    }

    if (blocks.length > 0) {
      const errorDiagLines = extractStructuralDiagnosticLines(
        request.diagnostics,
        request.filePath,
        totalLines,
        true,
      );
      let hitBlocks = findBlocksHitByLines(
        blocks,
        errorDiagLines,
        STRUCTURAL_DIAG_PROXIMITY_LINES,
      );
      if (hitBlocks.length === 0) {
        const allDiagLines = extractStructuralDiagnosticLines(
          request.diagnostics,
          request.filePath,
          totalLines,
          false,
        );
        hitBlocks = findBlocksHitByLines(
          blocks,
          allDiagLines,
          STRUCTURAL_DIAG_PROXIMITY_LINES,
        );
      }

      let selected: InternalBlockRange[];
      let diagnosticFocused = false;

      if (hitBlocks.length > 0) {
        selected = selectBlockCluster(hitBlocks, STRUCTURAL_MAX_CLUSTER_SPAN_LINES);
        diagnosticFocused = true;
      } else {
        const combinedSpan =
          blocks[blocks.length - 1]!.endLine - blocks[0]!.startLine + 1;
        if (combinedSpan <= STRUCTURAL_MAX_CLUSTER_SPAN_LINES) {
          selected = blocks;
        } else {
          // Never silently drop an unclosed table/math block when clustering
          const firstUnclosedIdx = blocks.findIndex((b) => b.unclosed);
          const clusterSource =
            firstUnclosedIdx >= 0 ? blocks.slice(firstUnclosedIdx) : blocks;
          selected = selectBlockCluster(clusterSource, STRUCTURAL_MAX_CLUSTER_SPAN_LINES);
        }
      }

      const clusterStart = selected[0]!.startLine;
      const clusterEnd = selected[selected.length - 1]!.endLine;
      const startLine = Math.max(1, clusterStart - STRUCTURAL_WINDOW_PADDING_LINES);
      const endLine = Math.min(totalLines, clusterEnd + STRUCTURAL_WINDOW_PADDING_LINES);
      const focusedPublic = toPublicRanges(selected);
      const hasOmittedOutsideBlocks = blocks.some(
        (b) => b.startLine < startLine || b.endLine > endLine,
      );

      if (startLine > 1 || endLine < totalLines) {
        const editableSlice = lines.slice(startLine - 1, endLine);
        const preamble = extractPreambleContext(lines, startLine);
        return {
          isWindowed: true,
          startLine,
          endLine,
          totalLines,
          editableCode: editableSlice.join('\n'),
          preambleContext: preamble?.text,
          preambleRange: preamble?.range,
          eol,
          hasTrailingNewline,
          editableEndsWithBlankLine: editableSlice[editableSlice.length - 1] === '',
          detectedBlocks: publicBlocks,
          focusedBlocks: focusedPublic,
          hasOmittedOutsideBlocks,
          diagnosticFocused,
        };
      }

      return {
        isWindowed: false,
        startLine: 1,
        endLine: totalLines,
        totalLines,
        editableCode: lines.join('\n'),
        eol,
        hasTrailingNewline,
        editableEndsWithBlankLine: lines[lines.length - 1] === '',
        detectedBlocks: publicBlocks,
        focusedBlocks: focusedPublic,
        hasOmittedOutsideBlocks: false,
        diagnosticFocused,
      };
    }
  }

  // 3. For long files (> 250 lines) with pinpointed diagnostics, extract a bounded
  //    ±60-line window around the target diagnostic cluster plus Preamble lines 1..40.
  if (totalLines > LONG_FILE_LINE_THRESHOLD) {
    const diagLines = pickDiagnosticTargetLines(
      request.diagnostics,
      request.filePath,
      totalLines,
    );
    if (diagLines.length > 0) {
      const anchor = diagLines[0]!;
      // Include nearby diagnostics within 2 * WINDOW_LINE_RADIUS of the primary anchor
      // so related cascading lines stay in one compact window without exploding size.
      let clusterMin = anchor;
      let clusterMax = anchor;
      for (const ln of diagLines) {
        if (ln - clusterMin <= WINDOW_LINE_RADIUS * 2) {
          clusterMax = Math.max(clusterMax, ln);
        }
      }

      const startLine = Math.max(1, clusterMin - WINDOW_LINE_RADIUS);
      const endLine = Math.min(totalLines, clusterMax + WINDOW_LINE_RADIUS);

      if (startLine > 1 || endLine < totalLines) {
        const editableSlice = lines.slice(startLine - 1, endLine);
        const preamble = extractPreambleContext(lines, startLine);
        return {
          isWindowed: true,
          startLine,
          endLine,
          totalLines,
          editableCode: editableSlice.join('\n'),
          preambleContext: preamble?.text,
          preambleRange: preamble?.range,
          eol,
          hasTrailingNewline,
          editableEndsWithBlankLine: editableSlice[editableSlice.length - 1] === '',
          ...(isStructuralMode
            ? {
                detectedBlocks: [],
                focusedBlocks: [],
                hasOmittedOutsideBlocks: false,
                diagnosticFocused: false,
              }
            : {}),
        };
      }
    }
  }

  // 4. Default: full-file editing
  return {
    isWindowed: false,
    startLine: 1,
    endLine: totalLines,
    totalLines,
    editableCode: lines.join('\n'),
    eol,
    hasTrailingNewline,
    editableEndsWithBlankLine: lines[lines.length - 1] === '',
    ...(isStructuralMode
      ? {
          detectedBlocks: [],
          focusedBlocks: [],
          hasOmittedOutsideBlocks: false,
          diagnosticFocused: false,
        }
      : {}),
  };
}

/**
 * Strips an accidental outer Markdown code fence (e.g. ```latex ... ```) if the
 * model wrapped `patchedCode` inside one despite JSON instructions.
 */
export function stripOuterCodeFenceIfAccidental(patched: string, original: string): string {
  const trimmedOrig = original.trimStart();
  if (trimmedOrig.startsWith('```')) {
    return patched;
  }
  const match = patched.match(/^```(?:latex|tex)?[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/i);
  if (match && typeof match[1] === 'string') {
    return match[1];
  }
  return patched;
}

/**
 * Accurately splices the model's `patchedEditableCode` back into the full
 * `originalSourceCode`, preserving untouched lines outside the window as well as
 * original line endings and trailing newline conventions.
 */
export function splicePatchedWindow(
  originalSourceCode: string,
  window: PreparedPromptWindow,
  rawPatchedEditableCode: string,
): string {
  const cleaned = stripOuterCodeFenceIfAccidental(
    rawPatchedEditableCode,
    window.editableCode,
  ).replace(/\r\n/g, '\n');

  if (!window.isWindowed) {
    let body = cleaned;
    if (!window.hasTrailingNewline && !window.editableEndsWithBlankLine && body.endsWith('\n')) {
      body = body.slice(0, -1);
    } else if (window.hasTrailingNewline && !body.endsWith('\n') && body.length > 0) {
      body = `${body}\n`;
    }
    return window.eol === '\r\n' ? body.replace(/\n/g, '\r\n') : body;
  }

  const { lines: originalLines } = splitLogicalLines(originalSourceCode);

  let normalizedWindow = cleaned;
  // LLMs frequently append a single trailing newline to a snippet that had none.
  if (!window.editableEndsWithBlankLine && normalizedWindow.endsWith('\n')) {
    normalizedWindow = normalizedWindow.slice(0, -1);
  }

  const replacementLines =
    normalizedWindow.length === 0 ? [] : normalizedWindow.split('\n');

  const mergedLines = [
    ...originalLines.slice(0, window.startLine - 1),
    ...replacementLines,
    ...originalLines.slice(window.endLine),
  ];

  const joined = mergedLines.join(window.eol);
  return window.hasTrailingNewline && mergedLines.length > 0
    ? `${joined}${window.eol}`
    : joined;
}

function formatDiagnosticsSection(
  diagnostics: CompileDiagnostic[] | undefined,
  filePath: string,
): string {
  if (!diagnostics || diagnostics.length === 0) {
    return '';
  }

  const targetNorm = normalizePathForMatch(filePath);
  const sorted = [...diagnostics].sort((a, b) => {
    const aSev = a.severity === 'error' ? 0 : a.severity === 'warning' ? 1 : 2;
    const bSev = b.severity === 'error' ? 0 : b.severity === 'warning' ? 1 : 2;
    if (aSev !== bSev) return aSev - bSev;
    const aSame = normalizePathForMatch(a.file || '') === targetNorm ? 0 : 1;
    const bSame = normalizePathForMatch(b.file || '') === targetNorm ? 0 : 1;
    if (aSame !== bSame) return aSame - bSame;
    return a.line - b.line;
  });

  const limited = sorted.slice(0, MAX_DIAGNOSTICS_IN_PROMPT);
  const lines = limited.map((d, idx) => {
    const loc = `${d.file || filePath}:${d.line}${d.column ? `:${d.column}` : ''}`;
    const snippetPart = d.snippet ? ` | 代码片段: ${d.snippet.trim()}` : '';
    return `${idx + 1}. [${d.severity.toUpperCase()}][${d.code}] ${loc} — ${d.titleZh} (${d.rawMessage}) | 说明: ${d.explanationZh}${snippetPart}`;
  });

  if (sorted.length > limited.length) {
    lines.push(`...（其余 ${sorted.length - limited.length} 条诊断已省略）`);
  }

  return `## 结构化编译诊断 (CompileDiagnostics)\n${lines.join('\n')}`;
}

function formatLogExcerptSection(rawLogExcerpt: string | undefined): string {
  if (!rawLogExcerpt || !rawLogExcerpt.trim()) {
    return '';
  }
  let text = rawLogExcerpt.trim();
  if (text.length > MAX_LOG_EXCERPT_CHARS) {
    text = `...(前文日志已截断)\n${text.slice(-MAX_LOG_EXCERPT_CHARS)}`;
  }
  return `## 原始编译日志片段 (Raw Log Excerpt)\n\`\`\`\n${text}\n\`\`\``;
}

function formatLineRangeZh(range: LatexLineRange): string {
  return range.startLine === range.endLine
    ? `第 ${range.startLine} 行`
    : `第 ${range.startLine}–${range.endLine} 行`;
}

function formatLineRangesListZh(ranges: LatexLineRange[]): string {
  return ranges.map(formatLineRangeZh).join('、');
}

function formatStructuralAutoScanSection(
  mode: AiFixMode,
  window: PreparedPromptWindow,
): string {
  if (
    (mode !== 'format-table' && mode !== 'format-math') ||
    window.detectedBlocks === undefined
  ) {
    return '';
  }

  const kindLabel = mode === 'format-table' ? '表格' : '数学公式';
  const errorExamples =
    mode === 'format-table'
      ? '多余或缺失的 `&`、缺失行尾 `\\\\`、未闭合的 `\\end{tabular}` / `\\end{table}`、未转义的 `%`/`_`/`#`、列格式与单元格数不匹配、破损的 `\\multicolumn` 等'
      : '未闭合的 `\\begin{align}` / `\\begin{equation}` / `\\[` / `$$`、不配对的 `\\left`/`\\right`（如缺少 `\\right.`）、花括号不配对、错误数学模式触发、缺失行尾 `\\\\` 或错位 `&` 等';

  const detected = window.detectedBlocks;
  const focused = window.focusedBlocks ?? [];

  if (!window.isWindowed) {
    if (detected.length > 0) {
      return [
        '## 自动扫描定位指令（整篇文件自动定位模式）',
        `- 已自动扫描整篇文件，发现 ${detected.length} 处${kindLabel}区域：${formatLineRangesListZh(detected)}。`,
        `- 若上方存在编译诊断或编译日志，请优先修复${kindLabel}内部的所有编译与语法错误（如${errorExamples}），并同时完成规范化排版整理。`,
        `- 必须保证上述${kindLabel}环境之外的每一行正文、标题、注释与导言区内容 100% 逐字保持原样，绝不改写！`,
      ].join('\n');
    }
    return [
      '## 自动扫描定位指令（整篇文件自动定位模式）',
      `- 已自动扫描整篇文件，暂未通过静态规则匹配到标准${kindLabel}环境；请通读全文排查是否存在残破、缺少 \`\\begin\`/\`\\end\` 或自定义宏封装的${kindLabel}区域，并结合编译诊断进行修复与整理。`,
      `- 若全文确实不包含任何${kindLabel}内容，请保持原文逐字不变并在 warningsZh 中向用户说明。`,
    ].join('\n');
  }

  if (window.diagnosticFocused && focused.length > 0) {
    const lines = [
      '## 自动扫描定位指令（长文件诊断定位窗口模式）',
      `- 全文件共 ${window.totalLines} 行，已自动扫描定位到 ${detected.length} 处${kindLabel}区域（${formatLineRangesListZh(detected)}）。`,
      `- 编译诊断命中以下${kindLabel}区域：${formatLineRangesListZh(focused)}，已自动将可编辑窗口精准聚焦至第 ${window.startLine}–${window.endLine} 行（并附带只读导言区上下文）。`,
      `- 请优先修复窗口内该${kindLabel}的所有编译与语法错误（如${errorExamples}）并规范化排版；窗口内${kindLabel}环境之外的其余行必须 100% 逐字保持原样！`,
    ];
    if (window.hasOmittedOutsideBlocks) {
      lines.push(
        `- 说明：文件其余位置还有其他${kindLabel}区域位于当前窗口外，系统会自动原样保留，请仅输出第 ${window.startLine}–${window.endLine} 行的完整修复结果。`,
      );
    }
    return lines.join('\n');
  }

  if (focused.length > 0) {
    const lines = [
      '## 自动扫描定位指令（长文件结构定位窗口模式）',
      `- 全文件共 ${window.totalLines} 行，已自动扫描定位到 ${detected.length} 处${kindLabel}区域（${formatLineRangesListZh(detected)}）。`,
      `- 当前可编辑窗口（第 ${window.startLine}–${window.endLine} 行）聚焦处理以下${kindLabel}区域：${formatLineRangesListZh(focused)}。`,
      `- 请修复并规范化整理上述${kindLabel}区域（如存在语法或编译错误请优先修复），同时保证窗口内${kindLabel}环境之外的每一行 100% 逐字保持原样！`,
    ];
    if (window.hasOmittedOutsideBlocks) {
      lines.push(
        `- 说明：全文件${kindLabel}分布跨度超过 ${STRUCTURAL_MAX_CLUSTER_SPAN_LINES} 行，本次优先聚焦上述首个/未闭合异常簇；窗口外的其余${kindLabel}区域将由系统自动原样保留，如需继续处理可在编辑器中框选对应区域后再次触发。`,
      );
    }
    return lines.join('\n');
  }

  return [
    '## 自动扫描定位指令（长文件诊断回退窗口模式）',
    `- 全文件共 ${window.totalLines} 行，未通过静态规则匹配到标准${kindLabel}环境，已依据编译诊断自动聚焦至第 ${window.startLine}–${window.endLine} 行。`,
    `- 请检查该窗口内是否存在拼写错误或残破的${kindLabel}环境并完成修复，窗口内非${kindLabel}正文请 100% 逐字保持原样。`,
  ].join('\n');
}

/**
 * Builds the Chinese+English system prompt, bounded user prompt, and splice
 * metadata for any of the 4 supported `AiFixMode`s.
 */
export function buildAiPrompt(request: AiFixRequest): BuiltAiPrompt {
  const modePrompt = MODE_INSTRUCTIONS[request.mode];
  if (!modePrompt) {
    throw new Error(`不支持的 AI 修复模式：${String(request.mode)}`);
  }

  const window = extractTargetWindow(request);

  const systemPrompt = [
    modePrompt,
    '',
    ANTI_REWRITE_GUARDRAIL,
    '',
    JSON_CONTRACT,
  ].join('\n');

  const sections: string[] = [
    `## 目标文件信息`,
    `- 文件路径: ${request.filePath}`,
    `- 修复模式: ${request.mode}`,
    `- 总行数: ${window.totalLines}`,
  ];

  if (window.isWindowed) {
    sections.push(
      `- 编辑范围: 仅第 ${window.startLine} 行至第 ${window.endLine} 行（窗口化精准拼接模式）`,
      `- 重要要求: patchedCode 必须且只能包含第 ${window.startLine}-${window.endLine} 行修复后的完整代码，严禁把下方只读导言区内容拼进 patchedCode！`,
    );
  } else {
    sections.push(`- 编辑范围: 全文件（第 1-${window.totalLines} 行）`);
  }

  const autoScanSection = formatStructuralAutoScanSection(request.mode, window);
  if (autoScanSection) {
    sections.push(`\n${autoScanSection}`);
  }

  if (request.userNote && request.userNote.trim()) {
    sections.push(`\n## 用户补充说明\n${request.userNote.trim()}`);
  }

  const diagSection = formatDiagnosticsSection(request.diagnostics, request.filePath);
  if (diagSection) {
    sections.push(`\n${diagSection}`);
  }

  const logSection = formatLogExcerptSection(request.rawLogExcerpt);
  if (logSection) {
    sections.push(`\n${logSection}`);
  }

  if (window.isWindowed && window.preambleContext && window.preambleRange) {
    sections.push(
      `\n## 只读导言区上下文（第 ${window.preambleRange.startLine}-${window.preambleRange.endLine} 行，仅供参考，严禁输出到 patchedCode）\n\`\`\`latex\n${window.preambleContext}\n\`\`\``,
    );
  }

  const codeHeading = window.isWindowed
    ? `## 待修复可编辑窗口（第 ${window.startLine}-${window.endLine} 行 — patchedCode 仅返回此区间的完整修复结果）`
    : `## 待修复完整源码（${request.filePath}）`;

  sections.push(`\n${codeHeading}\n\`\`\`latex\n${window.editableCode}\n\`\`\``);

  return {
    systemPrompt,
    userPrompt: sections.join('\n'),
    window,
  };
}
