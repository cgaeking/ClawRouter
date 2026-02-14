/**
 * OpenRouter Model ID Resolution
 *
 * ClawRouter uses internal model IDs like "moonshot/kimi-k2.5", but OpenRouter
 * expects its own IDs like "moonshotai/kimi-k2.5". This module fetches
 * OpenRouter's model catalog and maps ClawRouter IDs to OpenRouter IDs.
 *
 * Matching strategy:
 *   1. Exact match — ClawRouter ID exists in OpenRouter catalog
 *   2. Name match — strip provider prefix, find OR model with same name part
 *   3. No match — pass through original ID (OpenRouter will error, triggering fallback)
 */

import { BLOCKRUN_MODELS } from "./models.js";

type OpenRouterModel = { id: string; name?: string };

let cache: Map<string, string> | null = null; // clawrouter ID → OpenRouter ID
let cacheTime = 0;
const CACHE_TTL_MS = 3_600_000; // 1 hour

/**
 * Fetch OpenRouter's model catalog and build the ID mapping.
 */
export async function refreshOpenRouterModels(apiKey: string): Promise<void> {
  const response = await fetch("https://openrouter.ai/api/v1/models", {
    headers: {
      authorization: `Bearer ${apiKey}`,
      "user-agent": "ClawRouter",
    },
  });

  if (!response.ok) {
    throw new Error(`OpenRouter /models returned ${response.status}`);
  }

  const json = (await response.json()) as { data?: OpenRouterModel[] };
  const orModels = json.data;
  if (!Array.isArray(orModels)) {
    throw new Error("OpenRouter /models response missing data array");
  }

  // Build a set of all OpenRouter model IDs for exact matching
  const orIdSet = new Set(orModels.map((m) => m.id));

  // Build a map from model-name part → first OpenRouter ID that has it
  // e.g., "kimi-k2.5" → "moonshotai/kimi-k2.5"
  const nameToOrId = new Map<string, string>();
  for (const m of orModels) {
    const slash = m.id.indexOf("/");
    if (slash > 0) {
      const namePart = m.id.slice(slash + 1);
      if (!nameToOrId.has(namePart)) {
        nameToOrId.set(namePart, m.id);
      }
    }
  }

  // Map each ClawRouter model to its OpenRouter equivalent
  const newCache = new Map<string, string>();
  for (const model of BLOCKRUN_MODELS) {
    if (model.id === "auto") continue;

    // 1. Exact match
    if (orIdSet.has(model.id)) {
      newCache.set(model.id, model.id);
      continue;
    }

    // 2. Name match — strip provider prefix, find OR model with same name
    const slash = model.id.indexOf("/");
    if (slash > 0) {
      const namePart = model.id.slice(slash + 1);
      const orId = nameToOrId.get(namePart);
      if (orId) {
        newCache.set(model.id, orId);
        continue;
      }
    }

    // 3. No match — will pass through as-is
  }

  cache = newCache;
  cacheTime = Date.now();

  const mapped = [...newCache.entries()].filter(([k, v]) => k !== v);
  console.log(
    `[ClawRouter] Loaded ${orModels.length} OpenRouter models, ${newCache.size} mapped (${mapped.length} remapped)`,
  );
  if (mapped.length > 0) {
    for (const [from, to] of mapped) {
      console.log(`[ClawRouter]   ${from} → ${to}`);
    }
  }
}

/**
 * Resolve a ClawRouter model ID to an OpenRouter model ID.
 * Returns the mapped ID, or the original if no mapping exists.
 */
export function resolveOpenRouterModelId(clawrouterModelId: string): string {
  if (!cache) return clawrouterModelId;
  return cache.get(clawrouterModelId) ?? clawrouterModelId;
}

/**
 * Check if the OpenRouter model cache is populated and fresh.
 */
export function isOpenRouterCacheReady(): boolean {
  return cache !== null && Date.now() - cacheTime < CACHE_TTL_MS;
}

/**
 * Trigger a background refresh if cache is stale or empty.
 * Does not block — returns immediately.
 */
export function ensureOpenRouterCache(apiKey: string): void {
  if (isOpenRouterCacheReady()) return;
  refreshOpenRouterModels(apiKey).catch((err) => {
    console.error(`[ClawRouter] Background OpenRouter cache refresh failed: ${err.message}`);
  });
}
