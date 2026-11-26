import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  normalizeProjectRelPath,
  resolveInsideWorkspace,
  type ConvertOptions,
  type ConvertOutputArtifact,
  type FormatLayer,
  type OutlineItem,
  type SectionMergePreview,
  type WordCountStats,
} from '@novatex/shared';
import {
  extractLatexOutline,
  flattenLatexProject,
  type FlattenLatexResult,
} from './latex-flattener.js';
import {
  buildCiteprocArgs,
  detectPandoc,
  getCleanMarkdownInputFormat,
  getCleanMarkdownTargetFormat,
  resolveLuaFilterPath,
  runPandoc,
  type PandocInfo,
} from './pandoc-runner.js';
import { extractPdfDraft } from './pdf-extract.js';
import { ensureAcademicReferenceDocx } from './reference-docx.js';
import { previewSectionMerge, wrapBodyWithTemplate } from './templates.js';
import { countAcademicWords, stripToCleanPlainText } from './word-count.js';

export interface FormatConvertParams {
  inputFormat: FormatLayer;
  outputFormat: FormatLayer;
  inputContent?: string;
  inputBuffer?: Buffer;
  workspaceRoot?: string;
  sourceFilePath?: string;
  options?: ConvertOptions;
}

export interface FormatHubOptions {
  pandocBin?: string;
  cacheDir?: string;
  timeoutMs?: number;
}

const ALLOWED_TRACK_CHANGES = new Set<'accept' | 'reject' | 'all'>([
  'accept',
  'reject',
  'all',
]);

function normalizeTrackChanges(
  raw: ConvertOptions['trackChanges'],
): 'accept' | 'reject' | 'all' {
  if (raw === undefined) return 'accept';
  if (ALLOWED_TRACK_CHANGES.has(raw)) return raw;
  throw new Error(`非法的 Word 修订模式 trackChanges: ${String(raw)}`);
}

const MIME_TYPES: Record<FormatLayer, string> = {
  tex: 'application/x-tex; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
};

function deriveOutputFileName(
  sourceFilePath: string | undefined,
  outputFormat: FormatLayer,
): string {
  const base = sourceFilePath
    ? path.posix.basename(sourceFilePath.replace(/\\/g, '/'), path.posix.extname(sourceFilePath))
    : 'document';
  const safeBase = base.replace(/[^A-Za-z0-9_\u4E00-\u9FFF.-]/g, '_') || 'document';
  return `${safeBase}.${outputFormat}`;
}

function parsePandocWarnings(stderr: string): string[] {
  return stderr
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function walkFilesRecursive(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFilesRecursive(full));
    } else if (entry.isFile()) {
      results.push(full);
    }
  }
  return results;
}

function postProcessLatexOutput(
  rawLatex: string,
  opts?: { normalizeCitepToCite?: boolean },
): string {
  let out = rawLatex.replace(/\r\n/g, '\n');

  // Strip Pandoc 2.12 \hypertarget{id}{%\n\section{Title}\label{id}} wrapper -> \section{Title}\label{id}
  out = out.replace(
    /\\hypertarget\{[^}]*\}\{%\n((?:\\(?:part|chapter|section|subsection|subsubsection|paragraph)\*?\{[^\n]*\}(?:\\label\{[^}]*\})?))\}/g,
    '$1',
  );

  // Restore Pandoc internal cross-reference links \hyperlink{label}{...} -> \ref{label}
  // so Markdown round-trips preserve live LaTeX cross-references and never fail when hyperref is absent
  out = out.replace(/\\hyperlink\{([A-Za-z0-9_.:-]+)\}\{[^{}]*\}/g, '\\ref{$1}');

  // Strip any residual \tightlist macros
  out = out.replace(/^[ \t]*\\tightlist[ \t]*\n/gm, '');

  // Fix escaped backslash in Pandoc image width option if Pandoc 2.12 emitted \textbackslash{}linewidth
  out = out.replace(
    /width=0\.85\\textbackslash\{\}linewidth/g,
    'width=0.85\\linewidth',
  );
  out = out.replace(
    /width=0\.85\\linewidth,height=\\textheight/g,
    'width=0.85\\linewidth',
  );

  // Belt-and-suspenders: normalize simple \citep{keys} -> \cite{keys} when citation round-trip is enabled
  if (opts?.normalizeCitepToCite) {
    out = out.replace(/\\citep\{([^}]+)\}/g, '\\cite{$1}');
  }

  // Collapse excessive blank lines
  out = out.replace(/\n{3,}/g, '\n\n').trim();
  return out;
}

function postProcessMarkdownOutput(rawMd: string): string {
  let out = rawMd.replace(/\r\n/g, '\n');
  // Remove noisy Pandoc trailing backslashes on blank or simple lines
  out = out.replace(/\n{3,}/g, '\n\n').trim();
  return out;
}

function collectAndRewriteExtractedMedia(
  text: string,
  tmpMediaRoot: string,
  workspaceRoot: string | undefined,
  requestedMediaDir: string | undefined,
  warnings: string[],
): { text: string; extractedMedia: Array<{ relativePath: string; byteLength: number }> } {
  const files = walkFilesRecursive(tmpMediaRoot);
  if (files.length === 0) {
    return { text, extractedMedia: [] };
  }

  let safeMediaDirRel = 'media';
  if (requestedMediaDir?.trim()) {
    safeMediaDirRel = normalizeProjectRelPath(requestedMediaDir.trim());
  }

  let updatedText = text;
  const extractedMedia: Array<{ relativePath: string; byteLength: number }> = [];

  for (const absExtracted of files) {
    const relFromTmp = path.relative(tmpMediaRoot, absExtracted).replace(/\\/g, '/');
    // Pandoc extracts to `<tmpMediaRoot>/media/image1.png`; flatten nested `media/` prefix cleanly
    const strippedSubPath = relFromTmp.replace(/^media\//i, '');
    const cleanFileName = strippedSubPath
      .split('/')
      .map((seg) => seg.replace(/[^A-Za-z0-9._-]/g, '_'))
      .join('/');

    const targetRelPath = normalizeProjectRelPath(`${safeMediaDirRel}/${cleanFileName}`);
    const byteLength = fs.statSync(absExtracted).size;

    if (workspaceRoot) {
      try {
        const dest = resolveInsideWorkspace(workspaceRoot, targetRelPath);
        fs.mkdirSync(path.dirname(dest.absPath), { recursive: true });
        fs.copyFileSync(absExtracted, dest.absPath);
      } catch (err) {
        warnings.push(
          `媒体文件写入工作区失败 (${targetRelPath}): ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
    }

    extractedMedia.push({ relativePath: targetRelPath, byteLength });

    // Rewrite every possible path representation Pandoc may have emitted (Windows backslash, POSIX slash, relative)
    const variants = new Set<string>([
      absExtracted,
      absExtracted.replace(/\\/g, '/'),
      absExtracted.replace(/\//g, '\\'),
      relFromTmp,
      `./${relFromTmp}`,
      path.join(path.basename(tmpMediaRoot), relFromTmp).replace(/\\/g, '/'),
    ]);

    for (const variant of variants) {
      if (!variant) continue;
      updatedText = updatedText.replace(new RegExp(escapeRegExp(variant), 'g'), () => targetRelPath);
    }
  }

  return { text: updatedText, extractedMedia };
}

/**
 * Unified Four-Layer Academic Format Hub Engine (`tex` <-> `md` <-> `docx` <-> `txt`, plus `pdf` intake).
 */
export class FormatHub {
  private readonly explicitPandocBin?: string;
  private readonly cacheDir: string;
  private readonly timeoutMs: number;
  private cachedPandocInfo: PandocInfo | null = null;

  constructor(opts?: FormatHubOptions) {
    this.explicitPandocBin = opts?.pandocBin;
    this.cacheDir = opts?.cacheDir ?? path.join(os.tmpdir(), 'novatex-format-hub-cache');
    this.timeoutMs = opts?.timeoutMs ?? 60_000;
  }

  async getPandocInfo(forceRefresh = false): Promise<PandocInfo> {
    if (!forceRefresh && this.cachedPandocInfo) {
      return this.cachedPandocInfo;
    }
    this.cachedPandocInfo = await detectPandoc(this.explicitPandocBin);
    return this.cachedPandocInfo;
  }

  flattenLatex(workspaceRoot: string, mainRelPath: string): FlattenLatexResult {
    return flattenLatexProject(workspaceRoot, mainRelPath);
  }

  extractOutline(workspaceRoot: string, mainRelPath: string): OutlineItem[] {
    return extractLatexOutline(workspaceRoot, mainRelPath);
  }

  countWords(text: string): WordCountStats {
    return countAcademicWords(text);
  }

  previewSectionMerge(
    originalTex: string,
    incomingBodyLatex: string,
    targetFile: string,
    mode?: 'replace-body' | 'replace-file' | 'append-section',
  ): SectionMergePreview {
    return previewSectionMerge(originalTex, incomingBodyLatex, targetFile, mode);
  }

  private loadTextSource(params: FormatConvertParams): string {
    if (typeof params.inputContent === 'string') {
      return params.inputContent;
    }
    if (params.inputBuffer) {
      return params.inputBuffer.toString('utf8');
    }
    if (params.workspaceRoot && params.sourceFilePath) {
      const resolved = resolveInsideWorkspace(params.workspaceRoot, params.sourceFilePath);
      return fs.readFileSync(resolved.absPath, 'utf8');
    }
    throw new Error('缺少转换输入内容 (inputContent / inputBuffer / workspaceRoot+sourceFilePath)');
  }

  private loadBinarySource(params: FormatConvertParams): Buffer {
    if (params.inputBuffer) {
      return params.inputBuffer;
    }
    if (params.workspaceRoot && params.sourceFilePath) {
      const resolved = resolveInsideWorkspace(params.workspaceRoot, params.sourceFilePath);
      return fs.readFileSync(resolved.absPath);
    }
    throw new Error(`输入格式 ${params.inputFormat} 需要提供二进制数据 (inputBuffer) 或工作区文件路径`);
  }

  private resolveLatexInput(
    params: FormatConvertParams,
    warnings: string[],
  ): { latexText: string; discoveredBibFiles: string[] } {
    const shouldFlatten = params.options?.flattenInputs !== false;
    if (
      shouldFlatten &&
      params.workspaceRoot &&
      params.sourceFilePath &&
      params.inputContent === undefined &&
      params.inputBuffer === undefined
    ) {
      const flat = flattenLatexProject(params.workspaceRoot, params.sourceFilePath);
      warnings.push(...flat.warnings);
      return { latexText: flat.flattenedTex, discoveredBibFiles: flat.bibFiles };
    }

    const raw = this.loadTextSource(params);
    // If inputContent was supplied directly AND workspaceRoot + sourceFilePath exist AND flattenInputs is explicitly true,
    // still scan bib declarations safely inside workspace.
    const discoveredBibFiles: string[] = [];
    if (params.workspaceRoot) {
      const bibRe = /\\(?:bibliography|addbibresource(?:\[[^\]]*\])?)\s*\{([^}]+)\}/g;
      for (const m of raw.matchAll(bibRe)) {
        const entries = (m[1] ?? '').split(',');
        for (const entry of entries) {
          const clean = entry.trim();
          if (!clean) continue;
          const withExt = clean.endsWith('.bib') ? clean : `${clean}.bib`;
          try {
            const resolved = resolveInsideWorkspace(params.workspaceRoot, withExt);
            if (fs.existsSync(resolved.absPath) && !discoveredBibFiles.includes(resolved.relPath)) {
              discoveredBibFiles.push(resolved.relPath);
            }
          } catch {
            // ignore invalid bib path here
          }
        }
      }
    }
    return { latexText: raw, discoveredBibFiles };
  }

  private resolveBibAbsPath(
    workspaceRoot: string | undefined,
    explicitBibRel: string | undefined,
    discoveredBibFiles: string[],
    warnings: string[],
  ): string | null {
    if (!workspaceRoot) return null;

    const candidates: string[] = [];
    if (explicitBibRel?.trim()) {
      const trimmed = explicitBibRel.trim();
      candidates.push(trimmed);
      if (!trimmed.endsWith('.bib')) candidates.push(`${trimmed}.bib`);
    }
    for (const d of discoveredBibFiles) {
      if (!candidates.includes(d)) candidates.push(d);
    }

    for (const cand of candidates) {
      try {
        const resolved = resolveInsideWorkspace(workspaceRoot, cand);
        if (fs.existsSync(resolved.absPath) && fs.statSync(resolved.absPath).isFile()) {
          return resolved.absPath;
        }
      } catch (err) {
        warnings.push(
          `已拦截非法参考文献路径 (${cand}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (explicitBibRel?.trim()) {
      warnings.push(`指定的参考文献文件不存在: ${explicitBibRel}`);
    }
    return null;
  }

  private buildResourcePath(
    workspaceRoot: string | undefined,
    sourceFilePath: string | undefined,
  ): string | null {
    if (!workspaceRoot) return null;
    const dirs: string[] = [];
    if (sourceFilePath) {
      try {
        const resolved = resolveInsideWorkspace(workspaceRoot, sourceFilePath);
        dirs.push(path.dirname(resolved.absPath));
      } catch {
        // ignore
      }
    }
    const resolvedRoot = path.resolve(workspaceRoot);
    if (!dirs.includes(resolvedRoot)) {
      dirs.push(resolvedRoot);
    }
    return dirs.join(path.delimiter);
  }

  async convert(params: FormatConvertParams): Promise<ConvertOutputArtifact> {
    const { inputFormat, outputFormat, options = {} } = params;
    const warnings: string[] = [];
    const fileName = deriveOutputFileName(params.sourceFilePath, outputFormat);
    const mimeType = MIME_TYPES[outputFormat];

    // Disallow compiling to PDF inside FormatHub (handled by @novatex/compiler)
    if (outputFormat === 'pdf' && inputFormat !== 'pdf') {
      throw new Error('生成正式编译 PDF 请使用 @novatex/compiler（XeLaTeX / pdfLaTeX 编译器），FormatHub 负责四层源码与文档格式互转。');
    }

    // Same-format passthrough (with optional LaTeX flattening)
    if (inputFormat === outputFormat) {
      if (inputFormat === 'docx' || inputFormat === 'pdf') {
        const buf = this.loadBinarySource(params);
        return {
          format: outputFormat,
          fileName,
          mimeType,
          base64: buf.toString('base64'),
          byteLength: buf.byteLength,
          warnings,
        };
      }
      const text =
        inputFormat === 'tex'
          ? this.resolveLatexInput(params, warnings).latexText
          : this.loadTextSource(params);
      const plainForCount = stripToCleanPlainText(text, inputFormat);
      return {
        format: outputFormat,
        fileName,
        mimeType,
        text,
        byteLength: Buffer.byteLength(text, 'utf8'),
        wordCount: countAcademicWords(plainForCount),
        warnings,
      };
    }

    // PDF input path (lightweight pdfjs-dist extraction, zero heavy OCR)
    if (inputFormat === 'pdf') {
      const pdfBuf = this.loadBinarySource(params);
      const draft = await extractPdfDraft(pdfBuf, { title: options.title });
      warnings.push(...draft.warnings);

      if (outputFormat === 'md') {
        return {
          format: 'md',
          fileName,
          mimeType,
          text: draft.markdown,
          byteLength: Buffer.byteLength(draft.markdown, 'utf8'),
          wordCount: countAcademicWords(draft.plainText),
          warnings,
        };
      }
      if (outputFormat === 'txt') {
        return {
          format: 'txt',
          fileName,
          mimeType,
          text: draft.plainText,
          byteLength: Buffer.byteLength(draft.plainText, 'utf8'),
          wordCount: countAcademicWords(draft.plainText),
          warnings,
        };
      }
      // pdf -> tex or pdf -> docx via intermediate extracted Markdown
      const subResult = await this.convert({
        inputFormat: 'md',
        outputFormat,
        inputContent: draft.markdown,
        workspaceRoot: params.workspaceRoot,
        sourceFilePath: params.sourceFilePath,
        options,
      });
      return {
        ...subResult,
        fileName,
        warnings: [...warnings, ...subResult.warnings],
      };
    }

    const pandocInfo = await this.getPandocInfo();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'novatex-hub-'));

    try {
      // ------------------------------------------------------------------
      // 1. Plain Text export: tex | md | docx -> txt
      // ------------------------------------------------------------------
      if (outputFormat === 'txt') {
        if (inputFormat === 'tex') {
          const { latexText } = this.resolveLatexInput(params, warnings);
          let cleanText: string;
          if (pandocInfo.available) {
            const res = await runPandoc(
              pandocInfo,
              ['-f', 'latex', '-t', 'plain', '--wrap=none'],
              { input: latexText, timeoutMs: this.timeoutMs },
            );
            warnings.push(...parsePandocWarnings(res.stderr));
            cleanText = stripToCleanPlainText(res.stdout, 'txt');
          } else {
            warnings.push('未检测到 Pandoc，已自动降级为内置纯文本提取器。');
            cleanText = stripToCleanPlainText(latexText, 'tex');
          }
          return {
            format: 'txt',
            fileName,
            mimeType,
            text: cleanText,
            byteLength: Buffer.byteLength(cleanText, 'utf8'),
            wordCount: countAcademicWords(cleanText),
            warnings,
            pandocVersion: pandocInfo.version ?? undefined,
          };
        }

        if (inputFormat === 'md') {
          const mdText = this.loadTextSource(params);
          let cleanText: string;
          if (pandocInfo.available) {
            const res = await runPandoc(
              pandocInfo,
              ['-f', getCleanMarkdownInputFormat(), '-t', 'plain', '--wrap=none'],
              { input: mdText, timeoutMs: this.timeoutMs },
            );
            warnings.push(...parsePandocWarnings(res.stderr));
            cleanText = stripToCleanPlainText(res.stdout, 'txt');
          } else {
            warnings.push('未检测到 Pandoc，已自动降级为内置纯文本提取器。');
            cleanText = stripToCleanPlainText(mdText, 'md');
          }
          return {
            format: 'txt',
            fileName,
            mimeType,
            text: cleanText,
            byteLength: Buffer.byteLength(cleanText, 'utf8'),
            wordCount: countAcademicWords(cleanText),
            warnings,
            pandocVersion: pandocInfo.version ?? undefined,
          };
        }

        if (inputFormat === 'docx') {
          const docxBuf = this.loadBinarySource(params);
          const inDocx = path.join(tmpDir, 'input.docx');
          fs.writeFileSync(inDocx, docxBuf);
          const trackChanges = normalizeTrackChanges(options.trackChanges);
          const res = await runPandoc(
            pandocInfo,
            ['-f', 'docx', '-t', 'plain', `--track-changes=${trackChanges}`, '--wrap=none', inDocx],
            { timeoutMs: this.timeoutMs },
          );
          warnings.push(...parsePandocWarnings(res.stderr));
          const cleanText = stripToCleanPlainText(res.stdout, 'txt');
          return {
            format: 'txt',
            fileName,
            mimeType,
            text: cleanText,
            byteLength: Buffer.byteLength(cleanText, 'utf8'),
            wordCount: countAcademicWords(cleanText),
            warnings,
            pandocVersion: pandocInfo.version ?? undefined,
          };
        }
      }

      // ------------------------------------------------------------------
      // 2. LaTeX -> Markdown (preserves $math$ and [@bibkey], NO --citeproc)
      // ------------------------------------------------------------------
      if (inputFormat === 'tex' && outputFormat === 'md') {
        const { latexText } = this.resolveLatexInput(params, warnings);
        const luaFilter = resolveLuaFilterPath('academic-md.lua');
        const args = [
          '-f',
          'latex',
          '-t',
          getCleanMarkdownTargetFormat(),
          '--wrap=none',
          `--lua-filter=${luaFilter}`,
        ];
        const res = await runPandoc(pandocInfo, args, {
          input: latexText,
          cwd: params.workspaceRoot ? path.resolve(params.workspaceRoot) : undefined,
          timeoutMs: this.timeoutMs,
        });
        warnings.push(...parsePandocWarnings(res.stderr));
        const cleanMd = postProcessMarkdownOutput(res.stdout);
        return {
          format: 'md',
          fileName,
          mimeType,
          text: cleanMd,
          byteLength: Buffer.byteLength(cleanMd, 'utf8'),
          wordCount: countAcademicWords(stripToCleanPlainText(cleanMd, 'md')),
          warnings,
          pandocVersion: pandocInfo.version ?? undefined,
        };
      }

      // ------------------------------------------------------------------
      // 3. Markdown -> LaTeX ([@bibkey] -> \cite{bibkey}, bodyOnly default true)
      // ------------------------------------------------------------------
      if (inputFormat === 'md' && outputFormat === 'tex') {
        const mdText = this.loadTextSource(params);
        const luaFilter = resolveLuaFilterPath('academic-latex.lua');
        const citationFormat = options.citationFormat ?? 'natbib';
        const preserveCitations = options.preserveCitations !== false;
        const citeMode = preserveCitations && citationFormat !== 'biblatex' ? 'cite' : 'native';

        const args = [
          '-f',
          getCleanMarkdownInputFormat(),
          '-t',
          'latex',
          '--wrap=none',
          citationFormat === 'biblatex' ? '--biblatex' : '--natbib',
          `-M`,
          `novatex_cite_mode=${citeMode}`,
          `--lua-filter=${luaFilter}`,
        ];

        const res = await runPandoc(pandocInfo, args, {
          input: mdText,
          timeoutMs: this.timeoutMs,
        });
        warnings.push(...parsePandocWarnings(res.stderr));

        const bodyLatex = postProcessLatexOutput(res.stdout, {
          normalizeCitepToCite: preserveCitations && citationFormat !== 'biblatex',
        });

        const bodyOnly = options.bodyOnly !== false;
        const finalLatex = bodyOnly
          ? bodyLatex
          : wrapBodyWithTemplate(bodyLatex, options.template ?? 'clean-article', {
              title: options.title,
              bibFile: options.bibFile,
              citationFormat,
            });

        return {
          format: 'tex',
          fileName,
          mimeType,
          text: finalLatex,
          byteLength: Buffer.byteLength(finalLatex, 'utf8'),
          wordCount: countAcademicWords(stripToCleanPlainText(bodyLatex, 'tex')),
          warnings,
          pandocVersion: pandocInfo.version ?? undefined,
        };
      }

      // ------------------------------------------------------------------
      // 4. LaTeX | Markdown | TXT -> DOCX (native OMML math + --citeproc + academic reference.docx)
      // ------------------------------------------------------------------
      if (
        (inputFormat === 'tex' || inputFormat === 'md' || inputFormat === 'txt') &&
        outputFormat === 'docx'
      ) {
        let sourceText: string;
        let discoveredBibFiles: string[] = [];

        if (inputFormat === 'tex') {
          const resolvedLatex = this.resolveLatexInput(params, warnings);
          sourceText = resolvedLatex.latexText;
          discoveredBibFiles = resolvedLatex.discoveredBibFiles;
        } else {
          sourceText = this.loadTextSource(params);
        }

        const referenceDocxPath = ensureAcademicReferenceDocx(this.cacheDir);
        const outDocxPath = path.join(tmpDir, 'output.docx');
        const bibAbsPath = this.resolveBibAbsPath(
          params.workspaceRoot,
          options.bibFile,
          discoveredBibFiles,
          warnings,
        );
        const resourcePath = this.buildResourcePath(params.workspaceRoot, params.sourceFilePath);

        const fromFmt =
          inputFormat === 'tex'
            ? 'latex'
            : inputFormat === 'md'
              ? getCleanMarkdownInputFormat()
              : 'markdown-tex_math_dollars-raw_tex';

        const args = [
          '-f',
          fromFmt,
          '-t',
          'docx',
          `--reference-doc=${referenceDocxPath}`,
          '-o',
          outDocxPath,
        ];

        if (bibAbsPath) {
          args.push(...buildCiteprocArgs(pandocInfo, bibAbsPath));
        }
        if (resourcePath) {
          args.push(`--resource-path=${resourcePath}`);
        }
        if (options.title?.trim()) {
          args.push('-M', `title=${options.title.trim()}`);
        }

        const res = await runPandoc(pandocInfo, args, {
          input: sourceText,
          cwd: params.workspaceRoot ? path.resolve(params.workspaceRoot) : undefined,
          timeoutMs: this.timeoutMs,
        });
        warnings.push(...parsePandocWarnings(res.stderr));

        const docxBuf = fs.readFileSync(outDocxPath);
        return {
          format: 'docx',
          fileName,
          mimeType,
          base64: docxBuf.toString('base64'),
          byteLength: docxBuf.byteLength,
          warnings,
          pandocVersion: pandocInfo.version ?? undefined,
        };
      }

      // ------------------------------------------------------------------
      // 5. DOCX -> LaTeX | Markdown (OMML -> $math$, --extract-media, --track-changes)
      // ------------------------------------------------------------------
      if (inputFormat === 'docx' && (outputFormat === 'tex' || outputFormat === 'md')) {
        const docxBuf = this.loadBinarySource(params);
        const inDocxPath = path.join(tmpDir, 'input.docx');
        const tmpMediaDir = path.join(tmpDir, 'extracted-media');
        fs.writeFileSync(inDocxPath, docxBuf);
        fs.mkdirSync(tmpMediaDir, { recursive: true });

        // Validate mediaDir early before running Pandoc if user explicitly passed one
        if (options.mediaDir?.trim()) {
          normalizeProjectRelPath(options.mediaDir.trim());
        }

        const trackChanges = normalizeTrackChanges(options.trackChanges);
        const luaFilter = resolveLuaFilterPath(
          outputFormat === 'tex' ? 'academic-latex.lua' : 'academic-md.lua',
        );

        const args = [
          '-f',
          'docx',
          '-t',
          outputFormat === 'tex' ? 'latex' : getCleanMarkdownTargetFormat(),
          `--track-changes=${trackChanges}`,
          `--extract-media=${tmpMediaDir}`,
          '--wrap=none',
          `--lua-filter=${luaFilter}`,
          inDocxPath,
        ];

        const res = await runPandoc(pandocInfo, args, {
          timeoutMs: this.timeoutMs,
        });
        warnings.push(...parsePandocWarnings(res.stderr));

        let outputText =
          outputFormat === 'tex'
            ? postProcessLatexOutput(res.stdout, { normalizeCitepToCite: true })
            : postProcessMarkdownOutput(res.stdout);

        const mediaProcessed = collectAndRewriteExtractedMedia(
          outputText,
          tmpMediaDir,
          params.workspaceRoot,
          options.mediaDir,
          warnings,
        );
        outputText = mediaProcessed.text;

        let finalText = outputText;
        if (outputFormat === 'tex' && options.bodyOnly === false) {
          finalText = wrapBodyWithTemplate(outputText, options.template ?? 'clean-article', {
            title: options.title,
            bibFile: options.bibFile,
            citationFormat: options.citationFormat,
          });
        }

        const plainForCount = stripToCleanPlainText(outputText, outputFormat);
        return {
          format: outputFormat,
          fileName,
          mimeType,
          text: finalText,
          byteLength: Buffer.byteLength(finalText, 'utf8'),
          extractedMedia: mediaProcessed.extractedMedia,
          wordCount: countAcademicWords(plainForCount),
          warnings,
          pandocVersion: pandocInfo.version ?? undefined,
        };
      }

      // ------------------------------------------------------------------
      // 6. TXT -> Markdown | LaTeX
      // ------------------------------------------------------------------
      if (inputFormat === 'txt' && (outputFormat === 'md' || outputFormat === 'tex')) {
        const plainText = this.loadTextSource(params).replace(/\r\n/g, '\n').trim();
        if (outputFormat === 'md') {
          return {
            format: 'md',
            fileName,
            mimeType,
            text: plainText,
            byteLength: Buffer.byteLength(plainText, 'utf8'),
            wordCount: countAcademicWords(plainText),
            warnings,
          };
        }
        // txt -> tex: escape safely via Pandoc (or template wrap)
        const escapedBody = pandocInfo.available
          ? postProcessLatexOutput(
              (
                await runPandoc(
                  pandocInfo,
                  ['-f', 'markdown-tex_math_dollars-raw_tex', '-t', 'latex', '--wrap=none'],
                  { input: plainText, timeoutMs: this.timeoutMs },
                )
              ).stdout,
            )
          : plainText
              .replace(/\\/g, '\\textbackslash{}')
              .replace(/([#$%&_{}])/g, '\\$1');

        const finalTex =
          options.bodyOnly === false
            ? wrapBodyWithTemplate(escapedBody, options.template ?? 'clean-article', {
                title: options.title,
                bibFile: options.bibFile,
                citationFormat: options.citationFormat,
              })
            : escapedBody;

        return {
          format: 'tex',
          fileName,
          mimeType,
          text: finalTex,
          byteLength: Buffer.byteLength(finalTex, 'utf8'),
          wordCount: countAcademicWords(plainText),
          warnings,
          pandocVersion: pandocInfo.version ?? undefined,
        };
      }

      throw new Error(`不支持的格式转换路径: ${inputFormat} -> ${outputFormat}`);
    } finally {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore temp cleanup failure
      }
    }
  }
}
