# pi-grok-cli

[![CI](https://github.com/kenryu42/pi-grok-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/kenryu42/pi-grok-cli/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/pi-grok-cli?label=npm&color=blue)](https://www.npmjs.com/package/pi-grok-cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-red.svg)](./LICENSE)

<div align="center">

[![Pi Grok CLI](./.github/assets/pi-grok-cli.png)](./.github/assets/pi-grok-cli.png)

</div>

Use your X Premium or SuperGrok subscription in [pi](https://pi.dev/) with a clean, focused toolset.

- **OAuth login:** Sign in through a browser or device code with automatic token refresh.
- **Multiple accounts:** Manage accounts and quotas from the terminal or browser dashboard, and automatically continue with another account when quota runs out.
- **Usage tracking:** Check account limits, remaining credits, and reset times.
- **Image generation:** Generate images directly or let Grok use the `image_gen` tool.
- **Vision routing:** Let text-only models understand images through a vision-capable Grok model.
- **Model-specific tools:** Use Cursor-compatible tool names only where Grok Build and Composer 2.5 need them.

> Requires pi 0.80.9 or newer and an xAI/Grok account with access to the selected model. Availability varies by account, plan, region, and xAI rollout. The Grok Build executable is not required.
>
> This is an unofficial community integration. It does not bypass xAI access controls, quotas, or billing.

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

- **Browser login (default):** Opens xAI authorization in your browser. If xAI shows a one-time code, paste it back into pi.
- **Device code login:** Displays a URL and short code for SSH, containers, and other headless environments.

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

## Manage multiple accounts

Open the browser dashboard to view accounts and quotas in one place:

```text
/grok-cli-accounts gui
```

Select **Add account** to optionally label the account and start browser login.

Prefer the terminal? Run `/grok-cli-accounts`, choose **＋ Add account**, and press Enter when the login command appears. Device-code login remains available there for headless environments.

With at least two logged-in accounts, pi-grok-cli can continue an interrupted request with another account when the current account runs out of quota. Recently exhausted accounts are temporarily skipped, and rotation stops when no eligible account remains.

Only add accounts you own or are authorized to access.

## Manage installation

```bash
pi update npm:pi-grok-cli
pi remove npm:pi-grok-cli
```

## Models

Models are bundled rather than discovered live. Registered context limits may differ from the limits xAI enforces.

| Model ID | Registered context | Reasoning | Input | Coding tools |
| --- | ---: | --- | --- | --- |
| `grok-composer-2.5-fast` | 200K | no | text; vision routing available | Cursor-compatible names |
| `grok-build` | 500K | yes | text + image | Cursor-compatible names |
| `grok-4.3` | 1M | yes | text + image | native pi names |
| `grok-4.5` | 500K | yes | text + image | native pi names |
| `grok-4.20-0309-reasoning` | 2M | yes | text + image | native pi names |
| `grok-4.20-0309-non-reasoning` | 2M | no | text + image | native pi names |
| `grok-4.20-multi-agent-0309` | 2M | yes | text + image | native pi names |

## Coding tools and media

### Coding tool compatibility

Grok Build and Composer 2.5 use Cursor-compatible tool names. All other models and providers use pi's native tools.

| Compatibility tools | Implementation |
| --- | --- |
| `Read`, `Write`, `Edit`, `Grep`, `LS`, `Shell` | Delegate execution and rendering to pi's native tools. |
| `StrReplace` | Preserves Cursor's literal replace-all behavior. |
| `Glob` | Preserves Cursor's newest-first path ordering. |
| `Delete` | Provides the file-deletion operation expected by these models. |
| `WebSearch` | Optionally replaces an active `web_search` tool when pi-web-access is installed. |

pi applies `--tools` and `--exclude-tools` by exact name. For compatible models, use names such as `--tools Read,Grep` or `--exclude-tools Grep`. `--no-tools` disables all tools.

Install pi-web-access 0.13.0 or newer to add optional `WebSearch` support:

```bash
pi install npm:pi-web-access@^0.13.0
```

Restart pi or run `/reload` after installing it in an existing session. Other models and providers retain the native `web_search` tool.

### Vision routing for text-only models

When a text-only model reads an image, pi-grok-cli describes it with an image-capable Grok model (`grok-build` by default) and passes back the description. Routing is enabled by default for up to four images, caches descriptions locally, and is bypassed for models that support images natively.

### Grok Imagine image generation

Run `/grok-cli-imagine <prompt>` to generate and preview a JPEG, or let any active model call the `image_gen` tool. Images use the current or most recently selected Grok account and are saved under the current session unless you request another path.

`image_gen` is enabled by default across providers. Use `/grok-cli-imagine:tool [on|off|status]` to manage model access without disabling the direct command.

## Commands

| Command | Description |
| --- | --- |
| `/grok-cli-accounts [gui]` | Manage Grok accounts in the terminal, or add `gui` for the browser dashboard. |
| `/grok-cli-usage` | Fetch current quota, update its cache, and show cached data if refresh fails. |
| `/grok-cli-imagine <prompt>` | Generate and preview an image. Supports `--aspect`, `--out`, and `--resolution 1k`. |
| `/grok-cli-imagine:tool [on\|off\|status]` | Toggle, set, or report persistent model-callable `image_gen` availability. |
| `/grok-cli-vision` | Toggle vision routing on or off. |
| `/grok-cli-vision:status` | Show vision state, describer model, configuration path, and cache statistics. |
| `/grok-cli-vision:cache-clear` | Remove all cached image descriptions. |

## Configuration

Extension-owned data is grouped under `~/.pi/grok-cli/`:

```text
~/.pi/grok-cli/
├── config.json
├── vision-cache.json
└── quota-cache.json
```

`config.json` stores settings and account labels. The cache files store derived vision descriptions and quota responses. None contain OAuth tokens; pi stores credentials separately. Legacy settings are migrated automatically.

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
| xAI shows a one-time code | Paste the code into pi to complete the active login. |
| Browser login does not redirect to pi | Paste the complete callback URL into pi when prompted. |
| The browser callback cannot start | Use device-code login or review the callback settings in [Advanced configuration](./CONFIGURATION.md). |
| Authentication returns HTTP 401 or 403 | Run `/login` again and confirm the account can access the selected model. Replace an expired `GROK_CLI_OAUTH_TOKEN` if using an external token. |
| A listed model is unavailable | Availability can differ by account or region, and the catalog is bundled rather than discovered live. Try another model or update the extension. |
| Account rotation does not start | Confirm at least two accounts are logged in. Rotation responds only to Grok Build's final balance-exhausted error, not authentication failures, rate limits, or similar messages. |
| Images are not being described | Run `/grok-cli-vision:status`, confirm routing is on, and verify Grok authentication. Native image-capable models bypass routing by design. |

## Security and data flow

Enabled tools run with your system permissions and can modify files or execute commands. Prompts, model context, tool data, and routed images are sent to the configured xAI endpoints.

See [SECURITY.md](./SECURITY.md) for trust boundaries and private vulnerability reporting. Never include tokens, authorization codes, callback URLs, prompts, or private project data in public issues.

## Support and contributing

Report bugs and feature requests through [GitHub Issues](https://github.com/kenryu42/pi-grok-cli/issues). Include the pi version, pi-grok-cli version, selected model, login method, and exact error message.

For local development:

```bash
bun install
pi -e .
bun run check
```

Pull requests should include tests for behavior changes and pass `bun run check`.

## License

[MIT](./LICENSE) © 2026 kenryu42
