import type { LlmProvider } from '../api';

export const PROVIDER_KEYS_STORAGE_KEY = 'pbt_provider_keys';

export const DEFAULT_PROVIDER_KEYS: Record<LlmProvider, string> = {
  gemini: '',
  openai: '',
  anthropic: '',
};

export function hydrateProviderKeyState(raw: string | null): Record<LlmProvider, string> {
  if (!raw) return { ...DEFAULT_PROVIDER_KEYS };
  const parsed = JSON.parse(raw) as Partial<Record<LlmProvider, string>>;
  return {
    gemini: parsed.gemini ?? '',
    openai: parsed.openai ?? '',
    anthropic: parsed.anthropic ?? '',
  };
}
