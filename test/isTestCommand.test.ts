import { describe, expect, it } from 'vitest';
import { isTestCommand } from '../src/core/command';

describe('isTestCommand', () => {
  it.each([
    'pytest tests/test_cli.py',
    'pytest',
    'python -m pytest tests/test_cli.py -q',
    'python3 -m pytest -q',
    '"C:\\Users\\me\\Python312\\python.exe" -m pytest tests/test_cli.py -q',
    'set "PYTHONPATH=src" && "C:\\Python312\\python.exe" -m pytest tests/test_cli.py -q',
    'PYTHONPATH=src python -m pytest tests/test_cli.py -q',
  ])('allows %s', (c) => expect(isTestCommand(c)).toBe(true));

  it.each([
    'pip install -e .',
    'python -m pip install -e .',
    'pytest tests && pip install x',
    'pytest | tee out.txt',
    'pytest > out.txt',
    'rm -rf .git',
    'python -c "import os; os.remove(\'x\')"',
    'set "PYTHONPATH=src" && pip install flask',
    'pytestx',
  ])('refuses %s', (c) => expect(isTestCommand(c)).toBe(false));
});
