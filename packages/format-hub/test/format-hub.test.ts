import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ACADEMIC_TEMPLATES,
  FormatHub,
  buildCiteprocArgs,
  countAcademicWords,
  detectPandoc,
  ensureAcademicReferenceDocx,
  extractLatexOutline,
  flattenLatexProject,
  previewSectionMerge,
  resolveLuaFilterPath,
  runPandoc,
  stripToCleanPlainText,
  wrapBodyWithTemplate,
} from '../src/index.js';

// Minimal valid 1x1 transparent PNG
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

/**
 * Build a minimal, spec-compliant PDF 1.4 buffer with selectable Helvetica text
 * so we can verify real `pdfjs-dist` extraction without shipping binary fixtures.
 */
function buildMinimalPdfBuffer(lines: string[]): Buffer {
  const escapedLines = lines.map((l) =>
    l.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)'),
  );
  const streamOps = [
    'BT',
    '/F1 12 Tf',
    '72 720 Td',
    ...escapedLines.flatMap((line, idx) =>
      idx === 0 ? [`(${line}) Tj`] : ['0 -24 Td', `(${line}) Tj`],
    ),
    'ET',
  ].join('\n');

  const objects: string[] = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n',
    `4 0 obj\n<< /Length ${Buffer.byteLength(streamOps, 'utf8')} >>\nstream\n${streamOps}\nendstream\nendobj\n`,
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
  ];

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [0];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(pdf, 'utf8'));
    pdf += obj;
  }
  const xrefPos = Buffer.byteLength(pdf, 'utf8');
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (let i = 1; i <= objects.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  return Buffer.from(pdf, 'utf8');
}

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup error
    }
  }
});

describe('@novatex/format-hub', () => {
  it('1. detects real Pandoc binary on this machine and parses version', async () => {
    const info = await detectPandoc();
    expect(info.available).toBe(true);
    expect(info.binary).toBeTruthy();
    expect(info.version).toMatch(/^\d+\.\d+/);
    expect(info.major).toBeGreaterThanOrEqual(2);

    // Version-adaptive citeproc flag check for both Pandoc 2.12 and Pandoc 3.x (plus legacy <2.11)
    expect(buildCiteprocArgs({ available: true, version: '2.12', major: 2, minor: 12, binary: 'pandoc' }, 'refs.bib')).toEqual([
      '--citeproc',
      '--bibliography=refs.bib',
    ]);
    expect(buildCiteprocArgs({ available: true, version: '3.1.11', major: 3, minor: 1, binary: 'pandoc' }, 'refs.bib')).toEqual([
      '--citeproc',
      '--bibliography=refs.bib',
    ]);
    expect(buildCiteprocArgs({ available: true, version: '2.9', major: 2, minor: 9, binary: 'pandoc' }, 'refs.bib')).toEqual([
      '--filter=pandoc-citeproc',
      '--bibliography=refs.bib',
    ]);
  });

  it('2. accurately counts bilingual academic words and strips LaTeX/Markdown markup cleanly', () => {
    const sample = '基于 Transformer 的 state-of-the-art 模型在 2025 年达到 95.6% 准确率。\n第二行 ResNet50 测试。';
    const stats = countAcademicWords(sample);

    // CJK chars: 基 于 的 模 型 在 年 达 到 准 确 率 (12) + 第 二 行 测 试 (5) = 17
    expect(stats.cjkChars).toBe(17);
    // Latin words: Transformer, state-of-the-art, ResNet50 = 3
    expect(stats.latinWords).toBe(3);
    // Standalone numbers: 2025, 95.6% = 2 (50 inside ResNet50 must NOT be double-counted!)
    expect(stats.numbers).toBe(2);
    expect(stats.totalAcademicWords).toBe(stats.cjkChars + stats.latinWords + stats.numbers);
    expect(stats.totalAcademicWords).toBe(22);
    expect(stats.lines).toBe(2);
    expect(stats.nonEmptyLines).toBe(2);
    expect(stats.charactersNoSpaces).toBeGreaterThan(25);

    const rawTex = String.raw`\documentclass{article}
\usepackage{amsmath}
\title{中文论文}
\begin{document}
% This comment must disappear
\section{引言}\label{sec:intro}
本文提出了一种\textbf{高效\emph{方法}} \cite{vaswani2017}，准确率提升了 12.5\%。
\end{document}`;
    const stripped = stripToCleanPlainText(rawTex, 'tex');
    expect(stripped).toContain('中文论文');
    expect(stripped).toContain('引言');
    expect(stripped).toContain('高效方法');
    expect(stripped).toContain('12.5%');
    expect(stripped).not.toContain('This comment must disappear');
    expect(stripped).not.toMatch(/\\(section|textbf|emph|cite|label|documentclass|begin|end)\b/);
  });

  it('3. flattens multi-file LaTeX, detects .bib, extracts outline, and blocks traversal/cycles', () => {
    const parentDir = createTempDir('novatex-flat-parent-');
    const ws = path.join(parentDir, 'workspace');
    fs.mkdirSync(path.join(ws, 'sections'), { recursive: true });

    // Outside secret file that MUST NEVER be read
    fs.writeFileSync(path.join(parentDir, 'outside-secret.tex'), 'TOP_SECRET_LEAK_TOKEN', 'utf8');

    fs.writeFileSync(
      path.join(ws, 'refs.bib'),
      `@article{vaswani2017, title={Attention Is All You Need}, author={Vaswani, Ashish}, year={2017}}`,
      'utf8',
    );
    fs.writeFileSync(
      path.join(ws, 'sections', 'intro.tex'),
      `\\section{Introduction}\nHello from intro.\n\\subsection{Motivation}\nDetails here.\n`,
      'utf8',
    );
    fs.writeFileSync(
      path.join(ws, 'sections', 'cycleA.tex'),
      `\\section{Cycle A}\n\\input{sections/cycleB}\n`,
      'utf8',
    );
    fs.writeFileSync(
      path.join(ws, 'sections', 'cycleB.tex'),
      `\\subsection{Cycle B}\n\\input{sections/cycleA}\n`,
      'utf8',
    );
    fs.writeFileSync(
      path.join(ws, 'main.tex'),
      [
        '\\documentclass{article}',
        '\\begin{document}',
        '% \\input{sections/commented_out}',
        '\\input{sections/intro}',
        '\\input{../outside-secret}',
        '\\input{/etc/passwd}',
        '\\input{sections/cycleA}',
        '\\bibliography{refs}',
        '\\end{document}',
      ].join('\n'),
      'utf8',
    );

    const flat = flattenLatexProject(ws, 'main.tex');
    expect(flat.flattenedTex).toContain('Hello from intro.');
    expect(flat.flattenedTex).toContain('\\subsection{Cycle B}');
    expect(flat.flattenedTex).not.toContain('TOP_SECRET_LEAK_TOKEN');
    expect(flat.includedFiles).toEqual([
      'sections/intro.tex',
      'sections/cycleA.tex',
      'sections/cycleB.tex',
    ]);
    expect(flat.bibFiles).toEqual(['refs.bib']);
    // Must warn on ../outside-secret, /etc/passwd, and cyclic include
    expect(flat.warnings.some((w) => w.includes('outside-secret'))).toBe(true);
    expect(flat.warnings.some((w) => w.includes('/etc/passwd'))).toBe(true);
    expect(flat.warnings.some((w) => w.includes('循环引用'))).toBe(true);
    // Must NOT warn on commented-out \input
    expect(flat.warnings.some((w) => w.includes('commented_out'))).toBe(false);

    const outline = extractLatexOutline(ws, 'main.tex');
    expect(outline).toEqual([
      { level: 2, command: 'section', title: 'Introduction', file: 'sections/intro.tex', line: 1 },
      { level: 3, command: 'subsection', title: 'Motivation', file: 'sections/intro.tex', line: 3 },
      { level: 2, command: 'section', title: 'Cycle A', file: 'sections/cycleA.tex', line: 1 },
      { level: 3, command: 'subsection', title: 'Cycle B', file: 'sections/cycleB.tex', line: 1 },
    ]);
  });

  it('4. preserves citations and math losslessly in tex -> md -> tex round-trip and formats tables/images', async () => {
    const cacheDir = createTempDir('novatex-cache-');
    const hub = new FormatHub({ cacheDir });

    const originalTex = String.raw`\documentclass{article}
\begin{document}
\section{Introduction}
Transformers \cite{vaswani2017} satisfy $E = mc^2$ and:
$$
\sum_{i=1}^n x_i^2 = 1
$$

\begin{itemize}
\item First item
\item Second item
\end{itemize}
\end{document}
`;

    // tex -> md (NO citeproc, citations stay as [@vaswani2017])
    const mdArtifact = await hub.convert({
      inputFormat: 'tex',
      outputFormat: 'md',
      inputContent: originalTex,
      sourceFilePath: 'paper.tex',
    });

    expect(mdArtifact.format).toBe('md');
    expect(mdArtifact.text).toContain('[@vaswani2017]');
    expect(mdArtifact.text).toContain('$E = mc^2$');
    expect(mdArtifact.text).toContain('\\sum_{i=1}^n x_i^2 = 1');
    expect(mdArtifact.text).not.toContain('{.unnumbered}');
    expect(mdArtifact.text).not.toContain(':::');
    expect(mdArtifact.pandocVersion).toBeTruthy();

    // Add a table + unstyled image in Markdown before converting back to LaTeX
    const enrichedMd = `${mdArtifact.text}

| Method | Accuracy |
| ------ | -------- |
| Ours   | 96.4%    |

![System Architecture](figures/arch.png)
`;

    // md -> tex (bodyOnly default true)
    const texArtifact = await hub.convert({
      inputFormat: 'md',
      outputFormat: 'tex',
      inputContent: enrichedMd,
      sourceFilePath: 'paper.md',
    });

    expect(texArtifact.format).toBe('tex');
    expect(texArtifact.text).toContain('\\cite{vaswani2017}');
    expect(texArtifact.text).toContain('$E = mc^2$');
    expect(texArtifact.text).toContain('$$');
    expect(texArtifact.text).toContain('\\sum_{i=1}^n x_i^2 = 1');
    expect(texArtifact.text).not.toContain('\\tightlist');
    expect(texArtifact.text).not.toContain('\\hypertarget');
    expect(texArtifact.text).not.toContain('\\documentclass');
    // Booktabs table enhancement
    expect(texArtifact.text).toContain('\\toprule');
    expect(texArtifact.text).toContain('\\midrule');
    expect(texArtifact.text).toContain('\\bottomrule');
    // Image width normalized cleanly
    expect(texArtifact.text).toContain('0.85\\linewidth');

    // md -> tex standalone with Chinese ctex template
    const fullTex = await hub.convert({
      inputFormat: 'md',
      outputFormat: 'tex',
      inputContent: mdArtifact.text!,
      options: {
        bodyOnly: false,
        template: 'chinese-ctex',
        title: '基于注意力机制的脑电信号解码',
        bibFile: 'refs.bib',
      },
    });
    expect(fullTex.text).toContain('\\documentclass[12pt,a4paper]{ctexart}');
    expect(fullTex.text).toContain('\\bibliography{refs}');
    // Ensure $$ inside body was NOT collapsed to $ by String.replace
    expect(fullTex.text).toContain('$$');
    expect(fullTex.text).toContain('\\sum_{i=1}^n x_i^2 = 1');

    // Verify all 3 built-in templates wrap properly
    for (const tplId of Object.keys(ACADEMIC_TEMPLATES) as Array<keyof typeof ACADEMIC_TEMPLATES>) {
      const wrapped = wrapBodyWithTemplate('Body $$x^2$$', tplId, { title: 'Test' });
      expect(wrapped).toContain('\\begin{document}');
      expect(wrapped).toContain('Body $$x^2$$');
      expect(wrapped).toContain('\\end{document}');
    }

    // Multi-citation round-trip + biblatex mode check
    const multiCiteTex = await hub.convert({
      inputFormat: 'md',
      outputFormat: 'tex',
      inputContent: 'See [@vaswani2017; @devlin2019] for details.',
    });
    expect(multiCiteTex.text).toContain('\\cite{vaswani2017,devlin2019}');

    const biblatexTex = await hub.convert({
      inputFormat: 'md',
      outputFormat: 'tex',
      inputContent: 'See [@vaswani2017] for details.',
      options: { citationFormat: 'biblatex' },
    });
    expect(biblatexTex.text).toContain('\\autocite{vaswani2017}');
  });

  it('5. performs real Word OMML + citeproc + bilingual reference.docx round-trip (tex -> docx -> md / tex)', async () => {
    const ws = createTempDir('novatex-docx-ws-');
    const cacheDir = createTempDir('novatex-docx-cache-');

    // Verify programmatic reference.docx first
    const refPath = ensureAcademicReferenceDocx(cacheDir);
    expect(fs.existsSync(refPath)).toBe(true);
    const refEntries = unzipSync(new Uint8Array(fs.readFileSync(refPath)));
    expect(Object.keys(refEntries)).toEqual(
      expect.arrayContaining([
        '[Content_Types].xml',
        '_rels/.rels',
        'word/document.xml',
        'word/styles.xml',
        'word/settings.xml',
        'word/fontTable.xml',
      ]),
    );
    const refStyles = Buffer.from(refEntries['word/styles.xml']!).toString('utf8');
    expect(refStyles).toContain('Times New Roman');
    expect(refStyles).toContain('SimSun');
    expect(refStyles).toContain('SimHei');
    expect(refStyles).toContain('w:styleId="TableCaption"');
    expect(refStyles).toContain('w:styleId="FigureCaption"');
    expect(refStyles).toContain('w:styleId="Bibliography"');
    expect(refStyles).toContain('w:styleId="Abstract"');

    // Prepare workspace with paper.tex, refs.bib, and a real PNG figure
    fs.writeFileSync(
      path.join(ws, 'refs.bib'),
      `@inproceedings{vaswani2017,
  title={Attention Is All You Need},
  author={Vaswani, Ashish and Shazeer, Noam},
  booktitle={Advances in Neural Information Processing Systems},
  year={2017}
}
`,
      'utf8',
    );
    fs.writeFileSync(path.join(ws, 'fig1.png'), Buffer.from(TINY_PNG_BASE64, 'base64'));
    fs.writeFileSync(
      path.join(ws, 'paper.tex'),
      String.raw`\documentclass{article}
\usepackage{graphicx}
\begin{document}
\section{实验与方法}
本文采用 Transformer 模型 \cite{vaswani2017}，能量关系满足 $E = mc^2$，目标函数为：
$$
\sum_{i=1}^n x_i = 1
$$

\begin{figure}
\centering
\includegraphics{fig1.png}
\caption{Model overview}
\end{figure}

\bibliography{refs}
\end{document}
`,
      'utf8',
    );

    const hub = new FormatHub({ cacheDir });

    // tex -> docx
    const docxArtifact = await hub.convert({
      inputFormat: 'tex',
      outputFormat: 'docx',
      workspaceRoot: ws,
      sourceFilePath: 'paper.tex',
    });

    expect(docxArtifact.format).toBe('docx');
    expect(docxArtifact.base64).toBeTruthy();
    expect(docxArtifact.byteLength).toBeGreaterThan(2000);

    const docxBuf = Buffer.from(docxArtifact.base64!, 'base64');
    const entries = unzipSync(new Uint8Array(docxBuf));
    expect(entries['word/document.xml']).toBeDefined();
    const docXml = Buffer.from(entries['word/document.xml']!).toString('utf8');
    // Native Word OMML equations MUST be embedded
    expect(docXml).toContain('m:oMath');
    // Rendered bibliography via --citeproc MUST appear
    expect(docXml).toContain('Vaswani');
    expect(docXml).toContain('Attention Is All You Need');
    // Bilingual text preserved
    expect(docXml).toContain('实验与方法');
    // Embedded figure inside word/media/
    expect(Object.keys(entries).some((k) => k.startsWith('word/media/'))).toBe(true);
    // Bilingual styles carried from our reference.docx
    const outStyles = Buffer.from(entries['word/styles.xml']!).toString('utf8');
    expect(outStyles).toContain('SimSun');
    expect(outStyles).toContain('Times New Roman');

    // docx -> md (with workspace media extraction)
    const mdBack = await hub.convert({
      inputFormat: 'docx',
      outputFormat: 'md',
      inputBuffer: docxBuf,
      workspaceRoot: ws,
      options: { mediaDir: 'extracted_media', trackChanges: 'accept' },
    });

    expect(mdBack.format).toBe('md');
    expect(mdBack.text).toContain('实验与方法');
    expect(mdBack.text).toMatch(/\$E\s*=\s*mc\^\{?2\}?\$/);
    expect(mdBack.text).toContain('$$');
    expect(mdBack.extractedMedia && mdBack.extractedMedia.length).toBeGreaterThan(0);
    const firstMedia = mdBack.extractedMedia![0]!;
    expect(firstMedia.relativePath.startsWith('extracted_media/')).toBe(true);
    expect(fs.existsSync(path.join(ws, firstMedia.relativePath))).toBe(true);
    expect(mdBack.text).toContain(firstMedia.relativePath);
    // Must never leak temp dir path
    expect(mdBack.text).not.toContain('novatex-hub-');

    // docx -> tex
    const texBack = await hub.convert({
      inputFormat: 'docx',
      outputFormat: 'tex',
      inputBuffer: docxBuf,
      workspaceRoot: ws,
      options: { mediaDir: 'tex_media', trackChanges: 'accept' },
    });

    expect(texBack.format).toBe('tex');
    expect(texBack.text).toContain('\\section{实验与方法}');
    expect(texBack.text).toMatch(/\$E\s*=\s*mc\^\{?2\}?\$/);
    expect(texBack.text).toContain('$$');
    expect(texBack.text).not.toContain('\\hypertarget');
    expect(texBack.text).not.toContain('\\tightlist');
    expect(texBack.text).toContain('tex_media/');
    expect(texBack.text).not.toContain('novatex-hub-');

    // Negative security control: mediaDir traversal MUST be rejected
    await expect(
      hub.convert({
        inputFormat: 'docx',
        outputFormat: 'tex',
        inputBuffer: docxBuf,
        workspaceRoot: ws,
        options: { mediaDir: '../escape_dir' },
      }),
    ).rejects.toThrow(/越界/);
  });

  it('6. exports clean plain text with zero LaTeX commands and accurate bilingual word count', async () => {
    const cacheDir = createTempDir('novatex-txt-cache-');
    const hub = new FormatHub({ cacheDir });

    const texInput = String.raw`\documentclass{article}
\usepackage{amsmath}
\begin{document}
\section{研究背景}
深度学习模型在 2025 年取得了 98.2\% 的准确率 \cite{lecun2015}。
\textbf{核心结论}：我们的方法速度快且稳定。
\end{document}
`;

    const txtArtifact = await hub.convert({
      inputFormat: 'tex',
      outputFormat: 'txt',
      inputContent: texInput,
      sourceFilePath: 'draft.tex',
    });

    expect(txtArtifact.format).toBe('txt');
    expect(txtArtifact.text).toContain('研究背景');
    expect(txtArtifact.text).toContain('深度学习模型');
    expect(txtArtifact.text).toContain('2025');
    expect(txtArtifact.text).toContain('98.2%');
    // Zero LaTeX commands left
    expect(txtArtifact.text).not.toMatch(/\\[A-Za-z]+/);
    expect(txtArtifact.text).not.toContain('$$');
    expect(txtArtifact.wordCount).toBeDefined();
    expect(txtArtifact.wordCount!.cjkChars).toBeGreaterThanOrEqual(25);
    expect(txtArtifact.wordCount!.numbers).toBe(2);
    expect(txtArtifact.wordCount!.totalAcademicWords).toBe(
      txtArtifact.wordCount!.cjkChars +
        txtArtifact.wordCount!.latinWords +
        txtArtifact.wordCount!.numbers,
    );
  });

  it('7. performs section-level partial merge preserving preamble, maketitle, and bibliography with accurate diff', () => {
    const mainTex = [
      '\\documentclass[12pt,a4paper]{ctexart}',
      '\\usepackage{amsmath,booktabs}',
      '\\title{我的毕业论文}',
      '\\author{张三}',
      '\\begin{document}',
      '\\maketitle',
      '',
      '\\section{旧引言}',
      '这是旧的正文内容。',
      '',
      '\\bibliographystyle{plainnat}',
      '\\bibliography{refs}',
      '\\end{document}',
    ].join('\n');

    const incomingBody = [
      '\\section{新引言}',
      '这是从 Markdown 或 Word 同步回来的新正文内容，包含公式 $E = mc^2$。',
    ].join('\n');

    const preview = previewSectionMerge(mainTex, incomingBody, 'main.tex', 'replace-body');

    expect(preview.targetFile).toBe('main.tex');
    // Preamble, \maketitle, and trailing \bibliography MUST remain 100% intact
    expect(preview.mergedCode).toContain('\\documentclass[12pt,a4paper]{ctexart}');
    expect(preview.mergedCode).toContain('\\usepackage{amsmath,booktabs}');
    expect(preview.mergedCode).toContain('\\title{我的毕业论文}');
    expect(preview.mergedCode).toContain('\\maketitle');
    expect(preview.mergedCode).toContain('\\bibliographystyle{plainnat}');
    expect(preview.mergedCode).toContain('\\bibliography{refs}');
    // Body MUST be updated
    expect(preview.mergedCode).toContain('\\section{新引言}');
    expect(preview.mergedCode).not.toContain('\\section{旧引言}');
    // Accurate red/green diff
    expect(preview.diff.additions).toBeGreaterThan(0);
    expect(preview.diff.deletions).toBeGreaterThan(0);
    expect(preview.diff.unifiedDiff).toContain('-\\section{旧引言}');
    expect(preview.diff.unifiedDiff).toContain('+\\section{新引言}');
    expect(preview.warnings).toEqual([]);

    // Chapter fragment file (no \documentclass): must NOT inject preamble, and strips accidental incoming wrapper
    const chapterTex = '\\section{Method}\nOld method paragraph.\n';
    const wrappedIncoming = '\\documentclass{article}\n\\begin{document}\n\\section{Method}\nNew method paragraph.\n\\end{document}';
    const chapterPreview = previewSectionMerge(
      chapterTex,
      wrappedIncoming,
      'sections/method.tex',
      'replace-body',
    );
    expect(chapterPreview.mergedCode).not.toContain('\\documentclass');
    expect(chapterPreview.mergedCode).not.toContain('\\begin{document}');
    expect(chapterPreview.mergedCode).toContain('New method paragraph.');
    expect(chapterPreview.warnings.length).toBe(1);

    // Append-section mode inserts BEFORE bibliography & \end{document}
    const appended = previewSectionMerge(
      mainTex,
      '\\section{实验结论}\n实验结果显著提升。',
      'main.tex',
      'append-section',
    );
    expect(appended.mergedCode).toContain('\\section{旧引言}');
    expect(appended.mergedCode).toContain('\\section{实验结论}');
    const conclIdx = appended.mergedCode.indexOf('\\section{实验结论}');
    const bibIdx = appended.mergedCode.indexOf('\\bibliographystyle{plainnat}');
    expect(conclIdx).toBeGreaterThan(0);
    expect(conclIdx).toBeLessThan(bibIdx);
  });

  it('8. extracts readable Markdown and plain text drafts from PDF via lightweight pdfjs-dist', async () => {
    const cacheDir = createTempDir('novatex-pdf-cache-');
    const hub = new FormatHub({ cacheDir });
    const pdfBuf = buildMinimalPdfBuffer([
      'NovaTeX Lightweight PDF Draft Extraction',
      'Evaluating accuracy of 95.4% across 2025 benchmarks.',
    ]);

    const mdDraft = await hub.convert({
      inputFormat: 'pdf',
      outputFormat: 'md',
      inputBuffer: pdfBuf,
      sourceFilePath: 'sample.pdf',
      options: { title: 'Imported Paper' },
    });

    expect(mdDraft.format).toBe('md');
    expect(mdDraft.text).toContain('# Imported Paper');
    expect(mdDraft.text).toContain('## Page 1');
    expect(mdDraft.text).toContain('NovaTeX Lightweight PDF Draft Extraction');
    expect(mdDraft.text).toContain('95.4%');
    expect(mdDraft.wordCount!.latinWords).toBeGreaterThanOrEqual(8);
    expect(mdDraft.wordCount!.numbers).toBe(2);

    const txtDraft = await hub.convert({
      inputFormat: 'pdf',
      outputFormat: 'txt',
      inputBuffer: pdfBuf,
      sourceFilePath: 'sample.pdf',
    });
    expect(txtDraft.format).toBe('txt');
    expect(txtDraft.text).toContain('NovaTeX Lightweight PDF Draft Extraction');
  });

  it('9. [P2-3 regression] escapes %/#/{/} in table links/labels, validates bibFile, and compiles with real pdflatex', async () => {
    const cacheDir = createTempDir('novatex-p23-cache-');
    const hub = new FormatHub({ cacheDir });

    const mdWithSpecialUrlTable = `# Results

| Reference | Score |
| --------- | ----- |
| [Paper](https://example.com/a%20b#sec_1) | 98.5% |
| [Code](https://example.com/repo/{v1}#top) | 99.1% |
`;

    const texBody = await hub.convert({
      inputFormat: 'md',
      outputFormat: 'tex',
      inputContent: mdWithSpecialUrlTable,
      sourceFilePath: 'table-links.md',
    });

    expect(texBody.format).toBe('tex');
    // % and # and braces inside \href URLs MUST be escaped so LaTeX table row `& ... \\` is never commented out
    expect(texBody.text).toContain('\\href{https://example.com/a\\%20b\\#sec_1}{Paper}');
    expect(texBody.text).toMatch(
      /\\href\{https:\/\/example\.com\/repo\/(\\%7Bv1\\%7D|\\\{v1\\\})\\#top\}\{Code\}/,
    );
    expect(texBody.text).toContain('\\href{https://example.com/a\\%20b\\#sec_1}{Paper} & 98.5\\% \\\\');
    expect(texBody.text).toContain('\\bottomrule');
    expect(texBody.text).toContain('\\end{table}');

    // Verify figure path & label escaping in academic-latex.lua (no unescaped %, #, {, })
    const figTex = await hub.convert({
      inputFormat: 'md',
      outputFormat: 'tex',
      inputContent: '![Test Fig](figures/plot%201#v2.png){#fig:plot_1}\n',
      sourceFilePath: 'fig.md',
    });
    expect(figTex.text).toContain('\\begin{figure}[htbp]');
    expect(figTex.text).toContain('\\includegraphics[width=0.85\\linewidth]{figures/plot_201_v2.png}');
    expect(figTex.text).toContain('\\caption{Test Fig}');
    expect(figTex.text).toContain('\\label{fig:plot_1}');

    // Direct negative control on academic-latex.lua for dirty AST identifiers (e.g. from DOCX/HTML)
    const pandocInfo = await detectPandoc();
    const dirtyIdRes = await runPandoc(
      pandocInfo,
      ['-f', 'html', '-t', 'latex', '--wrap=none', `--lua-filter=${resolveLuaFilterPath('academic-latex.lua')}`],
      { input: '<p><img src="figures/a%20b#1.png" alt="Cap" title="fig:" id="fig:bad%1#2{3}" /></p>' },
    );
    expect(dirtyIdRes.stdout).toContain('\\includegraphics[width=0.85\\linewidth]{figures/a_20b_1.png}');
    expect(dirtyIdRes.stdout).toContain('\\label{fig:bad-1-2-3}');
    expect(dirtyIdRes.stdout).not.toMatch(/\\label\{[^}]*[%#{\\]/);

    // Also verify real pdflatex compilation when local TinyTeX pdflatex is configured via TEX_BIN_DIR or standard paths
    const fullDoc = wrapBodyWithTemplate(texBody.text!, 'clean-article', {
      title: 'Table URL Escaping Regression',
    });
    const pdflatexCandidates = [
      process.env.TEX_BIN_DIR ? path.join(process.env.TEX_BIN_DIR, 'pdflatex.exe') : '',
      process.env.TEX_BIN_DIR ? path.join(process.env.TEX_BIN_DIR, 'pdflatex') : '',
      'C:\\TinyTeX\\bin\\windows\\pdflatex.exe',
      'D:\\TinyTeX\\bin\\windows\\pdflatex.exe',
    ].filter(Boolean);
    const pdflatexBin = pdflatexCandidates.find((p) => fs.existsSync(p));
    if (pdflatexBin) {
      const asciiTmp = createTempDir('novatex-pdflatex-');
      const texFile = path.join(asciiTmp, 'regression.tex');
      fs.writeFileSync(texFile, fullDoc, 'utf8');
      execFileSync(
        pdflatexBin,
        ['-interaction=nonstopmode', '-halt-on-error', 'regression.tex'],
        { cwd: asciiTmp, encoding: 'utf8', stdio: 'pipe' },
      );
      const pdfFile = path.join(asciiTmp, 'regression.pdf');
      expect(fs.existsSync(pdfFile)).toBe(true);
      expect(fs.statSync(pdfFile).size).toBeGreaterThan(1000);
    }

    // Verify wrapBodyWithTemplate rejects malicious/traversal bibFile payloads
    const maliciousBibs = [
      'refs}\\write18{id}',
      '../secret.bib',
      '/etc/passwd',
      'refs%comment.bib',
      'refs{evil}.bib',
      'sub\\refs.bib',
      '.bib',
    ];
    for (const badBib of maliciousBibs) {
      expect(() =>
        wrapBodyWithTemplate('Body', 'clean-article', { bibFile: badBib }),
      ).toThrow();
      expect(() =>
        wrapBodyWithTemplate('Body', 'clean-article', {
          bibFile: badBib,
          citationFormat: 'biblatex',
        }),
      ).toThrow();
    }

    // Valid relative bibFile continues to work cleanly for both natbib and biblatex
    const validNatbib = wrapBodyWithTemplate('Body', 'clean-article', {
      bibFile: 'bib/references.bib',
    });
    expect(validNatbib).toContain('\\bibliography{bib/references}');

    const validBiblatex = wrapBodyWithTemplate('Body', 'clean-article', {
      bibFile: 'bib/references.bib',
      citationFormat: 'biblatex',
    });
    expect(validBiblatex).toContain('\\addbibresource{bib/references.bib}');
  });
});
