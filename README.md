# llm-shims

Small local proxies that sit between a tool and an LLM provider, translating
whatever the tool speaks into whatever the provider actually accepts.

Each shim stays single-purpose on purpose. Swapping providers means running
another small proxy, not adding a branch to a growing multi-backend server.

| Shim | Listens | Speaks to clients | Forwards to |
|---|---|---|---|
| [`ollama-anthropic`](ollama-anthropic/) | 127.0.0.1:3445 | Anthropic Messages | `ollama.com/api/chat` |

`ollama-anthropic` lets Claude Code drive Ollama Cloud models over the native
Ollama API, passing thinking through as a proper Anthropic `thinking` block.

## Requirements

An Ollama Cloud API key in `~/.config/ollama-anthropic-proxy/env` (mode 600):

```
OLLAMA_CLOUD_API_KEY=...
```

A systemd `--user` unit does not inherit a key that only exists inside an
interactive shell, which is why it lives on disk rather than in the
environment.

## Install

```bash
git clone https://github.com/jeremysball/llm-shims.git
cd llm-shims
mise install                          # node, pinned
npm install                           # dev tooling (eslint, typescript) + wires the pre-commit hook
mise run ollama-anthropic-install     # write the systemd --user unit for this checkout
systemctl --user enable --now ollama-anthropic-proxy
mise run ollama-anthropic-health      # /healthz
```

To run the proxy in the foreground instead: `mise run ollama-anthropic`.

## Why native, and where the think control went

Ollama Cloud serves the same models on two endpoints, and only the native
`/api/chat` honours the `think` switch. Verified 2026-08-08 against
`deepseek-v4-flash:0731`:

| Endpoint | Request | Thinking output |
|---|---|---|
| `/v1/chat/completions` | `{"think": false}` | present |
| `/v1/chat/completions` | `{"reasoning": {"enabled": false}}` | present |
| `/v1/chat/completions` | `{"chat_template_kwargs": {"thinking": false}}` | present |
| `/api/chat` | `{"think": false}` | **none** |

All three OpenAI-compatible spellings are accepted without error and silently
ignored. Because `ollama-anthropic` needs the think control, it talks to the
native endpoint rather than the OpenAI-compatible one.

`ollama-anthropic` **passes thinking through by default**: the model's
reasoning arrives in `message.thinking`, and the shim turns it into an Anthropic
`thinking` block that Claude Code renders collapsed. `PROXY_THINK` is the only
knob, and it reads `false`, `0`, `off`, and `no` to mean off, `true`, `1`,
`on`, and `yes` to mean on, any case.

## Status

`ollama-anthropic` is in daily use and verified end to end through Claude
Code. It now reports real token counts (input/output) on every turn, so the
Claude Code statusline context gauge reads correctly on Ollama Cloud
sessions.

A second shim, `ollama-mods`, briefly existed to do the same for
`charmbracelet/mods`. It was removed once the native path turned out to be
unusable from the client side: mods v1.8.1 never terminates an Ollama stream,
so no proxy can make that integration work. `git log` has the details.
