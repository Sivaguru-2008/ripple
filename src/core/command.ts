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

// About 600 tokens. Every later step resends it, and a test run's verdict is at the end.
export const MAX_COMMAND_OUTPUT_CHARS = 2400;
export const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * True for a plain test-runner invocation: `pytest ...` or `<python> -m pytest ...`, optionally
 * after one environment assignment (`set "PYTHONPATH=src" &&` or `PYTHONPATH=src`). Anything
 * chained, piped or redirected is not. Used to auto-approve test runs only, never installs.
 */
export function isTestCommand(command: string): boolean {
  let rest = command.trim();
  rest = rest.replace(/^set\s+"?[A-Za-z_][A-Za-z0-9_]*=[^"&|<>]*"?\s*&&\s*/i, '');
  rest = rest.replace(/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/, '');
  if (/[&|;<>`$\n]/.test(rest)) return false;
  return /^(?:pytest|(?:"[^"]*python[^"\\/]*(?:\.exe)?"|\S*python\d?(?:\.\d+)?(?:\.exe)?)\s+-m\s+pytest)(?:\s|$)/i.test(rest);
}

/** Runs a command in the workspace root with timeout and output truncation. */
export function runShellCommand(
  root: string,
  command: string,
  options: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<CommandResult> {
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolve) => {
    const child = exec(
      command,
      {
        // VS Code reports Windows paths with a lowercase drive letter; a process started there
        // sees `c:\...` as its cwd, which breaks tools that compare it with resolved paths.
        cwd: root.replace(/^[a-z]:/, (drive) => drive.toUpperCase()),
        timeout,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, ...options.env },
      },
      (error, stdout, stderr) => {
        const killed = Boolean(error && (error as unknown as { killed?: boolean }).killed);
        if (killed && process.platform === 'win32' && child.pid) {
          // On Windows, kill process tree so spawned sub-processes do not linger as orphans
          exec(`taskkill /pid ${child.pid} /T /F`, () => undefined);
        }
        const exitCode = error && typeof error.code === 'number' ? error.code : error ? 1 : 0;
        const outStr = (stdout || '').toString();
        let errStr = (stderr || '').toString();
        if (killed) {
          errStr = errStr ? `${errStr.trimEnd()}\n[command timed out after ${timeout} ms]` : `[command timed out after ${timeout} ms]`;
        }
        // stdout goes last: its end (a test runner's verdict) must survive truncation.
        const combined = errStr.trim() && outStr.trim() ? `[stderr]\n${errStr.trimEnd()}\n[stdout]\n${outStr}` : outStr + errStr;
        let truncated = false;
        let formatted = combined.trimEnd();
        if (formatted.length > MAX_COMMAND_OUTPUT_CHARS) {
          truncated = true;
          // Keep the start and the end: test runners print their verdict last.
          const head = Math.floor(MAX_COMMAND_OUTPUT_CHARS * 0.4);
          const omitted = formatted.length - MAX_COMMAND_OUTPUT_CHARS;
          formatted =
            formatted.slice(0, head) +
            `\n\n[output truncated: exceeded ${MAX_COMMAND_OUTPUT_CHARS} characters; ${omitted} characters in the middle left out]\n\n` +
            formatted.slice(-(MAX_COMMAND_OUTPUT_CHARS - head));
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
