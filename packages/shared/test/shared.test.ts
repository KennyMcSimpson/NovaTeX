import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PathSecurityError,
  computeLineDiff,
  computeMinimalTextSplice,
  isBinaryFilePath,
  normalizeProjectRelPath,
  resolveInsideWorkspace,
} from '../src/index.js';

describe('@novatex/shared path safety', () => {
  it('normalizes valid relative POSIX and Windows-slash paths', () => {
    expect(normalizeProjectRelPath('sections\\intro.tex')).toBe('sections/intro.tex');
    expect(normalizeProjectRelPath('./figures//arch.png')).toBe('figures/arch.png');
    expect(normalizeProjectRelPath('main.tex')).toBe('main.tex');
  });

  it('blocks path traversal, absolute paths, .git, reserved names, and .latexmkrc RCE', () => {
    const badInputs = [
      '',
      '   ',
      '../secret.txt',
      'sections/../../etc/passwd',
      '/etc/passwd',
      'C:\\Windows\\system.ini',
      '\\\\server\\share\\file.tex',
      '.git/config',
      '.GIT/config',
      '.Git/hooks/pre-commit',
      'sub/.GIT/HEAD',
      '.gitmodules',
      'sub/.git/HEAD',
      '-version',
      '-shell-escape.tex',
      '&plain.tex',
      'sections/-evil.tex',
      '.latexmkrc',
      '.LATEXMKRC',
      'sections/.latexmkrc',
      'latexmkrc',
      'texmf.cnf',
      '.env',
      'CON.tex',
      'aux',
      'nul.txt',
      'bad\0name.tex',
      'bad:name.tex',
      'trailing.',
      'a'.repeat(201) + '.tex',
    ];
    for (const bad of badInputs) {
      expect(() => normalizeProjectRelPath(bad), `expected reject for ${JSON.stringify(bad)}`).toThrow(
        PathSecurityError,
      );
    }
  });

  it('resolves files inside workspace and blocks dangling symlink escapes', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'novatex-shared-'));
    try {
      const res = resolveInsideWorkspace(tmp, 'sections/method.tex');
      expect(res.relPath).toBe('sections/method.tex');
      expect(res.absPath).toBe(path.resolve(tmp, 'sections/method.tex'));
      expect(isBinaryFilePath('figures/plot.png')).toBe(true);
      expect(isBinaryFilePath('figures/diagram.svg')).toBe(true);
      expect(isBinaryFilePath('main.tex')).toBe(false);

      // Test dangling symlink rejection (create symlink pointing to non-existent outside file if OS permits)
      const outsideTarget = path.join(os.tmpdir(), `novatex-nonexistent-${Date.now()}.txt`);
      const linkPath = path.join(tmp, 'dangling.tex');
      let symlinkCreated = false;
      try {
        fs.symlinkSync(outsideTarget, linkPath, 'file');
        symlinkCreated = true;
      } catch {
        // Windows without Developer Mode may disallow file symlinks; test directory junction fallback
        const outsideDir = path.join(os.tmpdir(), `novatex-nonexistent-dir-${Date.now()}`);
        try {
          fs.symlinkSync(outsideDir, path.join(tmp, 'dangling-dir'), 'junction');
          expect(() => resolveInsideWorkspace(tmp, 'dangling-dir/evil.tex')).toThrow(PathSecurityError);
        } catch {
          // If OS completely forbids creating symlinks/junctions, skip only creation
        }
      }
      if (symlinkCreated) {
        expect(() => resolveInsideWorkspace(tmp, 'dangling.tex')).toThrow(PathSecurityError);
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('@novatex/shared diff utilities', () => {
  it('computes accurate additions, deletions, and unified diff', () => {
    const oldText = ['\\documentclass{article}', '\\begin{document}', 'Hello world', '\\end{document}'].join('\n');
    const newText = ['\\documentclass{article}', '\\usepackage{amsmath}', '\\begin{document}', 'Hello NovaTeX', '\\end{document}'].join('\n');
    const diff = computeLineDiff(oldText, newText, 'main.tex');
    expect(diff.additions).toBe(2);
    expect(diff.deletions).toBe(1);
    expect(diff.unifiedDiff).toContain('--- a/main.tex');
    expect(diff.unifiedDiff).toContain('+++ b/main.tex');
    expect(diff.unifiedDiff).toContain('+\\usepackage{amsmath}');
    expect(diff.unifiedDiff).toContain('-Hello world');
    expect(diff.unifiedDiff).toContain('+Hello NovaTeX');
  });

  it('returns empty unified diff for identical content', () => {
    const diff = computeLineDiff('a\nb\n', 'a\nb\n');
    expect(diff.additions).toBe(0);
    expect(diff.deletions).toBe(0);
    expect(diff.unifiedDiff).toBe('');
  });

  it('computes minimal character-level splice for non-destructive Yjs edits', () => {
    expect(computeMinimalTextSplice('abc', 'abc')).toBeNull();
    const s1 = computeMinimalTextSplice('Hello world!', 'Hello NovaTeX!');
    expect(s1).toEqual({ index: 6, deleteCount: 5, insertText: 'NovaTeX' });

    const s2 = computeMinimalTextSplice('abc', 'abcdef');
    expect(s2).toEqual({ index: 3, deleteCount: 0, insertText: 'def' });

    const s3 = computeMinimalTextSplice('abcdef', 'abef');
    expect(s3).toEqual({ index: 2, deleteCount: 2, insertText: '' });
  });
});
