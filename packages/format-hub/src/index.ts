export { countAcademicWords, stripToCleanPlainText } from './word-count.js';
export {
  flattenLatexProject,
  extractLatexOutline,
  type FlattenLatexResult,
} from './latex-flattener.js';
export {
  buildAcademicReferenceDocxBuffer,
  ensureAcademicReferenceDocx,
} from './reference-docx.js';
export {
  ACADEMIC_TEMPLATES,
  wrapBodyWithTemplate,
  previewSectionMerge,
  type AcademicTemplateDefinition,
} from './templates.js';
export { extractPdfDraft, type PdfDraftExtractionResult } from './pdf-extract.js';
export {
  detectPandoc,
  resolveLuaFilterPath,
  buildCiteprocArgs,
  getCleanMarkdownTargetFormat,
  getCleanMarkdownInputFormat,
  runPandoc,
  type PandocInfo,
  type PandocRunResult,
} from './pandoc-runner.js';
export {
  FormatHub,
  type FormatConvertParams,
  type FormatHubOptions,
} from './format-hub.js';
