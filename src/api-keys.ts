/**
 * API Key Configuration
 *
 * Manages per-provider API keys for direct provider access.
 * Keys can be configured via:
 *   1. Environment variables (OPENAI_API_KEY, ANTHROPIC_API_KEY, etc.)
 *   2. Config file (~/.openclaw/clawrouter/config.json)
 *   3. Plugin config in openclaw.json
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const CONFIG_DIR = join(homedir(), ".openclaw", "clawrouter");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

export { CONFIG_FILE };

/** Provider ID to API base URL mapping */
export const PROVIDER_ENDPOINTS: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
  google: "https://generativelanguage.googleapis.com/v1beta",
  xai: "https://api.x.ai/v1",
  deepseek: "https://api.deepseek.com/v1",
  moonshot: "https://api.moonshot.cn/v1",
  nvidia: "https://integrate.api.nvidia.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
};

/**
 * Providers that accept the OpenAI /v1/chat/completions format.
 * Anthropic and Google use incompatible APIs and must go via OpenRouter.
 */
const OPENAI_COMPATIBLE_PROVIDERS = new Set([
  "openai", "xai", "deepseek", "moonshot", "nvidia",
]);

/** Environment variable names per provider */
const ENV_VAR_MAP: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GOOGLE_API_KEY",
  xai: "XAI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  moonshot: "MOONSHOT_API_KEY",
  nvidia: "NVIDIA_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

export type ProviderConfig = {
  apiKey: string;
  baseUrl?: string; // Override default endpoint
};

export type ApiKeysConfig = {
  providers: Record<string, ProviderConfig>;
};

/**
 * Load API keys from all sources (env vars take precedence over config file).
 */
export function loadApiKeys(pluginConfig?: Record<string, unknown>): ApiKeysConfig {
  const config: ApiKeysConfig = { providers: {} };

  // 1. Load from config file
  if (existsSync(CONFIG_FILE)) {
    try {
      const content = readFileSync(CONFIG_FILE, "utf-8").trim();
      if (content) {
        const parsed = JSON.parse(content) as Partial<ApiKeysConfig>;
        if (parsed.providers) {
          config.providers = { ...parsed.providers };
        }
      }
    } catch {
      // Invalid config file, ignore
    }
  }

  // 2. Load from plugin config (openclaw.json)
  if (pluginConfig?.providers && typeof pluginConfig.providers === "object") {
    const pluginProviders = pluginConfig.providers as Record<string, ProviderConfig>;
    for (const [provider, providerConfig] of Object.entries(pluginProviders)) {
      if (providerConfig.apiKey) {
        config.providers[provider] = { ...config.providers[provider], ...providerConfig };
      }
    }
  }

  // 3. Environment variables (highest precedence)
  for (const [provider, envVar] of Object.entries(ENV_VAR_MAP)) {
    const key = process.env[envVar];
    if (key) {
      if (!config.providers[provider]) {
        config.providers[provider] = { apiKey: key };
      } else {
        config.providers[provider].apiKey = key;
      }
    }
  }

  return config;
}

/**
 * Get configured providers (those with API keys).
 */
export function getConfiguredProviders(config: ApiKeysConfig): string[] {
  return Object.keys(config.providers).filter((p) => config.providers[p]?.apiKey);
}

/**
 * Get API key for a provider.
 */
export function getApiKey(config: ApiKeysConfig, provider: string): string | undefined {
  return config.providers[provider]?.apiKey;
}

/**
 * Get the base URL for a provider (custom or default).
 */
export function getProviderBaseUrl(config: ApiKeysConfig, provider: string): string | undefined {
  return config.providers[provider]?.baseUrl ?? PROVIDER_ENDPOINTS[provider];
}

/**
 * Extract provider from model ID (e.g., "openai/gpt-4o" -> "openai").
 */
export function getProviderFromModel(modelId: string): string {
  const slash = modelId.indexOf("/");
  return slash > 0 ? modelId.slice(0, slash) : modelId;
}

/**
 * Check if OpenRouter is configured as a fallback.
 */
export function hasOpenRouter(config: ApiKeysConfig): boolean {
  return !!config.providers.openrouter?.apiKey;
}

/**
 * Resolve the best API key + base URL for a model.
 * Priority: direct provider key > OpenRouter fallback.
 * Returns undefined if no key is available for this model.
 */
export function resolveProviderAccess(
  config: ApiKeysConfig,
  modelId: string,
): { apiKey: string; baseUrl: string; provider: string; viaOpenRouter: boolean } | undefined {
  const provider = getProviderFromModel(modelId);

  // Anthropic + Google need format conversion (tools, streaming, etc.)
  // Always route through OpenRouter if available — it handles conversion automatically
  const needsConversion = provider === "anthropic" || provider === "google";
  const orKey = config.providers.openrouter?.apiKey;
  if (needsConversion && orKey) {
    const orUrl = config.providers.openrouter?.baseUrl ?? PROVIDER_ENDPOINTS.openrouter;
    return { apiKey: orKey, baseUrl: orUrl, provider: "openrouter", viaOpenRouter: true };
  }

  // 1. Direct provider key (cheapest, no middleman)
  //    Only for OpenAI-compatible providers — Anthropic/Google use different APIs
  const directKey = getApiKey(config, provider);
  const directUrl = getProviderBaseUrl(config, provider);
  if (directKey && directUrl && OPENAI_COMPATIBLE_PROVIDERS.has(provider)) {
    return { apiKey: directKey, baseUrl: directUrl, provider, viaOpenRouter: false };
  }

  // 2. OpenRouter fallback (covers all providers)
  const orFallbackKey = config.providers.openrouter?.apiKey;
  if (orFallbackKey) {
    const orUrl2 = config.providers.openrouter?.baseUrl ?? PROVIDER_ENDPOINTS.openrouter;
    return { apiKey: orFallbackKey, baseUrl: orUrl2, provider: "openrouter", viaOpenRouter: true };
  }

  return undefined;
}

/**
 * Check if a model is accessible (has direct key or OpenRouter fallback).
 */
export function isModelAccessible(config: ApiKeysConfig, modelId: string): boolean {
  return resolveProviderAccess(config, modelId) !== undefined;
}

/**
 * Get all providers that have models accessible (direct + OpenRouter-backed).
 * Used for filtering the model list.
 */
export function getAccessibleProviders(config: ApiKeysConfig): string[] {
  const direct = getConfiguredProviders(config).filter((p) => p !== "openrouter");
  if (hasOpenRouter(config)) {
    // OpenRouter covers all known providers
    return Object.keys(PROVIDER_ENDPOINTS).filter((p) => p !== "openrouter");
  }
  return direct;
}

/**
 * Save API keys config to file.
 */
export function saveApiKeys(config: ApiKeysConfig): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}
