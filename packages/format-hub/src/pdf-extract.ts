export interface PdfDraftExtractionResult {
  markdown: string;
  plainText: string;
  pageCount: number;
  warnings: string[];
}

interface PdfTextItemLike {
  str: string;
  transform?: number[];
  width?: number;
  height?: number;
  hasEOL?: boolean;
}

interface VisualLine {
  y: number;
  fontSize: number;
  items: Array<{ x: number; width: number; text: string }>;
}

function reconstructPageText(rawItems: unknown[]): string {
  const textItems: PdfTextItemLike[] = [];
  for (const item of rawItems) {
    if (
      item &&
      typeof item === 'object' &&
      'str' in item &&
      typeof (item as PdfTextItemLike).str === 'string'
    ) {
      textItems.push(item as PdfTextItemLike);
    }
  }

  if (textItems.length === 0) return '';

  const lines: VisualLine[] = [];
  for (const item of textItems) {
    const str = item.str;
    if (!str && !item.hasEOL) continue;

    const transform = Array.isArray(item.transform) ? item.transform : [1, 0, 0, 12, 0, 0];
    const x = typeof transform[4] === 'number' ? transform[4] : 0;
    const y = typeof transform[5] === 'number' ? transform[5] : 0;
    const fontSize = Math.max(
      6,
      Math.abs(typeof item.height === 'number' && item.height > 0 ? item.height : (transform[3] ?? 12)),
    );
    const width = typeof item.width === 'number' ? item.width : 0;

    // Find an existing line within vertical tolerance
    const yTolerance = Math.max(2, fontSize * 0.45);
    let targetLine: VisualLine | undefined;
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 6); i--) {
      if (Math.abs(lines[i]!.y - y) <= yTolerance) {
        targetLine = lines[i];
        break;
      }
    }

    if (!targetLine) {
      targetLine = { y, fontSize, items: [] };
      lines.push(targetLine);
    }

    if (str.length > 0) {
      targetLine.items.push({ x, width, text: str });
    }
  }

  // Sort lines top-to-bottom (higher Y first in PDF coordinate system)
  lines.sort((a, b) => b.y - a.y);

  const renderedLines: Array<{ y: number; fontSize: number; text: string }> = [];
  for (const line of lines) {
    line.items.sort((a, b) => a.x - b.x);
    let text = '';
    let prevEndX: number | null = null;

    for (const seg of line.items) {
      if (prevEndX !== null) {
        const gap = seg.x - prevEndX;
        const needsSpace =
          gap > line.fontSize * 0.18 &&
          !text.endsWith(' ') &&
          !seg.text.startsWith(' ');
        if (needsSpace) {
          text += ' ';
        }
      }
      text += seg.text;
      prevEndX = seg.x + seg.width;
    }

    const cleaned = text.replace(/[ \t]+/g, ' ').trim();
    if (cleaned.length > 0) {
      renderedLines.push({ y: line.y, fontSize: line.fontSize, text: cleaned });
    }
  }

  if (renderedLines.length === 0) return '';

  // Join lines into paragraphs based on vertical spacing
  const paragraphs: string[] = [];
  let currentPara: string[] = [renderedLines[0]!.text];

  for (let i = 1; i < renderedLines.length; i++) {
    const prev = renderedLines[i - 1]!;
    const curr = renderedLines[i]!;
    const dy = Math.abs(prev.y - curr.y);
    const paraThreshold = Math.max(prev.fontSize, curr.fontSize) * 1.65;

    if (dy > paraThreshold) {
      paragraphs.push(currentPara.join('\n'));
      currentPara = [curr.text];
    } else {
      currentPara.push(curr.text);
    }
  }
  paragraphs.push(currentPara.join('\n'));

  return paragraphs.join('\n\n').trim();
}

/**
 * Lightweight, zero-OCR PDF text draft extractor powered by `pdfjs-dist/legacy/build/pdf.mjs`.
 * Safe for constrained servers (e.g. 2C3G) — extracts readable page-structured Markdown and plain text.
 */
export async function extractPdfDraft(
  pdfBuffer: Buffer,
  opts?: { title?: string; maxPages?: number },
): Promise<PdfDraftExtractionResult> {
  if (!pdfBuffer || pdfBuffer.byteLength === 0) {
    throw new Error('PDF 内容为空，无法提取文本草稿');
  }

  const maxPages = opts?.maxPages ?? 200;
  const warnings: string[] = [];

  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(pdfBuffer),
    useSystemFonts: true,
    isEvalSupported: false,
    disableFontFace: true,
    verbosity: 0,
  });

  const doc = await loadingTask.promise;
  try {
    const totalPages = doc.numPages;
    const pagesToRead = Math.min(totalPages, maxPages);
    if (totalPages > maxPages) {
      warnings.push(`PDF 共 ${totalPages} 页，轻量提取模式仅提取前 ${maxPages} 页以控制内存占用。`);
    }

    const mdSections: string[] = [];
    const plainSections: string[] = [];

    if (opts?.title?.trim()) {
      mdSections.push(`# ${opts.title.trim()}`);
      plainSections.push(opts.title.trim());
    }

    let extractedCharCount = 0;
    for (let pageNum = 1; pageNum <= pagesToRead; pageNum++) {
      const page = await doc.getPage(pageNum);
      try {
        const textContent = await page.getTextContent();
        const pageText = reconstructPageText(textContent.items);
        if (pageText.length > 0) {
          extractedCharCount += pageText.length;
          mdSections.push(`## Page ${pageNum}\n\n${pageText}`);
          plainSections.push(pageText);
        }
      } finally {
        page.cleanup();
      }
    }

    if (extractedCharCount === 0) {
      warnings.push(
        '未能从 PDF 中提取到可复制文本（该文件可能为扫描版图片 PDF）；轻量提取模式不含重型 OCR，建议先在本地 OCR 后再导入。',
      );
    }

    return {
      markdown: mdSections.join('\n\n').trim(),
      plainText: plainSections.join('\n\n').trim(),
      pageCount: totalPages,
      warnings,
    };
  } finally {
    await doc.destroy();
  }
}
