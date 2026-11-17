import { describe, expect, it } from 'vitest';
import { applyTextEdits } from '../src/core/transactions';

const base = [
  'def routes_command():',
  '    for row in rows:',
  '        click.echo(row)',
  '',
  '',
  'cli = FlaskGroup()',
  '',
].join('\n');

describe('applyTextEdits, indentation-tolerant matching', () => {
  it('matches old_text whose indentation was lost, and shifts new_text the same way', () => {
    const r = applyTextEdits(base, [
      { old_text: 'for row in rows:\n    click.echo(row)', new_text: 'for row in rows:\n    click.echo(row)\nprint("done")' },
    ]);
    expect(r).toEqual({
      ok: true,
      text: base.replace('        click.echo(row)', '        click.echo(row)\n    print("done")'),
    });
  });

  it('ignores trailing spaces', () => {
    const r = applyTextEdits(base, [{ old_text: 'cli = FlaskGroup()   ', new_text: 'cli = FlaskGroup(name="flask")' }]);
    expect(r.ok && r.text).toContain('cli = FlaskGroup(name="flask")');
  });

  it('refuses when the indentation is off by different amounts', () => {
    const r = applyTextEdits(base, [{ old_text: 'for row in rows:\nclick.echo(row)', new_text: 'x' }]);
    expect(r.ok).toBe(false);
  });

  it('refuses an ambiguous loose match', () => {
    const twice = `${base}\ndef other():\n    for row in rows:\n        click.echo(row)\n`;
    const r = applyTextEdits(twice, [{ old_text: 'for row in rows:\n    click.echo(row)', new_text: 'x' }]);
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/occur more than once/) });
  });

  it('points at the right lines when nothing matches', () => {
    const r = applyTextEdits(base, [{ old_text: 'cli = FlaskGroup()\nsomething else', new_text: 'x' }]);
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/occurs at line 6; read_file lines 6-/) });
  });
});
