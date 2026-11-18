import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const manifest = JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8')) as {
  contributes: { keybindings: { command: string; key: string; mac?: string }[] };
};

describe('keybindings', () => {
  it('starts inline edit with Ctrl+;', () => {
    const inline = manifest.contributes.keybindings.find((k) => k.command === 'ripple.inlineEdit');
    expect(inline?.key).toBe('ctrl+;');
  });

  // On Windows Ctrl+Alt is AltGr. On layouts such as English (India), AltGr+letter types a
  // character, so Ctrl+Alt+R typed a combining ring over the selected function instead of
  // starting an inline edit (18 Nov). No Windows/Linux binding may be Ctrl+Alt+<letter or digit>.
  it('uses no Ctrl+Alt+letter or digit, which AltGr layouts turn into typed characters', () => {
    const unsafe = manifest.contributes.keybindings
      .flatMap((k) => k.key.split(' '))
      .filter((part) => /^ctrl\+alt\+(shift\+)?[a-z0-9]$/i.test(part));
    expect(unsafe).toEqual([]);
  });
});
