#!/usr/bin/env node
// ollama-think-proxy: speaks Ollama's *native* API to local clients, adds the
// Ollama Cloud bearer token, and forces thinking off before forwarding.
//
// Why this exists: Ollama Cloud exposes the same models on two endpoints, and
// only one of them honours the thinking switch. Verified 2026-08-08 against
// deepseek-v4-flash:0731:
//
//   POST /v1/chat/completions  (OpenAI-compatible)
//     {"think": false} / {"reasoning": {"enabled": false}} /
//     {"chat_template_kwargs": {"thinking": false}}
//       -> all accepted without error, all silently ignored; reasoning text
//          came back on every variant.
//
//   POST /api/chat  (native)
//     {"think": false} -> 0 characters of thinking. Works.
//
// Clients that only speak the native protocol (charmbracelet/mods, ollama's
// own CLI) can therefore reach the working switch, but mods' native driver
// sends no Authorization header at all and emits no `think` field, so it
// cannot talk to Ollama Cloud directly. This proxy supplies both.

import http from "node:http";
import { Readable } from "node:stream";

const UPSTREAM = process.env.OLLAMA_UPSTREAM || "https://ollama.com";
const PORT = Number(process.env.PROXY_PORT || 3446);
const API_KEY = process.env.OLLAMA_CLOUD_API_KEY;

// The reason this proxy exists. Set PROXY_THINK=true to pass thinking through.
const THINK = process.env.PROXY_THINK === "true";

if (!API_KEY) {
  console.error("OLLAMA_CLOUD_API_KEY is not set in the environment");
  process.exit(1);
}

const server = http.createServer(async (req, reply) => {
  const path = req.url.split("?")[0];

  if (req.method === "GET" && path === "/healthz") {
    reply.writeHead(200, { "Content-Type": "application/json" });
    reply.end(JSON.stringify({ ok: true, upstream: UPSTREAM, think: THINK, hasKey: !!API_KEY }));
    return;
  }

  const chunks = [];
  for await (const c of req) chunks.push(c);
  let body = Buffer.concat(chunks);

  // /api/chat and /api/generate both take the `think` field.
  const rewritable = req.method === "POST" && (path === "/api/chat" || path === "/api/generate");
  let streaming = false;
  if (rewritable && body.length) {
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch (e) {
      log(`400 unparseable body on ${path}: ${e.message}`);
      reply.writeHead(400, { "Content-Type": "application/json" });
      reply.end(JSON.stringify({ error: `invalid JSON body: ${e.message}` }));
      return;
    }
    parsed.think = THINK;
    streaming = parsed.stream !== false; // native API streams unless told otherwise
    body = Buffer.from(JSON.stringify(parsed));
  }

  const headers = {
    Authorization: `Bearer ${API_KEY}`,
    "Content-Type": req.headers["content-type"] || "application/json",
  };
  if (req.headers.accept) headers.Accept = req.headers.accept;

  log(`${req.method} ${path}${rewritable ? ` think=${THINK}` : ""}`);

  const upstream = await fetch(UPSTREAM + req.url, {
    method: req.method,
    headers,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
  });

  // Ollama Cloud labels native streaming responses `application/json`, but the
  // body is newline-delimited JSON and the local daemon labels it
  // `application/x-ndjson`. Clients written against the local daemon (mods)
  // wait forever on the mislabelled stream, so correct it here.
  const upstreamType = upstream.headers.get("content-type") || "application/json";
  reply.writeHead(upstream.status, {
    "Content-Type": streaming && upstream.ok ? "application/x-ndjson" : upstreamType,
  });

  if (!upstream.body) {
    reply.end();
    return;
  }
  let sent = 0;
  const src = Readable.fromWeb(upstream.body);
  src.on("data", (c) => { sent += c.length; });
  src.on("end", () => log(`upstream ${upstream.status} done, ${sent} bytes`));
  src.pipe(reply);
});

server.listen(PORT, "127.0.0.1", () => {
  log(`ollama-think-proxy listening on http://127.0.0.1:${PORT} -> ${UPSTREAM} (think=${THINK})`);
});

function log(msg) {
  console.error(`[${new Date().toISOString()}] ${msg}`);
}
