# ollama-mods-proxy

A small local proxy for [charmbracelet/mods](https://github.com/charmbracelet/mods)
(and anything else that speaks Ollama's **native** `/api/chat` protocol) to
drive Ollama Cloud models. It adds the bearer token Ollama Cloud requires,
forces thinking off, and relabels streaming responses so native clients stop
waiting on them.

## Why this exists

Ollama Cloud serves the same models on two endpoints, and only one of them
honours the thinking switch. Verified 2026-08-08 against
`deepseek-v4-flash:0731`:

| Endpoint | Request | Thinking output |
|---|---|---|
| `/v1/chat/completions` | `{"think": false}` | present |
| `/v1/chat/completions` | `{"reasoning": {"enabled": false}}` | present |
| `/v1/chat/completions` | `{"chat_template_kwargs": {"thinking": false}}` | present |
| `/api/chat` | `{"think": false}` | **none** |

All three OpenAI-compatible spellings are accepted without error and silently
ignored. Only the native `/api/chat` honours `think: false`.

Clients that speak the native protocol can reach the working switch, but
`mods`' native driver sends no `Authorization` header and emits no `think`
field, so it cannot talk to Ollama Cloud on its own. This proxy supplies both.

## What it does

1. **Adds auth** — injects `Authorization: Bearer $OLLAMA_CLOUD_API_KEY` on
   every forwarded request.
2. **Forces thinking off** — rewrites `think` to `false` in the JSON body of
   `POST /api/chat` and `POST /api/generate`. Set `PROXY_THINK` to `true`, `1`,
   `on`, or `yes` to pass thinking through unchanged. `false`, `0`, `off`, and
   `no` force it off. Matching ignores case, and `ollama-anthropic` reads the
   same spellings, so one value means the same thing in both shims. Only the
   default differs: off here, on there.
3. **Relabels streaming responses** — Ollama Cloud returns newline-delimited
   JSON under `Content-Type: application/json`; the local daemon uses
   `application/x-ndjson`, which is what native clients (like `mods`) actually
   parse. Without the relabel, `mods` waits forever on the mislabelled stream.

## Using it with mods

Point `mods` at the proxy:

```sh
export MODS_OLLAMA_URL=http://127.0.0.1:3446
mods "summarize the llm-shims repo"
```

## Running

Managed by a systemd `--user` unit:

```sh
systemctl --user status  ollama-mods-proxy
systemctl --user restart ollama-mods-proxy
journalctl --user -u ollama-mods-proxy -f     # logs
```

Unit: `~/.config/systemd/user/ollama-mods-proxy.service`, written by
`mise run install` in the repo root. Bound to `127.0.0.1:3446` (local only).
The API key lives in `~/.config/ollama-anthropic-proxy/env` (mode 600, loaded
via `EnvironmentFile=`), shared with the sibling `ollama-anthropic` shim.

For the foreground: `mise run mods`.

## Endpoints

- `POST /api/chat` / `POST /api/generate` — forwarded to `ollama.com` with the
  bearer token added and `think` forced off.
- `GET /healthz` — liveness + key/think-state check.

## Tests

```sh
node --test 'ollama-mods/*.test.mjs'     # from the repo root
```

They spawn the real proxy as a subprocess against a fake loopback upstream and
talk to it over a real socket. `PROXY_UPSTREAM` exists for that: it overrides
the ollama.com endpoint and — as in `ollama-anthropic` — is loopback-only, so
an override can never hand the API key to a remote host.
