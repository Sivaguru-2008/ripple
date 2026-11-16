// Command execution in the workspace root for Ripple MCP server. No `vscode` imports.
import { exec } from 'node:child_process';

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  combined: string;
  truncated: boolean;
  text: string;
  isError: boolean;
}

export const MAX_COMMAND_OUTPUT_CHARS = 4000;
export const DEFAULT_TIMEOUT_MS = 60_000;

/** Runs a command in the workspace root with timeout and output truncation. */
export function runShellCommand(
  root: string,
  command: string,
  options: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<CommandResult> {
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolve) => {
    exec(
      command,
      {
        cwd: root,
        timeout,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, ...options.env },
      },
      (error, stdout, stderr) => {
        const exitCode = error && typeof error.code === 'number' ? error.code : error ? 1 : 0;
        const outStr = (stdout || '').toString();
        const errStr = (stderr || '').toString();
        const combined = outStr + (errStr ? (outStr ? '\n' : '') + errStr : '');
        let truncated = false;
        let formatted = combined.trimEnd();
        if (formatted.length > MAX_COMMAND_OUTPUT_CHARS) {
          truncated = true;
          formatted = formatted.slice(0, MAX_COMMAND_OUTPUT_CHARS) + `\n\n[output truncated: exceeded ${MAX_COMMAND_OUTPUT_CHARS} characters]`;
        }
        const text = formatted ? `exit code: ${exitCode}\noutput:\n${formatted}` : `exit code: ${exitCode}\n(no output)`;
        resolve({
          exitCode,
          stdout: outStr,
          stderr: errStr,
          combined,
          truncated,
          text,
          isError: exitCode !== 0,
        });
      },
    );
  });
}
