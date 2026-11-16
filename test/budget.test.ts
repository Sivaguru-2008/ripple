import { describe, expect, it } from 'vitest';
import {
  calculateRetrievalBudget,
  DEFAULT_FALLBACK_CONTEXT_WINDOW,
  MIN_RETRIEVAL_BUDGET,
} from '../src/core/budget';
import { estimateTokens, retrieve, type RetrieveSource } from '../src/core/retrieve';

function createMockSource(files: Record<string, string>): RetrieveSource {
  return {
    listFiles: async () => Object.keys(files),
    readText: async (p) => {
      const text = files[p];
      if (text === undefined) throw new Error(`file not found: ${p}`);
      return text;
    },
  };
}

const filler = (name: string, count: number): string =>
  Array.from({ length: count }, (_, k) => `def ${name}_${k}(value):\n    return "${name}" + str(value + ${k})\n`).join('\n');

describe('Adaptive Context Budget', () => {
  describe('calculateRetrievalBudget', () => {
    it('calculates safe retrieval budget for 4K context model', () => {
      const result = calculateRetrievalBudget({ contextWindow: 4096 });
      expect(result.contextWindow).toBe(4096);
      expect(result.source).toBe('trueforge');
      // Reserved tokens must account for instructions, tools, history, and generation
      expect(result.reservedTokens).toBeGreaterThanOrEqual(2000);
      expect(result.effectiveBudget).toBeLessThanOrEqual(4096 - result.reservedTokens);
      expect(result.effectiveBudget).toBeGreaterThanOrEqual(MIN_RETRIEVAL_BUDGET);
      // Total retrieval budget + reserved tokens must never exceed context window
      expect(result.effectiveBudget + result.reservedTokens).toBeLessThanOrEqual(4096);
    });

    it('calculates safe retrieval budget for 8K context model', () => {
      const result = calculateRetrievalBudget({ contextWindow: 8192 });
      expect(result.contextWindow).toBe(8192);
      expect(result.source).toBe('trueforge');
      expect(result.effectiveBudget).toBeLessThanOrEqual(8192 - result.reservedTokens);
      expect(result.effectiveBudget).toBeGreaterThan(calculateRetrievalBudget({ contextWindow: 4096 }).effectiveBudget);
      expect(result.effectiveBudget + result.reservedTokens).toBeLessThanOrEqual(8192);
    });

    it('calculates safe retrieval budget for 16K context model', () => {
      const result = calculateRetrievalBudget({ contextWindow: 16384 });
      expect(result.contextWindow).toBe(16384);
      expect(result.source).toBe('trueforge');
      expect(result.effectiveBudget).toBeLessThanOrEqual(16384 - result.reservedTokens);
      expect(result.effectiveBudget).toBeGreaterThan(calculateRetrievalBudget({ contextWindow: 8192 }).effectiveBudget);
      expect(result.effectiveBudget + result.reservedTokens).toBeLessThanOrEqual(16384);
    });

    it('handles missing context metadata with safe fallback', () => {
      const result = calculateRetrievalBudget({ modelName: 'some-unknown-provider/custom-model' });
      expect(result.contextWindow).toBe(DEFAULT_FALLBACK_CONTEXT_WINDOW);
      expect(result.source).toBe('fallback');
      expect(result.effectiveBudget).toBeLessThanOrEqual(DEFAULT_FALLBACK_CONTEXT_WINDOW - result.reservedTokens);
      expect(result.effectiveBudget).toBeGreaterThanOrEqual(MIN_RETRIEVAL_BUDGET);
    });

    it('supports per-model configuration overrides', () => {
      const result = calculateRetrievalBudget({
        modelName: 'ollama/qwen-coder-tools-7b',
        perModelConfig: {
          'ollama/qwen-coder-tools-7b': {
            contextWindow: 4096,
            retrievalBudget: 1500,
            reservedTokens: 2200,
          },
        },
      });
      expect(result.source).toBe('config');
      expect(result.contextWindow).toBe(4096);
      expect(result.reservedTokens).toBe(2200);
      expect(result.effectiveBudget).toBe(1500);
    });

    it('never exceeds effective context window even when requested budget is large', () => {
      const result = calculateRetrievalBudget({
        contextWindow: 4096,
        requestedBudget: 32000,
      });
      expect(result.effectiveBudget).toBeLessThanOrEqual(4096 - result.reservedTokens);
      expect(result.effectiveBudget).toBeLessThan(4096);
    });
  });

  describe('retrieval with adaptive model budgets', () => {
    const files: Record<string, string> = {
      'src/cli.py': `import json\n${filler('cli_command', 100)}\ndef config_cmd():\n    return 'cli config'\n`,
      'src/config.py': filler('config_loader', 120),
      'tests/test_cli.py': `from src.cli import config_cmd\n${filler('test_cli', 80)}\n`,
      'docs/cli.rst': `CLI Reference\n=============\n\nDocumentation for CLI commands.\n${filler('doc_section', 60)}\n`,
      'src/other_cli.py': `import json\n${filler('cli_more', 300)}\n`,
      'src/huge.py': `def config_huge():\n${filler('huge_config', 800)}\n`,
    };

    it('retrieves within 4K model budget without overflowing context', async () => {
      const budget4k = calculateRetrievalBudget({ contextWindow: 4096 }).effectiveBudget;
      const res = await retrieve('cli command config json', createMockSource(files), {
        budgetTokens: budget4k,
        contextWindow: 4096,
      });

      expect(res.budgetTokens).toBe(budget4k);
      expect(res.usedTokens).toBeLessThanOrEqual(budget4k);
      expect(estimateTokens(res.text)).toBeLessThanOrEqual(budget4k);
      // Evicted files are tracked and listed
      expect(res.evicted.length).toBeGreaterThan(0);
      for (const e of res.evicted) {
        expect(res.receipt.some((r) => r.path === e.path)).toBe(false);
      }
    });

    it('retrieves within 8K model budget packing more context', async () => {
      const budget8k = calculateRetrievalBudget({ contextWindow: 8192 }).effectiveBudget;
      const res = await retrieve('cli command config json', createMockSource(files), {
        budgetTokens: budget8k,
        contextWindow: 8192,
      });

      expect(res.budgetTokens).toBe(budget8k);
      expect(res.usedTokens).toBeLessThanOrEqual(budget8k);
      expect(res.usedTokens).toBeGreaterThan(1000);
    });

    it('retrieves within 16K model budget accommodating large context', async () => {
      const budget16k = calculateRetrievalBudget({ contextWindow: 16384 }).effectiveBudget;
      const res = await retrieve('cli command config json', createMockSource(files), {
        budgetTokens: budget16k,
        contextWindow: 16384,
      });

      expect(res.budgetTokens).toBe(budget16k);
      expect(res.usedTokens).toBeLessThanOrEqual(budget16k);
    });

    it('preserves pinned files even when pinned files exceed available budget', async () => {
      // Create pins that in total are larger than a tiny 700 token budget
      const pins = [
        { path: 'src/cli.py', label: '@cli.py' },
        { path: 'src/config.py', label: '@config.py' },
        { path: 'tests/test_cli.py', label: '@test_cli.py' },
      ];

      const tightBudget = 750;
      const res = await retrieve('unrelated query', createMockSource(files), {
        budgetTokens: tightBudget,
        pins,
      });

      // All pinned files MUST be in the receipt and NEVER silently evicted
      for (const pin of pins) {
        const inReceipt = res.receipt.find((r) => r.path === pin.path);
        expect(inReceipt, `Pinned file ${pin.path} must be in receipt`).toBeDefined();
        expect(inReceipt?.reason).toBe('pinned');

        const inEvicted = res.evicted.find((e) => e.path === pin.path);
        expect(inEvicted, `Pinned file ${pin.path} must NEVER be evicted`).toBeUndefined();
      }

      // Hard budget guarantee must still hold
      expect(res.usedTokens).toBeLessThanOrEqual(tightBudget);
    });

    it('handles oversized individual files by cleanly excerpting to fit budget', async () => {
      const singleHugeFile = {
        'src/massive.py': filler('massive_function', 1500), // ~15,000 tokens
      };

      const budget = 1500;
      const res = await retrieve('find massive_function_10', createMockSource(singleHugeFile), {
        budgetTokens: budget,
      });

      expect(res.receipt.length).toBe(1);
      const row = res.receipt[0]!;
      expect(row.path).toBe('src/massive.py');
      expect(row.mode).toBe('excerpt'); // Excerpted, not full
      expect(row.tokens).toBeLessThanOrEqual(budget);
      expect(res.usedTokens).toBeLessThanOrEqual(budget);
      expect(res.files[0]!.mode).toBe('excerpt');
      expect(res.files[0]!.text).toContain('=== src/massive.py (excerpt:');
    });
  });
});
