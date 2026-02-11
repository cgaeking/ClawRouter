# Troubleshooting

Quick solutions for common ClawRouter issues.

> Need help? [Open a Discussion](https://github.com/BlockRunAI/ClawRouter/discussions) or check [existing issues](https://github.com/BlockRunAI/ClawRouter/issues).

## Table of Contents

- [Quick Checklist](#quick-checklist)
- [Common Errors](#common-errors)
- [Security Scanner Warnings](#security-scanner-warnings)
- [Port Conflicts](#port-conflicts)
- [How to Update](#how-to-update)
- [Verify Routing](#verify-routing)

---

## Quick Checklist

```bash
# 1. Check your version (should be 0.5.7+)
cat ~/.openclaw/extensions/clawrouter/package.json | grep version

# 2. Check proxy is running
curl http://localhost:8402/health

# 3. Watch routing in action
openclaw logs --follow
# Should see: gemini-2.5-flash $0.0012 (saved 99%)

# 4. View cost savings
/stats
```

---

## Common Errors

### "Unknown model: blockrun/auto" or "Unknown model: auto"

Plugin isn't loaded or outdated. **Don't change the model name** — `blockrun/auto` is correct.

**Fix:** Update to v0.3.21+ which handles both `blockrun/auto` and `auto` (OpenClaw strips provider prefix). See [How to Update](#how-to-update).

### "No API key found for provider blockrun"

Auth profile is missing or wasn't created properly.

**Fix:** See [How to Update](#how-to-update) — the reinstall script automatically injects the auth profile.

### "Config validation failed: plugin not found: clawrouter"

Plugin directory was removed but config still references it. This blocks all OpenClaw commands until fixed.

**Fix:** See [How to Update](#how-to-update) for complete cleanup steps.

### "No USDC balance" / "Insufficient funds"

Wallet needs funding.

**Fix:**

1. Find your wallet address (printed during install)
2. Send USDC on **Base network** to that address
3. $1-5 is enough for hundreds of requests
4. Restart OpenClaw

---

## Security Scanner Warnings

### "WARNING: dangerous code patterns — possible credential harvesting"

This is a **false positive**. ClawRouter legitimately:

1. Reads `BLOCKRUN_WALLET_KEY` from environment (for authentication)
2. Sends authenticated requests to BlockRun API (for x402 micropayments)

This pattern triggers OpenClaw's security scanner, but it's the intended behavior — the wallet key is required to sign payment transactions. The code is fully open source and auditable.

### "env-harvesting" Warning

OpenClaw's security scanner may flag ClawRouter with:

```
[env-harvesting] Environment variable access combined with network send
```

**This is a false positive.** The scanner's heuristic (`env variable + network request = suspicious`) flags all payment plugins, but this pattern is inherently required for non-custodial payments.

ClawRouter reads `BLOCKRUN_WALLET_KEY` to sign x402 payment transactions — this is required and intentional:

- The wallet key is used **locally** for cryptographic signing (EIP-712)
- The **signature** is transmitted, not the private key itself
- The key **never leaves the machine** — only cryptographic proofs are sent
- This is standard [x402 payment protocol](https://x402.org) behavior
- Source code is [MIT licensed and fully auditable](https://github.com/BlockRunAI/ClawRouter)

See [`openclaw.security.json`](../openclaw.security.json) for detailed security documentation and [this discussion](https://x.com/bc1beat/status/2020158972561428686) for more context.

---

## Port Conflicts

### Port 8402 already in use

As of v0.4.1, ClawRouter automatically detects and reuses an existing proxy on the configured port instead of failing with `EADDRINUSE`. You should no longer see this error.

If you need to use a different port:

```bash
# Set custom port via environment variable
export BLOCKRUN_PROXY_PORT=8403
openclaw gateway restart
```

To manually check/kill the process:

```bash
lsof -i :8402
# Kill the process or restart OpenClaw
```

---

## How to Update

```bash
curl -fsSL https://raw.githubusercontent.com/BlockRunAI/ClawRouter/main/scripts/reinstall.sh | bash
openclaw gateway restart
```

This removes the old version, installs the latest, and restarts the gateway.

---

## Verify Routing

```bash
openclaw logs --follow
```

You should see model selection for each request:

```
[plugins] [SIMPLE] google/gemini-2.5-flash $0.0012 (saved 99%)
[plugins] [MEDIUM] deepseek/deepseek-chat $0.0003 (saved 99%)
[plugins] [REASONING] deepseek/deepseek-reasoner $0.0005 (saved 99%)
```
