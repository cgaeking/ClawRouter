/**
 * Regression test: System prompt contamination
 *
 * Verifies that tool definitions in the system prompt don't inflate
 * keyword scores and cause simple queries to be over-classified.
 *
 * Usage: npx tsx test/sysprompt-contamination.ts
 */

import { route, DEFAULT_ROUTING_CONFIG } from "../src/router/index.js";
import { classifyByRules } from "../src/router/rules.js";
import type { ModelPricing } from "../src/router/selector.js";

function pricing(i: number, o: number): ModelPricing {
  return { inputPrice: i, outputPrice: o };
}

const modelPricing = new Map<string, ModelPricing>([
  ["google/gemini-2.5-flash", pricing(0.15, 0.6)],
  ["google/gemini-2.5-pro", pricing(1.25, 10)],
  ["nvidia/gpt-oss-120b", pricing(0, 0)],
  ["deepseek/deepseek-chat", pricing(0.28, 0.42)],
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

function ok(cond: boolean, msg: string) {
  if (cond) { console.log(`  ✓ ${msg}`); passed++; }
  else { console.error(`  ✗ FAIL: ${msg}`); failed++; }
}

// Realistic system prompt with tool definitions (OpenClaw-style)
const TOOL_SYSTEM_PROMPT = `You are a helpful AI assistant. You have access to the following tools:

## Tools

### function read_file
Read a file from the filesystem.
Parameters:
- path (string, required): The file path to read
- encoding (string, optional): File encoding, default "utf-8"

Returns: The file contents as a string.

### function write_file
Write content to a file.
Parameters:
- path (string, required): The file path to write to
- content (string, required): The content to write
- create (boolean, optional): Create the file if it doesn't exist

Returns: Success confirmation.

### function execute_command
Execute a shell command and return the output.
Parameters:
- command (string, required): The command to execute
- timeout (number, optional): Timeout in milliseconds, default 30000
- cwd (string, optional): Working directory

Returns: An object with stdout, stderr, and exit code.

### function search_code
Search for patterns in code files.
Parameters:
- pattern (string, required): Regex pattern to search for
- path (string, optional): Directory to search in
- include (string[], optional): File patterns to include
- exclude (string[], optional): File patterns to exclude

Returns: Array of matches with file, line number, and context.

### function deploy_service
Deploy a service to the cluster.
Parameters:
- service (string, required): Service name
- version (string, required): Version tag
- environment (string, required): Target environment (staging/production)
- config (object, optional): Additional deployment configuration

Returns: Deployment status and URL.

## Instructions
- Always verify your changes before deploying
- Do not modify files without user confirmation
- Use step by step reasoning for complex tasks
- Avoid making assumptions about the codebase structure
- Never execute destructive commands without explicit approval
- If you're not sure about something, ask the user first
- Format output as JSON when structured data is requested
- Optimize for readability and maintainability
- Build on existing patterns in the codebase
- Create tests for any new functionality`;

console.log("══ System Prompt Contamination Test ══\n");
console.log(`System prompt length: ${TOOL_SYSTEM_PROMPT.length} chars (~${Math.ceil(TOOL_SYSTEM_PROMPT.length / 4)} tokens)\n`);

// These simple queries should NOT be pushed to COMPLEX/REASONING by the system prompt
const simpleQueries = [
  "What is 2+2?",
  "Hello, how are you?",
  "What's the weather like?",
  "Tell me a joke",
  "Summarize this text for me",
  "Who was the first president?",
  "Translate 'hello' to French",
];

console.log("Simple queries WITH heavy tool system prompt:");
for (const q of simpleQueries) {
  const tokens = Math.ceil((TOOL_SYSTEM_PROMPT.length + q.length) / 4);
  const r = classifyByRules(q, TOOL_SYSTEM_PROMPT, tokens, config.scoring);
  const d = route(q, TOOL_SYSTEM_PROMPT, 4096, routerOpts);
  ok(
    d.tier === "SIMPLE" || d.tier === "MEDIUM",
    `"${q}" → tier=${d.tier}, model=${d.model} (score=${r.score.toFixed(3)}) [${r.signals.join(", ")}]`,
  );
}

console.log("\nSame queries WITHOUT system prompt (baseline):");
for (const q of simpleQueries) {
  const tokens = Math.ceil(q.length / 4);
  const r = classifyByRules(q, undefined, tokens, config.scoring);
  const d = route(q, undefined, 4096, routerOpts);
  console.log(`  → "${q}" → tier=${d.tier}, model=${d.model} (score=${r.score.toFixed(3)})`);
}

// Medium complexity queries should stay MEDIUM, not inflate to REASONING
console.log("\nMedium queries WITH tool system prompt:");
const mediumQueries = [
  "Write a Python function to sort a list",
  "Explain how async/await works in JavaScript",
  "What's the difference between REST and GraphQL?",
  "Help me debug this database query",
];

for (const q of mediumQueries) {
  const tokens = Math.ceil((TOOL_SYSTEM_PROMPT.length + q.length) / 4);
  const r = classifyByRules(q, TOOL_SYSTEM_PROMPT, tokens, config.scoring);
  const d = route(q, TOOL_SYSTEM_PROMPT, 4096, routerOpts);
  ok(
    d.tier !== "REASONING",
    `"${q}" → tier=${d.tier}, model=${d.model} (score=${r.score.toFixed(3)}) [${r.signals.join(", ")}]`,
  );
}

// Only REASONING queries should actually be REASONING
console.log("\nActual reasoning queries (should be REASONING regardless of system prompt):");
const reasoningQueries = [
  "Prove that sqrt(2) is irrational step by step",
  "Derive the time complexity formally using mathematical proof",
];

for (const q of reasoningQueries) {
  const tokens = Math.ceil((TOOL_SYSTEM_PROMPT.length + q.length) / 4);
  const r = classifyByRules(q, TOOL_SYSTEM_PROMPT, tokens, config.scoring);
  const d = route(q, TOOL_SYSTEM_PROMPT, 4096, routerOpts);
  ok(
    d.tier === "REASONING",
    `"${q.slice(0, 50)}..." → tier=${d.tier}, model=${d.model} (score=${r.score.toFixed(3)})`,
  );
}

console.log("\n══════════════════════════════════");
console.log(`  ${passed} passed, ${failed} failed`);
console.log("══════════════════════════════════\n");

process.exit(failed > 0 ? 1 : 0);
