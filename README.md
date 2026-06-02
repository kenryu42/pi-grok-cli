# pi-grok-cli

[![CI](https://github.com/kenryu42/pi-grok-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/kenryu42/pi-grok-cli/actions/workflows/ci.yml)
[![Version](https://img.shields.io/github/v/tag/kenryu42/pi-grok-cli?label=version&color=blue)](https://github.com/kenryu42/pi-grok-cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-red.svg)](https://opensource.org/licenses/MIT)

A pi extension that connects to **Grok CLI's API endpoint** .

## Why?

The Grok CLI uhas access to models **not available** on the public `api.x.ai` API yet:

| Model | Public API (`api.x.ai`) | Grok CLI |
|---|---|---|
| `grok-composer-2.5-fast` | ❌ | ✅ |
| `grok-build` | ✅ | ✅ |
| `grok-4.3` | ✅ | ✅ |

`grok-composer-2.5-fast` is Cursor's Composer 2.5 model, a purpose-built agentic coding model optimized for long-horizon coding tasks.

## Requirements

You need an active Grok subscription or an X Premium subscription with Grok access to use this extension.

## Installation

```bash
pi install npm:pi-grok-cli
```

For local development from this checkout:

```bash
pi install ./pi-grok-cli
# or run once without installing
pi -e ./pi-grok-cli
```

## Usage

### Login

```
/login
```

Select **"Grok CLI"** from the provider list. This opens the xAI OAuth page in your browser.

### Select a model

```
/model grok-cli/grok-composer-2.5-fast
```

### Check quota status

```
/grok-cli-status
```

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PI_GROK_CLI_BASE_URL` | `https://cli-chat-proxy.grok.com/v1` | Override API base URL |
| `PI_GROK_CLI_MODELS` | (all models) | Comma-separated model IDs to expose |
| `PI_GROK_CLI_OAUTH_CLIENT_ID` | `b1a00492-...` | Override OAuth client ID |
| `PI_GROK_CLI_OAUTH_SCOPE` | `openid profile email offline_access grok-cli:access api:access` | Override OAuth scopes |
| `GROK_CLI_OAUTH_TOKEN` | — | Direct token bypass (no auto-refresh) |