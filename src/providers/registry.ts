import type { ProviderAdapter } from './ProviderAdapter.js';
import { OpenAIAdapter } from './openai.js';
import { AnthropicAdapter } from './anthropic.js';

const adapters = new Map<string, ProviderAdapter>();

export function getAdapter(provider: string): ProviderAdapter {
  if (!adapters.has(provider)) {
    switch (provider) {
      case 'openai':
        adapters.set(provider, new OpenAIAdapter());
        break;
      case 'anthropic':
        adapters.set(provider, new AnthropicAdapter());
        break;
      default:
        throw new Error(`Unknown provider: ${provider}`);
    }
  }
  return adapters.get(provider)!;
}
