# ollama-anthropic-proxy

A purpose-built local proxy that lets Claude Code drive Ollama Cloud models
(default: `deepseek-v4-flash:0731`) by presenting the **Anthropic Messages
API** to Claude Code and translating to Ollama Cloud's OpenAI-compatible
**Chat Completions API** upstream.

Sibling of [`codex-anthropic-proxy`](https://github.com/jeremysball/codex-anthropic-proxy),
which does the same job for OpenAI's Codex Plan (Responses API + OAuth).
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

Unit: `~/.config/systemd/user/ollama-anthropic-proxy.service`. Proxy code:
`~/.local/share/ollama-anthropic-proxy/proxy.mjs`. Bound to `127.0.0.1:3445`
(local only). The API key lives in `~/.config/ollama-anthropic-proxy/env`
(mode 600, loaded via `EnvironmentFile=`) since a systemd --user unit doesn't
inherit the harness-injected `OLLAMA_CLOUD_API_KEY` that's only present inside
an interactive Claude Code session.

## Using it from Claude Code

**Use the `ollama` fish abbr, not bare `claude`:**

```bash
ollama                    # interactive, deepseek-v4-flash:0731
ollama -p "..."           # headless
```

Defined in `~/.config/fish/conf.d/myabbrs.fish` alongside the other
model-switch abbrs (`gpt`, `glm`, `minimax`, `deepseek`):

```fish
abbr -a -- ollama 'env -u ANTHROPIC_BASE_URL -u ANTHROPIC_API_BASE_URL -u CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY claude --dangerously-skip-permissions --settings ~/.claude/settings.ollama-cloud.json'
```

The `env -u` prefix unsets three env vars a parent Claude Code session leaks
that would otherwise override the proxy URL in `~/.claude/settings.ollama-cloud.json`
and silently reroute requests to a different backend — same reasoning as the
`gpt` abbr's write-up in `codex-anthropic-proxy`'s README.

Verified end-to-end through Claude Code itself: text response and a real
Bash tool round-trip both confirmed live (2026-08-08).

## Endpoints

- `POST /v1/messages` — Anthropic Messages (streaming + non-streaming, including tool calls)
- `GET /v1/models` — lists the configured model
- `GET /healthz` — liveness + key-presence check

## Caveats

- Local-only (127.0.0.1); the inbound API key isn't enforced — real auth is the
  static key sent upstream to Ollama Cloud.
- Ollama Cloud enforces a per-account concurrency cap (observed: 3 requests
  in flight); this proxy does not queue or rate-limit for you.
- To point at a different Ollama Cloud model, override `PROXY_MODEL` in the
  systemd unit's `Environment=` line and update `~/.claude/settings.ollama-cloud.json`
  to match (both the `model` field and the four `ANTHROPIC_*_MODEL` env vars).
