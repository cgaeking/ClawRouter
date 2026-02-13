/**
 * Local Proxy Server — Direct Provider Access
 *
 * Routes requests to provider APIs using the user's own API keys.
 * Keeps all the smart routing logic (tier classification, fallback chains).
 *
 * Flow:
 *   OpenClaw → http://localhost:{port}/v1/chat/completions
 *           → proxy classifies request, picks cheapest model
 *           → forwards to provider API (OpenAI, Anthropic, Google, etc.)
 *           → streams response back
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { finished } from "node:stream";
import type { AddressInfo } from "node:net";
import {
  loadApiKeys,
  getConfiguredProviders,
  getApiKey,
  getProviderBaseUrl,
  getProviderFromModel,
  resolveProviderAccess,
  isModelAccessible,
  getAccessibleProviders,
  hasOpenRouter,
  type ApiKeysConfig,
} from "./api-keys.js";
import {
  route,
  getFallbackChain,
  getFallbackChainFiltered,
  DEFAULT_ROUTING_CONFIG,
  type RouterOptions,
  type RoutingDecision,
  type RoutingConfig,
  type ModelPricing,
} from "./router/index.js";
import { BLOCKRUN_MODELS, resolveModelAlias, getModelContextWindow } from "./models.js";
import { logUsage, type UsageEntry } from "./logger.js";
import { getStats } from "./stats.js";
import { RequestDeduplicator } from "./dedup.js";
import { USER_AGENT } from "./version.js";
import { SessionStore, getSessionId, type SessionConfig } from "./session.js";

const AUTO_MODEL = "clawrouter/auto";
const AUTO_MODEL_SHORT = "auto";
const HEARTBEAT_INTERVAL_MS = 2_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 180_000;
const DEFAULT_PORT = 8402;
const MAX_FALLBACK_ATTEMPTS = 3;
const HEALTH_CHECK_TIMEOUT_MS = 2_000;
const RATE_LIMIT_COOLDOWN_MS = 60_000;
const PORT_RETRY_ATTEMPTS = 5;
const PORT_RETRY_DELAY_MS = 1_000;

const rateLimitedModels = new Map<string, number>();

function isRateLimited(modelId: string): boolean {
  const hitTime = rateLimitedModels.get(modelId);
  if (!hitTime) return false;
  if (Date.now() - hitTime >= RATE_LIMIT_COOLDOWN_MS) {
    rateLimitedModels.delete(modelId);
    return false;
  }
  return true;
}

function markRateLimited(modelId: string): void {
  rateLimitedModels.set(modelId, Date.now());
  console.log(`[ClawRouter] Model ${modelId} rate-limited, will deprioritize for 60s`);
}

function prioritizeNonRateLimited(models: string[]): string[] {
  const available: string[] = [];
  const limited: string[] = [];
  for (const model of models) {
    (isRateLimited(model) ? limited : available).push(model);
  }
  return [...available, ...limited];
}

function canWrite(res: ServerResponse): boolean {
  return !res.writableEnded && !res.destroyed && res.socket !== null && !res.socket.destroyed && res.socket.writable;
}

function safeWrite(res: ServerResponse, data: string | Buffer): boolean {
  if (!canWrite(res)) return false;
  return res.write(data);
}

export function getProxyPort(): number {
  const envPort = process.env.CLAWROUTER_PORT;
  if (envPort) {
    const parsed = parseInt(envPort, 10);
    if (!isNaN(parsed) && parsed > 0 && parsed < 65536) return parsed;
  }
  return DEFAULT_PORT;
}

async function checkExistingProxy(port: number): Promise<boolean> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal });
    clearTimeout(timeoutId);
    if (response.ok) {
      const data = (await response.json()) as { status?: string };
      return data.status === "ok";
    }
    return false;
  } catch {
    clearTimeout(timeoutId);
    return false;
  }
}

const PROVIDER_ERROR_PATTERNS = [
  /billing/i, /insufficient.*balance/i, /credits/i, /quota.*exceeded/i,
  /rate.*limit/i, /model.*unavailable/i, /service.*unavailable/i,
  /capacity/i, /overloaded/i, /temporarily.*unavailable/i,
  /api.*key.*invalid/i, /authentication.*failed/i,
];

const FALLBACK_STATUS_CODES = [400, 401, 402, 403, 429, 500, 502, 503, 504];

function isProviderError(status: number, body: string): boolean {
  if (!FALLBACK_STATUS_CODES.includes(status)) return false;
  if (status >= 500) return true;
  return PROVIDER_ERROR_PATTERNS.some((pattern) => pattern.test(body));
}

const VALID_ROLES = new Set(["system", "user", "assistant", "tool", "function"]);
const ROLE_MAPPINGS: Record<string, string> = { developer: "system", model: "assistant" };

type ChatMessage = { role: string; content: string | unknown };

const VALID_TOOL_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

function sanitizeToolId(id: string | undefined): string | undefined {
  if (!id || typeof id !== "string") return id;
  if (VALID_TOOL_ID_PATTERN.test(id)) return id;
  return id.replace(/[^a-zA-Z0-9_-]/g, "_");
}

type MessageWithTools = ChatMessage & {
  tool_calls?: Array<{ id?: string; type?: string; function?: unknown }>;
  tool_call_id?: string;
};

type ContentBlock = { type?: string; id?: string; tool_use_id?: string; [key: string]: unknown };

function sanitizeToolIds(messages: ChatMessage[]): ChatMessage[] {
  if (!messages || messages.length === 0) return messages;
  let hasChanges = false;
  const sanitized = messages.map((msg) => {
    const typedMsg = msg as MessageWithTools;
    let msgChanged = false;
    let newMsg = { ...msg } as MessageWithTools;

    if (typedMsg.tool_calls && Array.isArray(typedMsg.tool_calls)) {
      const newToolCalls = typedMsg.tool_calls.map((tc) => {
        if (tc.id && typeof tc.id === "string") {
          const s = sanitizeToolId(tc.id);
          if (s !== tc.id) { msgChanged = true; return { ...tc, id: s }; }
        }
        return tc;
      });
      if (msgChanged) newMsg = { ...newMsg, tool_calls: newToolCalls };
    }

    if (typedMsg.tool_call_id && typeof typedMsg.tool_call_id === "string") {
      const s = sanitizeToolId(typedMsg.tool_call_id);
      if (s !== typedMsg.tool_call_id) { msgChanged = true; newMsg = { ...newMsg, tool_call_id: s }; }
    }

    if (Array.isArray(typedMsg.content)) {
      const newContent = (typedMsg.content as ContentBlock[]).map((block) => {
        if (!block || typeof block !== "object") return block;
        let blockChanged = false;
        let newBlock = { ...block };
        if (block.type === "tool_use" && block.id && typeof block.id === "string") {
          const s = sanitizeToolId(block.id);
          if (s !== block.id) { blockChanged = true; newBlock = { ...newBlock, id: s }; }
        }
        if (block.type === "tool_result" && block.tool_use_id && typeof block.tool_use_id === "string") {
          const s = sanitizeToolId(block.tool_use_id);
          if (s !== block.tool_use_id) { blockChanged = true; newBlock = { ...newBlock, tool_use_id: s }; }
        }
        if (blockChanged) { msgChanged = true; return newBlock; }
        return block;
      });
      if (msgChanged) newMsg = { ...newMsg, content: newContent };
    }

    if (msgChanged) { hasChanges = true; return newMsg; }
    return msg;
  });
  return hasChanges ? sanitized : messages;
}

function normalizeMessageRoles(messages: ChatMessage[]): ChatMessage[] {
  if (!messages || messages.length === 0) return messages;
  let hasChanges = false;
  const normalized = messages.map((msg) => {
    if (VALID_ROLES.has(msg.role)) return msg;
    const mapped = ROLE_MAPPINGS[msg.role];
    if (mapped) { hasChanges = true; return { ...msg, role: mapped }; }
    hasChanges = true;
    return { ...msg, role: "user" };
  });
  return hasChanges ? normalized : messages;
}

function normalizeMessagesForGoogle(messages: ChatMessage[]): ChatMessage[] {
  if (!messages || messages.length === 0) return messages;
  let firstNonSystemIdx = -1;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role !== "system") { firstNonSystemIdx = i; break; }
  }
  if (firstNonSystemIdx === -1) return messages;
  const firstRole = messages[firstNonSystemIdx].role;
  if (firstRole === "user") return messages;
  if (firstRole === "assistant" || firstRole === "model") {
    const normalized = [...messages];
    normalized.splice(firstNonSystemIdx, 0, { role: "user", content: "(continuing conversation)" });
    return normalized;
  }
  return messages;
}

function isGoogleModel(modelId: string): boolean {
  return modelId.startsWith("google/") || modelId.startsWith("gemini");
}

type ExtendedChatMessage = ChatMessage & { tool_calls?: unknown[]; reasoning_content?: unknown };

function normalizeMessagesForThinking(messages: ExtendedChatMessage[]): ExtendedChatMessage[] {
  if (!messages || messages.length === 0) return messages;
  let hasChanges = false;
  const normalized = messages.map((msg) => {
    if (msg.role === "assistant" && msg.tool_calls && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0 && msg.reasoning_content === undefined) {
      hasChanges = true;
      return { ...msg, reasoning_content: "" };
    }
    return msg;
  });
  return hasChanges ? normalized : messages;
}

const KIMI_BLOCK_RE = /<[｜|][^<>]*begin[^<>]*[｜|]>[\s\S]*?<[｜|][^<>]*end[^<>]*[｜|]>/gi;
const KIMI_TOKEN_RE = /<[｜|][^<>]*[｜|]>/g;
const THINKING_TAG_RE = /<\s*\/?\s*(?:think(?:ing)?|thought|antthinking)\b[^>]*>/gi;
const THINKING_BLOCK_RE = /<\s*(?:think(?:ing)?|thought|antthinking)\b[^>]*>[\s\S]*?<\s*\/\s*(?:think(?:ing)?|thought|antthinking)\s*>/gi;

function stripThinkingTokens(content: string): string {
  if (!content) return content;
  let cleaned = content.replace(KIMI_BLOCK_RE, "");
  cleaned = cleaned.replace(KIMI_TOKEN_RE, "");
  cleaned = cleaned.replace(THINKING_BLOCK_RE, "");
  cleaned = cleaned.replace(THINKING_TAG_RE, "");
  return cleaned;
}

/**
 * Convert OpenAI chat completion format to Anthropic Messages API format.
 */
function convertToAnthropicFormat(parsed: Record<string, unknown>): Record<string, unknown> {
  const messages = (parsed.messages as ChatMessage[]) || [];
  
  // Extract system message
  let system: string | undefined;
  const nonSystemMessages: Array<{ role: string; content: string | unknown }> = [];
  
  for (const msg of messages) {
    if (msg.role === "system") {
      system = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
    } else {
      nonSystemMessages.push({
        role: msg.role === "assistant" ? "assistant" : "user",
        content: msg.content,
      });
    }
  }

  const result: Record<string, unknown> = {
    model: parsed.model,
    messages: nonSystemMessages,
    max_tokens: (parsed.max_tokens as number) || 4096,
  };

  if (system) result.system = system;
  if (parsed.stream) result.stream = true;
  if (parsed.temperature !== undefined) result.temperature = parsed.temperature;
  if (parsed.top_p !== undefined) result.top_p = parsed.top_p;
  if (parsed.tools) result.tools = parsed.tools;

  return result;
}

/**
 * Convert Anthropic response to OpenAI format.
 */
function convertAnthropicResponseToOpenAI(anthropicData: Record<string, unknown>): Record<string, unknown> {
  const content = anthropicData.content as Array<{ type: string; text?: string }> | undefined;
  const textContent = content?.filter(b => b.type === "text").map(b => b.text).join("") || "";
  
  return {
    id: (anthropicData.id as string) || `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: anthropicData.model,
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: textContent,
      },
      finish_reason: anthropicData.stop_reason === "end_turn" ? "stop" : (anthropicData.stop_reason || "stop"),
    }],
    usage: anthropicData.usage ? {
      prompt_tokens: (anthropicData.usage as Record<string, number>).input_tokens || 0,
      completion_tokens: (anthropicData.usage as Record<string, number>).output_tokens || 0,
      total_tokens: ((anthropicData.usage as Record<string, number>).input_tokens || 0) + ((anthropicData.usage as Record<string, number>).output_tokens || 0),
    } : undefined,
  };
}

export type ProxyOptions = {
  apiKeys: ApiKeysConfig;
  port?: number;
  routingConfig?: Partial<RoutingConfig>;
  requestTimeoutMs?: number;
  sessionConfig?: Partial<SessionConfig>;
  onReady?: (port: number) => void;
  onError?: (error: Error) => void;
  onRouted?: (decision: RoutingDecision) => void;
};

export type ProxyHandle = {
  port: number;
  baseUrl: string;
  configuredProviders: string[];
  close: () => Promise<void>;
};

function buildModelPricing(): Map<string, ModelPricing> {
  const map = new Map<string, ModelPricing>();
  for (const m of BLOCKRUN_MODELS) {
    if (m.id === "auto") continue;
    map.set(m.id, { inputPrice: m.inputPrice, outputPrice: m.outputPrice });
  }
  return map;
}

function mergeRoutingConfig(overrides?: Partial<RoutingConfig>): RoutingConfig {
  if (!overrides) return DEFAULT_ROUTING_CONFIG;
  return {
    ...DEFAULT_ROUTING_CONFIG,
    ...overrides,
    classifier: { ...DEFAULT_ROUTING_CONFIG.classifier, ...overrides.classifier },
    scoring: { ...DEFAULT_ROUTING_CONFIG.scoring, ...overrides.scoring },
    tiers: { ...DEFAULT_ROUTING_CONFIG.tiers, ...overrides.tiers },
    overrides: { ...DEFAULT_ROUTING_CONFIG.overrides, ...overrides.overrides },
  };
}

/**
 * Build the upstream URL for a provider.
 * Priority: direct provider key > OpenRouter fallback.
 */
function buildUpstreamUrl(
  modelId: string,
  path: string,
  apiKeys: ApiKeysConfig,
): { url: string; provider: string; apiKey: string; actualModelId: string; viaOpenRouter: boolean } | undefined {
  const access = resolveProviderAccess(apiKeys, modelId);
  if (!access) return undefined;

  const { apiKey, baseUrl, provider, viaOpenRouter } = access;

  if (viaOpenRouter) {
    // OpenRouter uses the full provider/model format as model ID
    // e.g., "openai/gpt-4o", "anthropic/claude-sonnet-4"
    const orPath = baseUrl.endsWith("/v1") && path.startsWith("/v1") ? path.slice(3) : path;
    return {
      url: `${baseUrl}${orPath}`,
      provider,
      apiKey,
      actualModelId: modelId, // Keep full ID for OpenRouter
      viaOpenRouter: true,
    };
  }

  // Direct provider access — strip provider prefix
  const actualModelId = modelId.includes("/") ? modelId.split("/").slice(1).join("/") : modelId;

  // Strip /v1 prefix from path if baseUrl already ends with /v1
  const normalizedPath = baseUrl.endsWith("/v1") && path.startsWith("/v1")
    ? path.slice(3) // remove leading /v1
    : path;

  // Google uses a different URL structure
  if (provider === "google") {
    return {
      url: `${baseUrl}/models/${actualModelId}:streamGenerateContent?alt=sse`,
      provider,
      apiKey,
      actualModelId,
      viaOpenRouter: false,
    };
  }

  // Anthropic uses /v1/messages, not /v1/chat/completions
  // Also needs full model IDs (e.g., claude-sonnet-4-20250514)
  if (provider === "anthropic") {
    const ANTHROPIC_MODEL_MAP: Record<string, string> = {
      "claude-sonnet-4": "claude-sonnet-4-20250514",
      "claude-opus-4": "claude-opus-4-20250514",
      "claude-opus-4.5": "claude-opus-4-20250514", // fallback
      "claude-haiku-4.5": "claude-haiku-4-20250414",
    };
    const mappedModel = ANTHROPIC_MODEL_MAP[actualModelId] || actualModelId;
    return {
      url: `${baseUrl}/messages`,
      provider,
      apiKey,
      actualModelId: mappedModel,
      viaOpenRouter: false,
    };
  }

  return {
    url: `${baseUrl}${normalizedPath}`,
    provider,
    apiKey,
    actualModelId,
    viaOpenRouter: false,
  };
}

/**
 * Build headers for a provider request.
 */
function buildProviderHeaders(provider: string, apiKey: string, viaOpenRouter = false): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": USER_AGENT,
  };

  // OpenRouter always uses Bearer auth (OpenAI-compatible)
  if (viaOpenRouter) {
    headers["authorization"] = `Bearer ${apiKey}`;
    headers["x-title"] = "ClawRouter";
    return headers;
  }

  switch (provider) {
    case "anthropic":
      headers["x-api-key"] = apiKey;
      headers["anthropic-version"] = "2023-06-01";
      break;
    case "google":
      headers["x-goog-api-key"] = apiKey;
      break;
    default:
      // OpenAI-compatible providers (openai, xai, deepseek, moonshot, nvidia)
      headers["authorization"] = `Bearer ${apiKey}`;
      break;
  }

  return headers;
}

type ModelRequestResult = {
  success: boolean;
  response?: Response;
  errorBody?: string;
  errorStatus?: number;
  isProviderError?: boolean;
};

async function tryModelRequest(
  modelId: string,
  path: string,
  method: string,
  body: Buffer,
  maxTokens: number,
  apiKeys: ApiKeysConfig,
  signal: AbortSignal,
): Promise<ModelRequestResult> {
  const upstream = buildUpstreamUrl(modelId, path, apiKeys);
  if (!upstream) {
    return {
      success: false,
      errorBody: `No API key configured for provider: ${getProviderFromModel(modelId)} (and no OpenRouter fallback)`,
      errorStatus: 401,
      isProviderError: true,
    };
  }

  // Update model in body and normalize messages
  let requestBody = body;
  try {
    const parsed = JSON.parse(body.toString()) as Record<string, unknown>;
    parsed.model = upstream.actualModelId;

    if (Array.isArray(parsed.messages)) {
      parsed.messages = normalizeMessageRoles(parsed.messages as ChatMessage[]);
      parsed.messages = sanitizeToolIds(parsed.messages as ChatMessage[]);
    }

    if (isGoogleModel(modelId) && Array.isArray(parsed.messages)) {
      parsed.messages = normalizeMessagesForGoogle(parsed.messages as ChatMessage[]);
    }

    if (parsed.thinking && Array.isArray(parsed.messages)) {
      parsed.messages = normalizeMessagesForThinking(parsed.messages as ExtendedChatMessage[]);
    }

    // Convert OpenAI format to Anthropic Messages API format
    if (upstream.provider === "anthropic" && !upstream.viaOpenRouter) {
      const anthropicBody = convertToAnthropicFormat(parsed);
      requestBody = Buffer.from(JSON.stringify(anthropicBody));
    } else {
      requestBody = Buffer.from(JSON.stringify(parsed));
    }
  } catch {
    // If body isn't valid JSON, use as-is
  }

  const headers = buildProviderHeaders(upstream.provider, upstream.apiKey, upstream.viaOpenRouter);

  try {
    console.log(`[ClawRouter] → ${upstream.provider} ${upstream.url} model=${upstream.actualModelId} viaOR=${upstream.viaOpenRouter}`);
    const response = await fetch(upstream.url, {
      method,
      headers,
      body: requestBody.length > 0 ? new Uint8Array(requestBody) : undefined,
      signal,
    });

    if (response.status !== 200) {
      const errorBody = await response.text();
      console.log(`[ClawRouter] ← ${response.status} ${errorBody.slice(0, 200)}`);
      return {
        success: false,
        errorBody,
        errorStatus: response.status,
        isProviderError: isProviderError(response.status, errorBody),
      };
    }

    return { success: true, response };
  } catch (err) {
    return {
      success: false,
      errorBody: err instanceof Error ? err.message : String(err),
      errorStatus: 500,
      isProviderError: true,
    };
  }
}

export async function startProxy(options: ProxyOptions): Promise<ProxyHandle> {
  const listenPort = options.port ?? getProxyPort();
  const configuredProviders = getConfiguredProviders(options.apiKeys);

  // Check if proxy already running
  const existing = await checkExistingProxy(listenPort);
  if (existing) {
    options.onReady?.(listenPort);
    return {
      port: listenPort,
      baseUrl: `http://127.0.0.1:${listenPort}`,
      configuredProviders,
      close: async () => {},
    };
  }

  const routingConfig = mergeRoutingConfig(options.routingConfig);
  const modelPricing = buildModelPricing();
  const routerOpts: RouterOptions = { config: routingConfig, modelPricing };
  const deduplicator = new RequestDeduplicator();
  const sessionStore = new SessionStore(options.sessionConfig);
  const connections = new Set<import("net").Socket>();

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    req.on("error", (err) => console.error(`[ClawRouter] Request stream error: ${err.message}`));
    res.on("error", (err) => console.error(`[ClawRouter] Response stream error: ${err.message}`));
    finished(res, (err) => { if (err && err.code !== "ERR_STREAM_DESTROYED") console.error(`[ClawRouter] Response finished with error: ${err.message}`); });

    // Health check
    if (req.url === "/health" || req.url?.startsWith("/health?")) {
      const accessibleProviders = getAccessibleProviders(options.apiKeys);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        status: "ok",
        configuredProviders,
        openRouterFallback: hasOpenRouter(options.apiKeys),
        accessibleProviders,
        modelCount: BLOCKRUN_MODELS.filter((m) => {
          if (m.id === "auto") return false;
          const provider = getProviderFromModel(m.id);
          return accessibleProviders.includes(provider);
        }).length,
      }));
      return;
    }

    // Stats endpoint
    if (req.url === "/stats" || req.url?.startsWith("/stats?")) {
      try {
        const url = new URL(req.url, "http://localhost");
        const days = parseInt(url.searchParams.get("days") || "7", 10);
        const stats = await getStats(Math.min(days, 30));
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
        res.end(JSON.stringify(stats, null, 2));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `Failed to get stats: ${err instanceof Error ? err.message : String(err)}` }));
      }
      return;
    }

    // Models list
    if (req.url === "/v1/models" && req.method === "GET") {
      const accessibleProviders = getAccessibleProviders(options.apiKeys);
      const models = BLOCKRUN_MODELS
        .filter((m) => {
          if (m.id === "auto") return true;
          const provider = getProviderFromModel(m.id);
          return accessibleProviders.includes(provider);
        })
        .map((m) => ({
          id: m.id,
          object: "model",
          created: Math.floor(Date.now() / 1000),
          owned_by: m.id.split("/")[0] || "clawrouter",
        }));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: models }));
      return;
    }

    if (!req.url?.startsWith("/v1")) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }

    try {
      await proxyRequest(req, res, options, routerOpts, deduplicator, sessionStore);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      options.onError?.(error);
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: `Proxy error: ${error.message}`, type: "proxy_error" } }));
      } else if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ error: { message: error.message, type: "proxy_error" } })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      }
    }
  });

  // Port binding with retry
  const tryListen = (attempt: number): Promise<void> => {
    return new Promise<void>((resolve, reject) => {
      const onError = async (err: NodeJS.ErrnoException) => {
        server.removeListener("error", onError);
        if (err.code === "EADDRINUSE") {
          if (attempt < PORT_RETRY_ATTEMPTS) {
            reject({ code: "RETRY", attempt });
            return;
          }
        }
        reject(err);
      };
      server.once("error", onError);
      server.listen(listenPort, "127.0.0.1", () => { server.removeListener("error", onError); resolve(); });
    });
  };

  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= PORT_RETRY_ATTEMPTS; attempt++) {
    try {
      await tryListen(attempt);
      break;
    } catch (err: unknown) {
      const error = err as { code?: string };
      if (error.code === "RETRY") {
        await new Promise((r) => setTimeout(r, PORT_RETRY_DELAY_MS));
        continue;
      }
      lastError = err as Error;
      break;
    }
  }
  if (lastError) throw lastError;

  const addr = server.address() as AddressInfo;
  const port = addr.port;
  options.onReady?.(port);

  server.on("error", (err) => { console.error(`[ClawRouter] Server runtime error: ${err.message}`); options.onError?.(err); });
  server.on("clientError", (err, socket) => { console.error(`[ClawRouter] Client error: ${err.message}`); if (socket.writable && !socket.destroyed) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"); });
  server.on("connection", (socket) => {
    connections.add(socket);
    socket.setTimeout(300_000);
    socket.on("timeout", () => socket.destroy());
    socket.on("error", (err) => console.error(`[ClawRouter] Socket error: ${err.message}`));
    socket.on("close", () => connections.delete(socket));
  });

  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    configuredProviders,
    close: () => new Promise<void>((res, rej) => {
      const timeout = setTimeout(() => rej(new Error("[ClawRouter] Close timeout after 4s")), 4000);
      sessionStore.close();
      for (const socket of connections) socket.destroy();
      connections.clear();
      server.close((err) => { clearTimeout(timeout); err ? rej(err) : res(); });
    }),
  };
}

async function proxyRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: ProxyOptions,
  routerOpts: RouterOptions,
  deduplicator: RequestDeduplicator,
  sessionStore: SessionStore,
): Promise<void> {
  const startTime = Date.now();
  const requestPath = req.url || "/v1/chat/completions";

  // Collect request body
  const bodyChunks: Buffer[] = [];
  for await (const chunk of req) {
    bodyChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  let body = Buffer.concat(bodyChunks);

  let routingDecision: RoutingDecision | undefined;
  let isStreaming = false;
  let modelId = "";
  let maxTokens = 4096;
  const isChatCompletion = req.url?.includes("/chat/completions");

  if (isChatCompletion && body.length > 0) {
    try {
      const parsed = JSON.parse(body.toString()) as Record<string, unknown>;
      isStreaming = parsed.stream === true;
      modelId = (parsed.model as string) || "";
      maxTokens = (parsed.max_tokens as number) || 4096;

      const normalizedModel = typeof parsed.model === "string" ? parsed.model.trim().toLowerCase() : "";
      const resolvedModel = resolveModelAlias(normalizedModel);
      const wasAlias = resolvedModel !== normalizedModel;

      const isAutoModel = normalizedModel === AUTO_MODEL.toLowerCase() ||
        normalizedModel === AUTO_MODEL_SHORT.toLowerCase() ||
        normalizedModel === "blockrun/auto" || // backward compat
        normalizedModel === "clawrouter/auto";

      console.log(`[ClawRouter] Received model: "${parsed.model}" -> normalized: "${normalizedModel}"${wasAlias ? ` -> alias: "${resolvedModel}"` : ""}, isAuto: ${isAutoModel}`);

      if (wasAlias && !isAutoModel) {
        parsed.model = resolvedModel;
        modelId = resolvedModel;
      }

      if (isAutoModel) {
        const sessionId = getSessionId(req.headers as Record<string, string | string[] | undefined>);
        const existingSession = sessionId ? sessionStore.getSession(sessionId) : undefined;

        if (existingSession) {
          console.log(`[ClawRouter] Session ${sessionId?.slice(0, 8)}... using pinned model: ${existingSession.model}`);
          parsed.model = existingSession.model;
          modelId = existingSession.model;
          sessionStore.touchSession(sessionId!);
        } else {
          type Msg = { role: string; content: string };
          const messages = parsed.messages as Msg[] | undefined;
          let lastUserMsg: Msg | undefined;
          if (messages) {
            for (let i = messages.length - 1; i >= 0; i--) {
              if (messages[i].role === "user") { lastUserMsg = messages[i]; break; }
            }
          }
          const systemMsg = messages?.find((m: Msg) => m.role === "system");
          const prompt = typeof lastUserMsg?.content === "string" ? lastUserMsg.content : "";
          const systemPrompt = typeof systemMsg?.content === "string" ? systemMsg.content : undefined;

          routingDecision = route(prompt, systemPrompt, maxTokens, routerOpts);

          // Filter to models with configured API keys (direct or via OpenRouter)
          if (!isModelAccessible(options.apiKeys, routingDecision.model)) {
            // Primary model not accessible, find alternative
            const tierConfig = routerOpts.config.tiers[routingDecision.tier];
            const chain = [tierConfig.primary, ...tierConfig.fallback];
            const available = chain.find((m) => isModelAccessible(options.apiKeys, m));
            if (available) {
              routingDecision = { ...routingDecision, model: available, reasoning: routingDecision.reasoning + ` | rerouted to ${available} (key available)` };
            }
          }

          parsed.model = routingDecision.model;
          modelId = routingDecision.model;

          if (sessionId) {
            sessionStore.setSession(sessionId, routingDecision.model, routingDecision.tier);
          }
          options.onRouted?.(routingDecision);
        }
      }

      body = Buffer.from(JSON.stringify(parsed));
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[ClawRouter] Routing error: ${errorMsg}`);
      options.onError?.(new Error(`Routing failed: ${errorMsg}`));
    }
  }

  // Dedup check
  const dedupKey = RequestDeduplicator.hash(body);
  const cached = deduplicator.getCached(dedupKey);
  if (cached) { res.writeHead(cached.status, cached.headers); res.end(cached.body); return; }
  const inflight = deduplicator.getInflight(dedupKey);
  if (inflight) { const result = await inflight; res.writeHead(result.status, result.headers); res.end(result.body); return; }
  deduplicator.markInflight(dedupKey);

  // Streaming heartbeat
  let heartbeatInterval: ReturnType<typeof setInterval> | undefined;
  let headersSentEarly = false;

  if (isStreaming) {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    headersSentEarly = true;
    safeWrite(res, ": heartbeat\n\n");
    heartbeatInterval = setInterval(() => {
      if (canWrite(res)) safeWrite(res, ": heartbeat\n\n");
      else { clearInterval(heartbeatInterval); heartbeatInterval = undefined; }
    }, HEARTBEAT_INTERVAL_MS);
  }

  let completed = false;
  res.on("close", () => {
    if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = undefined; }
    if (!completed) deduplicator.removeInflight(dedupKey);
  });

  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // Build fallback chain
    let modelsToTry: string[];
    if (routingDecision) {
      const estimatedInputTokens = Math.ceil(body.length / 4);
      const estimatedTotalTokens = estimatedInputTokens + maxTokens;
      const useAgenticTiers = routingDecision.reasoning?.includes("agentic") && routerOpts.config.agenticTiers;
      const tierConfigs = useAgenticTiers ? routerOpts.config.agenticTiers! : routerOpts.config.tiers;
      const contextFiltered = getFallbackChainFiltered(routingDecision.tier, tierConfigs, estimatedTotalTokens, getModelContextWindow);
      modelsToTry = contextFiltered.slice(0, MAX_FALLBACK_ATTEMPTS);
      // Filter to models with accessible keys (direct or OpenRouter)
      modelsToTry = modelsToTry.filter((m) => isModelAccessible(options.apiKeys, m));
      modelsToTry = prioritizeNonRateLimited(modelsToTry);
    } else {
      modelsToTry = modelId ? [modelId] : [];
    }

    let upstream: Response | undefined;
    let lastError: { body: string; status: number } | undefined;
    let actualModelUsed = modelId;

    for (let i = 0; i < modelsToTry.length; i++) {
      const tryModel = modelsToTry[i];
      const isLastAttempt = i === modelsToTry.length - 1;
      console.log(`[ClawRouter] Trying model ${i + 1}/${modelsToTry.length}: ${tryModel}`);

      const result = await tryModelRequest(tryModel, requestPath, req.method ?? "POST", body, maxTokens, options.apiKeys, controller.signal);

      if (result.success && result.response) {
        upstream = result.response;
        actualModelUsed = tryModel;
        console.log(`[ClawRouter] Success with model: ${tryModel}`);
        break;
      }

      lastError = { body: result.errorBody || "Unknown error", status: result.errorStatus || 500 };
      if (result.isProviderError && !isLastAttempt) {
        if (result.errorStatus === 429) markRateLimited(tryModel);
        console.log(`[ClawRouter] Provider error from ${tryModel}, trying fallback: ${result.errorBody?.slice(0, 100)}`);
        continue;
      }
      break;
    }

    clearTimeout(timeoutId);
    if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = undefined; }

    if (routingDecision && actualModelUsed !== routingDecision.model) {
      routingDecision = { ...routingDecision, model: actualModelUsed, reasoning: `${routingDecision.reasoning} | fallback to ${actualModelUsed}` };
      options.onRouted?.(routingDecision);
    }

    // All models failed
    if (!upstream) {
      const errBody = lastError?.body || "All models in fallback chain failed";
      const errStatus = lastError?.status || 502;
      if (headersSentEarly) {
        const errEvent = `data: ${JSON.stringify({ error: { message: errBody, type: "provider_error", status: errStatus } })}\n\n`;
        safeWrite(res, errEvent);
        safeWrite(res, "data: [DONE]\n\n");
        res.end();
        deduplicator.complete(dedupKey, { status: 200, headers: { "content-type": "text/event-stream" }, body: Buffer.from(errEvent + "data: [DONE]\n\n"), completedAt: Date.now() });
      } else {
        res.writeHead(errStatus, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: errBody, type: "provider_error" } }));
        deduplicator.complete(dedupKey, { status: errStatus, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify({ error: { message: errBody, type: "provider_error" } })), completedAt: Date.now() });
      }
      return;
    }

    // Stream response
    const responseChunks: Buffer[] = [];

    if (headersSentEarly) {
      // Stream SSE from upstream
      if (upstream.body) {
        const reader = upstream.body.getReader();
        const chunks: Uint8Array[] = [];
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
          }
        } finally {
          reader.releaseLock();
        }

        const jsonBody = Buffer.concat(chunks);
        const jsonStr = jsonBody.toString();

        // Check if response is SSE (streaming) or JSON (non-streaming)
        // SSE can start with "data: ", "event: ", or ": " (comment/heartbeat)
        const isSSE = jsonStr.startsWith("data: ") || jsonStr.startsWith("event: ") || jsonStr.startsWith(": ");
        if (isSSE) {
          // Already SSE format - filter out OpenRouter processing comments and non-JSON data lines
          const filteredLines: string[] = [];
          for (const line of jsonStr.split("\n")) {
            // Skip OpenRouter "PROCESSING" lines (e.g., "data: : OPENROUTER PROCESSING")
            if (line.startsWith("data: :") || line.startsWith("data: : ")) continue;
            filteredLines.push(line);
          }
          const filtered = filteredLines.join("\n");
          safeWrite(res, filtered);
          responseChunks.push(Buffer.from(filtered));
        } else {
          // JSON response - convert to SSE
          // If from Anthropic, convert to OpenAI format first
          let responseJson = jsonStr;
          try {
            const rawParsed = JSON.parse(jsonStr);
            if (rawParsed.type === "message" && rawParsed.content) {
              // This is an Anthropic response — convert to OpenAI format
              const converted = convertAnthropicResponseToOpenAI(rawParsed);
              responseJson = JSON.stringify(converted);
            }
          } catch { /* not JSON or parse error, continue */ }
          try {
            const rsp = JSON.parse(responseJson) as {
              id?: string; created?: number; model?: string;
              choices?: Array<{ index?: number; message?: { role?: string; content?: string; tool_calls?: unknown[] }; delta?: { role?: string; content?: string; tool_calls?: unknown[] }; finish_reason?: string | null }>;
            };

            const baseChunk = {
              id: rsp.id ?? `chatcmpl-${Date.now()}`,
              object: "chat.completion.chunk",
              created: rsp.created ?? Math.floor(Date.now() / 1000),
              model: rsp.model ?? "unknown",
              system_fingerprint: null,
            };

            if (rsp.choices && Array.isArray(rsp.choices)) {
              for (const choice of rsp.choices) {
                const rawContent = choice.message?.content ?? choice.delta?.content ?? "";
                const content = stripThinkingTokens(rawContent);
                const role = choice.message?.role ?? choice.delta?.role ?? "assistant";
                const index = choice.index ?? 0;

                const roleData = `data: ${JSON.stringify({ ...baseChunk, choices: [{ index, delta: { role }, logprobs: null, finish_reason: null }] })}\n\n`;
                safeWrite(res, roleData);
                responseChunks.push(Buffer.from(roleData));

                if (content) {
                  const contentData = `data: ${JSON.stringify({ ...baseChunk, choices: [{ index, delta: { content }, logprobs: null, finish_reason: null }] })}\n\n`;
                  safeWrite(res, contentData);
                  responseChunks.push(Buffer.from(contentData));
                }

                const toolCalls = choice.message?.tool_calls ?? choice.delta?.tool_calls;
                if (toolCalls && (toolCalls as unknown[]).length > 0) {
                  const toolCallData = `data: ${JSON.stringify({ ...baseChunk, choices: [{ index, delta: { tool_calls: toolCalls }, logprobs: null, finish_reason: null }] })}\n\n`;
                  safeWrite(res, toolCallData);
                  responseChunks.push(Buffer.from(toolCallData));
                }

                const finishData = `data: ${JSON.stringify({ ...baseChunk, choices: [{ index, delta: {}, logprobs: null, finish_reason: choice.finish_reason ?? "stop" }] })}\n\n`;
                safeWrite(res, finishData);
                responseChunks.push(Buffer.from(finishData));
              }
            }
          } catch {
            const sseData = `data: ${jsonStr}\n\n`;
            safeWrite(res, sseData);
            responseChunks.push(Buffer.from(sseData));
          }
        }
      }

      safeWrite(res, "data: [DONE]\n\n");
      responseChunks.push(Buffer.from("data: [DONE]\n\n"));
      res.end();
      deduplicator.complete(dedupKey, { status: 200, headers: { "content-type": "text/event-stream" }, body: Buffer.concat(responseChunks), completedAt: Date.now() });
    } else {
      // Non-streaming
      const responseHeaders: Record<string, string> = {};
      upstream.headers.forEach((value, key) => {
        if (key === "transfer-encoding" || key === "connection" || key === "content-encoding") return;
        responseHeaders[key] = value;
      });

      if (upstream.body) {
        const reader = upstream.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            responseChunks.push(Buffer.from(value));
          }
        } finally {
          reader.releaseLock();
        }
      }
      let finalBody = Buffer.concat(responseChunks);
      
      // Convert Anthropic response to OpenAI format for non-streaming
      try {
        const rawParsed = JSON.parse(finalBody.toString());
        if (rawParsed.type === "message" && rawParsed.content) {
          const converted = convertAnthropicResponseToOpenAI(rawParsed);
          finalBody = Buffer.from(JSON.stringify(converted));
          responseHeaders["content-type"] = "application/json";
        }
      } catch { /* not JSON, pass through */ }
      
      res.writeHead(upstream.status, responseHeaders);
      safeWrite(res, finalBody);
      res.end();
      deduplicator.complete(dedupKey, { status: upstream.status, headers: responseHeaders, body: finalBody, completedAt: Date.now() });
    }

    completed = true;
  } catch (err) {
    clearTimeout(timeoutId);
    if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = undefined; }
    deduplicator.removeInflight(dedupKey);
    if (err instanceof Error && err.name === "AbortError") throw new Error(`Request timed out after ${timeoutMs}ms`);
    throw err;
  }

  // Usage logging
  if (routingDecision) {
    const entry: UsageEntry = {
      timestamp: new Date().toISOString(),
      model: routingDecision.model,
      tier: routingDecision.tier,
      cost: routingDecision.costEstimate,
      baselineCost: routingDecision.baselineCost,
      savings: routingDecision.savings,
      latencyMs: Date.now() - startTime,
    };
    logUsage(entry).catch(() => {});
  }
}
