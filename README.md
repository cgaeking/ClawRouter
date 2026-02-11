# ClawRouter — Smart LLM Router (Direct API Keys)

Smart LLM router that picks the cheapest model capable of handling each request. Uses **your own API keys** — no crypto, no middleman, no markup.

Forked from [BlockRun/ClawRouter](https://github.com/BlockRunAI/ClawRouter), replacing USDC/x402 micropayments with direct provider API keys.

## How It Works

1. You provide your own API keys for each provider
2. ClawRouter classifies each request across **15 weighted dimensions** in <1ms
3. Routes to the cheapest model that can handle it (4 tiers: SIMPLE → MEDIUM → COMPLEX → REASONING)
4. Falls back through a chain of alternatives if a provider errors

**Result:** Same smart routing intelligence, but you pay providers directly at their listed prices.

## Quick Start

### Fastest Setup (one key → all models)

```bash
# Install
openclaw plugins install ./ClawRouter

# One OpenRouter key covers all 30+ models
export OPENROUTER_API_KEY=sk-or-...

# Use smart routing
openclaw models set clawrouter/auto
```

### Optimal Setup (direct keys + OpenRouter fallback)

```bash
# Direct keys are cheaper (no middleman markup)
export OPENAI_API_KEY=sk-...
export ANTHROPIC_API_KEY=sk-ant-...

# OpenRouter covers everything else
export OPENROUTER_API_KEY=sk-or-...

openclaw models set clawrouter/auto
```

Direct provider keys take priority. OpenRouter is used as fallback for providers without a direct key.

### Standalone

```bash
npm install
npm run build

export OPENROUTER_API_KEY=sk-or-...
npx clawrouter
```

## Configuration

### Environment Variables (recommended)

| Variable | Provider | Notes |
|---|---|---|
| `OPENROUTER_API_KEY` | **OpenRouter** | **One key → all models!** |
| `OPENAI_API_KEY` | OpenAI (GPT-4o, GPT-5, o3) | Direct = cheaper |
| `ANTHROPIC_API_KEY` | Anthropic (Claude) | Direct = cheaper |
| `GOOGLE_API_KEY` | Google (Gemini) | Direct = cheaper |
| `XAI_API_KEY` | xAI (Grok) | Direct = cheaper |
| `DEEPSEEK_API_KEY` | DeepSeek | Direct = cheaper |
| `MOONSHOT_API_KEY` | Moonshot (Kimi) | Direct = cheaper |
| `NVIDIA_API_KEY` | NVIDIA | Direct = cheaper |

**Priority:** Direct provider key > OpenRouter fallback. If you have both `OPENAI_API_KEY` and `OPENROUTER_API_KEY`, OpenAI models use the direct key while other providers fall back to OpenRouter.

### Config File

`~/.openclaw/clawrouter/config.json`:

```json
{
  "providers": {
    "openrouter": { "apiKey": "sk-or-..." },
    "openai": { "apiKey": "sk-..." },
    "anthropic": { "apiKey": "sk-ant-..." }
  }
}
```

### Plugin Config (openclaw.json)

```json
{
  "plugins": {
    "clawrouter": {
      "providers": {
        "openai": { "apiKey": "sk-..." }
      },
      "routing": {
        "overrides": {
          "ambiguousDefaultTier": "COMPLEX"
        }
      }
    }
  }
}
```

## Routing Tiers

| Tier | Use Case | Default Model |
|---|---|---|
| **SIMPLE** | Facts, translations, short answers | Gemini 2.5 Flash |
| **MEDIUM** | Code generation, summaries | Grok Code Fast |
| **COMPLEX** | System design, analysis | Gemini 2.5 Pro |
| **REASONING** | Proofs, formal logic | Grok 4 Fast Reasoning |

Models without a configured API key are automatically skipped. The router falls back through alternatives until it finds one with a valid key.

## Model Aliases

Use short names: `/model sonnet`, `/model gpt`, `/model flash`, etc.

| Alias | Model |
|---|---|
| `auto` | Smart router (picks best) |
| `sonnet` | Claude Sonnet 4 |
| `opus` | Claude Opus 4 |
| `haiku` | Claude Haiku 4.5 |
| `gpt` | GPT-4o |
| `flash` | Gemini 2.5 Flash |
| `deepseek` | DeepSeek V3.2 Chat |
| `grok` | Grok 3 |
| `kimi` | Kimi K2.5 |

## Commands

- `/stats [days]` — Usage statistics and cost savings
- `/keys` — Show configured API key status

## Features Preserved from Original

- ✅ 15-dimension weighted scoring classifier (<1ms, zero cost)
- ✅ 4-tier routing (SIMPLE/MEDIUM/COMPLEX/REASONING)
- ✅ Agentic task auto-detection
- ✅ Fallback chains with rate-limit awareness
- ✅ Session pinning (prevents mid-task model switching)
- ✅ Request deduplication
- ✅ SSE heartbeat (prevents timeout during slow responses)
- ✅ Usage logging and statistics
- ✅ Tool ID sanitization (Anthropic compatibility)
- ✅ Thinking token stripping (Kimi, DeepSeek)
- ✅ Message normalization (roles, Google format, etc.)

## What Was Removed

- ❌ USDC/x402 cryptocurrency payments
- ❌ Wallet generation and management
- ❌ Balance monitoring (Base L2 RPC calls)
- ❌ Payment caching and pre-authorization
- ❌ `viem` dependency (saves ~2MB)
- ❌ BlockRun API gateway dependency

## License

MIT
