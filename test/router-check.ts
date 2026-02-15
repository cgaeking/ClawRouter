/**
 * Quick router sanity check — tests classification + model selection.
 * No network needed.
 *
 * Usage: npx tsx test/router-check.ts
 */

import { route, DEFAULT_ROUTING_CONFIG } from "../src/router/index.js";
import { classifyByRules } from "../src/router/rules.js";
import type { ModelPricing } from "../src/router/selector.js";

// ─── Helpers ───

function pricing(input: number, output: number): ModelPricing {
  return { inputPrice: input, outputPrice: output };
}

const modelPricing = new Map<string, ModelPricing>([
  ["google/gemini-2.5-flash", pricing(0.15, 0.6)],
  ["google/gemini-2.5-pro", pricing(1.25, 10)],
  ["nvidia/gpt-oss-120b", pricing(0, 0)],
  ["deepseek/deepseek-chat", pricing(0.28, 0.42)],
  ["deepseek/deepseek-reasoner", pricing(0.28, 0.42)],
  ["openai/gpt-4o-mini", pricing(0.15, 0.6)],
  ["openai/gpt-4o", pricing(2.5, 10)],
  ["anthropic/claude-sonnet-4", pricing(3, 15)],
  ["anthropic/claude-haiku-4.5", pricing(1, 5)],
  ["xai/grok-code-fast-1", pricing(0.2, 1.5)],
  ["xai/grok-4-fast-reasoning", pricing(0.2, 0.5)],
  ["xai/grok-4-fast-non-reasoning", pricing(0.2, 0.5)],
  ["xai/grok-4-0709", pricing(3, 15)],
  ["moonshot/kimi-k2.5", pricing(0.5, 2.4)],
]);

const config = DEFAULT_ROUTING_CONFIG;
const routerOpts = { config, modelPricing };

let passed = 0;
let failed = 0;

function ok(condition: boolean, msg: string) {
  if (condition) { console.log(`  ✓ ${msg}`); passed++; }
  else { console.error(`  ✗ FAIL: ${msg}`); failed++; }
}

// ─── 1. Rule-based classification ───

console.log("\n══ 1. Rule-Based Classifier ══\n");

// SIMPLE
{
  console.log("SIMPLE queries:");
  for (const [prompt, tokens] of [
    ["What is the capital of France?", 8],
    ["Hello", 2],
    ["Translate hello to Spanish", 6],
    ["Yes or no: is the sky blue?", 8],
    ["你好，什么是人工智能？", 15],
    ["Hallo, was ist maschinelles Lernen?", 10],
    ["Привет, что такое машинное обучение?", 15],
  ] as const) {
    const r = classifyByRules(prompt, undefined, tokens, config.scoring);
    ok(r.tier === "SIMPLE", `"${prompt}" → ${r.tier} (score=${r.score.toFixed(3)})`);
  }
}

// REASONING
{
  console.log("\nREASONING queries:");
  for (const [prompt, tokens] of [
    ["Prove that sqrt(2) is irrational step by step using proof by contradiction", 60],
    ["Derive the time complexity step by step, then prove it is optimal", 80],
    ["Using chain of thought, prove that 1+2+...+n = n(n+1)/2", 70],
    ["请证明根号2是无理数，逐步推导", 20],
    ["Beweisen Sie Schritt für Schritt, dass Wurzel 2 irrational ist", 25],
  ] as const) {
    const r = classifyByRules(prompt, undefined, tokens, config.scoring);
    ok(r.tier === "REASONING", `"${prompt.slice(0, 60)}..." → ${r.tier} (score=${r.score.toFixed(3)})`);
  }
}

// System prompt should NOT affect user-prompt classification
{
  console.log("\nSystem prompt isolation:");
  const sysPrompt = "Think step by step and reason logically about the user's question.";
  const r1 = classifyByRules("What is 2+2?", sysPrompt, 10, config.scoring);
  ok(r1.tier === "SIMPLE", `"2+2" with reasoning sys prompt → ${r1.tier} (should be SIMPLE)`);
  const r2 = classifyByRules("Hello", sysPrompt, 5, config.scoring);
  ok(r2.tier === "SIMPLE", `"Hello" with reasoning sys prompt → ${r2.tier} (should be SIMPLE)`);
}

// ─── 2. Full route() — model selection ───

console.log("\n══ 2. Full route() — Model Selection ══\n");

// SIMPLE → should pick cheap model
{
  console.log("SIMPLE tier model:");
  const d = route("What is 2+2?", undefined, 4096, routerOpts);
  ok(d.tier === "SIMPLE", `tier=${d.tier}`);
  ok(d.model === "google/gemini-2.5-flash", `model=${d.model} (expected gemini-2.5-flash)`);
  console.log(`  reasoning: ${d.reasoning}`);
}

// REASONING → should pick reasoning model
{
  console.log("\nREASONING tier model:");
  const d = route("Prove step by step that sqrt(2) is irrational using proof by contradiction", undefined, 4096, routerOpts);
  ok(d.tier === "REASONING", `tier=${d.tier}`);
  ok(d.model === "xai/grok-4-fast-reasoning", `model=${d.model} (expected grok-4-fast-reasoning)`);
  console.log(`  reasoning: ${d.reasoning}`);
}

// Large context override → COMPLEX (user tokens only!)
{
  console.log("\nLarge context override (user tokens only):");
  const longPrompt = "x".repeat(500_000); // ~125K user tokens
  const d = route(longPrompt, undefined, 4096, routerOpts);
  ok(d.tier === "COMPLEX", `125K user tokens → tier=${d.tier} (should be COMPLEX)`);
  ok(d.model === "google/gemini-2.5-pro", `model=${d.model} (expected gemini-2.5-pro)`);
}

// KEY TEST: Large system prompt should NOT force COMPLEX
{
  console.log("\nLarge system prompt should NOT force COMPLEX:");
  const bigSystemPrompt = "tool definitions ".repeat(50_000); // ~200K chars = ~50K tokens
  const d = route("What is 2+2?", bigSystemPrompt, 4096, routerOpts);
  ok(d.tier !== "COMPLEX", `Small user prompt + big sys prompt → tier=${d.tier} (should NOT be COMPLEX)`);
  console.log(`  model=${d.model}, reasoning: ${d.reasoning}`);
}

// COMPLEX tier model check (no Opus!)
{
  console.log("\nCOMPLEX tier model (Opus should be gone):");
  const d = route("x".repeat(500_000), undefined, 4096, routerOpts);
  ok(!d.model.includes("opus"), `model=${d.model} (should NOT contain opus)`);
  ok(d.model === "google/gemini-2.5-pro", `model=${d.model} (expected gemini-2.5-pro)`);

  // Check fallback chain too
  const tierConfig = config.tiers.COMPLEX;
  const allModels = [tierConfig.primary, ...tierConfig.fallback];
  const hasOpus = allModels.some(m => m.includes("opus"));
  ok(!hasOpus, `COMPLEX fallback chain: [${allModels.join(", ")}] — no opus`);
}

// Agentic COMPLEX tier check
{
  console.log("\nAgentic COMPLEX tier (Opus should be gone):");
  const agenticTierConfig = config.agenticTiers!.COMPLEX;
  const allModels = [agenticTierConfig.primary, ...agenticTierConfig.fallback];
  const hasOpus = allModels.some(m => m.includes("opus"));
  ok(!hasOpus, `Agentic COMPLEX chain: [${allModels.join(", ")}] — no opus`);
  ok(agenticTierConfig.primary === "google/gemini-2.5-pro", `agentic COMPLEX primary=${agenticTierConfig.primary}`);
}

// Agentic REASONING tier check
{
  console.log("\nAgentic REASONING tier (Opus should be gone):");
  const agenticTierConfig = config.agenticTiers!.REASONING;
  const allModels = [agenticTierConfig.primary, ...agenticTierConfig.fallback];
  const hasOpus = allModels.some(m => m.includes("opus"));
  ok(!hasOpus, `Agentic REASONING chain: [${allModels.join(", ")}] — no opus`);
  ok(agenticTierConfig.primary === "anthropic/claude-sonnet-4", `agentic REASONING primary=${agenticTierConfig.primary}`);
}

// Full config scan: NO opus anywhere
{
  console.log("\nFull config scan — Opus completely removed:");
  const allTierModels: string[] = [];
  for (const tier of Object.values(config.tiers)) {
    allTierModels.push(tier.primary, ...tier.fallback);
  }
  for (const tier of Object.values(config.agenticTiers!)) {
    allTierModels.push(tier.primary, ...tier.fallback);
  }
  const opusModels = allTierModels.filter(m => m.includes("opus"));
  ok(opusModels.length === 0, `Opus in config: ${opusModels.length === 0 ? "NONE ✓" : opusModels.join(", ")}`);
}

// ─── 3. Structured output override ───

{
  console.log("\n══ 3. Structured Output Override ══\n");
  const d = route("What is 2+2?", "Respond in JSON format with the answer", 4096, routerOpts);
  ok(d.tier === "MEDIUM" || d.tier === "COMPLEX", `JSON sys prompt → tier=${d.tier} (should be >= MEDIUM)`);
  console.log(`  model=${d.model}, reasoning: ${d.reasoning}`);
}

// ─── Summary ───

console.log("\n══════════════════════════════════");
console.log(`  ${passed} passed, ${failed} failed`);
console.log("══════════════════════════════════\n");

process.exit(failed > 0 ? 1 : 0);
