/**
 * ClawRouter ProviderPlugin for OpenClaw
 *
 * Registers ClawRouter as an LLM provider in OpenClaw.
 * Uses a local proxy to handle smart routing to provider APIs.
 */

import type { ProviderPlugin } from "./types.js";
import { buildProviderModels } from "./models.js";
import type { ProxyHandle } from "./proxy.js";

let activeProxy: ProxyHandle | null = null;

export function setActiveProxy(proxy: ProxyHandle): void {
  activeProxy = proxy;
}

export function getActiveProxy(): ProxyHandle | null {
  return activeProxy;
}

export const clawrouterProvider: ProviderPlugin = {
  id: "clawrouter",
  label: "ClawRouter",
  docsPath: "https://github.com/user/ClawRouter",
  aliases: ["cr"],
  envVars: [],

  get models() {
    if (!activeProxy) {
      return buildProviderModels("http://127.0.0.1:8402");
    }
    return buildProviderModels(activeProxy.baseUrl);
  },

  auth: [],
};
