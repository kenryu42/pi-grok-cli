# pi-grok-cli

[![CI](https://github.com/kenryu42/pi-grok-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/kenryu42/pi-grok-cli/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/pi-grok-cli?label=npm&color=blue)](https://www.npmjs.com/package/pi-grok-cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-red.svg)](https://opensource.org/licenses/MIT)

A [pi](https://github.com/earendil-works/pi-coding-agent) extension that connects to **Grok CLI's inference endpoint** (`cli-chat-proxy.grok.com`) instead of the public `api.x.ai` API. This gives pi access to models the public API does not expose, plus Cursor-style coding tools the Grok CLI models are trained to call.

> Requires an active Grok subscription or an X Premium subscription with Grok access.

## Models

Default catalog (filter/reorder with `PI_GROK_CLI_MODELS`):

| Model ID | Context | Reasoning | Input | Cost ($/M tok, in/out) |
|---|---|---|---|---|
| `grok-composer-2.5-fast` | 200K | no | text | 3 / 15 |
| `grok-build` | 512K | yes | text + image | 1 / 2 |
| `grok-4.3` | 1M | yes | text + image | 1.25 / 2.5 |
| `grok-4.20-0309-reasoning` | 2M | yes | text + image | 1.25 / 2.5 |
| `grok-4.20-0309-non-reasoning` | 2M | no | text + image | 1.25 / 2.5 |
| `grok-4.20-multi-agent-0309` | 2M | yes | text + image | 1.25 / 2.5 |

`grok-composer-2.5-fast` is Cursor's Composer 2.5 — an agentic coding model tuned for long-horizon tasks. Reasoning-effort control is honored by `grok-4.3`, `grok-4.20-multi-agent`, and `grok-3-mini*` reasoning models; non-reasoning models expose a thinking-level map instead.

## Installation

```bash
pi install npm:pi-grok-cli
```

Local development from this checkout:

```bash
pi install ./pi-grok-cli     # install
pi -e ./pi-grok-cli          # run once without installing
```

## Usage

### 1. Log in

```
/login
```

Pick **"Grok CLI"**, then choose a method:

- **Browser OAuth callback** — opens the xAI OAuth page; pi listens on a local loopback port and completes the PKCE exchange automatically.
- **Device code (SSH / headless)** — shows a verification URL and short code. Open the URL anywhere, confirm the code, and pi polls xAI until tokens arrive. Useful when no local browser is available.

Tokens auto-refresh 120s before expiry. To skip OAuth entirely, set `GROK_CLI_OAUTH_TOKEN` (no auto-refresh, no model discovery — rotate it yourself).

### 2. Select a model

```
/model grok-cli/grok-composer-2.5-fast
```

### 3. Check quota

```
/grok-cli-usage
```

Prints credits used / limit, remaining credits, and the reset time for the current billing period.

## Cursor tool compatibility

Grok CLI models are trained on Cursor-style tools. This extension registers shims so those calls keep working inside pi:

| Category | Tools |
|---|---|
| File | `Read`, `Write`, `StrReplace`, `Edit`, `Delete`, `LS` |
| Search | `Grep`, `Glob` |
| Terminal | `Shell` |
| Web | `WebSearch` — only when [pi-web-access](https://www.npmjs.com/package/pi-web-access) is installed |

These tools auto-activate when the active provider is **grok-cli**. The shims normalize common Cursor/Grok argument shapes (`contents` for writes, `glob_pattern`/`glob_filter` for search, `old_string`/`new_string` or `oldText`/`newText` for replacements) so agentic workflows don't fail on schema mismatches.

**Web search:** when pi-web-access is installed and grok-cli is active, pi's native `web_search` is removed from the active set and `WebSearch` (which delegates to pi-web-access) is used instead. Other providers keep using `web_search`. Without pi-web-access, nothing changes.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PI_GROK_CLI_BASE_URL` | `https://cli-chat-proxy.grok.com/v1` | Override the API base URL |
| `GROK_CLI_BASE_URL` | — | Fallback base URL if `PI_GROK_CLI_BASE_URL` is unset |
| `PI_GROK_CLI_MODELS` | (all) | Comma-separated model IDs to expose (filters/reorders) |
| `PI_GROK_CLI_OAUTH_CLIENT_ID` | `b1a00492-…` | Override the OAuth client ID |
| `PI_GROK_CLI_OAUTH_SCOPE` | `openid profile email offline_access grok-cli:access api:access` | Override OAuth scopes |
| `PI_GROK_CLI_CALLBACK_HOST` | `127.0.0.1` | Browser-flow loopback callback host |
| `PI_GROK_CLI_CALLBACK_PORT` | `56122` | Browser-flow loopback callback port (falls back to ephemeral) |
| `PI_GROK_CLI_TOKEN_TIMEOUT_MS` | `30000` | Timeout for OAuth token requests |
| `GROK_CLI_OAUTH_TOKEN` | — | Direct token bypass that skips OAuth. No auto-refresh; rotate it yourself. |

## Development

```bash
bun install
bun run check        # lint + typecheck + knip + duplicate detection + coverage
bun run test         # vitest only
```

## License

MIT
