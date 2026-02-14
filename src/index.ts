/**
 * ClawRouter — Smart LLM Router (Direct API Keys)
 *
 * Routes each request to the cheapest model that can handle it,
 * using your own provider API keys. No crypto, no middleman.
 *
 * Usage:
 *   openclaw plugins install ./ClawRouter
 *   # Configure API keys via env vars or ~/.openclaw/clawrouter/config.json
 *   openclaw models set clawrouter/auto
 */

import type {
  OpenClawPluginDefinition,
  OpenClawPluginApi,
  PluginCommandContext,
  OpenClawPluginCommandDefinition,
} from "./types.js";
import { clawrouterProvider, setActiveProxy } from "./provider.js";
import { startProxy, getProxyPort } from "./proxy.js";
import { loadApiKeys, getConfiguredProviders, hasOpenRouter, getAccessibleProviders, type ApiKeysConfig } from "./api-keys.js";
import type { RoutingConfig } from "./router/index.js";
import { OPENCLAW_MODELS } from "./models.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { VERSION } from "./version.js";
import { getStats, formatStatsAscii } from "./stats.js";
import { refreshOpenRouterModels } from "./openrouter-models.js";

async function waitForProxyHealth(port: number, timeoutMs = 3000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return true;
    } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

function isCompletionMode(): boolean {
  return process.argv.some((arg, i) => arg === "completion" && i >= 1 && i <= 3);
}

function isGatewayMode(): boolean {
  return process.argv.includes("gateway");
}

function injectModelsConfig(logger: { info: (msg: string) => void }): void {
  const configDir = join(homedir(), ".openclaw");
  const configPath = join(configDir, "openclaw.json");

  let config: Record<string, unknown> = {};
  let needsWrite = false;

  if (!existsSync(configDir)) {
    try { mkdirSync(configDir, { recursive: true }); } catch { return; }
  }

  if (existsSync(configPath)) {
    try {
      const content = readFileSync(configPath, "utf-8").trim();
      if (content) config = JSON.parse(content);
      else needsWrite = true;
    } catch { config = {}; needsWrite = true; }
  } else {
    needsWrite = true;
  }

  if (!config.models) { config.models = {}; needsWrite = true; }
  const models = config.models as Record<string, unknown>;
  if (!models.providers) { models.providers = {}; needsWrite = true; }

  const proxyPort = getProxyPort();
  const expectedBaseUrl = `http://127.0.0.1:${proxyPort}/v1`;
  const providers = models.providers as Record<string, unknown>;

  if (!providers.clawrouter) {
    providers.clawrouter = {
      baseUrl: expectedBaseUrl,
      api: "openai-completions",
      apiKey: "local-proxy",
      models: OPENCLAW_MODELS,
    };
    needsWrite = true;
  } else {
    const cr = providers.clawrouter as Record<string, unknown>;
    let fixed = false;
    if (!cr.baseUrl || cr.baseUrl !== expectedBaseUrl) { cr.baseUrl = expectedBaseUrl; fixed = true; }
    if (!cr.api) { cr.api = "openai-completions"; fixed = true; }
    if (!cr.apiKey) { cr.apiKey = "local-proxy"; fixed = true; }
    const currentModels = cr.models as unknown[];
    if (!currentModels || !Array.isArray(currentModels) || currentModels.length !== OPENCLAW_MODELS.length) { cr.models = OPENCLAW_MODELS; fixed = true; }
    if (fixed) needsWrite = true;
  }

  // Set default model only on first install
  if (!config.agents) { config.agents = {}; needsWrite = true; }
  const agents = config.agents as Record<string, unknown>;
  if (!agents.defaults) { agents.defaults = {}; needsWrite = true; }
  const defaults = agents.defaults as Record<string, unknown>;
  if (!defaults.model) { defaults.model = {}; needsWrite = true; }
  const model = defaults.model as Record<string, unknown>;
  if (!model.primary) { model.primary = "clawrouter/auto"; needsWrite = true; }

  const KEY_ALIASES = [
    { id: "auto", alias: "auto" }, { id: "sonnet", alias: "sonnet" },
    { id: "opus", alias: "opus" }, { id: "haiku", alias: "haiku" },
    { id: "grok", alias: "grok" }, { id: "deepseek", alias: "deepseek" },
    { id: "kimi", alias: "kimi" }, { id: "gemini", alias: "gemini" },
    { id: "flash", alias: "flash" }, { id: "gpt", alias: "gpt" },
    { id: "reasoner", alias: "reasoner" },
  ];

  if (!defaults.models) { defaults.models = {}; needsWrite = true; }
  const allowlist = defaults.models as Record<string, unknown>;
  for (const m of KEY_ALIASES) {
    const fullId = `clawrouter/${m.id}`;
    if (!allowlist[fullId]) { allowlist[fullId] = { alias: m.alias }; needsWrite = true; }
  }

  if (needsWrite) {
    try { writeFileSync(configPath, JSON.stringify(config, null, 2)); } catch { /* ignore */ }
  }
}

let activeProxyHandle: Awaited<ReturnType<typeof startProxy>> | null = null;

async function startProxyInBackground(api: OpenClawPluginApi, apiKeys: ApiKeysConfig): Promise<void> {
  const configuredProviders = getConfiguredProviders(apiKeys);
  const orFallback = hasOpenRouter(apiKeys);
  const accessibleProviders = getAccessibleProviders(apiKeys);
  api.logger.info(`Configured providers: ${configuredProviders.join(", ") || "(none)"}${orFallback ? " (OpenRouter covers all)" : ""}`);

  if (configuredProviders.length === 0) {
    api.logger.warn("No API keys configured! Set OPENROUTER_API_KEY for all models, or individual keys (OPENAI_API_KEY, etc.).");
    return;
  }

  const routingConfig = api.pluginConfig?.routing as Partial<RoutingConfig> | undefined;

  const proxy = await startProxy({
    apiKeys,
    routingConfig,
    onReady: (port) => api.logger.info(`ClawRouter proxy listening on port ${port}`),
    onError: (error) => api.logger.error(`ClawRouter proxy error: ${error.message}`),
    onRouted: (decision) => {
      const cost = decision.costEstimate.toFixed(4);
      const saved = (decision.savings * 100).toFixed(0);
      api.logger.info(`[${decision.tier}] ${decision.model} ~$${cost} (saved ${saved}%) | ${decision.reasoning}`);
    },
  });

  setActiveProxy(proxy);
  activeProxyHandle = proxy;
  api.logger.info(`ClawRouter ready — ${accessibleProviders.length} providers accessible, smart routing enabled`);

  // Pre-load OpenRouter model catalog for ID resolution
  if (hasOpenRouter(apiKeys)) {
    const orKey = apiKeys.providers.openrouter.apiKey;
    refreshOpenRouterModels(orKey).catch((err) =>
      api.logger.warn(`Failed to load OpenRouter models: ${err.message}`),
    );
  }
}

async function createStatsCommand(): Promise<OpenClawPluginCommandDefinition> {
  return {
    name: "stats",
    description: "Show ClawRouter usage statistics and cost savings",
    acceptsArgs: true,
    requireAuth: false,
    handler: async (ctx: PluginCommandContext) => {
      const days = parseInt(ctx.args?.trim() || "7", 10) || 7;
      try {
        const stats = await getStats(Math.min(days, 30));
        return { text: ["```", formatStatsAscii(stats), "```"].join("\n") };
      } catch (err) {
        return { text: `Failed to load stats: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
    },
  };
}

async function createKeysCommand(apiKeys: ApiKeysConfig): Promise<OpenClawPluginCommandDefinition> {
  return {
    name: "keys",
    description: "Show configured API key status (no secrets shown)",
    acceptsArgs: false,
    requireAuth: true,
    handler: async () => {
      const providers = getConfiguredProviders(apiKeys);
      if (providers.length === 0) {
        return {
          text: [
            "🔑 **ClawRouter API Keys**",
            "",
            "No API keys configured!",
            "",
            "**Quickest setup (one key → all models):**",
            "• `OPENROUTER_API_KEY=sk-or-...`",
            "",
            "**Or configure individual providers:**",
            "• `OPENAI_API_KEY=sk-...`",
            "• `ANTHROPIC_API_KEY=sk-ant-...`",
            "• `GOOGLE_API_KEY=AIza...`",
            "• `XAI_API_KEY=xai-...`",
            "• `DEEPSEEK_API_KEY=sk-...`",
            "",
            "**Or edit:** `~/.openclaw/clawrouter/config.json`",
          ].join("\n"),
        };
      }

      const orActive = hasOpenRouter(apiKeys);
      const accessible = getAccessibleProviders(apiKeys);
      const lines = [
        "🔑 **ClawRouter API Keys**",
        "",
        ...providers.map((p) => {
          const key = apiKeys.providers[p]?.apiKey || "";
          const masked = key.length > 8 ? key.slice(0, 4) + "..." + key.slice(-4) : "****";
          const label = p === "openrouter" ? `${p} (fallback for all providers)` : p;
          return `• **${label}**: \`${masked}\` ✅`;
        }),
        "",
        orActive ? `**${accessible.length} providers accessible** (${providers.filter(p => p !== "openrouter").length} direct + OpenRouter fallback)` : `**${providers.length} providers configured**`,
      ];

      return { text: lines.join("\n") };
    },
  };
}

const plugin: OpenClawPluginDefinition = {
  id: "clawrouter",
  name: "ClawRouter",
  description: "Smart LLM router — your keys, smart routing, maximum savings",
  version: VERSION,

  async register(api: OpenClawPluginApi) {
    const isDisabled = process.env.CLAWROUTER_DISABLED === "true" || process.env.CLAWROUTER_DISABLED === "1";
    if (isDisabled) {
      api.logger.info("ClawRouter disabled (CLAWROUTER_DISABLED=true)");
      return;
    }

    if (isCompletionMode()) {
      api.registerProvider(clawrouterProvider);
      return;
    }

    // Load API keys
    const apiKeys = loadApiKeys(api.pluginConfig);

    api.registerProvider(clawrouterProvider);
    injectModelsConfig(api.logger);

    // Runtime config
    const runtimePort = getProxyPort();
    if (!api.config.models) api.config.models = { providers: {} };
    if (!api.config.models.providers) api.config.models.providers = {};
    api.config.models.providers.clawrouter = {
      baseUrl: `http://127.0.0.1:${runtimePort}/v1`,
      api: "openai-completions",
      apiKey: "local-proxy",
      models: OPENCLAW_MODELS,
    };

    if (!api.config.agents) api.config.agents = {};
    const agents = api.config.agents as Record<string, unknown>;
    if (!agents.defaults) agents.defaults = {};
    const defaults = agents.defaults as Record<string, unknown>;
    if (!defaults.model) defaults.model = {};
    const model = defaults.model as Record<string, unknown>;
    if (!model.primary) model.primary = "clawrouter/auto";

    const configuredProviders = getConfiguredProviders(apiKeys);
    api.logger.info(`ClawRouter registered (${configuredProviders.length} providers: ${configuredProviders.join(", ") || "none"})`);

    // Register commands
    createStatsCommand().then((cmd) => api.registerCommand(cmd)).catch(() => {});
    createKeysCommand(apiKeys).then((cmd) => api.registerCommand(cmd)).catch(() => {});

    // Register service for cleanup
    api.registerService({
      id: "clawrouter-proxy",
      start: () => {},
      stop: async () => {
        if (activeProxyHandle) {
          try { await activeProxyHandle.close(); } catch { /* ignore */ }
          activeProxyHandle = null;
        }
      },
    });

    if (!isGatewayMode()) {
      api.logger.info("Not in gateway mode — proxy will start when gateway runs");
      return;
    }

    startProxyInBackground(api, apiKeys)
      .then(async () => {
        const port = getProxyPort();
        const healthy = await waitForProxyHealth(port, 5000);
        if (!healthy) api.logger.warn("Proxy health check timed out");
      })
      .catch((err) => {
        api.logger.error(`Failed to start proxy: ${err instanceof Error ? err.message : String(err)}`);
      });
  },
};

export default plugin;

// Re-exports
export { startProxy, getProxyPort } from "./proxy.js";
export type { ProxyOptions, ProxyHandle } from "./proxy.js";
export { clawrouterProvider } from "./provider.js";
export {
  OPENCLAW_MODELS, BLOCKRUN_MODELS, buildProviderModels, MODEL_ALIASES,
  resolveModelAlias, isAgenticModel, getAgenticModels, getModelContextWindow,
} from "./models.js";
export { route, DEFAULT_ROUTING_CONFIG, getFallbackChain, getFallbackChainFiltered } from "./router/index.js";
export type { RoutingDecision, RoutingConfig, Tier } from "./router/index.js";
export { logUsage } from "./logger.js";
export type { UsageEntry } from "./logger.js";
export { RequestDeduplicator } from "./dedup.js";
export type { CachedResponse } from "./dedup.js";
export { fetchWithRetry, isRetryable, DEFAULT_RETRY_CONFIG } from "./retry.js";
export type { RetryConfig } from "./retry.js";
export { getStats, formatStatsAscii } from "./stats.js";
export type { DailyStats, AggregatedStats } from "./stats.js";
export { SessionStore, getSessionId, DEFAULT_SESSION_CONFIG } from "./session.js";
export type { SessionEntry, SessionConfig } from "./session.js";
export { loadApiKeys, getConfiguredProviders, getApiKey, getProviderFromModel, resolveProviderAccess, hasOpenRouter, getAccessibleProviders, isModelAccessible } from "./api-keys.js";
export type { ApiKeysConfig, ProviderConfig } from "./api-keys.js";
export { refreshOpenRouterModels, resolveOpenRouterModelId, isOpenRouterCacheReady } from "./openrouter-models.js";
