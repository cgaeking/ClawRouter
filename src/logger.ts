/**
 * Usage Logger
 *
 * Logs every LLM request as a JSON line to a daily log file.
 * Files: ~/.openclaw/blockrun/logs/usage-YYYY-MM-DD.jsonl
 *
 * MVP: append-only JSON lines. No rotation, no cleanup.
 * Logging never breaks the request flow — all errors are swallowed.
 */

import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

export type UsageEntry = {
  timestamp: string;
  model: string;
  tier: string;
  cost: number;
  baselineCost: number;
  savings: number; // 0-1 percentage
  latencyMs: number;
  reasoning?: string; // Router classification reasoning (for debugging)
};

const LOG_DIR = join(homedir(), ".openclaw", "clawrouter", "logs");
let dirReady = false;

async function ensureDir(): Promise<void> {
  if (dirReady) return;
  await mkdir(LOG_DIR, { recursive: true });
  dirReady = true;
}

/**
 * Log a usage entry as a JSON line.
 */
export async function logUsage(entry: UsageEntry): Promise<void> {
  try {
    await ensureDir();
    const date = entry.timestamp.slice(0, 10); // YYYY-MM-DD
    const file = join(LOG_DIR, `usage-${date}.jsonl`);
    await appendFile(file, JSON.stringify(entry) + "\n");
  } catch {
    // Never break the request flow
  }
}
