import {
  PathSecurityError,
  computeLineDiff,
  normalizeProjectRelPath,
  type AcademicTemplateId,
  type SectionMergePreview,
} from '@novatex/shared';

export interface AcademicTemplateDefinition {
  id: AcademicTemplateId;
  name: string;
  description: string;
  recommendedEngine: 'xelatex' | 'pdflatex' | 'lualatex';
  source: string;
}

export const ACADEMIC_TEMPLATES: Record<AcademicTemplateId, AcademicTemplateDefinition> = {
  'lab-report-en': {
    id: 'lab-report-en',
    name: 'Engineering / STEM Lab Report (pdfLaTeX)',
    description:
      'Structured STEM & engineering lab report with course/experiment metadata table, syntax-highlighted code listings, booktabs tables, and hyperref bookmarks.',
    recommendedEngine: 'pdflatex',
    source: `\\documentclass[11pt,a4paper]{article}
\\usepackage[margin=2.4cm]{geometry}
\\usepackage{amsmath,amssymb}
\\usepackage{booktabs,longtable,array}
\\usepackage{graphicx}
\\usepackage{listings}
\\usepackage{xcolor}
\\usepackage[numbers,sort&compress]{natbib}
\\usepackage[colorlinks=true,linkcolor=blue,citecolor=blue,urlcolor=blue]{hyperref}

\\definecolor{novacodebg}{RGB}{248,250,252}
\\definecolor{novacodeframe}{RGB}{226,232,240}
\\definecolor{novacodekw}{RGB}{29,78,216}
\\definecolor{novacodecomment}{RGB}{100,116,139}
\\definecolor{novacodestr}{RGB}{21,128,61}

\\lstset{
  backgroundcolor=\\color{novacodebg},
  frame=single,
  rulecolor=\\color{novacodeframe},
  basicstyle=\\ttfamily\\small,
  keywordstyle=\\color{novacodekw}\\bfseries,
  commentstyle=\\color{novacodecomment}\\itshape,
  stringstyle=\\color{novacodestr},
  numbers=left,
  numberstyle=\\tiny\\color{novacodecomment},
  numbersep=8pt,
  breaklines=true,
  tabsize=2,
  columns=flexible,
  showstringspaces=false
}

\\title{\\Large\\bfseries % NOVATEX_TITLE%}
\\author{% NOVATEX_AUTHOR%}
\\date{\\today}

\\begin{document}
\\maketitle

\\begin{center}
\\begin{tabular}{@{}p{0.22\\textwidth}p{0.72\\textwidth}@{}}
\\toprule
\\textbf{Course} & Engineering / STEM Laboratory \\\\
\\textbf{Experiment} & % NOVATEX_TITLE% \\\\
\\textbf{Author} & % NOVATEX_AUTHOR% \\\\
\\textbf{Date} & \\today \\\\
\\bottomrule
\\end{tabular}
\\end{center}
\\vspace{0.6em}

% NOVATEX_BODY%

% NOVATEX_BIB%
\\end{document}
`,
  },
  'lab-report-zh': {
    id: 'lab-report-zh',
    name: '中文课程实验报告 (ctexart / XeLaTeX)',
    description:
      '高校通用中文课程实验报告模板，内置实验信息表（课程名称/实验项目/姓名/学号/日期）、listings 代码高亮配色与 booktabs 三线表。',
    recommendedEngine: 'xelatex',
    source: `\\documentclass[12pt,a4paper]{ctexart}
\\usepackage[margin=2.4cm]{geometry}
\\usepackage{amsmath,amssymb}
\\usepackage{booktabs,longtable,array}
\\usepackage{graphicx}
\\usepackage{listings}
\\usepackage{xcolor}
\\usepackage[numbers,sort&compress]{natbib}
\\usepackage[colorlinks=true,linkcolor=blue,citecolor=blue,urlcolor=blue]{hyperref}

\\definecolor{novacodebg}{RGB}{248,250,252}
\\definecolor{novacodeframe}{RGB}{226,232,240}
\\definecolor{novacodekw}{RGB}{29,78,216}
\\definecolor{novacodecomment}{RGB}{100,116,139}
\\definecolor{novacodestr}{RGB}{21,128,61}

\\lstset{
  backgroundcolor=\\color{novacodebg},
  frame=single,
  rulecolor=\\color{novacodeframe},
  basicstyle=\\ttfamily\\small,
  keywordstyle=\\color{novacodekw}\\bfseries,
  commentstyle=\\color{novacodecomment}\\itshape,
  stringstyle=\\color{novacodestr},
  numbers=left,
  numberstyle=\\tiny\\color{novacodecomment},
  numbersep=8pt,
  breaklines=true,
  tabsize=2,
  columns=flexible,
  showstringspaces=false
}

\\title{\\Large\\bfseries % NOVATEX_TITLE%}
\\author{% NOVATEX_AUTHOR%}
\\date{\\today}

\\begin{document}
\\maketitle

\\begin{center}
\\begin{tabular}{@{}p{0.20\\textwidth}p{0.74\\textwidth}@{}}
\\toprule
\\textbf{课程名称} & 专业基础实验课程 \\\\
\\textbf{实验项目} & % NOVATEX_TITLE% \\\\
\\textbf{姓名} & % NOVATEX_AUTHOR% \\\\
\\textbf{学号} & 2026000001 \\\\
\\textbf{实验日期} & \\today \\\\
\\bottomrule
\\end{tabular}
\\end{center}
\\vspace{0.6em}

% NOVATEX_BODY%

% NOVATEX_BIB%
\\end{document}
`,
  },
  'tech-report': {
    id: 'tech-report',
    name: 'Technical & Course Project Report (pdfLaTeX)',
    description:
      'Structured technical and course project report featuring table of contents, clean geometry, syntax-highlighted code blocks, booktabs tables, and hyperref.',
    recommendedEngine: 'pdflatex',
    source: `\\documentclass[11pt,a4paper]{article}
\\usepackage[margin=2.5cm]{geometry}
\\usepackage{amsmath,amssymb}
\\usepackage{booktabs,longtable,array}
\\usepackage{graphicx}
\\usepackage{listings}
\\usepackage{xcolor}
\\usepackage[numbers,sort&compress]{natbib}
\\usepackage[colorlinks=true,linkcolor=blue,citecolor=blue,urlcolor=blue]{hyperref}

\\definecolor{novacodebg}{RGB}{248,250,252}
\\definecolor{novacodeframe}{RGB}{226,232,240}
\\definecolor{novacodekw}{RGB}{29,78,216}
\\definecolor{novacodecomment}{RGB}{100,116,139}
\\definecolor{novacodestr}{RGB}{21,128,61}

\\lstset{
  backgroundcolor=\\color{novacodebg},
  frame=single,
  rulecolor=\\color{novacodeframe},
  basicstyle=\\ttfamily\\small,
  keywordstyle=\\color{novacodekw}\\bfseries,
  commentstyle=\\color{novacodecomment}\\itshape,
  stringstyle=\\color{novacodestr},
  numbers=left,
  numberstyle=\\tiny\\color{novacodecomment},
  numbersep=8pt,
  breaklines=true,
  tabsize=2,
  columns=flexible,
  showstringspaces=false
}

\\title{\\Large\\bfseries % NOVATEX_TITLE%}
\\author{% NOVATEX_AUTHOR%}
\\date{\\today}

\\begin{document}
\\maketitle
\\tableofcontents
\\vspace{0.8em}

% NOVATEX_BODY%

% NOVATEX_BIB%
\\end{document}
`,
  },
  'beamer-slides': {
    id: 'beamer-slides',
    name: 'Academic & Lab Presentation Slides (Beamer)',
    description:
      'Crisp 16:9 Beamer presentation deck using the Madrid theme with amsmath, booktabs, listings, and natbib ready for lab demos and talks.',
    recommendedEngine: 'pdflatex',
    source: `\\documentclass[aspectratio=169,11pt]{beamer}
\\usetheme{Madrid}
\\usepackage{amsmath,amssymb}
\\usepackage{booktabs,array}
\\usepackage{graphicx}
\\usepackage{listings}
\\usepackage[numbers,sort&compress]{natbib}

\\definecolor{novacodebg}{RGB}{248,250,252}
\\definecolor{novacodekw}{RGB}{29,78,216}
\\definecolor{novacodecomment}{RGB}{100,116,139}

\\lstset{
  backgroundcolor=\\color{novacodebg},
  basicstyle=\\ttfamily\\footnotesize,
  keywordstyle=\\color{novacodekw}\\bfseries,
  commentstyle=\\color{novacodecomment}\\itshape,
  breaklines=true,
  columns=flexible,
  showstringspaces=false
}

\\title{% NOVATEX_TITLE%}
\\author{% NOVATEX_AUTHOR%}
\\date{\\today}

\\begin{document}

\\begin{frame}
  \\titlepage
\\end{frame}

% NOVATEX_BODY%

% NOVATEX_BIB%
\\end{document}
`,
  },
  'chinese-ctex': {
    id: 'chinese-ctex',
    name: '中文学术论文 (ctexart / XeLaTeX)',
    description: '适用于中文期刊、课程报告与学位论文草稿，内置 amsmath、booktabs、graphicx、hyperref 与 natbib。',
    recommendedEngine: 'xelatex',
    source: `\\documentclass[12pt,a4paper]{ctexart}
\\usepackage[margin=2.5cm]{geometry}
\\usepackage{amsmath,amssymb}
\\usepackage{booktabs,longtable,array}
\\usepackage{graphicx}
\\usepackage[numbers,sort&compress]{natbib}
\\usepackage[colorlinks=true,linkcolor=blue,citecolor=blue,urlcolor=blue]{hyperref}

\\title{% NOVATEX_TITLE%}
\\author{% NOVATEX_AUTHOR%}
\\date{\\today}

\\begin{document}
\\maketitle

% NOVATEX_BODY%

% NOVATEX_BIB%
\\end{document}
`,
  },
  'ieee-conf': {
    id: 'ieee-conf',
    name: '双栏会议论文 (IEEE 风格)',
    description: '标准双栏 10pt 学术会议排版，适合计算机/人工智能/工程类会议投稿初稿。',
    recommendedEngine: 'pdflatex',
    source: `\\documentclass[10pt,twocolumn,a4paper]{article}
\\usepackage[top=1.9cm,bottom=2.5cm,left=1.65cm,right=1.65cm,columnsep=0.6cm]{geometry}
\\usepackage{amsmath,amssymb}
\\usepackage{booktabs,array}
\\usepackage{graphicx}
\\usepackage[numbers,sort&compress]{natbib}
\\usepackage[colorlinks=true,linkcolor=blue,citecolor=blue,urlcolor=blue]{hyperref}

\\title{\\Large\\bfseries % NOVATEX_TITLE%}
\\author{% NOVATEX_AUTHOR%}
\\date{}

\\begin{document}
\\maketitle

% NOVATEX_BODY%

% NOVATEX_BIB%
\\end{document}
`,
  },
  'clean-article': {
    id: 'clean-article',
    name: '现代单栏学术文章 (Clean Article)',
    description: '清爽单栏学术排版，兼顾英文论文、技术报告与审稿修改稿。',
    recommendedEngine: 'pdflatex',
    source: `\\documentclass[11pt,a4paper]{article}
\\usepackage[margin=2.54cm]{geometry}
\\usepackage{amsmath,amssymb}
\\usepackage{booktabs,longtable,array}
\\usepackage{graphicx}
\\usepackage[numbers,sort&compress]{natbib}
\\usepackage[colorlinks=true,linkcolor=blue,citecolor=blue,urlcolor=blue]{hyperref}

\\title{% NOVATEX_TITLE%}
\\author{% NOVATEX_AUTHOR%}
\\date{\\today}

\\begin{document}
\\maketitle

% NOVATEX_BODY%

% NOVATEX_BIB%
\\end{document}
`,
  },
};

function escapeLatexText(raw: string): string {
  return raw
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/([#$%&_{}])/g, '\\$1')
    .replace(/\^/g, '\\textasciicircum{}')
    .replace(/~/g, '\\textasciitilde{}');
}

const FORBIDDEN_BIB_TEX_CHARS_RE = /[\\{}%#$~^,;\s]/;

/**
 * Strictly validate a bibliography file path before interpolating into
 * `\bibliography{...}` or `\addbibresource{...}`.
 */
function validateSafeBibFile(rawBibFile: string): string {
  const trimmed = rawBibFile.trim();
  if (!trimmed) {
    throw new PathSecurityError('INVALID_BIB_PATH', '参考文献路径不能为空');
  }
  if (FORBIDDEN_BIB_TEX_CHARS_RE.test(trimmed)) {
    throw new PathSecurityError(
      'INVALID_BIB_CHARS',
      `参考文献路径包含非法的 LaTeX 控制字符: ${rawBibFile}`,
    );
  }
  const safeRel = normalizeProjectRelPath(trimmed);
  if (FORBIDDEN_BIB_TEX_CHARS_RE.test(safeRel)) {
    throw new PathSecurityError(
      'INVALID_BIB_CHARS',
      `参考文献路径包含非法的 LaTeX 控制字符: ${rawBibFile}`,
    );
  }
  const stem = safeRel.replace(/\.bib$/i, '');
  if (!stem || stem.endsWith('/')) {
    throw new PathSecurityError('INVALID_BIB_PATH', `参考文献文件名无效: ${rawBibFile}`);
  }
  return safeRel;
}

/**
 * Wrap a LaTeX body fragment into one of NovaTeX's built-in compilable academic templates.
 */
export function wrapBodyWithTemplate(
  bodyLatex: string,
  templateId: AcademicTemplateId,
  opts?: {
    title?: string;
    author?: string;
    bibFile?: string;
    citationFormat?: 'natbib' | 'biblatex';
  },
): string {
  const def = Object.prototype.hasOwnProperty.call(ACADEMIC_TEMPLATES, templateId)
    ? ACADEMIC_TEMPLATES[templateId as AcademicTemplateId]
    : ACADEMIC_TEMPLATES['clean-article'];
  const defaultTitles: Record<AcademicTemplateId, string> = {
    'lab-report-en': 'Engineering Laboratory Report',
    'lab-report-zh': '课程实验报告',
    'tech-report': 'Technical Project Report',
    'beamer-slides': 'Academic Presentation',
    'chinese-ctex': '学术论文标题',
    'ieee-conf': 'Academic Manuscript',
    'clean-article': 'Academic Manuscript',
  };
  const defaultTitle = defaultTitles[def.id] ?? 'Academic Manuscript';
  const titleText = opts?.title ? escapeLatexText(opts.title.trim()) : defaultTitle;
  const authorText = opts?.author ? escapeLatexText(opts.author.trim()) : 'NovaTeX Author';
  const cleanBody = bodyLatex.replace(/\r\n/g, '\n').trim();

  let out = def.source;

  let bibTail = '';
  const bibFileRaw = opts?.bibFile?.trim();
  if (bibFileRaw) {
    const safeBibRel = validateSafeBibFile(bibFileRaw);
    if (opts?.citationFormat === 'biblatex') {
      const bibFileWithExt = safeBibRel.endsWith('.bib') ? safeBibRel : `${safeBibRel}.bib`;
      out = out.replace(
        '\\usepackage[numbers,sort&compress]{natbib}',
        () =>
          `\\usepackage[backend=biber,style=numeric]{biblatex}\n\\addbibresource{${bibFileWithExt}}`,
      );
      bibTail = '\\printbibliography';
    } else {
      const bibStem = safeBibRel.replace(/\.bib$/i, '');
      bibTail = `\\bibliographystyle{plainnat}\n\\bibliography{${bibStem}}`;
    }
    if (def.id === 'beamer-slides') {
      bibTail = `\\begin{frame}[allowframebreaks]{References}\n${bibTail}\n\\end{frame}`;
    }
  } else if (opts?.citationFormat === 'biblatex') {
    out = out.replace(
      '\\usepackage[numbers,sort&compress]{natbib}',
      () => '\\usepackage[backend=biber,style=numeric]{biblatex}',
    );
  }

  // Always use function replacers so `$$` inside LaTeX math is never mangled by JS String.replace!
  out = out.replace(/% NOVATEX_TITLE%/g, () => titleText);
  out = out.replace(/% NOVATEX_AUTHOR%/g, () => authorText);
  out = out.replace('% NOVATEX_BODY%', () => cleanBody);
  out = out.replace('% NOVATEX_BIB%', () => bibTail);

  // Clean trailing extra blank line when bibTail is empty
  out = out.replace(/\n{3,}\\end\{document\}/, '\n\n\\end{document}');
  return out;
}

interface DocumentBounds {
  beginLineStart: number;
  beginLineEnd: number;
  endLineStart: number;
  endLineEnd: number;
}

function isCommentedOutBefore(text: string, idx: number): boolean {
  const lineStart = text.lastIndexOf('\n', idx - 1) + 1;
  for (let i = lineStart; i < idx; i++) {
    if (text[i] === '%') {
      let bs = 0;
      let j = i - 1;
      while (j >= lineStart && text[j] === '\\') {
        bs++;
        j--;
      }
      if (bs % 2 === 0) return true;
    }
  }
  return false;
}

function findUncommentedDocumentBounds(tex: string): DocumentBounds | null {
  const beginRe = /\\begin\{document\}/g;
  let beginMatch: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = beginRe.exec(tex)) !== null) {
    if (!isCommentedOutBefore(tex, m.index)) {
      beginMatch = m;
      break;
    }
  }
  if (!beginMatch) return null;

  const endRe = /\\end\{document\}/g;
  let endMatch: RegExpExecArray | null = null;
  while ((m = endRe.exec(tex)) !== null) {
    if (m.index > beginMatch.index && !isCommentedOutBefore(tex, m.index)) {
      endMatch = m;
    }
  }
  if (!endMatch) return null;

  return {
    beginLineStart: beginMatch.index,
    beginLineEnd: beginMatch.index + beginMatch[0].length,
    endLineStart: endMatch.index,
    endLineEnd: endMatch.index + endMatch[0].length,
  };
}

function extractLeadingHeaderBlock(body: string): { header: string; rest: string } {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  let headerEndIdx = -1;
  let sawMaketitle = false;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (trimmed === '' || trimmed.startsWith('%')) {
      continue;
    }
    if (
      /^\\(maketitle|title|author|date|tableofcontents)\b/.test(trimmed)
    ) {
      headerEndIdx = i;
      if (/^\\maketitle\b/.test(trimmed)) {
        sawMaketitle = true;
      }
      continue;
    }
    break;
  }

  if (headerEndIdx === -1 && !sawMaketitle) {
    return { header: '', rest: body };
  }

  const header = lines.slice(0, headerEndIdx + 1).join('\n').trim();
  const rest = lines.slice(headerEndIdx + 1).join('\n');
  return { header, rest };
}

function extractTrailingBibliographyBlock(body: string): { main: string; bibTail: string } {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  let tailStartIdx = lines.length;
  let foundBib = false;

  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i]!.trim();
    if (trimmed === '' || trimmed.startsWith('%')) {
      continue;
    }
    if (/^\\(bibliographystyle|bibliography|printbibliography|nocite)\b/.test(trimmed)) {
      tailStartIdx = i;
      foundBib = true;
      continue;
    }
    break;
  }

  if (!foundBib) {
    return { main: body, bibTail: '' };
  }

  const main = lines.slice(0, tailStartIdx).join('\n').trimEnd();
  const bibTail = lines.slice(tailStartIdx).join('\n').trim();
  return { main, bibTail };
}

function stripIncomingWrapperIfPresent(
  incoming: string,
  warnings: string[],
): string {
  const norm = incoming.replace(/\r\n/g, '\n');
  const bounds = findUncommentedDocumentBounds(norm);
  if (!bounds) {
    return norm.trim();
  }
  warnings.push('检测到待合并内容包含完整的 \\begin{document} 包装，已自动剥离导言区以保留目标文件原有配置。');
  return norm.slice(bounds.beginLineEnd, bounds.endLineStart).trim();
}

/**
 * Preview a safe, section-level partial merge of incoming LaTeX body into a target `.tex` file.
 * - `replace-body`: preserves the entire preamble (`\documentclass`, `\usepackage`, `\title`, `\author`),
 *   leading `\maketitle` block, and trailing `\bibliography`/`\printbibliography` block when target is a
 *   standalone document; or cleanly replaces chapter/section fragments without injecting any preamble.
 * - `append-section`: appends incoming content before the trailing bibliography / `\end{document}`.
 * - `replace-file`: replaces the entire file content directly.
 */
export function previewSectionMerge(
  originalTex: string,
  incomingBodyLatex: string,
  targetFile: string,
  mode: 'replace-body' | 'replace-file' | 'append-section' = 'replace-body',
): SectionMergePreview {
  const warnings: string[] = [];
  const normOriginal = originalTex.replace(/\r\n/g, '\n');
  const normIncoming = incomingBodyLatex.replace(/\r\n/g, '\n');

  let mergedCode: string;

  if (mode === 'replace-file') {
    mergedCode = normIncoming;
  } else {
    const cleanIncoming = stripIncomingWrapperIfPresent(normIncoming, warnings);
    const bounds = findUncommentedDocumentBounds(normOriginal);

    if (bounds) {
      const preambleWithBegin = normOriginal.slice(0, bounds.beginLineEnd);
      const existingBody = normOriginal.slice(bounds.beginLineEnd, bounds.endLineStart);
      const endWithAfter = normOriginal.slice(bounds.endLineStart);

      const { header: existingHeader, rest: bodyAfterHeader } =
        extractLeadingHeaderBlock(existingBody);
      const { main: existingMain, bibTail: existingBibTail } =
        extractTrailingBibliographyBlock(bodyAfterHeader);

      const incomingHasMaketitle = /\\maketitle\b/.test(cleanIncoming);
      const incomingHasBib = /\\(bibliography|printbibliography)\b/.test(cleanIncoming);

      const parts: string[] = [];
      if (mode === 'replace-body') {
        if (existingHeader && !incomingHasMaketitle) {
          parts.push(existingHeader);
        }
        if (cleanIncoming) {
          parts.push(cleanIncoming);
        }
        if (existingBibTail && !incomingHasBib) {
          parts.push(existingBibTail);
        }
      } else {
        // append-section
        if (existingHeader) {
          parts.push(existingHeader);
        }
        if (existingMain.trim()) {
          parts.push(existingMain.trim());
        }
        if (cleanIncoming) {
          parts.push(cleanIncoming);
        }
        if (existingBibTail && !incomingHasBib) {
          parts.push(existingBibTail);
        }
      }

      const assembledBody = parts.join('\n\n');
      mergedCode = `${preambleWithBegin}\n${assembledBody}\n${endWithAfter}`;
    } else {
      // Chapter / section fragment without \begin{document}
      if (mode === 'append-section') {
        const base = normOriginal.trimEnd();
        mergedCode = base ? `${base}\n\n${cleanIncoming}\n` : `${cleanIncoming}\n`;
      } else {
        mergedCode = cleanIncoming ? `${cleanIncoming}\n` : '';
      }
    }
  }

  const diff = computeLineDiff(normOriginal, mergedCode, targetFile);
  return {
    targetFile,
    originalCode: normOriginal,
    mergedCode,
    diff,
    warnings,
  };
}
