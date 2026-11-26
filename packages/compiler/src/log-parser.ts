import fs from 'node:fs';
import path from 'node:path';
import {
  resolveInsideWorkspace,
  type CompileDiagnostic,
  type DiagnosticSeverity,
} from '@novatex/shared';

interface ClassifiedDiagnostic {
  severity: DiagnosticSeverity;
  code: string;
  titleZh: string;
  explanationZh: string;
  quickFixHintZh: string;
}

interface RawParsedEntry {
  file: string;
  line: number;
  column?: number;
  rawMessage: string;
  contextLine?: string;
  forcedSeverity?: DiagnosticSeverity;
  order: number;
}

const FILE_LINE_ERROR_RE =
  /^((?:[a-zA-Z]:[\\/])?[^:\r\n]+?\.[a-zA-Z0-9]{1,8}):(\d+):\s*(.+)$/;

const TEX_FILE_IN_PAREN_RE =
  /^((?:[a-zA-Z]:[\\/]|\/|\.\.?[\\/])?[^\s()]+?\.(?:tex|sty|cls|bib|bbl|aux|ltx|dtx|def|cfg|clo|fd))(?=$|\s|\))/i;

const LINE_NUMBER_RE = /^l\.(\d+)(?:\s*(.*))?$/;
const ON_INPUT_LINE_RE = /on input line (\d+)/i;
const OVERFULL_HBOX_RE =
  /^(Overfull|Underfull)\s+\\(hbox|vbox)\s+\(([^)]+)\)\s+.*?(?:at lines?\s+(\d+)(?:--(\d+))?|detected at line\s+(\d+))/i;
const LATEX_WARNING_RE =
  /^(LaTeX|LaTeX Font|Package\s+([^\s]+)|Class\s+([^\s]+))\s+Warning:\s*(.*)$/;

function isSystemTexPath(p: string): boolean {
  const lower = p.replace(/\\/g, '/').toLowerCase();
  return (
    lower.includes('/texmf-dist/') ||
    lower.includes('/texmf-var/') ||
    lower.includes('/tinytex/texmf') ||
    lower.includes('/texlive/') ||
    lower.includes('/miktex/')
  );
}

/**
 * Normalize a raw file path from TeX logs to a clean POSIX relative path
 * (e.g. `main.tex` or `sections/method.tex`).
 */
export function normalizeLogFilePath(rawPath: string, workspaceRoot?: string): string {
  let cleaned = rawPath.trim().replace(/^["']|["']$/g, '');
  if (!cleaned) return '';

  // Handle Windows paths & collapse separators
  const posixRaw = cleaned.replace(/\\/g, '/').replace(/\/+/g, '/');

  // If absolute and workspaceRoot is provided, relativize against workspaceRoot
  const isAbs = /^[a-zA-Z]:\//.test(posixRaw) || posixRaw.startsWith('/');
  if (isAbs && workspaceRoot) {
    const resolvedRoot = path.resolve(workspaceRoot).replace(/\\/g, '/').replace(/\/+$/, '');
    const lowerRaw = posixRaw.toLowerCase();
    const lowerRoot = resolvedRoot.toLowerCase();
    if (lowerRaw.startsWith(lowerRoot + '/')) {
      cleaned = posixRaw.slice(resolvedRoot.length + 1);
    } else {
      // Also check realpath in case of Windows short paths or symlinks
      try {
        if (fs.existsSync(workspaceRoot)) {
          const realRoot = fs.realpathSync(workspaceRoot).replace(/\\/g, '/').replace(/\/+$/, '');
          if (lowerRaw.startsWith(realRoot.toLowerCase() + '/')) {
            cleaned = posixRaw.slice(realRoot.length + 1);
          } else {
            cleaned = posixRaw;
          }
        } else {
          cleaned = posixRaw;
        }
      } catch {
        cleaned = posixRaw;
      }
    }
  } else {
    cleaned = posixRaw;
  }

  // Strip embedded `/./` boundary marker from TeX output
  const dotBoundary = cleaned.lastIndexOf('/./');
  if (dotBoundary >= 0) {
    cleaned = cleaned.slice(dotBoundary + 3);
  }

  // Strip leading `./`
  cleaned = cleaned.replace(/^(?:\.\/)+/, '');
  return cleaned;
}

/**
 * Update balanced paren stack to track the currently open project TeX source file.
 */
function updateFileStack(
  line: string,
  stack: Array<string | null>,
  workspaceRoot?: string,
): void {
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '(') {
      const rest = line.slice(i + 1);
      const match = TEX_FILE_IN_PAREN_RE.exec(rest);
      if (match && match[1]) {
        const raw = match[1];
        if (!isSystemTexPath(raw)) {
          stack.push(normalizeLogFilePath(raw, workspaceRoot));
        } else {
          stack.push(null);
        }
      } else {
        stack.push(null);
      }
    } else if (ch === ')') {
      if (stack.length > 0) {
        stack.pop();
      }
    }
  }
}

function getCurrentFileFromStack(stack: Array<string | null>): string {
  for (let i = stack.length - 1; i >= 0; i--) {
    const candidate = stack[i];
    if (candidate) {
      return candidate;
    }
  }
  return '';
}

function extractUndefinedCommand(rawMessage: string, contextLine?: string): string | null {
  const fromMsg = /Undefined control sequence\.?\s*(\\[a-zA-Z@]+|\\.)?/.exec(rawMessage);
  if (fromMsg && fromMsg[1]) return fromMsg[1];
  if (contextLine) {
    // TeX typically breaks the `l.N ...` line right after the undefined control sequence
    const trimmed = contextLine.trimEnd();
    const endCmdMatch = /(\\[a-zA-Z@]+|\\[^a-zA-Z\s])\s*$/.exec(trimmed);
    if (endCmdMatch && endCmdMatch[1]) return endCmdMatch[1];
    // Fallback when arguments remain on the same line (e.g. `l.42 \unknownmacro{hello}`)
    const allCmds = trimmed.match(/\\[a-zA-Z@]+/g);
    if (allCmds && allCmds.length > 0) {
      return allCmds[allCmds.length - 1] ?? null;
    }
  }
  return null;
}

function classifyDiagnostic(
  rawMessage: string,
  contextLine?: string,
  forcedSeverity?: DiagnosticSeverity,
): ClassifiedDiagnostic {
  const msg = rawMessage.trim();

  // 1. CJK / XeLaTeX engine requirement
  if (
    /requires\s+(?:either\s+)?XeTeX(?:\s+or\s+LuaTeX)?/i.test(msg) ||
    /Cannot be used with pdfTeX/i.test(msg) ||
    /Package\s+(?:fontspec|xeCJK|ctex)\s+Error/i.test(msg) ||
    /Critical\s+Package\s+ctex\s+Error/i.test(msg) ||
    /Fatal\s+Package\s+fontspec\s+Error/i.test(msg) ||
    (/Unicode character\s+.*?\(U\+([0-9A-F]{4,6})\)/i.test(msg) &&
      (() => {
        const m = /\(U\+([0-9A-F]{4,6})\)/i.exec(msg);
        if (!m || !m[1]) return false;
        const cp = parseInt(m[1], 16);
        return (
          (cp >= 0x3000 && cp <= 0x9fff) ||
          (cp >= 0xf900 && cp <= 0xfaff) ||
          (cp >= 0xff00 && cp <= 0xffef)
        );
      })()) ||
    /Missing character: There is no [\u3000-\u9fff\uf900-\ufaff\uff00-\uffef]/.test(msg)
  ) {
    return {
      severity: forcedSeverity ?? 'error',
      code: 'CJK_NEEDS_XELATEX',
      titleZh: '中文或字体宏包需要 XeLaTeX 引擎',
      explanationZh:
        '当前文档使用了中文字符或 fontspec/xeCJK/ctex 等 Unicode 字体宏包，pdfLaTeX 无法直接处理。',
      quickFixHintZh: '请在项目编译设置中将编译引擎切换为 XeLaTeX（xelatex）后重新编译。',
    };
  }

  // 2. Missing package / file not found
  const missingFileMatch =
    /File [`'"]([^`'"]+)[`'"] not found/i.exec(msg) ??
    /I can't find file [`'"]([^`'"]+)[`'"]/i.exec(msg);
  if (missingFileMatch) {
    const missingFile = missingFileMatch[1] ?? '未知文件';
    const isSty = missingFile.endsWith('.sty') || missingFile.endsWith('.cls');
    return {
      severity: forcedSeverity ?? 'error',
      code: 'MISSING_PACKAGE',
      titleZh: isSty ? `缺少宏包或文档类：${missingFile}` : `找不到文件：${missingFile}`,
      explanationZh: isSty
        ? `编译器未能在当前 TeX 发行版中找到 ${missingFile}，可能是宏包名拼写错误或环境中未安装该宏包。`
        : `文档中引用的文件 ${missingFile} 不存在或相对路径有误。`,
      quickFixHintZh: isSty
        ? `请核对 \\usepackage / \\documentclass 名称拼写，或在 TeX 环境中安装对应宏包（如 tlmgr install ${missingFile.replace(/\.(sty|cls)$/i, '')}）。`
        : `请检查项目目录中是否存在 ${missingFile}，并确认路径大小写与相对路径正确。`,
    };
  }

  // 3. Environment mismatch
  const envMismatch =
    /\\begin\{([^}]+)\}(?:\s+on input line \d+)?\s+ended by\s+\\end\{([^}]+)\}/i.exec(msg);
  if (envMismatch) {
    const startEnv = envMismatch[1] ?? '';
    const endEnv = envMismatch[2] ?? '';
    return {
      severity: forcedSeverity ?? 'error',
      code: 'ENV_MISMATCH',
      titleZh: `环境不匹配：\\begin{${startEnv}} 与 \\end{${endEnv}}`,
      explanationZh: `以 \\begin{${startEnv}} 打开的环境在结束时遇到了 \\end{${endEnv}}，可能是漏写了 \\end{${startEnv}} 或环境名拼写不一致。`,
      quickFixHintZh: `请将结束标签改为 \\end{${startEnv}}，或补齐内部缺失的 \\end{...} 配对。`,
    };
  }
  const envUndefined = /Environment\s+([^\s]+)\s+undefined/i.exec(msg);
  if (envUndefined) {
    const envName = envUndefined[1] ?? '';
    return {
      severity: forcedSeverity ?? 'error',
      code: 'ENV_MISMATCH',
      titleZh: `未定义的环境：${envName}`,
      explanationZh: `使用了未定义的 LaTeX 环境 ${envName}，通常是因为缺少对应宏包（如 amsmath、algorithm2e 等）或环境名拼写错误。`,
      quickFixHintZh: `请检查环境名 ${envName} 的拼写，并在导言区引入定义该环境的宏包。`,
    };
  }

  // 4. Undefined control sequence
  if (/Undefined control sequence/i.test(msg)) {
    const cmd = extractUndefinedCommand(msg, contextLine);
    return {
      severity: forcedSeverity ?? 'error',
      code: 'UNDEFINED_CONTROL_SEQUENCE',
      titleZh: cmd ? `未定义的命令：${cmd}` : '未定义的控制序列（命令）',
      explanationZh: cmd
        ? `LaTeX 无法识别命令 ${cmd}，常见原因是命令拼写错误、忘记加载所需宏包，或自定义命令未定义。`
        : 'LaTeX 遇到了无法识别的命令，常见原因是拼写错误或未引入对应宏包。',
      quickFixHintZh: cmd
        ? `请检查 ${cmd} 的拼写，或在导言区通过 \\usepackage{...} 加载提供该命令的宏包。`
        : '请查看出错行附近的反斜杠命令，核对拼写并确认已加载对应宏包。',
    };
  }

  // 5. Missing $ / math mode errors
  if (
    /Missing \$ inserted/i.test(msg) ||
    /Display math should end with \$\$/i.test(msg) ||
    /Bad math environment delimiter/i.test(msg) ||
    /You can't use .* in (?:vertical|horizontal) mode/i.test(msg)
  ) {
    return {
      severity: forcedSeverity ?? 'error',
      code: 'MISSING_MATH_DOLLAR',
      titleZh: '缺少数学模式分隔符 $',
      explanationZh:
        '在普通文本中使用了下标 _、上标 ^ 或数学符号命令，但未用 $...$ 或数学环境包裹；也可能是文本中的下划线未转义为 \\_。',
      quickFixHintZh:
        '如果是数学公式请用 $...$ 包裹；如果只是普通文本中的下划线/上标符号，请改写为 \\_ 或 \\^{}。',
    };
  }

  // 6. Missing / extra brace or runaway argument
  if (
    /Extra \}, or forgotten \$/i.test(msg) ||
    /Missing \} inserted/i.test(msg) ||
    /Missing \{ inserted/i.test(msg) ||
    /Too many \}'s/i.test(msg) ||
    /Runaway argument\?/i.test(msg)
  ) {
    const isRunaway = /Runaway argument\?/i.test(msg);
    return {
      severity: forcedSeverity ?? 'error',
      code: 'MISSING_BRACE',
      titleZh: isRunaway ? '参数未闭合（可能缺少右花括号 }）' : '花括号 { } 不匹配',
      explanationZh: isRunaway
        ? '某个命令的参数跨段未结束，通常是因为漏写了闭合的右花括号 }。'
        : '当前行存在多余或缺失的花括号 { }，或花括号内遗漏了成对的数学符号 $。',
      quickFixHintZh: '请检查该行及上方几行的 { 与 } 是否成对闭合，并排查是否漏掉闭合的 $。',
    };
  }

  // 7. Undefined citation
  const citeMatch = /Citation [`'"]([^`'"]+)[`'"].*undefined/i.exec(msg);
  if (citeMatch) {
    const citeKey = citeMatch[1] ?? '';
    return {
      severity: forcedSeverity ?? 'warning',
      code: 'UNDEFINED_CITATION',
      titleZh: `未定义的文献引用：${citeKey}`,
      explanationZh: `引用的文献条目 "${citeKey}" 在 .bib 文献库中未找到，或尚未完成 BibTeX/Biber 交叉编译。`,
      quickFixHintZh: `请核对 .bib 文件中是否存在条目 ${citeKey}，确认 \\bibliography / \\addbibresource 路径无误后重新编译。`,
    };
  }

  // 8. Undefined reference / duplicate label
  const refMatch = /Reference [`'"]([^`'"]+)[`'"].*undefined/i.exec(msg);
  if (refMatch) {
    const refKey = refMatch[1] ?? '';
    return {
      severity: forcedSeverity ?? 'warning',
      code: 'UNDEFINED_REF',
      titleZh: `未定义的交叉引用：${refKey}`,
      explanationZh: `引用的标签 "${refKey}" 尚未定义，可能是 \\label{${refKey}} 拼写不一致、尚未添加，或需要再次编译更新 .aux。`,
      quickFixHintZh: `请确认文档中存在对应的 \\label{${refKey}} 且拼写完全一致，然后重新编译一次。`,
    };
  }
  const dupLabelMatch = /Label [`'"]([^`'"]+)[`'"] multiply defined/i.exec(msg);
  if (dupLabelMatch) {
    const labelKey = dupLabelMatch[1] ?? '';
    return {
      severity: forcedSeverity ?? 'warning',
      code: 'UNDEFINED_REF',
      titleZh: `重复定义的标签：${labelKey}`,
      explanationZh: `标签 "${labelKey}" 在文档中被定义了多次，交叉引用可能指向错误位置。`,
      quickFixHintZh: `请搜索 \\label{${labelKey}} 并为重复的图表或章节分配唯一标签名。`,
    };
  }

  // 9. Overfull / Underfull box
  const boxMatch = OVERFULL_HBOX_RE.exec(msg);
  if (boxMatch) {
    const kind = boxMatch[1] ?? 'Overfull';
    const axis = boxMatch[2] ?? 'hbox';
    const detail = boxMatch[3] ?? '';
    const isOver = kind.toLowerCase() === 'overfull';
    return {
      severity: forcedSeverity ?? 'warning',
      code: 'OVERFULL_HBOX',
      titleZh: isOver
        ? `排版溢出（${kind} \\${axis}：${detail}）`
        : `排版过松（${kind} \\${axis}：${detail}）`,
      explanationZh: isOver
        ? `该处内容超出页面边界（${detail}），常见于过长的公式、无空格 URL、宽表格或不可断行单词。`
        : `该处行距或字距偏松（${detail}），可能影响版面美观。`,
      quickFixHintZh: isOver
        ? '可尝试折行长公式、用 \\url{...} 包裹链接、缩小表格宽度（\\resizebox / tabularx）或微调用词。'
        : '可检查是否使用了多余的强制换行 \\\\，改用空行分段。',
    };
  }

  // 10. Package / Class / LaTeX warnings
  if (forcedSeverity === 'warning' || /\bWarning:/i.test(msg)) {
    const pkgWarn = /Package\s+([^\s]+)\s+Warning:\s*(.*)/i.exec(msg);
    if (pkgWarn) {
      const pkgName = pkgWarn[1] ?? '宏包';
      return {
        severity: 'warning',
        code: 'PACKAGE_WARNING',
        titleZh: `宏包警告（${pkgName}）`,
        explanationZh: `宏包 ${pkgName} 报告了警告：${pkgWarn[2] ?? msg}`,
        quickFixHintZh: `请根据 ${pkgName} 提示检查对应位置的命令参数或宏包选项。`,
      };
    }
    return {
      severity: 'warning',
      code: 'LATEX_WARNING',
      titleZh: 'LaTeX 编译警告',
      explanationZh: `编译器发出警告：${msg}`,
      quickFixHintZh: '警告通常不会阻止生成 PDF，建议按提示检查排版或引用状态。',
    };
  }

  // 11. Emergency stop
  if (/Emergency stop/i.test(msg)) {
    return {
      severity: forcedSeverity ?? 'error',
      code: 'GENERIC_LATEX_ERROR',
      titleZh: '编译紧急中止（Emergency stop）',
      explanationZh: 'LaTeX 遇到致命错误而被迫中止编译，通常由上方第一条致命错误（如缺失文件或严重语法错）引发。',
      quickFixHintZh: '请优先修复位于本条之前的第一个编译错误，再重新编译。',
    };
  }

  // 12. Package specific error (e.g. biblatex)
  const pkgErr = /Package\s+([^\s]+)\s+Error:\s*(.*)/i.exec(msg);
  if (pkgErr) {
    const pkgName = pkgErr[1] ?? '宏包';
    return {
      severity: forcedSeverity ?? 'error',
      code: 'GENERIC_LATEX_ERROR',
      titleZh: `宏包错误（${pkgName}）`,
      explanationZh: `宏包 ${pkgName} 报错：${pkgErr[2] ?? msg}`,
      quickFixHintZh: `请检查 ${pkgName} 相关配置、命令参数及依赖的辅助文件是否完整。`,
    };
  }

  // Default fallback
  return {
    severity: forcedSeverity ?? 'error',
    code: 'GENERIC_LATEX_ERROR',
    titleZh: 'LaTeX 编译错误',
    explanationZh: `编译器报告错误：${msg}`,
    quickFixHintZh: '请检查出错行附近的语法、命令拼写与符号配对。',
  };
}

/**
 * Safely extract a 3-line source context snippet around `line` from a file inside `workspaceRoot`.
 */
function extractSnippet(
  workspaceRoot: string | undefined,
  relFile: string,
  line: number,
  fileLinesCache: Map<string, string[] | null>,
): string | undefined {
  if (!workspaceRoot || !relFile || line <= 0) {
    return undefined;
  }

  let cached = fileLinesCache.get(relFile);
  if (cached === undefined) {
    cached = null;
    try {
      const { absPath } = resolveInsideWorkspace(workspaceRoot, relFile);
      if (fs.existsSync(absPath)) {
        const stat = fs.statSync(absPath);
        if (stat.isFile() && stat.size <= 5 * 1024 * 1024) {
          const content = fs.readFileSync(absPath, 'utf8');
          cached = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
        }
      }
    } catch {
      cached = null;
    }
    fileLinesCache.set(relFile, cached);
  }

  if (!cached || cached.length === 0 || line > cached.length) {
    return undefined;
  }

  const total = cached.length;
  let start = Math.max(1, line - 1);
  let end = Math.min(total, line + 1);
  // Keep 3 lines whenever file has >= 3 lines
  if (end - start < 2 && total >= 3) {
    if (start === 1) {
      end = 3;
    } else if (end === total) {
      start = total - 2;
    }
  }

  const width = String(end).length;
  const out: string[] = [];
  for (let ln = start; ln <= end; ln++) {
    const marker = ln === line ? '>' : ' ';
    const numStr = String(ln).padStart(width, ' ');
    out.push(`${marker} ${numStr} | ${cached[ln - 1] ?? ''}`);
  }
  return out.join('\n');
}

function lookAheadForErrorContext(
  lines: string[],
  startIndex: number,
): { lineNumber: number | null; contextLine?: string; extraMessage: string } {
  let lineNumber: number | null = null;
  let contextLine: string | undefined;
  const extraParts: string[] = [];

  const maxLookAhead = Math.min(lines.length, startIndex + 12);
  for (let j = startIndex + 1; j < maxLookAhead; j++) {
    const next = lines[j] ?? '';
    const trimmed = next.trim();

    // Stop if another error or warning starts
    if (
      trimmed.startsWith('! ') ||
      FILE_LINE_ERROR_RE.test(next) ||
      OVERFULL_HBOX_RE.test(trimmed) ||
      LATEX_WARNING_RE.test(trimmed)
    ) {
      break;
    }

    const lineMatch = LINE_NUMBER_RE.exec(next);
    if (lineMatch && lineMatch[1]) {
      lineNumber = parseInt(lineMatch[1], 10);
      contextLine = lineMatch[2] ?? '';
      break;
    }

    // Stop at standard interactive prompt hint
    if (
      trimmed.startsWith('See the LaTeX manual') ||
      trimmed.startsWith('Type  H <return>') ||
      trimmed === ''
    ) {
      if (trimmed === '' && extraParts.length > 0) {
        // Keep scanning a bit for `l.N`, since LaTeX inserts blank lines before `l.N`
        continue;
      }
      continue;
    }

    // Capture wrapped error continuation lines (e.g. "ended by \end{equation}." or "(biblatex) ...")
    if (
      lineNumber === null &&
      extraParts.length < 2 &&
      !trimmed.startsWith('...') &&
      !/^<\w/.test(trimmed) &&
      (trimmed.startsWith('ended by ') ||
        /^\([a-zA-Z0-9_-]+\)\s+/.test(trimmed) ||
        /^on input line \d+/i.test(trimmed))
    ) {
      extraParts.push(trimmed);
    }
  }

  return {
    lineNumber,
    contextLine,
    extraMessage: extraParts.join(' '),
  };
}

/**
 * Parse a raw TeX / LaTeX / XeLaTeX / LuaLaTeX compilation log into structured,
 * deduplicated, Chinese-annotated diagnostics.
 */
export function parseLatexLog(rawLog: string, workspaceRoot?: string): CompileDiagnostic[] {
  if (!rawLog || typeof rawLog !== 'string') {
    return [];
  }

  const lines = rawLog.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const fileStack: Array<string | null> = [];
  const rawEntries: RawParsedEntry[] = [];
  let order = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();

    // 1. `-file-line-error` format: `./main.tex:42: Undefined control sequence.`
    const fleMatch = FILE_LINE_ERROR_RE.exec(line);
    if (fleMatch && fleMatch[1] && fleMatch[2] && fleMatch[3]) {
      const candidatePath = fleMatch[1].trim();
      // Guard against URLs like `https://...` or log prefixes
      if (!/^https?$/i.test(candidatePath)) {
        const normalizedFile = normalizeLogFilePath(candidatePath, workspaceRoot);
        const lineNum = parseInt(fleMatch[2], 10);
        const baseMsg = fleMatch[3].trim();
        const look = lookAheadForErrorContext(lines, i);
        const fullMsg = look.extraMessage ? `${baseMsg} ${look.extraMessage}` : baseMsg;
        const isWarn = /\bWarning:/i.test(fullMsg);

        rawEntries.push({
          file: normalizedFile,
          line: lineNum,
          rawMessage: fullMsg,
          contextLine: look.contextLine,
          forcedSeverity: isWarn ? 'warning' : 'error',
          order: order++,
        });
        continue;
      }
    }

    // 2. Classic `! ...` TeX/LaTeX/Package error (or `! Package ... Warning:`)
    if (line.startsWith('! ')) {
      const baseMsg = line.slice(2).trim();
      const look = lookAheadForErrorContext(lines, i);
      const fullMsg = look.extraMessage ? `${baseMsg} ${look.extraMessage}` : baseMsg;

      let lineNum = look.lineNumber ?? 0;
      if (lineNum === 0) {
        const inlineMatch = ON_INPUT_LINE_RE.exec(fullMsg);
        if (inlineMatch && inlineMatch[1]) {
          lineNum = parseInt(inlineMatch[1], 10);
        }
      }

      const isWarn = /\bWarning:/i.test(fullMsg);
      rawEntries.push({
        file: getCurrentFileFromStack(fileStack),
        line: lineNum,
        rawMessage: fullMsg,
        contextLine: look.contextLine,
        forcedSeverity: isWarn ? 'warning' : 'error',
        order: order++,
      });
      continue;
    }

    // 3. Overfull / Underfull \hbox / \vbox warnings
    const boxMatch = OVERFULL_HBOX_RE.exec(trimmed);
    if (boxMatch) {
      const lineNum = parseInt(boxMatch[4] ?? boxMatch[6] ?? '0', 10);
      // Only surface Overfull boxes as warnings by default (Underfull noise is skipped unless Overfull)
      if ((boxMatch[1] ?? '').toLowerCase() === 'overfull') {
        rawEntries.push({
          file: getCurrentFileFromStack(fileStack),
          line: lineNum,
          rawMessage: trimmed,
          forcedSeverity: 'warning',
          order: order++,
        });
      }
      continue;
    }

    // 4. LaTeX / Package / Class Warning
    const warnMatch = LATEX_WARNING_RE.exec(trimmed);
    if (warnMatch) {
      let fullWarn = trimmed;
      const pkgOrClass = warnMatch[2] ?? warnMatch[3];
      // Fold multi-line `(pkg)   continuation...` lines
      let k = i + 1;
      while (k < lines.length) {
        const cont = lines[k] ?? '';
        if (pkgOrClass && cont.startsWith(`(${pkgOrClass})`)) {
          fullWarn += ' ' + cont.slice(pkgOrClass.length + 2).trim();
          k++;
        } else if (
          !pkgOrClass &&
          /^\s+/.test(cont) &&
          cont.trim().length > 0 &&
          !cont.trim().startsWith('! ') &&
          !FILE_LINE_ERROR_RE.test(cont) &&
          !LATEX_WARNING_RE.test(cont.trim())
        ) {
          fullWarn += ' ' + cont.trim();
          k++;
        } else {
          break;
        }
      }
      i = k - 1;

      // Skip purely generic summary lines when specific warnings exist, or keep meaningful warnings
      if (
        /^LaTeX Warning:\s*There were undefined (?:references|citations)\.?$/i.test(fullWarn) ||
        /^LaTeX Warning:\s*Label\(s\) may have changed\./i.test(fullWarn)
      ) {
        continue;
      }

      const inlineLineMatch = ON_INPUT_LINE_RE.exec(fullWarn);
      const lineNum = inlineLineMatch && inlineLineMatch[1] ? parseInt(inlineLineMatch[1], 10) : 0;

      rawEntries.push({
        file: getCurrentFileFromStack(fileStack),
        line: lineNum,
        rawMessage: fullWarn,
        forcedSeverity: 'warning',
        order: order++,
      });
      continue;
    }

    // 5. Missing CJK character warning emitted by pdfTeX/XeTeX
    if (trimmed.startsWith('Missing character: There is no ')) {
      if (/[\u3000-\u9fff\uf900-\ufaff\uff00-\uffef]/.test(trimmed)) {
        rawEntries.push({
          file: getCurrentFileFromStack(fileStack),
          line: 0,
          rawMessage: trimmed,
          forcedSeverity: 'warning',
          order: order++,
        });
      }
      continue;
    }

    // Update file stack for normal log lines
    updateFileStack(line, fileStack, workspaceRoot);
  }

  // Classify, extract snippets, and deduplicate
  const fileLinesCache = new Map<string, string[] | null>();
  const seenKeys = new Set<string>();
  const intermediate: Array<{ diag: Omit<CompileDiagnostic, 'id'>; order: number }> = [];

  for (const entry of rawEntries) {
    const classified = classifyDiagnostic(
      entry.rawMessage,
      entry.contextLine,
      entry.forcedSeverity,
    );
    const dedupKey = `${entry.file}|${entry.line}|${classified.code}|${entry.rawMessage}`;
    if (seenKeys.has(dedupKey)) {
      continue;
    }
    seenKeys.add(dedupKey);

    const snippet = extractSnippet(workspaceRoot, entry.file, entry.line, fileLinesCache);

    intermediate.push({
      order: entry.order,
      diag: {
        file: entry.file,
        line: entry.line,
        ...(entry.column !== undefined ? { column: entry.column } : {}),
        severity: classified.severity,
        code: classified.code,
        titleZh: classified.titleZh,
        explanationZh: classified.explanationZh,
        quickFixHintZh: classified.quickFixHintZh,
        rawMessage: entry.rawMessage,
        ...(snippet !== undefined ? { snippet } : {}),
      },
    });
  }

  // Sort errors before warnings before info, preserving file/line/appearance stability
  const severityRank: Record<DiagnosticSeverity, number> = {
    error: 0,
    warning: 1,
    info: 2,
  };

  intermediate.sort((a, b) => {
    const sevDiff = severityRank[a.diag.severity] - severityRank[b.diag.severity];
    if (sevDiff !== 0) return sevDiff;
    if (a.diag.file !== b.diag.file) return a.diag.file.localeCompare(b.diag.file);
    if (a.diag.line !== b.diag.line) return a.diag.line - b.diag.line;
    return a.order - b.order;
  });

  return intermediate.map((item, idx) => ({
    id: `diag-${idx + 1}`,
    ...item.diag,
  }));
}
