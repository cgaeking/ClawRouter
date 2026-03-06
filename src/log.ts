/**
 * Timestamped console logging helpers.
 */

export function clog(...args: unknown[]): void {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  console.log(`[${ts}]`, ...args);
}

export function cerr(...args: unknown[]): void {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  console.error(`[${ts}]`, ...args);
}
