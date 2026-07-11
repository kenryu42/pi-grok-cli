# pi-grok-cli

[![CI](https://github.com/kenryu42/pi-grok-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/kenryu42/pi-grok-cli/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/pi-grok-cli?label=npm&color=blue)](https://www.npmjs.com/package/pi-grok-cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-red.svg)](./LICENSE)

Use your X Premium or SuperGrok subscription in [pi](https://pi.dev).

- **Vision for text-only models** — automatically describe images with a vision-capable Grok model and cache descriptions locally.
- **Subscription OAuth** — sign in through a browser or device code; tokens refresh automatically.
- **Coding-tool compatibility** — use Grok models with the Cursor-style tools they were trained to call.
- **Usage tracking** — check account limits, remaining credits, and reset times from pi.

> Requires pi 0.80.0 or newer and an xAI/Grok account with access to the selected model. Model availability varies by account, plan, region, and xAI rollout. The Grok CLI executable is not required.
>
> pi-grok-cli is an unofficial community integration. It does not bypass xAI access controls, quotas, or billing.

## Quick start

### 1. Install and start pi

```bash
pi install npm:pi-grok-cli
pi
```

Check `pi --version` if installation fails. Update an older installation with `pi update --self`.

### 2. Log in

Inside pi, run:

```text
/login
```

Choose **Grok CLI**, then select one of these methods:

- **Browser login** — opens xAI authorization and completes a PKCE exchange through a local loopback callback.
- **Device code** — displays a URL and short code for SSH, containers, and other headless environments.

### 3. Select a model

```text
/model grok-cli/grok-composer-2.5-fast
```

Composer 2.5 is the recommended starting point for agentic coding. Choose an image-capable model when native image input matters.

### 4. Verify account usage

```text
/grok-cli-usage
```

This fetches the current account allowance, usage, remaining credits, and reset time. Weekly usage is shown when xAI returns it.

## Manage installation

```bash
pi update npm:pi-grok-cli
pi remove npm:pi-grok-cli
```

## Why pi-grok-cli?

pi already includes an xAI provider for the public API. This extension targets the backend used by Grok CLI instead.

| | pi's built-in `xai` provider | `pi-grok-cli` |
| --- | --- | --- |
| Authentication | `XAI_API_KEY` | xAI OAuth or an externally supplied OAuth token |
| Endpoint | `api.x.ai` | `cli-chat-proxy.grok.com` |
| Usage accounting | Public API billing | Grok account allowance and credits |
| Best fit | Public API access and API-key billing | Grok CLI model access, Composer 2.5, and Cursor-tool compatibility |

The Grok CLI and public API catalogs can overlap. Use the provider that matches the account access and billing model you intend to use.

## Models

The table describes metadata bundled with this extension, not live model discovery. Context limits are the values registered in pi; xAI may enforce different limits or change availability without notice.

| Model ID | Registered context | Reasoning | Input |
| --- | ---: | --- | --- |
| `grok-composer-2.5-fast` | 200K | no | text; images can be described through vision routing |
| `grok-build` | 512K | yes | text + image |
| `grok-4.3` | 1M | yes | text + image |
| `grok-4.5` | 500K | yes | text + image |
| `grok-4.20-0309-reasoning` | 2M | yes | text + image |
| `grok-4.20-0309-non-reasoning` | 2M | no | text + image |
| `grok-4.20-multi-agent-0309` | 2M | yes | text + image |

Pi's thinking-level control is forwarded to `grok-4.3`, `grok-4.5`, and `grok-4.20-multi-agent-0309`. Unsupported models have reasoning parameters removed before the request.

The model-cost metadata shown by pi consists of bundled per-token estimates. It is not a conversion of Grok subscription credits. Use `/grok-cli-usage` for account limits and [xAI's pricing documentation](https://docs.x.ai/developers/pricing) for current public API prices.

The catalog is static for the lifetime of the extension process. Use `PI_GROK_CLI_MODELS` to filter, reorder, or expose a server-supported model ID that has not been bundled yet.

## Features

### OAuth authentication

Browser login listens on `127.0.0.1:56122` by default and falls back to an ephemeral port if needed. Device-code login avoids callback-port forwarding entirely. Pi stores the resulting credentials and refreshes them automatically before expiry.

For automation that already has an OAuth access token, `GROK_CLI_OAUTH_TOKEN` skips interactive login. Direct tokens are not refreshed; replace them before they expire.

### Cursor tool compatibility

Grok CLI models are trained to call Cursor-style tools. pi-grok-cli registers compatible names and argument normalization so those calls work in pi.

| Category | Tools |
| --- | --- |
| File | `Read`, `Write`, `StrReplace`, `Edit`, `Delete`, `LS` |
| Search | `Grep`, `Glob` |
| Terminal | `Shell` |
| Web | `WebSearch` when [pi-web-access](https://www.npmjs.com/package/pi-web-access) is installed |

The shims activate only while the selected provider is `grok-cli`. Other providers retain their normal pi tool set.

Install optional web search support with:

```bash
pi install npm:pi-web-access
```

When Grok CLI is active, `WebSearch` delegates to pi-web-access and replaces pi's native `web_search` tool. Other providers are unaffected. Restart pi or run `/reload` after installing it in an existing session.

### Vision routing for text-only models

When pi's `read` or `Read` tool returns an image and the active model does not support image input, pi-grok-cli can:

1. Send the image to an image-capable Grok model (`grok-build` by default).
2. Replace the image block with the generated text description.
3. Let the active text-only model reason over that description.

Vision routing is enabled by default and handles up to four images per tool result. It is a lossy description step, not native vision. Image-capable active models receive images directly and are never routed through the describer.

Descriptions are persisted by image hash, model, and prompt in `~/.pi/grok-cli-vision-cache.json`. A cache hit avoids another describer request, but the active model still processes the description text. The cache stores descriptions, hashes, and metadata—not raw image data.

### Usage tracking

`/grok-cli-usage` requests billing data each time it runs; it does not reuse stale quota data. It reports monthly usage and, when available, weekly utilization. Reset times use the system's local timezone.

## Commands

| Command | Description |
| --- | --- |
| `/grok-cli-usage` | Fetch current quota, remaining credits, and reset times. |
| `/grok-cli-vision:status` | Show vision state, describer model, configuration path, and cache statistics. |
| `/grok-cli-vision:on` / `/grok-cli-vision:off` | Enable or disable vision routing. |
| `/grok-cli-vision:cache-clear` | Remove all cached image descriptions. |

## Configuration

### Vision routing

Vision configuration is read from `~/.pi/grok-cli-vision.json`. The file is created after the first setting change and defaults to:

```json
{
  "enabled": true,
  "model": "grok-build",
  "maxImages": 4,
  "cacheEnabled": true,
  "cacheMaxEntries": 100
}
```

`model` must identify an image-capable model. Invalid values are reported and replaced with safe defaults. Manual changes apply on the next image read.

### Common environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `PI_GROK_CLI_MODELS` | all bundled models | Comma-separated model IDs to expose, in display order. Unknown IDs receive generic text-only metadata. |
| `GROK_CLI_OAUTH_TOKEN` | — | Use an external access token instead of `/login`. No automatic refresh. |

### Advanced OAuth and endpoint overrides

| Variable | Default | Description |
| --- | --- | --- |
| `PI_GROK_CLI_BASE_URL` | `https://cli-chat-proxy.grok.com/v1` | Override the API base URL. |
| `GROK_CLI_BASE_URL` | — | Fallback when `PI_GROK_CLI_BASE_URL` is unset. |
| `PI_GROK_CLI_OAUTH_CLIENT_ID` | bundled client ID | Override the OAuth client ID. |
| `PI_GROK_CLI_OAUTH_SCOPE` | `openid profile email offline_access grok-cli:access api:access` | Override OAuth scopes. |
| `PI_GROK_CLI_CALLBACK_HOST` | `127.0.0.1` | Browser callback host. |
| `PI_GROK_CLI_CALLBACK_PORT` | `56122` | Preferred callback port; falls back to an ephemeral port. |
| `PI_GROK_CLI_TOKEN_TIMEOUT_MS` | `30000` | Timeout for OAuth token requests. |

Only point the base URL overrides at an endpoint you trust. The configured endpoint receives the OAuth bearer token, prompts, and model context.

## Troubleshooting

| Problem | What to do |
| --- | --- |
| Grok CLI is missing from `/model` | Confirm the package appears in `pi list`, run `/login`, choose **Grok CLI**, then restart pi or run `/reload`. |
| Browser login cannot bind or complete | Use the device-code method, or adjust `PI_GROK_CLI_CALLBACK_HOST` and `PI_GROK_CLI_CALLBACK_PORT`. |
| Authentication returns HTTP 401 or 403 | Run `/login` again and confirm the account can access the selected model. Replace an expired `GROK_CLI_OAUTH_TOKEN` if using the bypass. |
| Inference returns HTTP 426 | Update the extension with `pi update npm:pi-grok-cli`; the Grok CLI endpoint enforces client-version headers. |
| A listed model is unavailable | Availability can differ by account or region, and the catalog is bundled rather than discovered live. Try another model or update the extension. |
| `/grok-cli-usage` reports a billing refresh failure | Retry later. A billing-endpoint failure does not necessarily mean inference is unavailable. |
| `WebSearch` is unavailable | Install pi-web-access, then restart pi or run `/reload`. |
| Images are not being described | Run `/grok-cli-vision:status`, confirm routing is on, and verify Grok CLI authentication. Native image-capable models bypass routing by design. |

## Security and data flow

Like every pi extension, pi-grok-cli runs with the user's system permissions. Its tool shims can read, write, edit, and delete files or execute shell commands when the active model calls them. Review third-party extension source before installing it.

| Data | Destination or storage |
| --- | --- |
| OAuth authorization and token exchange | `auth.x.ai`; credentials are stored by pi in `~/.pi/agent/auth.json` by default. |
| Prompts, model context, tool definitions, and tool results | `cli-chat-proxy.grok.com`. |
| Account usage requests | The Grok CLI proxy's `/billing` endpoints. |
| Images handled by vision routing | Sent to the configured Grok describer model through the proxy. |
| Vision cache | Local description text and hashes in `~/.pi/grok-cli-vision-cache.json`; raw images are not cached. |
| Optional web searches | Delegated to pi-web-access and its configured search provider. |

Environment variables can leak through process inspection, logs, or child processes. Prefer `/login` over `GROK_CLI_OAUTH_TOKEN` for normal interactive use.

This project is not affiliated with or endorsed by xAI. The Grok CLI endpoint, models, headers, and account policies can change without notice.

## Support and contributing

Report bugs and feature requests through [GitHub Issues](https://github.com/kenryu42/pi-grok-cli/issues). Include the pi version, pi-grok-cli version, selected model, login method, and exact error message. Remove tokens and private project data before posting.

For local development:

```bash
bun install
pi -e .
bun run check
```

Pull requests should include tests for behavior changes and pass `bun run check`.

## License

[MIT](./LICENSE) © 2026 kenryu42
