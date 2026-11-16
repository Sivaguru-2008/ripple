import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { runShellCommand, MAX_COMMAND_OUTPUT_CHARS } from '../src/core/command';

describe('runShellCommand', () => {
  const root = path.resolve(__dirname, '..');

  it('runs echo command and captures output', async () => {
    const res = await runShellCommand(root, 'node -e "console.log(\'hello ripple\')"');
    expect(res.exitCode).toBe(0);
    expect(res.text).toContain('hello ripple');
    expect(res.isError).toBe(false);
  });

  it('captures non-zero exit codes', async () => {
    const res = await runShellCommand(root, 'node -e "process.exit(42)"');
    expect(res.exitCode).toBe(42);
    expect(res.isError).toBe(true);
  });

  it('truncates oversized output', async () => {
    const res = await runShellCommand(root, 'node -e "console.log(\'x\'.repeat(6000))"');
    expect(res.truncated).toBe(true);
    expect(res.text).toContain(`[output truncated: exceeded ${MAX_COMMAND_OUTPUT_CHARS} characters]`);
  });
});
