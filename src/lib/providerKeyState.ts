import type { LlmProvider } from '@/api';

export const PROVIDER_KEYS_STORAGE_KEY = 'pbt_provider_keys';

export type ProviderKeyState = Record<LlmProvider, string>;

export const DEFAULT_PROVIDER_KEYS: ProviderKeyState = {
  gemini: '',
  openai: '',
  anthropic: '',
  'local-small': '',
  'local-medium': '',
  'local-large': '',
};

function isProviderKeyState(value: unknown): value is Partial<ProviderKeyState> {
  return typeof value === 'object' && value !== null;
}

export function hydrateProviderKeyState(raw: string | null): ProviderKeyState {
  if (!raw) return DEFAULT_PROVIDER_KEYS;

  const parsed: unknown = JSON.parse(raw);
  if (!isProviderKeyState(parsed)) {
    throw new Error('Invalid provider key state');
  }

  return {
    gemini: typeof parsed.gemini === 'string' ? parsed.gemini : '',
    openai: typeof parsed.openai === 'string' ? parsed.openai : '',
    anthropic: typeof parsed.anthropic === 'string' ? parsed.anthropic : '',
    // Local tiers never hold a key, but they are part of the record shape.
    'local-small': '',
    'local-medium': '',
    'local-large': '',
  };
}
