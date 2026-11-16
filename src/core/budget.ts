// Ripple adaptive context budget (AGENTS.md section 3 & Day 2 context fix).
// Calculates retrieval token budget dynamically per model, reserving space for
// system instructions, tool schemas, conversation history, and model output generation.
// No `vscode` imports: unit-testable in isolation.

export const DEFAULT_FALLBACK_CONTEXT_WINDOW = 4096;
export const DEFAULT_RESERVED_SYSTEM_AND_TOOLS = 1400;
export const DEFAULT_RESERVED_HISTORY = 400;
export const DEFAULT_RESERVED_OUTPUT = 600;
export const MIN_RETRIEVAL_BUDGET = 600;

export interface ModelContextConfig {
  /** Maximum context window limit in tokens (e.g. 4096, 8192, 16384, 32768, 128000). */
  contextWindow?: number;
  /** Reserved tokens for system prompt, tool schemas, history, and generation. */
  reservedTokens?: number;
  /** Fixed retrieval budget override for this model (still clamped by context window). */
  retrievalBudget?: number;
  /** Maximum output tokens expected or configured. */
  maxOutputTokens?: number;
}

export interface AdaptiveBudgetOptions {
  modelName?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  reservedTokens?: number;
  requestedBudget?: number;
  perModelConfig?: Record<string, ModelContextConfig>;
  fallbackContextWindow?: number;
}

export interface AdaptiveBudgetResult {
  modelName?: string;
  contextWindow: number;
  reservedTokens: number;
  effectiveBudget: number;
  remainingTokensAfterRetrieval: number;
  source: 'trueforge' | 'config' | 'heuristic' | 'fallback';
}

/**
 * Known model heuristics when TrueForge metadata is not provided.
 */
function inferContextWindow(modelName: string | undefined): number | undefined {
  if (!modelName) return undefined;
  const lower = modelName.toLowerCase();
  if (lower.includes('4k') || lower.includes('4096')) return 4096;
  if (lower.includes('8k') || lower.includes('8192')) return 8192;
  if (lower.includes('16k') || lower.includes('16384')) return 16384;
  if (lower.includes('32k') || lower.includes('32768')) return 32768;
  if (lower.includes('64k')) return 65536;
  if (lower.includes('128k')) return 131072;
  // Ollama default Qwen 7B model runs with 4096 context unless specifically set
  if (lower.includes('qwen') && (lower.includes('7b') || lower.includes('qwen2.5-coder'))) {
    // If not specified otherwise, default local Qwen runner context is 4096
    return 4096;
  }
  return undefined;
}

/**
 * Calculates adaptive token budget for retrieval ensuring the model's effective
 * context window is never exceeded.
 */
export function calculateRetrievalBudget(options: AdaptiveBudgetOptions = {}): AdaptiveBudgetResult {
  const modelName = options.modelName;
  const modelConfig = modelName && options.perModelConfig ? options.perModelConfig[modelName] : undefined;

  let contextWindow: number;
  let source: AdaptiveBudgetResult['source'];

  if (modelConfig?.contextWindow && modelConfig.contextWindow > 0) {
    contextWindow = modelConfig.contextWindow;
    source = 'config';
  } else if (options.contextWindow && options.contextWindow > 0) {
    contextWindow = options.contextWindow;
    source = 'trueforge';
  } else {
    const heuristic = inferContextWindow(modelName);
    if (heuristic) {
      contextWindow = heuristic;
      source = 'heuristic';
    } else {
      contextWindow = options.fallbackContextWindow ?? DEFAULT_FALLBACK_CONTEXT_WINDOW;
      source = 'fallback';
    }
  }

  // Calculate reserved tokens for system instructions, tool schemas, conversation history, and output
  let reserved: number;
  if (modelConfig?.reservedTokens !== undefined && modelConfig.reservedTokens >= 0) {
    reserved = modelConfig.reservedTokens;
  } else if (options.reservedTokens !== undefined && options.reservedTokens >= 0) {
    reserved = options.reservedTokens;
  } else {
    const maxOutput = modelConfig?.maxOutputTokens ?? options.maxOutputTokens ?? DEFAULT_RESERVED_OUTPUT;
    // Don't reserve more than 25% of context window for output on small context models
    const outputReserve = Math.min(maxOutput, Math.floor(contextWindow * 0.25));
    const baseReserve = DEFAULT_RESERVED_SYSTEM_AND_TOOLS + DEFAULT_RESERVED_HISTORY;
    reserved = baseReserve + outputReserve;

    // Ensure reservation leaves at least MIN_RETRIEVAL_BUDGET if contextWindow allows
    if (contextWindow > MIN_RETRIEVAL_BUDGET && reserved > contextWindow - MIN_RETRIEVAL_BUDGET) {
      reserved = contextWindow - MIN_RETRIEVAL_BUDGET;
    }
  }

  // Max effective budget available for retrieval
  const maxAvailable = Math.max(MIN_RETRIEVAL_BUDGET, contextWindow - reserved);

  let effectiveBudget: number;
  if (modelConfig?.retrievalBudget !== undefined && modelConfig.retrievalBudget > 0) {
    effectiveBudget = Math.min(modelConfig.retrievalBudget, maxAvailable);
  } else if (options.requestedBudget !== undefined && options.requestedBudget > 0) {
    effectiveBudget = Math.min(options.requestedBudget, maxAvailable);
  } else {
    // For large models without explicit budget request, default up to 8000 tokens
    effectiveBudget = Math.min(maxAvailable, 8000);
  }

  // Hard safety guarantee: retrieval budget must never exceed effective context window
  effectiveBudget = Math.min(effectiveBudget, maxAvailable);

  return {
    modelName,
    contextWindow,
    reservedTokens: reserved,
    effectiveBudget,
    remainingTokensAfterRetrieval: Math.max(0, contextWindow - reserved - effectiveBudget),
    source,
  };
}
