import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseLatexLog } from '../src/log-parser.js';

const tempDirs: string[] = [];

function createTempWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novatex-log-parser-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('parseLatexLog', () => {
  it('parses -file-line-error POSIX and Windows paths with normalization', () => {
    const rawLog = [
      'This is XeTeX, Version 3.141592653',
      './main.tex:42: Undefined control sequence.',
      'l.42 \\unknownmacro{hello}',
      'sections\\method.tex:18: Missing $ inserted.',
      'l.18 We compute x_1 + y_2 here.',
    ].join('\n');

    const diags = parseLatexLog(rawLog);
    expect(diags).toHaveLength(2);

    const undef = diags.find((d) => d.code === 'UNDEFINED_CONTROL_SEQUENCE');
    expect(undef).toBeDefined();
    expect(undef?.file).toBe('main.tex');
    expect(undef?.line).toBe(42);
    expect(undef?.severity).toBe('error');
    expect(undef?.titleZh).toContain('\\unknownmacro');

    const math = diags.find((d) => d.code === 'MISSING_MATH_DOLLAR');
    expect(math).toBeDefined();
    expect(math?.file).toBe('sections/method.tex');
    expect(math?.line).toBe(18);
    expect(math?.severity).toBe('error');
    expect(math?.quickFixHintZh).toContain('$');
  });

  it('normalizes absolute Windows paths inside workspaceRoot and extracts 3-line snippet', () => {
    const ws = createTempWorkspace();
    const secDir = path.join(ws, 'sections');
    fs.mkdirSync(secDir, { recursive: true });
    const targetFile = path.join(secDir, 'method.tex');
    fs.writeFileSync(
      targetFile,
      [
        '\\section{Method}',
        'Line two before error.',
        'We test \\badcmd here.',
        'Line four after error.',
        'Line five.',
      ].join('\n'),
      'utf8',
    );

    const rawLog = `${targetFile}:3: Undefined control sequence.\nl.3 We test \\badcmd`;
    const diags = parseLatexLog(rawLog, ws);
    expect(diags).toHaveLength(1);
    expect(diags[0]?.file).toBe('sections/method.tex');
    expect(diags[0]?.line).toBe(3);
    expect(diags[0]?.snippet).toBeDefined();
    expect(diags[0]?.snippet).toContain('2 | Line two before error.');
    expect(diags[0]?.snippet).toContain('> 3 | We test \\badcmd here.');
    expect(diags[0]?.snippet).toContain('4 | Line four after error.');
  });

  it('parses classic ! Error fallback with l.N lines and file stack tracking', () => {
    const rawLog = [
      '(./main.tex',
      '(/usr/local/texlive/texmf-dist/tex/latex/base/article.cls)',
      '(./sections/intro.tex',
      "! LaTeX Error: File 'ctex.sty' not found.",
      '',
      'Type X to quit or <RETURN> to proceed,',
      'l.5 \\usepackage{ctex}',
      '',
      '! LaTeX Error: \\begin{align} on input line 15 ended by \\end{equation}.',
      'l.20 \\end{equation}',
      '',
      '! Extra }, or forgotten $.',
      'l.27 \\textbf{broken}}',
      '',
      '! Runaway argument?',
      '{unclosed heading',
      'l.33 \\section{Next}',
      '',
      '! Package biblatex Error: Incompatible package natbib.',
      'l.40 \\usepackage{biblatex}',
      '',
      '! Package hyperref Warning: Token not allowed in a PDF string (Unicode):',
      '',
      '! Emergency stop.',
      ')',
      ')',
    ].join('\n');

    const diags = parseLatexLog(rawLog);
    const byCode = new Map(diags.map((d) => [d.code, d]));

    expect(byCode.get('MISSING_PACKAGE')).toMatchObject({
      file: 'sections/intro.tex',
      line: 5,
      severity: 'error',
    });
    expect(byCode.get('ENV_MISMATCH')).toMatchObject({
      file: 'sections/intro.tex',
      line: 20,
      severity: 'error',
    });

    const braceErrors = diags.filter((d) => d.code === 'MISSING_BRACE');
    expect(braceErrors).toHaveLength(2);
    expect(braceErrors.map((d) => d.line)).toEqual([27, 33]);

    const hyperrefWarn = diags.find((d) => d.rawMessage.includes('hyperref Warning'));
    expect(hyperrefWarn?.severity).toBe('warning');

    const biblatexErr = diags.find((d) => d.rawMessage.includes('biblatex Error'));
    expect(biblatexErr?.severity).toBe('error');
    expect(biblatexErr?.line).toBe(40);
  });

  it('parses undefined citations, undefined references, Overfull hbox, and CJK engine errors', () => {
    const rawLog = [
      '(./main.tex',
      "LaTeX Warning: Citation 'vaswani2017' on page 1 undefined on input line 25.",
      "LaTeX Warning: Reference 'fig:arch' on page 2 undefined on input line 30.",
      'Overfull \\hbox (14.23456pt too wide) in paragraph at lines 10--12',
      '! Package inputenc Error: Unicode character 中 (U+4E2D) not set up for use with LaTeX.',
      'l.8 标题：中文测试',
      ')',
    ].join('\n');

    const diags = parseLatexLog(rawLog);
    expect(diags.map((d) => d.code)).toEqual([
      'CJK_NEEDS_XELATEX',
      'OVERFULL_HBOX',
      'UNDEFINED_CITATION',
      'UNDEFINED_REF',
    ]);

    // Errors must always be sorted before warnings
    expect(diags[0]?.severity).toBe('error');
    expect(diags[1]?.severity).toBe('warning');
    expect(diags[1]?.line).toBe(10);
    expect(diags[2]?.line).toBe(25);
    expect(diags[3]?.line).toBe(30);
  });

  it('deduplicates identical (file, line, code, rawMessage) entries and sorts errors before warnings', () => {
    const rawLog = [
      '(./main.tex',
      'Overfull \\hbox (5.0pt too wide) in paragraph at lines 10--12',
      'Overfull \\hbox (5.0pt too wide) in paragraph at lines 10--12',
      "LaTeX Warning: Citation 'foo' on page 1 undefined on input line 25.",
      "LaTeX Warning: Citation 'foo' on page 1 undefined on input line 25.",
      './main.tex:42: Undefined control sequence.',
      './main.tex:42: Undefined control sequence.',
      ')',
    ].join('\n');

    const diags = parseLatexLog(rawLog);
    expect(diags).toHaveLength(3);
    expect(diags[0]?.severity).toBe('error');
    expect(diags[0]?.code).toBe('UNDEFINED_CONTROL_SEQUENCE');
    expect(diags[1]?.severity).toBe('warning');
    expect(diags[1]?.code).toBe('OVERFULL_HBOX');
    expect(diags[2]?.severity).toBe('warning');
    expect(diags[2]?.code).toBe('UNDEFINED_CITATION');
  });
});
