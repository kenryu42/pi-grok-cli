# pi-grok-cli

[![CI](https://github.com/kenryu42/pi-grok-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/kenryu42/pi-grok-cli/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/pi-grok-cli?label=npm&color=blue)](https://www.npmjs.com/package/pi-grok-cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-red.svg)](./LICENSE)

Use your X Premium or SuperGrok subscription in [pi](https://pi.dev/) with a clean, focused toolset.

- **Vision for text-only models** — automatically describe images with a vision-capable Grok model and cache descriptions locally.
- **Grok Imagine** — generate JPEGs from the TUI or let Grok call the `image_gen` tool, with inline previews.
- **Subscription OAuth** — sign in through a browser or device code; tokens refresh automatically.
- **Multiple accounts** — keep independent Pi logins, switch from a TUI, and continue automatically on an exact exhausted-balance error.
- **Model-scoped compatibility** — Cursor-style tool names only for Grok Build and Composer 2.5. All other models keep Pi's native tools.
- **Usage tracking** — check account limits, remaining credits, and reset times from pi.

> Requires pi 0.80.9 or newer and an xAI/Grok account with access to the selected model. Model availability varies by account, plan, region, and xAI rollout. The Grok Build executable is not required.
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

To add another login, run `/grok-cli-accounts`, choose **＋ Add account**, and optionally label it. The extension adds a stable provider alias and pre-fills `/login <provider-id>`; press Enter to complete Pi's native login flow. For a visual account and quota dashboard, run `/grok-cli-accounts gui`; adding an account there starts browser login immediately. Use only accounts you own or are authorized to access.

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
| `grok-build` | 500K | yes | text + image | Cursor-compatible names |
| `grok-4.3` | 1M | yes | text + image | native pi names |
| `grok-4.5` | 500K | yes | text + image | native pi names |
| `grok-4.20-0309-reasoning` | 2M | yes | text + image | native pi names |
| `grok-4.20-0309-non-reasoning` | 2M | no | text + image | native pi names |
| `grok-4.20-multi-agent-0309` | 2M | yes | text + image | native pi names |

## Features

### OAuth authentication

Use `/login` to authenticate through a browser or device code. Pi stores and refreshes OAuth credentials automatically. For automation, `GROK_CLI_OAUTH_TOKEN` supplies a direct token without automatic refresh.

Run `/grok-cli-accounts` to add, switch, rename, relogin, log out, or remove accounts. Each account is registered as an independent Pi provider (`grok-cli`, `grok-cli-2`, and so on), so Pi keeps its OAuth credential separately in `auth.json`. The base `grok-cli` slot is permanent; aliases can be removed. Existing aliases keep their provider IDs, and a removed alias number is reused by the next account when it is the lowest available slot.

Run `/grok-cli-accounts gui` to open the same account controls as a visual local dashboard with monthly and weekly quota meters. The dashboard binds to a random `127.0.0.1` port for the current Pi session, completes browser login without exposing credentials to the page, and closes on Pi session shutdown or after 15 minutes without requests. Its private local URL grants access to account controls while the server is running; do not share it. Browser login and manual one-time-code entry are supported in the dashboard, while device-code login remains available through the TUI for headless environments.

The account selectors show the last cached quota for every logged-in account as consumed monthly and weekly usage. Press `r` to refresh all logged-in accounts without switching models or changing the selected account. Refreshes run three accounts at a time; a failed account keeps its previous cached value and is marked as failed for the current dialog. Values older than 30 minutes are labeled stale. Opening the selector does not refresh automatically.

`GROK_CLI_OAUTH_TOKEN` applies only to the permanent base account. When it is set, the accounts UI identifies the environment token and tells you to unset it instead of presenting a logout action that cannot remove it.

#### Automatic exhaustion rotation

When at least two configured accounts are logged in, pi-grok-cli rotates after a final Grok assistant error whose trimmed message is exactly:

```text
OpenAI API error (402): 402 "Grok Build usage balance exhausted"
```

Rotation waits until Pi has finished retries, compaction, and tool activity. It preserves the current model when available and automatically continues the interrupted request once. Accounts that returned the exact error are skipped for five minutes within the current Pi session, including across new requests and successful continuations. A successful relogin makes that account immediately eligible again. If every logged-in account is exhausted or still cooling down, the extension stops without wrapping and reports that all accounts are exhausted.

Within the eligible circular fallback order, quota values cached less than 30 minutes ago rank candidates by their tightest remaining monthly or weekly percentage. Candidates with stale, missing, or invalid quota keep their circular slots, and equal scores keep circular order. Failover reads the cache only—it never fetches billing data—and quota ranking never rotates a healthy account or chooses the initial account. Similar 402 messages, 401s, 429s, non-Grok errors, and non-final errors do not trigger rotation. A manual model change before failover cancels the pending rotation.

### Model-scoped Cursor compatibility

Pi's native tool vocabulary remains the default. Cursor-compatible tool names are exposed only when one of these exact models is selected:

- `grok-cli/grok-build`
- `grok-cli/grok-composer-2.5-fast`

Managed account aliases expose the same two model IDs with the same compatibility behavior.

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

Run `/grok-cli-imagine <prompt>` to generate and preview a JPEG, or let any active model call the `image_gen` tool. Both use the current or last successfully selected Grok account and save the result under the current session or a requested output path. The command supports `--aspect`, `--out`, and `--resolution 1k`.

`image_gen` is enabled by default across providers and is independent of Cursor compatibility. Use `/grok-cli-imagine:tool [on|off|status]` to manage its persisted availability without disabling the direct command.

## Commands

| Command | Description |
| --- | --- |
| `/grok-cli-accounts [gui]` | Manage Grok accounts in the TUI, or add `gui` for the local visual account and quota dashboard. |
| `/grok-cli-usage` | Fetch current quota, update its cache, and show cached data if refresh fails. |
| `/grok-cli-imagine <prompt>` | Generate and preview an image. Supports `--aspect`, `--out`, and `--resolution 1k`. |
| `/grok-cli-imagine:tool [on\|off\|status]` | Toggle, set, or report persistent model-callable `image_gen` availability. |
| `/grok-cli-vision:status` | Show vision state, describer model, configuration path, and cache statistics. |
| `/grok-cli-vision:on` / `/grok-cli-vision:off` | Enable or disable vision routing. |
| `/grok-cli-vision:cache-clear` | Remove all cached image descriptions. |

## Configuration

Extension-owned data is grouped under `~/.pi/grok-cli/`:

```text
~/.pi/grok-cli/
├── config.json
├── vision-cache.json
└── quota-cache.json
```

`config.json` contains settings and account labels. The two cache files contain derived vision descriptions and quota responses; neither contains OAuth tokens. Pi owns OAuth credentials in its `auth.json`; this extension does not read Grok Build credentials.

The configuration file is created after the first setting change and defaults to:

```json
{
  "version": 2,
  "accounts": {
    "nextAccountNumber": 2,
    "selectedProvider": "grok-cli",
    "items": [
      {
        "provider": "grok-cli",
        "label": "Account 1"
      }
    ]
  },
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

Existing `~/.pi/grok-cli.json`, `~/.pi/grok-cli-vision-cache.json`, version 1 configuration, and legacy Imagine and vision settings are migrated atomically while preserving feature settings and cache data. A conflicting file at the new location remains authoritative and the legacy file is preserved with a warning instead of being overwritten.

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
