export interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
  provider: 'anthropic' | 'openai' | 'xai' | 'deepseek' | 'mock';
  displayName: string;
}

export const MODEL_PRICING_TABLE: Record<string, ModelPricing> = {
  // Anthropic Models
  'claude-3-7-sonnet-20250219': {
    inputPerMillion: 3.00,
    outputPerMillion: 15.00,
    provider: 'anthropic',
    displayName: 'Claude 3.7 Sonnet',
  },
  'claude-3-5-sonnet-20241022': {
    inputPerMillion: 3.00,
    outputPerMillion: 15.00,
    provider: 'anthropic',
    displayName: 'Claude 3.5 Sonnet',
  },
  'claude-3-5-haiku-20241022': {
    inputPerMillion: 0.80,
    outputPerMillion: 4.00,
    provider: 'anthropic',
    displayName: 'Claude 3.5 Haiku',
  },
  'claude-3-opus-20240229': {
    inputPerMillion: 15.00,
    outputPerMillion: 75.00,
    provider: 'anthropic',
    displayName: 'Claude 3 Opus',
  },

  // xAI Grok Models
  'grok-2-1212': {
    inputPerMillion: 2.00,
    outputPerMillion: 10.00,
    provider: 'xai',
    displayName: 'Grok 2',
  },
  'grok-2-vision-1212': {
    inputPerMillion: 2.00,
    outputPerMillion: 10.00,
    provider: 'xai',
    displayName: 'Grok 2 Vision',
  },
  'grok-beta': {
    inputPerMillion: 5.00,
    outputPerMillion: 15.00,
    provider: 'xai',
    displayName: 'Grok Beta',
  },

  // OpenAI Models
  'gpt-4o': {
    inputPerMillion: 2.50,
    outputPerMillion: 10.00,
    provider: 'openai',
    displayName: 'GPT-4o',
  },
  'gpt-4o-mini': {
    inputPerMillion: 0.15,
    outputPerMillion: 0.60,
    provider: 'openai',
    displayName: 'GPT-4o mini',
  },
  'o1': {
    inputPerMillion: 15.00,
    outputPerMillion: 60.00,
    provider: 'openai',
    displayName: 'OpenAI o1',
  },
  'o3-mini': {
    inputPerMillion: 1.10,
    outputPerMillion: 4.40,
    provider: 'openai',
    displayName: 'OpenAI o3-mini',
  },

  // DeepSeek Models
  'deepseek-chat': {
    inputPerMillion: 0.14,
    outputPerMillion: 0.28,
    provider: 'deepseek',
    displayName: 'DeepSeek V3',
  },
  'deepseek-reasoner': {
    inputPerMillion: 0.55,
    outputPerMillion: 2.19,
    provider: 'deepseek',
    displayName: 'DeepSeek R1',
  },

  // Default Mock / Fallback
  'mock-agent-model': {
    inputPerMillion: 3.00,
    outputPerMillion: 15.00,
    provider: 'mock',
    displayName: 'Simulated Claude Model',
  }
};

export function getPricingForModel(modelName: string): ModelPricing {
  const normalized = modelName.toLowerCase();
  
  if (MODEL_PRICING_TABLE[normalized]) {
    return MODEL_PRICING_TABLE[normalized];
  }

  // Prefix matching
  for (const [key, pricing] of Object.entries(MODEL_PRICING_TABLE)) {
    if (normalized.includes(key) || key.includes(normalized)) {
      return pricing;
    }
  }

  if (normalized.includes('sonnet')) {
    return MODEL_PRICING_TABLE['claude-3-7-sonnet-20250219'];
  }
  if (normalized.includes('haiku')) {
    return MODEL_PRICING_TABLE['claude-3-5-haiku-20241022'];
  }
  if (normalized.includes('grok')) {
    return MODEL_PRICING_TABLE['grok-2-1212'];
  }
  if (normalized.includes('4o-mini')) {
    return MODEL_PRICING_TABLE['gpt-4o-mini'];
  }
  if (normalized.includes('4o')) {
    return MODEL_PRICING_TABLE['gpt-4o'];
  }

  // Default fallback to standard Claude Sonnet tier pricing
  return {
    inputPerMillion: 3.00,
    outputPerMillion: 15.00,
    provider: 'anthropic',
    displayName: modelName || 'Standard Agent Model',
  };
}

export function calculateCostUsd(
  modelName: string,
  promptTokens: number,
  completionTokens: number
): number {
  const pricing = getPricingForModel(modelName);
  const inputCost = (promptTokens / 1_000_000) * pricing.inputPerMillion;
  const outputCost = (completionTokens / 1_000_000) * pricing.outputPerMillion;
  return Number((inputCost + outputCost).toFixed(6));
}
