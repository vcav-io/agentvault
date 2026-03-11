export interface DemoModelOption {
  id: string;
  tier: string;
  profileId?: string;
  default?: boolean;
}

export interface DemoProviderOption {
  name: 'gemini' | 'openai' | 'anthropic';
  envVar: 'GEMINI_API_KEY' | 'OPENAI_API_KEY' | 'ANTHROPIC_API_KEY';
  models: DemoModelOption[];
}

export const DEMO_PROVIDER_OPTIONS: DemoProviderOption[] = [
  {
    name: 'gemini',
    envVar: 'GEMINI_API_KEY',
    models: [
      { id: 'gemini-3-flash-preview', tier: 'flagship', profileId: 'api-gemini3flash-v1', default: true },
      { id: 'gemini-3.1-flash-lite-preview', tier: 'budget', profileId: 'api-gemini3flash-lite-v1' },
    ],
  },
  {
    name: 'openai',
    envVar: 'OPENAI_API_KEY',
    models: [
      { id: 'gpt-5', tier: 'flagship', profileId: 'api-gpt5-v1', default: true },
      { id: 'gpt-4.1-mini', tier: 'mid', profileId: 'api-gpt41mini-v1' },
    ],
  },
  {
    name: 'anthropic',
    envVar: 'ANTHROPIC_API_KEY',
    models: [
      { id: 'claude-sonnet-4-6', tier: 'flagship', profileId: 'api-claude-sonnet-v1', default: true },
      { id: 'claude-haiku-4-5-20251001', tier: 'budget', profileId: 'api-claude-haiku-v1' },
    ],
  },
];

export const HEARTBEAT_DEFAULTS: Record<DemoProviderOption['name'], string> = {
  gemini: 'gemini-3.1-flash-lite-preview',
  openai: 'gpt-4.1-nano',
  anthropic: 'claude-haiku-4-5-20251001',
};

export function getAvailableDemoProviders(
  env: NodeJS.ProcessEnv,
): Array<{ name: string; models: DemoModelOption[] }> {
  return DEMO_PROVIDER_OPTIONS.filter((provider) => Boolean(env[provider.envVar])).map((provider) => ({
    name: provider.name,
    models: provider.models,
  }));
}
