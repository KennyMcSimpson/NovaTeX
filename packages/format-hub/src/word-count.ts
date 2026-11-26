import type { WordCountStats } from '@novatex/shared';

const CJK_RE = /[\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF\u{20000}-\u{2CEAF}]/gu;
const LATIN_WORD_RE = /[A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u024F][A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u024F0-9]*(?:['\u2019-][A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u024F0-9]+)*/g;
const STANDALONE_NUMBER_RE = /(?<![A-Za-z\u00C0-\u024F\d])\d+(?:[.,]\d+)*%?(?![A-Za-z\u00C0-\u024F\d])/g;

/**
 * Bilingual academic word counter.
 * Accurately separates CJK characters, Latin words (including hyphenated/alphanumeric terms
 * like "state-of-the-art" or "ResNet50"), and standalone numeric tokens (e.g. "2025", "95.6%").
 */
export function countAcademicWords(text: string): WordCountStats {
  const normalized = text.replace(/\r\n/g, '\n');
  const rawLines = normalized.length === 0 ? [] : normalized.split('\n');
  const lines = rawLines.length;
  let nonEmptyLines = 0;
  for (const line of rawLines) {
    if (line.trim().length > 0) nonEmptyLines++;
  }

  const charactersNoSpaces = normalized.replace(/\s+/g, '').length;
  const cjkMatches = normalized.match(CJK_RE);
  const cjkChars = cjkMatches ? cjkMatches.length : 0;

  const latinMatches = normalized.match(LATIN_WORD_RE);
  const latinWords = latinMatches ? latinMatches.length : 0;

  const numberMatches = normalized.match(STANDALONE_NUMBER_RE);
  const numbers = numberMatches ? numberMatches.length : 0;

  const totalAcademicWords = cjkChars + latinWords + numbers;

  return {
    cjkChars,
    latinWords,
    numbers,
    totalAcademicWords,
    lines,
    nonEmptyLines,
    charactersNoSpaces,
  };
}

/**
 * Strip unescaped LaTeX comments (`% ...`) line by line while preserving `\%`.
 */
function stripLatexComments(input: string): string {
  return input
    .split('\n')
    .map((line) => {
      for (let i = 0; i < line.length; i++) {
        if (line[i] === '%') {
          let bsCount = 0;
          let j = i - 1;
          while (j >= 0 && line[j] === '\\') {
            bsCount++;
            j--;
          }
          if (bsCount % 2 === 0) {
            return line.slice(0, i);
          }
        }
      }
      return line;
    })
    .join('\n');
}

/**
 * Find matching closing brace `}` starting from the index of `{`.
 * Returns index of matching `}` or -1 if unbalanced.
 */
function findMatchingBrace(text: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') {
      i++; // skip escaped char
      continue;
    }
    if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Replace commands of the form `\cmd*[opt]{arg}` by either dropping them or unwrapping `{arg}`.
 */
function processLatexCommand(
  input: string,
  commandNames: string[],
  mode: 'unwrap' | 'drop' | 'unwrap-second',
): string {
  const nameSet = new Set(commandNames);
  let text = input;

  // Iterate a few passes to cleanly handle nested commands like \textbf{foo \emph{bar}}
  for (let pass = 0; pass < 6; pass++) {
    let changed = false;
    let out = '';
    let i = 0;

    while (i < text.length) {
      if (text[i] === '\\') {
        let j = i + 1;
        while (j < text.length && /[A-Za-z@]/.test(text[j]!)) {
          j++;
        }
        const cmd = text.slice(i + 1, j);
        if (cmd.length > 0 && nameSet.has(cmd)) {
          let cursor = j;
          if (text[cursor] === '*') cursor++;

          // Skip optional [...] arguments
          while (cursor < text.length) {
            let ws = cursor;
            while (ws < text.length && (text[ws] === ' ' || text[ws] === '\t')) ws++;
            if (text[ws] === '[') {
              const closeBracket = text.indexOf(']', ws + 1);
              if (closeBracket !== -1) {
                cursor = closeBracket + 1;
                continue;
              }
            }
            break;
          }

          let ws = cursor;
          while (ws < text.length && (text[ws] === ' ' || text[ws] === '\t')) ws++;

          if (text[ws] === '{') {
            const close1 = findMatchingBrace(text, ws);
            if (close1 !== -1) {
              const arg1 = text.slice(ws + 1, close1);
              if (mode === 'unwrap-second') {
                let ws2 = close1 + 1;
                while (ws2 < text.length && (text[ws2] === ' ' || text[ws2] === '\t')) ws2++;
                if (text[ws2] === '{') {
                  const close2 = findMatchingBrace(text, ws2);
                  if (close2 !== -1) {
                    const arg2 = text.slice(ws2 + 1, close2);
                    out += arg2;
                    i = close2 + 1;
                    changed = true;
                    continue;
                  }
                }
              }
              if (mode === 'unwrap') {
                out += arg1;
              }
              i = close1 + 1;
              changed = true;
              continue;
            }
          } else if (mode === 'drop') {
            i = cursor;
            changed = true;
            continue;
          }
        }
      }
      out += text[i]!;
      i++;
    }

    text = out;
    if (!changed) break;
  }

  return text;
}

function normalizePlainLines(input: string): string {
  const lines = input
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim());

  const collapsed: string[] = [];
  let blankRun = 0;
  for (const line of lines) {
    if (line.length === 0) {
      blankRun++;
      if (blankRun <= 1 && collapsed.length > 0) {
        collapsed.push('');
      }
    } else {
      blankRun = 0;
      collapsed.push(line);
    }
  }

  while (collapsed.length > 0 && collapsed[collapsed.length - 1] === '') {
    collapsed.pop();
  }

  return collapsed.join('\n');
}

function stripLatexToPlain(content: string): string {
  let text = stripLatexComments(content.replace(/\r\n/g, '\n'));

  // Extract document body if full document is provided (preserving optional \title)
  const beginDocMatch = /\\begin\{document\}/.exec(text);
  const endDocMatch = /\\end\{document\}/.exec(text);
  if (beginDocMatch) {
    const preamble = text.slice(0, beginDocMatch.index);
    const titleMatch = /\\title\s*\{/.exec(preamble);
    let extractedTitle = '';
    if (titleMatch) {
      const braceStart = preamble.indexOf('{', titleMatch.index);
      const braceEnd = findMatchingBrace(preamble, braceStart);
      if (braceEnd !== -1) {
        extractedTitle = preamble.slice(braceStart + 1, braceEnd).trim();
      }
    }
    const bodyStart = beginDocMatch.index + beginDocMatch[0].length;
    const bodyEnd = endDocMatch ? endDocMatch.index : text.length;
    const body = text.slice(bodyStart, bodyEnd);
    text = extractedTitle ? `${extractedTitle}\n\n${body}` : body;
  }

  // Drop non-content structural / citation / reference / layout commands
  text = processLatexCommand(
    text,
    [
      'documentclass',
      'usepackage',
      'label',
      'ref',
      'eqref',
      'pageref',
      'autoref',
      'cref',
      'Cref',
      'cite',
      'citep',
      'citet',
      'citealt',
      'citealp',
      'citeauthor',
      'citeyear',
      'autocite',
      'textcite',
      'parencite',
      'footcite',
      'nocite',
      'bibliography',
      'bibliographystyle',
      'addbibresource',
      'includegraphics',
      'vspace',
      'hspace',
      'setlength',
      'setcounter',
      'addtocounter',
      'newcommand',
      'renewcommand',
      'providecommand',
      'DeclareMathOperator',
      'pagestyle',
      'thispagestyle',
      'graphicspath',
      'input',
      'include',
      'hypertarget',
    ],
    'drop',
  );

  // \href{url}{display text} -> display text
  text = processLatexCommand(text, ['href'], 'unwrap-second');

  // Unwrap readable text commands
  text = processLatexCommand(
    text,
    [
      'part',
      'chapter',
      'section',
      'subsection',
      'subsubsection',
      'paragraph',
      'subparagraph',
      'title',
      'author',
      'date',
      'caption',
      'textbf',
      'textit',
      'emph',
      'underline',
      'texttt',
      'textrm',
      'textsf',
      'textsc',
      'text',
      'mathrm',
      'mathbf',
      'mathit',
      'mathcal',
      'mathbb',
      'operatorname',
      'footnote',
      'url',
      'textsuperscript',
      'textsubscript',
      'mbox',
      'hbox',
    ],
    'unwrap',
  );

  // Remove \begin{env}[opt]{args} and \end{env}
  text = text.replace(/\\begin\{[^}]+\}(?:\[[^\]]*\])?(?:\{[^}]*\})?/g, '\n');
  text = text.replace(/\\end\{[^}]+\}/g, '\n');

  // Convert list items, line breaks, and table separators
  text = text.replace(/\\item(?:\[[^\]]*\])?\s*/g, '\n');
  text = text.replace(/\\\\(?:\[[^\]]*\])?/g, '\n');
  text = text.replace(/\\(maketitle|tableofcontents|listoffigures|listoftables|centering|noindent|newpage|clearpage|pagebreak|hline|toprule|midrule|bottomrule|tightlist|printbibliography|par|bigskip|medskip|smallskip|hfill|vfill|quad|qquad)\b/g, ' ');

  // Remove math delimiters while keeping readable formula tokens
  text = text.replace(/\$\$([\s\S]*?)\$\$/g, '\n$1\n');
  text = text.replace(/\\\[([\s\S]*?)\\\]/g, '\n$1\n');
  text = text.replace(/\\\(([\s\S]*?)\\\)/g, '$1');
  text = text.replace(/(?<!\\)\$([^$\n]+?)(?<!\\)\$/g, '$1');

  // Unescape standard LaTeX escaped punctuation
  text = text
    .replace(/\\%/g, '%')
    .replace(/\\_/g, '_')
    .replace(/\\&/g, '&')
    .replace(/\\#/g, '#')
    .replace(/\\\$/g, '$')
    .replace(/\\\{/g, '{')
    .replace(/\\\}/g, '}')
    .replace(/``/g, '"')
    .replace(/''/g, '"')
    .replace(/~/g, ' ');

  // Strip any remaining unknown \command tokens (keeping brace content)
  text = text.replace(/\\[A-Za-z@]+\*?(?:\[[^\]]*\])?/g, ' ');
  text = text.replace(/[{}]/g, '');
  text = text.replace(/\s*&\s*/g, ' ');

  return normalizePlainLines(text);
}

function stripMarkdownToPlain(content: string): string {
  let text = content.replace(/\r\n/g, '\n');

  // Strip YAML frontmatter
  text = text.replace(/^---\n[\s\S]*?\n---\n?/, '');
  // Strip HTML comments and tags
  text = text.replace(/<!--[\s\S]*?-->/g, '');
  text = text.replace(/<\/?[A-Za-z][^>]*>/g, '');

  // Strip fenced code markers (keep inner content)
  text = text.replace(/^```[^\n]*\n([\s\S]*?)^```[ \t]*$/gm, '$1');

  // Images ![alt](url) -> alt ; Links [label](url) -> label
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');

  // Strip Pandoc citation groups [@key; @key2, p. 1] and inline attributes {#id .cls}
  text = text.replace(/\[[^\[\]]*@[A-Za-z0-9_:-]+[^\[\]]*\]/g, '');
  text = text.replace(/\{[#.:][^}]+\}/g, '');

  // Strip fenced div markers ::: ...
  text = text.replace(/^:{3,}.*$/gm, '');

  // Strip headings, blockquotes, horizontal rules, list bullets, table borders
  text = text.replace(/^#{1,6}\s+/gm, '');
  text = text.replace(/^>\s?/gm, '');
  text = text.replace(/^\s*([-*_])\1{2,}\s*$/gm, '');
  text = text.replace(/^\s*[-*+]\s+/gm, '');
  text = text.replace(/^\s*\d+[.)]\s+/gm, '');
  text = text.replace(/^\s*\|?(?:\s*:?-+:?\s*\|)+\s*:?-+:?\s*\|?\s*$/gm, '');
  text = text.replace(/\|/g, ' ');

  // Strip emphasis, strikeout, inline code
  text = text.replace(/(\*\*|__)(.*?)\1/g, '$2');
  text = text.replace(/(\*|_)(.*?)\1/g, '$2');
  text = text.replace(/~~(.*?)~~/g, '$1');
  text = text.replace(/`([^`]+)`/g, '$1');

  // Strip math delimiters and any stray LaTeX commands inside math
  text = text.replace(/\$\$([\s\S]*?)\$\$/g, '\n$1\n');
  text = text.replace(/(?<!\\)\$([^$\n]+?)(?<!\\)\$/g, '$1');
  text = text.replace(/\\[A-Za-z@]+\*?/g, ' ');
  text = text.replace(/[{}]/g, '');

  return normalizePlainLines(text);
}

/**
 * Cleanly strip markup from LaTeX, Markdown, or plain text into readable paragraphs/headings
 * with zero residual LaTeX/Markdown syntax artifacts.
 */
export function stripToCleanPlainText(
  content: string,
  sourceFormat: 'tex' | 'md' | 'txt',
): string {
  if (!content) return '';
  if (sourceFormat === 'tex') {
    return stripLatexToPlain(content);
  }
  if (sourceFormat === 'md') {
    return stripMarkdownToPlain(content);
  }
  // For 'txt', also clean any residual math delimiters or LaTeX macros (e.g. from Pandoc plain writer)
  let cleaned = content.replace(/\r\n/g, '\n');
  cleaned = cleaned.replace(/\$\$([\s\S]*?)\$\$/g, '\n$1\n');
  cleaned = cleaned.replace(/(?<!\\)\$([^$\n]+?)(?<!\\)\$/g, '$1');
  cleaned = cleaned.replace(/\\[A-Za-z@]+\*?/g, ' ');
  cleaned = cleaned.replace(/[{}]/g, '');
  return normalizePlainLines(cleaned);
}
