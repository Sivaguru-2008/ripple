import { describe, expect, it } from 'vitest';
import { decodeEdits } from '../src/mcp/server';

describe('decodeEdits', () => {
  const list = [{ old_text: 'a', new_text: 'b' }];

  it('passes a list through', () => {
    expect(decodeEdits(list)).toEqual(list);
  });

  it('decodes a JSON-encoded list, as one model sent it', () => {
    expect(decodeEdits(JSON.stringify(list))).toEqual(list);
  });

  it('says what is wrong with text that is not JSON', () => {
    expect(decodeEdits('[{old_text: a}')).toMatch(/not text/);
  });

  it('rejects an empty or malformed list with a usable message', () => {
    expect(decodeEdits('[]')).toMatch(/non-empty list/);
    expect(decodeEdits([{ old_text: 1 }])).toMatch(/non-empty list/);
  });
});
