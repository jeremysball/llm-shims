# ollama-anthropic-proxy

A purpose-built local proxy that lets Claude Code drive Ollama Cloud models
(default: `deepseek-v4-flash:0731`) by presenting the **Anthropic Messages
API** to Claude Code and translating to Ollama Cloud's OpenAI-compatible
**Chat Completions API** upstream.

Each proxy stays single-provider on purpose rather than growing into one
generic multi-backend server — swapping providers means running (or adding)
another small proxy, not branching this one.

## How it works

```
Claude Code  --Anthropic Messages-->  proxy (127.0.0.1:3445)  --Chat Completions-->  ollama.com/v1/chat/completions
```

Auth is a static API key (`OLLAMA_CLOUD_API_KEY`), sent as `Authorization: Bearer`
on every upstream request — no OAuth/token refresh needed, unlike the Codex proxy.

## Running

Managed by a systemd --user unit:

```bash
systemctl --user status   ollama-anthropic-proxy
systemctl --user restart  ollama-anthropic-proxy
journalctl --user -u ollama-anthropic-proxy -f      # logs
```

Unit: `~/.config/systemd/user/ollama-anthropic-proxy.service`, written by
`mise run install` in the repo root. Bound to `127.0.0.1:3445`
(local only). The API key lives in `~/.config/ollama-anthropic-proxy/env`
(mode 600, loaded via `EnvironmentFile=`) since a systemd --user unit doesn't
inherit the harness-injected `OLLAMA_CLOUD_API_KEY` that's only present inside
an interactive Claude Code session.

## Using it from Claude Code

**Use the `ollama-cc` fish abbr, not bare `claude`:**

```bash
ollama-cc                    # interactive, deepseek-v4-flash:0731
ollama-cc -p "..."           # headless
```

Defined in `~/.config/fish/conf.d/myabbrs.fish` alongside the other
model-switch abbrs (`gpt`, `glm`, `minimax`, `deepseek`):

```fish
abbr -a -- ollama-cc 'env -u ANTHROPIC_BASE_URL -u ANTHROPIC_API_BASE_URL -u CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY claude --dangerously-skip-permissions --settings ~/.claude/settings.ollama-cloud.json'
```

The `env -u` prefix unsets three env vars a parent Claude Code session leaks
that would otherwise override the proxy URL in `~/.claude/settings.ollama-cloud.json`
and silently reroute requests to a different backend.

Verified end-to-end through Claude Code itself: text response and a real
Bash tool round-trip both confirmed live (2026-08-08).

## Tests

```bash
node --test 'ollama-anthropic/*.test.mjs'      # from the repo root
```

They spawn the real proxy as a subprocess against a fake upstream and talk to
it over a real socket, because the faults worth catching here live in the wire
format. `PROXY_UPSTREAM` exists for that: it overrides the ollama.com endpoint
and is not used in production.

## Endpoints

- `POST /v1/messages` — Anthropic Messages (streaming + non-streaming, including tool calls)
  - Translates native OpenAI tool calls plus complete DeepSeek DSML-in-content invocations for tools supplied by the client. Malformed or unoffered DSML remains ordinary text.
- `GET /v1/models` — lists the configured model
- `GET /healthz` — liveness + key-presence check

## Token usage

Ollama Cloud only sends token counts when the request carries
`stream_options.include_usage`, and then only in a final chunk whose `choices`
array is empty. The proxy asks for it and forwards the numbers on
`message_delta`, which is where Claude Code picks them up — the same place
OpenRouter's Anthropic endpoint puts them. `message_start` reports zeroes
because upstream hasn't counted anything yet at that point; that is expected,
not a bug.

Without both halves of that, every turn is reported as costing zero tokens and
the statusline's context gauge reads `n/a`.

## Caveats

- Local-only (127.0.0.1); the inbound API key isn't enforced — real auth is the
  static key sent upstream to Ollama Cloud.
- Ollama Cloud enforces a per-account concurrency cap (observed: 3 requests
  in flight); this proxy does not queue or rate-limit for you.
- To point at a different Ollama Cloud model, override `PROXY_MODEL` in the
  systemd unit's `Environment=` line and update `~/.claude/settings.ollama-cloud.json`
  to match (both the `model` field and the four `ANTHROPIC_*_MODEL` env vars).
