import fs from 'node:fs';
import path from 'node:path';
import {
  PathSecurityError,
  resolveInsideWorkspace,
  type OutlineItem,
} from '@novatex/shared';

export interface FlattenLatexResult {
  flattenedTex: string;
  includedFiles: string[];
  bibFiles: string[];
  warnings: string[];
}

const INCLUDE_PATTERN = /\\(input|include)\s*\{([^}]+)\}/;
const BIBLIOGRAPHY_PATTERN = /\\bibliography\s*\{([^}]+)\}/;
const ADDBIBRESOURCE_PATTERN = /\\addbibresource(?:\[[^\]]*\])?\s*\{([^}]+)\}/;
const SECTION_RE = /\\(part|chapter|section|subsection|subsubsection)\*?(?:\[[^\]]*\])?\s*\{/;

const OUTLINE_LEVELS: Record<string, number> = {
  part: 0,
  chapter: 1,
  section: 2,
  subsection: 3,
  subsubsection: 4,
};

/**
 * Return the code portion of a single LaTeX line before any unescaped `%` comment.
 */
function stripLineComment(line: string): { code: string; comment: string } {
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '%') {
      let backslashes = 0;
      let j = i - 1;
      while (j >= 0 && line[j] === '\\') {
        backslashes++;
        j--;
      }
      if (backslashes % 2 === 0) {
        return { code: line.slice(0, i), comment: line.slice(i) };
      }
    }
  }
  return { code: line, comment: '' };
}

function readBalancedBraces(line: string, openBraceIdx: number): string {
  let depth = 0;
  for (let i = openBraceIdx; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return line.slice(openBraceIdx + 1, i);
      }
    }
  }
  return line.slice(openBraceIdx + 1).replace(/\}\s*$/, '');
}

/**
 * Safely resolve a referenced LaTeX include or bibliography path strictly inside workspaceRoot.
 * Never allows `..`, absolute paths, Windows drives, or symlinks escaping the workspace.
 */
function resolveSafeLatexTarget(
  workspaceRoot: string,
  currentFileRel: string,
  rawRef: string,
  defaultExt: '.tex' | '.bib',
): { ok: true; relPath: string; absPath: string; exists: boolean } | { ok: false; reason: string } {
  const trimmed = rawRef.trim();
  if (!trimmed) {
    return { ok: false, reason: '引用路径为空' };
  }

  // Reject explicit escapes immediately (even before joining with subdir)
  if (
    /^[a-zA-Z]:/.test(trimmed) ||
    trimmed.startsWith('/') ||
    trimmed.startsWith('\\\\') ||
    trimmed.replace(/\\/g, '/').split('/').includes('..')
  ) {
    return { ok: false, reason: `禁止越界或绝对路径引用: ${trimmed}` };
  }

  const hasExt = path.extname(trimmed).length > 0;
  const currentDir = path.posix.dirname(currentFileRel);
  const candidateRelPaths: string[] = [];

  // LaTeX resolves \input relative to main/workspace root first
  candidateRelPaths.push(trimmed);
  if (!hasExt) {
    candidateRelPaths.push(`${trimmed}${defaultExt}`);
  }
  if (currentDir && currentDir !== '.') {
    candidateRelPaths.push(`${currentDir}/${trimmed}`);
    if (!hasExt) {
      candidateRelPaths.push(`${currentDir}/${trimmed}${defaultExt}`);
    }
  }

  let firstValid: { relPath: string; absPath: string } | null = null;
  for (const cand of candidateRelPaths) {
    try {
      const resolved = resolveInsideWorkspace(workspaceRoot, cand);
      if (!firstValid) firstValid = resolved;
      if (fs.existsSync(resolved.absPath) && fs.statSync(resolved.absPath).isFile()) {
        return {
          ok: true,
          relPath: resolved.relPath,
          absPath: resolved.absPath,
          exists: true,
        };
      }
    } catch (err) {
      if (err instanceof PathSecurityError) {
        return { ok: false, reason: `${err.message} (${trimmed})` };
      }
      throw err;
    }
  }

  if (firstValid) {
    // Prefer defaultExt variant as canonical missing path if no extension was given
    if (!hasExt) {
      try {
        const withExt = resolveInsideWorkspace(workspaceRoot, `${trimmed}${defaultExt}`);
        return { ok: true, relPath: withExt.relPath, absPath: withExt.absPath, exists: false };
      } catch {
        // fallback below
      }
    }
    return { ok: true, relPath: firstValid.relPath, absPath: firstValid.absPath, exists: false };
  }

  return { ok: false, reason: `无法解析路径: ${trimmed}` };
}

/**
 * Recursively flatten a multi-file LaTeX project starting at `mainRelPath`.
 * - Expands `\input{...}` and `\include{...}` (auto-appending `.tex` if omitted)
 * - Respects `%` comments
 * - Guards against circular includes via active recursion stack + expansion cap
 * - Strictly validates every path with `resolveInsideWorkspace` so escapes are blocked and logged
 * - Safely discovers `\bibliography{...}` and `\addbibresource{...}` files
 */
export function flattenLatexProject(
  workspaceRoot: string,
  mainRelPath: string,
): FlattenLatexResult {
  const mainResolved = resolveInsideWorkspace(workspaceRoot, mainRelPath);
  if (!fs.existsSync(mainResolved.absPath)) {
    throw new Error(`主 LaTeX 文件不存在: ${mainResolved.relPath}`);
  }

  const includedFiles: string[] = [];
  const includedSet = new Set<string>();
  const bibFiles: string[] = [];
  const bibSet = new Set<string>();
  const warnings: string[] = [];
  const activeStack = new Set<string>();
  const MAX_EXPANSIONS = 256;
  let expansionCount = 0;

  function recordBibRef(currentFileRel: string, rawEntry: string): void {
    const resolved = resolveSafeLatexTarget(workspaceRoot, currentFileRel, rawEntry, '.bib');
    if (!resolved.ok) {
      warnings.push(`已拦截非法参考文献路径 (${currentFileRel}): ${resolved.reason}`);
      return;
    }
    if (!resolved.exists) {
      warnings.push(`参考文献文件不存在 (${currentFileRel}): ${resolved.relPath}`);
      return;
    }
    if (!bibSet.has(resolved.relPath)) {
      bibSet.add(resolved.relPath);
      bibFiles.push(resolved.relPath);
    }
  }

  function expandFile(relPath: string, absPath: string): string {
    activeStack.add(relPath);
    try {
      const rawContent = fs.readFileSync(absPath, 'utf8').replace(/\r\n/g, '\n');
      const lines = rawContent.split('\n');
      const outLines: string[] = [];

      for (const line of lines) {
        const { code, comment } = stripLineComment(line);

        // Scan bibliography declarations in active code portion (fresh /g regex per call)
        for (const match of code.matchAll(new RegExp(BIBLIOGRAPHY_PATTERN, 'g'))) {
          const entries = (match[1] ?? '').split(',');
          for (const entry of entries) {
            const clean = entry.trim();
            if (clean) recordBibRef(relPath, clean);
          }
        }
        for (const match of code.matchAll(new RegExp(ADDBIBRESOURCE_PATTERN, 'g'))) {
          const clean = (match[1] ?? '').trim();
          if (clean) recordBibRef(relPath, clean);
        }

        // Expand \input{...} / \include{...} in active code portion using a local non-shared regex
        const includeMatches = [...code.matchAll(new RegExp(INCLUDE_PATTERN, 'g'))];
        if (includeMatches.length === 0) {
          outLines.push(line);
          continue;
        }

        let lastIndex = 0;
        let rebuilt = '';

        for (const match of includeMatches) {
          const matchIndex = match.index ?? 0;
          rebuilt += code.slice(lastIndex, matchIndex);
          lastIndex = matchIndex + match[0].length;

          const cmd = match[1]!;
          const rawTarget = (match[2] ?? '').trim();
          const resolved = resolveSafeLatexTarget(workspaceRoot, relPath, rawTarget, '.tex');

          if (!resolved.ok) {
            warnings.push(`已拦截非法 \\${cmd} 路径 (${relPath}): ${resolved.reason}`);
            rebuilt += `% [NovaTeX blocked unsafe \\${cmd}: ${rawTarget}]`;
            continue;
          }

          if (activeStack.has(resolved.relPath)) {
            warnings.push(`检测到循环引用，已跳过 \\${cmd}{${rawTarget}} -> ${resolved.relPath}`);
            rebuilt += `% [NovaTeX skipped cyclic \\${cmd}: ${resolved.relPath}]`;
            continue;
          }

          if (!resolved.exists) {
            warnings.push(`找不到被引用的文件 (${relPath}): ${resolved.relPath}`);
            rebuilt += `% [NovaTeX missing \\${cmd}: ${resolved.relPath}]`;
            continue;
          }

          if (expansionCount >= MAX_EXPANSIONS) {
            warnings.push(`达到最大递归展开次数上限 (${MAX_EXPANSIONS})，已停止展开: ${resolved.relPath}`);
            rebuilt += `% [NovaTeX expansion limit reached: ${resolved.relPath}]`;
            continue;
          }

          expansionCount++;
          if (!includedSet.has(resolved.relPath)) {
            includedSet.add(resolved.relPath);
            includedFiles.push(resolved.relPath);
          }

          const expandedChild = expandFile(resolved.relPath, resolved.absPath);
          if (cmd === 'include') {
            rebuilt += `\n${expandedChild}\n`;
          } else {
            rebuilt += expandedChild;
          }
        }

        rebuilt += code.slice(lastIndex);
        if (comment) {
          rebuilt += comment;
        }
        outLines.push(rebuilt);
      }

      return outLines.join('\n');
    } finally {
      activeStack.delete(relPath);
    }
  }

  const flattenedTex = expandFile(mainResolved.relPath, mainResolved.absPath);
  return {
    flattenedTex,
    includedFiles,
    bibFiles,
    warnings,
  };
}

/**
 * Extract document outline (`\part`, `\chapter`, `\section`, `\subsection`, `\subsubsection`)
 * across the main LaTeX file and all safely included sub-files, preserving exact `{file, line, level, command, title}`.
 */
export function extractLatexOutline(
  workspaceRoot: string,
  mainRelPath: string,
): OutlineItem[] {
  const mainResolved = resolveInsideWorkspace(workspaceRoot, mainRelPath);
  if (!fs.existsSync(mainResolved.absPath)) {
    throw new Error(`主 LaTeX 文件不存在: ${mainResolved.relPath}`);
  }

  const items: OutlineItem[] = [];
  const activeStack = new Set<string>();
  const MAX_VISITS = 256;
  let visits = 0;

  function scanFile(relPath: string, absPath: string): void {
    activeStack.add(relPath);
    try {
      const content = fs.readFileSync(absPath, 'utf8').replace(/\r\n/g, '\n');
      const lines = content.split('\n');

      for (let idx = 0; idx < lines.length; idx++) {
        const lineNumber = idx + 1;
        const { code } = stripLineComment(lines[idx]!);
        if (!code.trim()) continue;

        // Check for sectioning commands on this line
        const secMatch = SECTION_RE.exec(code);
        if (secMatch) {
          const command = secMatch[1]!;
          const braceIdx = code.indexOf('{', secMatch.index + secMatch[0].length - 1);
          const rawTitle = braceIdx !== -1 ? readBalancedBraces(code, braceIdx) : '';
          const cleanTitle = rawTitle.replace(/\\label\{[^}]*\}/g, '').trim();
          items.push({
            level: OUTLINE_LEVELS[command] ?? 2,
            command,
            title: cleanTitle,
            file: relPath,
            line: lineNumber,
          });
        }

        // Follow safe \input / \include directives in order using local matches (recursion-safe)
        for (const incMatch of code.matchAll(new RegExp(INCLUDE_PATTERN, 'g'))) {
          const rawTarget = (incMatch[2] ?? '').trim();
          const resolved = resolveSafeLatexTarget(workspaceRoot, relPath, rawTarget, '.tex');
          if (!resolved.ok || !resolved.exists || activeStack.has(resolved.relPath)) {
            continue;
          }
          if (visits >= MAX_VISITS) continue;
          visits++;
          scanFile(resolved.relPath, resolved.absPath);
        }
      }
    } finally {
      activeStack.delete(relPath);
    }
  }

  scanFile(mainResolved.relPath, mainResolved.absPath);
  return items;
}
