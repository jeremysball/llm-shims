#!/usr/bin/env node
// ollama-anthropic-proxy: presents the Anthropic Messages API to Claude Code,
// translates to the OpenAI Chat Completions API, forwards to Ollama Cloud
// with a static API key, and translates the SSE stream back to Anthropic shape.
//
// Verified wire details (this session):
//   UPSTREAM: POST https://ollama.com/v1/chat/completions
//     headers: Authorization: Bearer <OLLAMA_CLOUD_API_KEY>
//     body:    {model, messages, stream, stream_options, tools} — standard
//     OpenAI chat-completions shape
//     streaming tool calls confirmed via curl: delta.tool_calls[].function.{name,arguments}
//     arrive incrementally, keyed by index (not always id) — see toolBlocksByIndex below.
//     token usage only arrives if stream_options.include_usage is asked for,
//     and then only in a final chunk that carries an empty choices array.

import http from "node:http";

const UPSTREAM = process.env.PROXY_UPSTREAM || "https://ollama.com/v1/chat/completions";
const PORT = Number(process.env.PROXY_PORT || 3445);
const API_KEY = process.env.OLLAMA_CLOUD_API_KEY;
const MODEL = process.env.PROXY_MODEL || "deepseek-v4-flash:0731";

if (!API_KEY) {
  console.error("OLLAMA_CLOUD_API_KEY is not set in the environment");
  process.exit(1);
}

// ---------- Anthropic Messages -> OpenAI Chat Completions request translation ----------
function translateSystem(system) {
  if (!system) return null;
  if (typeof system === "string") return system;
  if (Array.isArray(system)) {
    return system.filter((b) => b.type === "text").map((b) => b.text).join("\n");
  }
  return null;
}

function translateMessages(anth) {
  const out = [];
  const sys = translateSystem(anth.system);
  if (sys) out.push({ role: "system", content: sys });

  for (const msg of anth.messages || []) {
    const role = msg.role === "assistant" ? "assistant" : "user";
    const content = msg.content;

    if (typeof content === "string") {
      out.push({ role, content });
      continue;
    }
    if (!Array.isArray(content)) continue;

    const textParts = [];
    const toolCalls = [];
    for (const block of content) {
      if (block.type === "text") {
        textParts.push(block.text);
      } else if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          type: "function",
          function: {
            name: block.name,
            arguments: typeof block.input === "string" ? block.input : JSON.stringify(block.input ?? {}),
          },
        });
      } else if (block.type === "tool_result") {
        const out2 = Array.isArray(block.content)
          ? block.content.map((c) => c.text ?? JSON.stringify(c)).join("\n")
          : typeof block.content === "string"
            ? block.content
            : JSON.stringify(block.content ?? "");
        out.push({ role: "tool", tool_call_id: block.tool_use_id, content: out2 });
      }
      // "thinking" blocks: Ollama Cloud has no equivalent input slot; skip.
    }
    if (toolCalls.length) {
      out.push({ role: "assistant", content: textParts.join("") || null, tool_calls: toolCalls });
    } else if (textParts.length) {
      out.push({ role, content: textParts.join("") });
    }
  }
  return out;
}

function translateTools(tools) {
  if (!Array.isArray(tools)) return undefined;
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description || "",
      parameters: t.input_schema || t.parameters || { type: "object", properties: {} },
    },
  }));
}

function buildChatRequest(anth) {
  const req = {
    model: MODEL,
    messages: translateMessages(anth),
    stream: anth.stream !== false,
  };
  // Without this, Ollama Cloud streams no usage at all and every turn is
  // reported to Claude Code as costing zero tokens, which leaves the
  // statusline's context gauge permanently blank. Verified against
  // ollama.com: absent include_usage, no chunk in the stream carries a usage
  // object; present, a final chunk does.
  if (req.stream) req.stream_options = { include_usage: true };
  const tools = translateTools(anth.tools);
  if (tools) req.tools = tools;
  return req;
}

// ---------- OpenAI chat-completions SSE -> Anthropic SSE translation ----------
function sse(obj) {
  return `event: ${obj.type}\ndata: ${JSON.stringify(obj)}\n\n`;
}

const FINISH_TO_STOP_REASON = { tool_calls: "tool_use", length: "max_tokens", stop: "end_turn" };

async function streamTranslated(upstreamRes, reply, clientModel, reqId) {
  reply.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  // Zeroed usage in message_start is correct and matches what OpenRouter's
  // Anthropic endpoint sends: the real numbers are only known once upstream
  // finishes, so they ride on message_delta and Claude Code merges them.
  reply.write(sse({ type: "message_start", message: { id: reqId, type: "message", role: "assistant", model: clientModel, content: [], stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } } }));
  reply.write(sse({ type: "ping" }));

  let textBlockOpen = false;
  const textBlockIndex = 0;
  const toolBlocksByIndex = new Map(); // openai tool_call index -> {blockIndex, opened}
  let nextBlockIndex = 1;
  let stopReason = "end_turn";
  let usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  let buffer = "";

  const reader = upstreamRes.body.getReader();
  const dec = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      let dataLine = "";
      for (const ln of frame.split("\n")) if (ln.startsWith("data:")) dataLine += ln.slice(5).trim();
      if (!dataLine || dataLine === "[DONE]") continue;
      let ev;
      try { ev = JSON.parse(dataLine); } catch { continue; }

      // The usage chunk arrives last and carries choices: [], so this has to
      // come before the choice guard below or it gets thrown away.
      if (ev.usage) {
        usage = {
          input_tokens: ev.usage.prompt_tokens || 0,
          output_tokens: ev.usage.completion_tokens || 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        };
      }

      const choice = ev.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta || {};

      if (delta.content) {
        if (!textBlockOpen) {
          reply.write(sse({ type: "content_block_start", index: textBlockIndex, content_block: { type: "text", text: "" } }));
          textBlockOpen = true;
        }
        reply.write(sse({ type: "content_block_delta", index: textBlockIndex, delta: { type: "text_delta", text: delta.content } }));
      }

      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          let block = toolBlocksByIndex.get(tc.index);
          if (!block) {
            block = { blockIndex: nextBlockIndex++, opened: true };
            toolBlocksByIndex.set(tc.index, block);
            reply.write(sse({ type: "content_block_start", index: block.blockIndex, content_block: { type: "tool_use", id: tc.id, name: tc.function?.name || "", input: {} } }));
          }
          if (tc.function?.arguments) {
            reply.write(sse({ type: "content_block_delta", index: block.blockIndex, delta: { type: "input_json_delta", partial_json: tc.function.arguments } }));
          }
        }
      }

      if (choice.finish_reason) {
        stopReason = FINISH_TO_STOP_REASON[choice.finish_reason] || "end_turn";
      }
    }
  }
  if (textBlockOpen) reply.write(sse({ type: "content_block_stop", index: textBlockIndex }));
  for (const block of toolBlocksByIndex.values()) reply.write(sse({ type: "content_block_stop", index: block.blockIndex }));
  reply.write(sse({ type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage }));
  reply.write(sse({ type: "message_stop" }));
  reply.end();
}

async function bufferTranslated(upstreamRes, reply, clientModel, reqId) {
  const json = await upstreamRes.json();
  const msg = json.choices?.[0]?.message || {};
  const content = [];
  if (msg.content) content.push({ type: "text", text: msg.content });
  for (const tc of msg.tool_calls || []) {
    let input = {};
    try { input = JSON.parse(tc.function.arguments); } catch {}
    content.push({ type: "tool_use", id: tc.id, name: tc.function.name, input });
  }
  const stopReason = FINISH_TO_STOP_REASON[json.choices?.[0]?.finish_reason] || "end_turn";
  const usage = { input_tokens: json.usage?.prompt_tokens || 0, output_tokens: json.usage?.completion_tokens || 0 };
  reply.writeHead(200, { "Content-Type": "application/json" });
  reply.end(JSON.stringify({ id: reqId, type: "message", role: "assistant", model: clientModel, content, stop_reason: stopReason, usage }));
}

// ---------- HTTP server ----------
async function forward(anth, reply) {
  const reqBody = buildChatRequest(anth);
  const clientModel = anth.model;
  const reqId = "msg_proxy_" + Math.random().toString(36).slice(2, 12);
  const wantStream = reqBody.stream;

  const upstreamRes = await fetch(UPSTREAM, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
      "User-Agent": "ollama-anthropic-proxy",
    },
    body: JSON.stringify(reqBody),
  });

  if (!upstreamRes.ok) {
    const errText = await upstreamRes.text();
    reply.writeHead(upstreamRes.status, { "Content-Type": "application/json" });
    reply.end(JSON.stringify({ type: "error", error: { type: "upstream_error", message: `upstream ${upstreamRes.status}: ${errText.slice(0, 500)}` } }));
    return;
  }
  if (wantStream) await streamTranslated(upstreamRes, reply, clientModel, reqId);
  else await bufferTranslated(upstreamRes, reply, clientModel, reqId);
}

const server = http.createServer(async (req, reply) => {
  const path = req.url.split("?")[0];
  const isHead = req.method === "HEAD";
  const method = isHead ? "GET" : req.method;

  const readBody = async () => {
    let body = "";
    for await (const chunk of req) body += chunk;
    return body;
  };

  if (method === "GET" && path === "/api/hello") {
    log(`REQ ${req.method} ${req.url} -> hello`);
    reply.writeHead(200, { "Content-Type": "application/json" });
    reply.end(isHead ? "" : JSON.stringify({ ok: true }));
    return;
  }
  if (method === "GET" && path === "/healthz") {
    reply.writeHead(200, { "Content-Type": "application/json" });
    reply.end(isHead ? "" : JSON.stringify({ ok: true, model: MODEL, hasKey: !!API_KEY }));
    return;
  }
  if (method === "GET" && (path === "/v1/models" || path === "/models")) {
    log(`REQ ${req.method} ${req.url} -> models list`);
    reply.writeHead(200, { "Content-Type": "application/json" });
    reply.end(isHead ? "" : JSON.stringify({ object: "list", data: [{ id: MODEL, object: "model", created: 0, owned_by: "ollama" }] }));
    return;
  }
  if (method === "POST" && (path === "/v1/messages" || path === "/messages")) {
    const body = await readBody();
    let bodyModel = "";
    try { bodyModel = JSON.parse(body).model || ""; } catch {}
    log(`REQ ${req.method} ${req.url} model=${bodyModel} bytes=${body.length}`);
    let anth;
    try {
      anth = JSON.parse(body);
    } catch (e) {
      reply.writeHead(400, { "Content-Type": "application/json" });
      reply.end(JSON.stringify({ type: "error", error: { type: "invalid_request", message: "invalid JSON body: " + e.message } }));
      return;
    }
    try {
      await forward(anth, reply);
    } catch (e) {
      log("forward error: " + (e?.stack || e));
      if (!reply.headersSent) {
        reply.writeHead(500, { "Content-Type": "application/json" });
        reply.end(JSON.stringify({ type: "error", error: { type: "proxy_error", message: String(e?.message || e) } }));
      } else {
        try { reply.end(sse({ type: "error", error: { type: "proxy_error", message: String(e?.message || e) } })); } catch {}
      }
    }
    return;
  }
  log(`REQ ${req.method} ${req.url} -> 404 (unrouted)`);
  reply.writeHead(404, { "Content-Type": "application/json" });
  reply.end(isHead ? "" : JSON.stringify({ error: "not found", path: req.url }));
});

server.listen(PORT, "127.0.0.1", () => {
  log(`ollama-anthropic-proxy listening on http://127.0.0.1:${PORT}`);
  log(`model: ${MODEL}`);
});

function log(msg) {
  console.error(`[${new Date().toISOString()}] ${msg}`);
}
