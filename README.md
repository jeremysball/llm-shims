# llm-shims

Small local proxies that sit between a tool and an LLM provider, translating
whatever the tool speaks into whatever the provider actually accepts.

Each shim stays single-purpose on purpose. Swapping providers means running
another small proxy, not adding a branch to a growing multi-backend server.

| Shim | Listens | Speaks to clients | Forwards to |
|---|---|---|---|
| [`ollama-anthropic`](ollama-anthropic/) | 127.0.0.1:3445 | Anthropic Messages | `ollama.com/v1/chat/completions` |
| [`ollama-think`](ollama-think/) | 127.0.0.1:3446 | Ollama native | `ollama.com/api/chat` |

`ollama-anthropic` lets Claude Code drive Ollama Cloud models.
`ollama-think` adds the bearer token Ollama Cloud needs and forces thinking
off, which is not possible through the OpenAI-compatible endpoint.

## Requirements

An Ollama Cloud API key in `~/.config/ollama-anthropic-proxy/env` (mode 600):

```
OLLAMA_CLOUD_API_KEY=...
```

Both proxies read the same file. A systemd `--user` unit does not inherit a
key that only exists inside an interactive shell, which is why it lives on
disk rather than in the environment.

## Install

```bash
git clone https://github.com/jeremysball/llm-shims.git
cd llm-shims
mise install                 # node, pinned
mise run install             # write systemd --user units for this checkout
systemctl --user enable --now ollama-anthropic-proxy ollama-think-proxy
mise run health              # both /healthz endpoints
```

To run one in the foreground instead: `mise run think` or `mise run anthropic`.

## Why `ollama-think` exists

Ollama Cloud serves the same models on two endpoints, and only one honours
the thinking switch. Verified 2026-08-08 against `deepseek-v4-flash:0731`:

| Endpoint | Request | Thinking output |
|---|---|---|
| `/v1/chat/completions` | `{"think": false}` | present |
| `/v1/chat/completions` | `{"reasoning": {"enabled": false}}` | present |
| `/v1/chat/completions` | `{"chat_template_kwargs": {"thinking": false}}` | present |
| `/api/chat` | `{"think": false}` | **none** |

All three OpenAI-compatible spellings are accepted without error and
silently ignored.

Clients that speak Ollama's native protocol can reach the working switch,
but `charmbracelet/mods` sends no `Authorization` header from its native
driver and emits no `think` field, so it cannot talk to Ollama Cloud on its
own. This shim supplies both, and relabels the response: Ollama Cloud
returns newline-delimited JSON under `Content-Type: application/json`, where
the local daemon uses `application/x-ndjson`.

Set `PROXY_THINK=true` to pass thinking through unchanged.

## Status

`ollama-anthropic` is in daily use and verified end to end through Claude
Code.

`ollama-think` correctly strips thinking and is verified with `curl`,
including overriding a client that explicitly asked for `"think": true`.
It is **not yet working with `mods`**: mods completes a request against it
and then immediately re-requests in a loop, roughly every 0.7s. The response
is well-formed newline-delimited JSON terminated by `"done": true`, so the
cause is still open. See the tracking issue before relying on that path.
