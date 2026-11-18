import { describe, expect, it } from 'vitest';
import { decodeEdits } from '../src/mcp/server';
import { applyTextEdits } from '../src/core/transactions';

const base = ['import click', '', 'def routes_command():', '    pass', '', 'cli = FlaskGroup()', ''].join('\n');

describe('insert edits', () => {
  it('inserts after a numbered line whose text matches', () => {
    const r = applyTextEdits(base, [{ insert_after_line: 1, line_text: 'import click', new_text: 'import json' }]);
    expect(r).toEqual({ ok: true, text: base.replace('import click\n', 'import click\nimport json\n') });
  });

  it('accepts line_text copied with the read_file gutter', () => {
    const r = applyTextEdits(base, [{ insert_after_line: 4, line_text: '4      pass', new_text: '\n\ndef config_command():\n    pass' }]);
    expect(r.ok && r.text).toContain('    pass\n\n\ndef config_command():\n    pass\n\ncli = FlaskGroup()');
  });

  it('inserts at the top with line 0 and needs no line_text', () => {
    const r = applyTextEdits(base, [{ insert_after_line: 0, new_text: '"""CLI."""' }]);
    expect(r.ok && r.text.startsWith('"""CLI."""\nimport click')).toBe(true);
  });

  it('appends after the last line of a file without a final newline, keeping that style', () => {
    const r = applyTextEdits('a\nb', [{ insert_after_line: 2, line_text: 'b', new_text: 'c' }]);
    expect(r).toEqual({ ok: true, text: 'a\nb\nc' });
  });

  it('keeps CRLF files CRLF', () => {
    const crlf = base.replace(/\n/g, '\r\n');
    const r = applyTextEdits(crlf, [{ insert_after_line: 1, line_text: 'import click', new_text: 'import json\nimport os' }]);
    expect(r.ok && r.text.startsWith('import click\r\nimport json\r\nimport os\r\n\r\n')).toBe(true);
  });

  it('refuses a stale line number and says what the line is now', () => {
    const r = applyTextEdits(base, [{ insert_after_line: 2, line_text: 'import json', new_text: 'x' }]);
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/line 2 is now "", not "import json"; .*read it again/) });
  });

  it('asks for line_text when it is missing, quoting the line', () => {
    const r = applyTextEdits(base, [{ insert_after_line: 3, new_text: 'x' }]);
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/give line_text.*"def routes_command\(\):"/) });
  });

  it('accepts several quoted lines that end at the anchor line', () => {
    const r = applyTextEdits(base, [{ insert_after_line: 4, line_text: 'def routes_command():\n    pass', new_text: '\n\ndef config_command():\n    pass' }]);
    expect(r.ok && r.text).toContain('    pass\n\n\ndef config_command():');
  });

  it('corrects a line number that is off by up to 3 when the quoted line is unique nearby', () => {
    const r = applyTextEdits(base, [{ insert_after_line: 6, line_text: '    pass', new_text: 'print(1)' }]);
    expect(r.ok && r.text).toBe(base.replace('    pass\n', '    pass\nprint(1)\n'));
  });

  it('corrects a line number just past the end of the file', () => {
    const r = applyTextEdits('a\nb\n', [{ insert_after_line: 3, line_text: 'b', new_text: 'c' }]);
    expect(r).toEqual({ ok: true, text: 'a\nb\nc\n' });
  });

  it('refuses when the quoted line occurs more than once nearby', () => {
    const twice = 'x\npass\npass\ny\n';
    const r = applyTextEdits(twice, [{ insert_after_line: 1, line_text: 'pass', new_text: 'z' }]);
    expect(r.ok).toBe(false);
  });

  it('refuses a line number past the end', () => {
    const r = applyTextEdits(base, [{ insert_after_line: 99, line_text: 'x', new_text: 'y' }]);
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/from 0 to 6/) });
  });

  it('mixes with a replace edit in one call, both against the same read', () => {
    const r = applyTextEdits(base, [
      { insert_after_line: 1, line_text: 'import click', new_text: 'import json' },
      { old_text: 'cli = FlaskGroup()', new_text: 'cli = FlaskGroup(name="flask")' },
    ]);
    expect(r.ok && r.text).toBe(base.replace('import click\n', 'import click\nimport json\n').replace('cli = FlaskGroup()', 'cli = FlaskGroup(name="flask")'));
  });

  it('is accepted by the propose_write schema', () => {
    expect(decodeEdits([{ insert_after_line: 1, line_text: 'import click', new_text: 'import json' }])).toEqual([
      { insert_after_line: 1, line_text: 'import click', new_text: 'import json' },
    ]);
  });

  it('allows an insert edit and a replace edit touching at the exact same offset', () => {
    const r = applyTextEdits(base, [
      { insert_after_line: 1, line_text: 'import click', new_text: 'import json' },
      { old_text: '\ndef routes_command():', new_text: '\ndef routes_command_v2():' },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.text).toContain('import click\nimport json\n\ndef routes_command_v2():');
    }
  });
});
