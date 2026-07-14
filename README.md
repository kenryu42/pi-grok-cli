# pi-grok-cli

[![CI](https://github.com/kenryu42/pi-grok-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/kenryu42/pi-grok-cli/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/pi-grok-cli?label=npm&color=blue)](https://www.npmjs.com/package/pi-grok-cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-red.svg)](./LICENSE)

Use your X Premium or SuperGrok subscription in [pi](https://pi.dev/) with a clean, focused toolset.

- **Vision for text-only models** — automatically describe images with a vision-capable Grok model and cache descriptions locally.
- **Grok Imagine** — generate JPEGs from the TUI or let Grok call the `image_gen` tool, with inline previews.
- **Subscription OAuth** — sign in through a browser or device code or reuse an official Grok Build login; tokens refresh automatically.
- **Model-scoped compatibility** — Cursor-style tool names only for Grok Build and Composer 2.5. All other models keep Pi's native tools.
- **Usage tracking** — check account limits, remaining credits, and reset times from pi.

> Requires pi 0.80.0 or newer and an xAI/Grok account with access to the selected model. Model availability varies by account, plan, region, and xAI rollout. The Grok Build executable is not required.
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

- **Browser login (default)** — opens xAI authorization and completes a PKCE exchange through a local loopback callback. If xAI shows a one-time code instead of redirecting to pi, paste that code into pi to complete the active PKCE exchange.
- **Device code login (headless)** — displays a URL and short code for SSH, containers, and other headless environments.
- **Use existing Grok Build login** — appears when a valid official `~/.grok/auth.json` entry is available. The file is read-only to this extension.

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

## Models

The table describes metadata bundled with this extension, not live model discovery. Context limits are the values registered in pi; xAI may enforce different limits or change availability without notice.

| Model ID | Registered context | Reasoning | Input | Coding tools |
| --- | ---: | --- | --- | --- |
| `grok-composer-2.5-fast` | 200K | no | text; images can be described through vision routing | Cursor-compatible names |
| `grok-build` | 512K | yes | text + image | Cursor-compatible names |
| `grok-4.3` | 1M | yes | text + image | native pi names |
| `grok-4.5` | 500K | yes | text + image | native pi names |
| `grok-4.20-0309-reasoning` | 2M | yes | text + image | native pi names |
| `grok-4.20-0309-non-reasoning` | 2M | no | text + image | native pi names |
| `grok-4.20-multi-agent-0309` | 2M | yes | text + image | native pi names |

## Features

### OAuth authentication

Use `/login` to authenticate through a browser or device code, or reuse an official Grok Build login. Pi stores and refreshes OAuth credentials automatically. For automation, `GROK_CLI_OAUTH_TOKEN` supplies a direct token without automatic refresh.

### Model-scoped Cursor compatibility

Pi's native tool vocabulary remains the default. Cursor-compatible tool names are exposed only when one of these exact models is selected:

- `grok-cli/grok-build`
- `grok-cli/grok-composer-2.5-fast`

Only these two models get Cursor-compatible tool names. Grok 4.5, future Grok models, and other providers continue to use Pi's native tools. No extra shims.

| Compatibility tools | Implementation |
| --- | --- |
| `Read`, `Write`, `Edit`, `Grep`, `LS`, `Shell` | Delegate execution and rendering to Pi's native tools. |
| `StrReplace` | Preserves Cursor's literal replace-all behavior. |
| `Glob` | Preserves Cursor's newest-first path ordering. |
| `Delete` | Provides the file-deletion operation expected by these models. |
| `WebSearch` | Optionally replaces an active `web_search` tool when pi-web-access is installed. |

Pi applies `--tools` and `--exclude-tools` by exact name. When restricting one of the two compatible models, include its compatibility names—for example, `--tools Read,Grep` or `--exclude-tools Grep`. `--no-tools` disables all tools.

Install optional web search support with:

```bash
pi install npm:pi-web-access@^0.13.0
```

pi-web-access 0.13.0 or newer is required. `WebSearch` is used only by the two Cursor-compatible models. Other models and providers retain the native `web_search` tool. Restart Pi or run `/reload` after installing it in an existing session.

### Vision routing for text-only models

When `read` or `Read` returns an image to a text-only model, pi-grok-cli describes it with an image-capable Grok model (`grok-build` by default) and passes the description to the active model. Routing is enabled by default for up to four images, caches descriptions locally, and is bypassed when the active model supports images natively.

### Grok Imagine image generation

Run `/grok-cli-imagine <prompt>` to generate and preview a JPEG, or let any active model call the `image_gen` tool. Both use the current Grok CLI OAuth token and save the result under the current session or a requested output path. The command supports `--aspect`, `--out`, and `--resolution 1k`.

`image_gen` is enabled by default across providers and is independent of Cursor compatibility. Use `/grok-cli-imagine:tool [on|off|status]` to manage its persisted availability without disabling the direct command.

## Commands

| Command | Description |
| --- | --- |
| `/grok-cli-usage` | Fetch current quota, remaining credits, and reset times. |
| `/grok-cli-imagine <prompt>` | Generate and preview an image. Supports `--aspect`, `--out`, and `--resolution 1k`. |
| `/grok-cli-imagine:tool [on\|off\|status]` | Toggle, set, or report persistent model-callable `image_gen` availability. |
| `/grok-cli-vision:status` | Show vision state, describer model, configuration path, and cache statistics. |
| `/grok-cli-vision:on` / `/grok-cli-vision:off` | Enable or disable vision routing. |
| `/grok-cli-vision:cache-clear` | Remove all cached image descriptions. |

## Configuration

All extension settings are read from `~/.pi/grok-cli.json`. The file is created after the first setting change and defaults to:

```json
{
  "version": 1,
  "imagine": {
    "enabled": true
  },
  "vision": {
    "enabled": true,
    "model": "grok-build",
    "maxImages": 4,
    "cacheEnabled": true,
    "cacheMaxEntries": 100
  }
}
```

Legacy Imagine and vision settings are migrated automatically. The vision cache remains separate at `~/.pi/grok-cli-vision-cache.json`.

`model` must identify an image-capable model. Invalid values are reported and replaced with safe defaults. Manual changes apply on the next image read.

### Common environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `PI_GROK_CLI_MODELS` | all bundled models | Comma-separated model IDs to expose, in display order. Unknown IDs receive generic text-only metadata. |
| `GROK_CLI_OAUTH_TOKEN` | — | Use an external access token instead of `/login`. No automatic refresh. |

See [Advanced configuration](./CONFIGURATION.md) for OAuth, callback, endpoint, and Imagine overrides.

## Troubleshooting

| Problem | What to do |
| --- | --- |
| grok-cli is missing from `/model` | Confirm the package appears in `pi list`, run `/login`, choose **Grok CLI**, then restart pi or run `/reload`. |
| Browser login cannot bind or complete | Paste the complete callback URL into pi when prompted. If xAI displays a one-time code instead, paste it into the same prompt. Otherwise, use device-code login or adjust `PI_GROK_CLI_CALLBACK_HOST` and `PI_GROK_CLI_CALLBACK_PORT`. Never post the callback URL or authorization code publicly. |
| Authentication returns HTTP 401 or 403 | Run `/login` again and confirm the account can access the selected model. Replace an expired `GROK_CLI_OAUTH_TOKEN` if using the bypass. |
| A listed model is unavailable | Availability can differ by account or region, and the catalog is bundled rather than discovered live. Try another model or update the extension. |
| Images are not being described | Run `/grok-cli-vision:status`, confirm routing is on, and verify Grok authentication. Native image-capable models bypass routing by design. |

## Security and data flow

pi-grok-cli is an unofficial community extension. It runs with your system permissions, and enabled tools can modify files or execute commands; prompts, model context, tool data, and routed images are sent to the configured xAI endpoints.

See [SECURITY.md](./SECURITY.md) for trust boundaries and private vulnerability reporting. Never include tokens, authorization codes, callback URLs, prompts, or private project data in public issues.

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
