#!/usr/bin/env node
// ollama-anthropic-proxy: presents the Anthropic Messages API to Claude Code,
// translates to Ollama's native /api/chat, forwards to Ollama Cloud with a
// static API key, and translates the NDJSON stream back to Anthropic shape.
//
// Why native instead of the OpenAI-compatible /v1/chat/completions endpoint:
// only the native /api/chat honours the `think` switch on Ollama Cloud. The
// OpenAI-compatible endpoint silently ignores every think spelling (verified
// 2026-08-08 against deepseek-v4-flash:0731), so it cannot force thinking off.
//
// Verified wire details (this session, against ollama.com):
//   UPSTREAM: POST https://ollama.com/api/chat
//     headers: Authorization: Bearer <OLLAMA_CLOUD_API_KEY>
//     body:    {model, messages, stream, think, tools} — native chat shape
//     streaming is newline-delimited JSON (one JSON object per line), not SSE.
//     `think` is honoured (false -> 0 chars of thinking).
//     token usage arrives only in the terminal frame (done:true) as
//     prompt_eval_count / eval_count.
//     tool calls arrive whole in a single frame's message.tool_calls, with
//     `arguments` as a JSON object (not an incrementally-streamed string).

import http from "node:http";

// PROXY_UPSTREAM exists so the tests can point this at a fake upstream. Every
// request carries the Ollama Cloud key in an Authorization header, so an
// override that reached a remote host would hand the key to it; loopback only,
// and a violation is fatal rather than silently ignored.
const UPSTREAM = resolveUpstream(process.env.PROXY_UPSTREAM);

function resolveUpstream(override) {
  if (!override) return "https://ollama.com/api/chat";
  let host;
  try {
    host = new URL(override).hostname;
  } catch {
    console.error(`PROXY_UPSTREAM is not a valid URL: ${override}`);
    process.exit(1);
  }
  if (host !== "127.0.0.1" && host !== "[::1]" && host !== "localhost") {
    console.error(`PROXY_UPSTREAM must point at loopback, got host ${host}`);
    process.exit(1);
  }
  return override;
}
const PORT = Number(process.env.PROXY_PORT || 3445);
const API_KEY = process.env.OLLAMA_CLOUD_API_KEY;
const MODEL = process.env.PROXY_MODEL || "deepseek-v4-flash:0731";
// PROXY_THINK=true passes the model's thinking through; the default (false)
// forces it off. Only the native endpoint can do this on Ollama Cloud.
const THINK = process.env.PROXY_THINK === "true";

if (!API_KEY) {
  console.error("OLLAMA_CLOUD_API_KEY is not set in the environment");
  process.exit(1);
}

// ---------- Anthropic Messages -> native /api/chat request translation ----------
function translateSystem(system) {
  if (!system) return null;
  if (typeof system === "string") return system;
  if (Array.isArray(system)) {
    return system.filter((b) => b.type === "text").map((b) => b.text).join("\n");
  }
  return null;
}

// Translates Anthropic messages to native ChatMessage objects. Native bundles
// tool calls into the assistant message that produced them, so a tool_use block
// is folded onto the previous assistant message's tool_calls array; a
// tool_result block becomes its own role:"tool" message.
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

    let last = out[out.length - 1];
    const textParts = [];
    for (const block of content) {
      if (block.type === "text") {
        textParts.push(block.text);
      } else if (block.type === "tool_use") {
        // Fold onto the previous assistant message if present; native requires
        // tool_calls on an assistant message. Otherwise synthesize one.
        let target = null;
        if (last && last.role === "assistant" && Array.isArray(last.tool_calls)) {
          target = last;
        }
        if (!target) {
          target = { role: "assistant", content: null, tool_calls: [] };
          out.push(target);
          last = target;
        }
        target.tool_calls = target.tool_calls || [];
        target.tool_calls.push({
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
        out.push({ role: "tool", content: out2 });
      }
      // "thinking" blocks: with think=false none arrive; on passthrough they
      // would ride in message.thinking on the native side, not as content.
    }
    if (textParts.length) {
      if (last && last.role === "assistant" && Array.isArray(last.tool_calls) && !last.content) {
        last.content = textParts.join("");
      } else {
        out.push({ role, content: textParts.join("") });
      }
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
  req.think = THINK;
  const tools = translateTools(anth.tools);
  if (tools) req.tools = tools;
  return req;
}

// ---------- native /api/chat NDJSON -> Anthropic SSE translation ----------
function sse(obj) {
  return `event: ${obj.type}\ndata: ${JSON.stringify(obj)}\n\n`;
}

const FINISH_TO_STOP_REASON = { tool_calls: "tool_use", length: "max_tokens", stop: "end_turn" };

function createDsmlDecoder(offeredToolNames) {
  const open = "<invoke name=\"";
  const close = "</invoke>";
  let buffer = "";

  function parseInvocation(source) {
    const match = source.match(/^<invoke name="([^"]+)">\n([\s\S]*)<\/invoke>$/);
    if (!match || !offeredToolNames.has(match[1])) return null;

    const input = {};
    const parameter = /<parameter name="([^"]+)">([\s\S]*?)(?:<parameter>|<\/parameter>)/g;
    let offset = 0;
    for (let item; (item = parameter.exec(match[2])); ) {
      if (match[2].slice(offset, item.index).trim() || Object.hasOwn(input, item[1])) return null;
      Object.defineProperty(input, item[1], { value: item[2], enumerable: true });
      offset = parameter.lastIndex;
    }
    if (match[2].slice(offset).trim() || offset === 0 && match[2].trim()) return null;
    return { name: match[1], input };
  }

  function drain(final = false) {
    const parts = [];
    while (buffer) {
      const start = buffer.indexOf(open);
      if (start < 0) {
        let keep = 0;
        if (!final) {
          const maxLength = Math.min(buffer.length, open.length - 1);
          for (let length = maxLength; length > 0; length--) {
            if (buffer.endsWith(open.slice(0, length))) {
              keep = length;
              break;
            }
          }
        }
        if (buffer.length > keep) parts.push({ type: "text", text: buffer.slice(0, buffer.length - keep) });
        buffer = buffer.slice(buffer.length - keep);
        break;
      }
      if (start > 0) {
        parts.push({ type: "text", text: buffer.slice(0, start) });
        buffer = buffer.slice(start);
      }
      const end = buffer.indexOf(close, open.length);
      if (end < 0) {
        if (final) {
          parts.push({ type: "text", text: buffer });
          buffer = "";
        }
        break;
      }
      const source = buffer.slice(0, end + close.length);
      const invocation = parseInvocation(source);
      parts.push(invocation ? { type: "tool", ...invocation } : { type: "text", text: source });
      buffer = buffer.slice(source.length);
    }
    return parts;
  }

  return {
    push(text) {
      buffer += text;
      return drain();
    },
    finish() {
      return drain(true);
    },
  };
}

async function streamTranslated(upstreamRes, reply, clientModel, reqId, offeredToolNames) {
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

  let textBlock = null;
  // A native tool call may be interleaved with later content deltas. Anthropic
  // blocks cannot receive deltas after their stop event, so defer events after
  // the first native tool call; ordinary text still streams.
  let deferContent = false;
  const toolBlocksByKey = new Map();
  const deferredEvents = [];
  let emittedToolUse = false;
  let anonymousToolCallCount = 0;
  let nextBlockIndex = 0;
  let stopReason = "end_turn";
  let usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  const dsml = createDsmlDecoder(offeredToolNames);

  const closeTextBlock = () => {
    if (!textBlock) return;
    reply.write(sse({ type: "content_block_stop", index: textBlock.blockIndex }));
    textBlock = null;
  };
  const emitNativeToolBlock = (block) => {
    if (block.emitted) return;
    closeTextBlock();
    block.blockIndex = nextBlockIndex++;
    emitToolUse(block);
    if (block.arguments) {
      reply.write(sse({ type: "content_block_delta", index: block.blockIndex, delta: { type: "input_json_delta", partial_json: block.arguments } }));
    }
    reply.write(sse({ type: "content_block_stop", index: block.blockIndex }));
    block.emitted = true;
  };
  const emitDeferredEvents = () => {
    for (const event of deferredEvents) {
      if (event.type === "native") emitNativeToolBlock(event.block);
      else if (event.type === "dsml") {
        const blockIndex = nextBlockIndex++;
        const block = {
          blockIndex,
          contentBlock: { type: "tool_use", id: `toolu_dsml_${Math.random().toString(36).slice(2, 12)}`, name: event.invocation.name, input: {} },
        };
        emitToolUse(block);
        reply.write(sse({ type: "content_block_delta", index: blockIndex, delta: { type: "input_json_delta", partial_json: JSON.stringify(event.invocation.input) } }));
        reply.write(sse({ type: "content_block_stop", index: blockIndex }));
      } else {
        deferContent = false;
        emitText(event.text);
        deferContent = true;
      }
    }
    deferContent = false;
  };
  const emitText = (text) => {
    if (!text) return;
    if (deferContent) {
      deferredEvents.push({ type: "text", text });
      return;
    }
    if (!textBlock) {
      textBlock = { blockIndex: nextBlockIndex++ };
      reply.write(sse({ type: "content_block_start", index: textBlock.blockIndex, content_block: { type: "text", text: "" } }));
    }
    reply.write(sse({ type: "content_block_delta", index: textBlock.blockIndex, delta: { type: "text_delta", text } }));
  };
  const emitToolUse = (block) => {
    closeTextBlock();
    reply.write(sse({ type: "content_block_start", index: block.blockIndex, content_block: block.contentBlock }));
  };
  const emitDsmlInvocation = (invocation) => {
    emittedToolUse = true;
    stopReason = "tool_use";
    deferContent = true;
    deferredEvents.push({ type: "dsml", invocation });
  };
  const emitDsmlParts = (parts) => {
    for (const part of parts) {
      if (part.type === "text") emitText(part.text);
      else emitDsmlInvocation(part);
    }
  };

  // A native /api/chat frame is a single JSON object per line (NDJSON), unlike
  // the OpenAI SSE frames this proxy previously translated. The final frame has
  // done:true and carries the usage stats.
  const processFrame = (frame) => {
    if (!frame.trim()) return;
    let ev;
    try { ev = JSON.parse(frame); } catch { return; }

    if (ev.done && typeof ev.prompt_eval_count === "number") {
      usage = {
        input_tokens: ev.prompt_eval_count || 0,
        output_tokens: ev.eval_count || 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      };
    }

    const msg = ev.message || {};
    if (msg.content) emitDsmlParts(dsml.push(msg.content));

    if (Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        const idKey = tc.id ? `id:${tc.id}` : null;
        const indexKey = tc.function?.index === undefined ? null : `index:${tc.function.index}`;
        const indexedBlock = indexKey ? toolBlocksByKey.get(indexKey) : null;
        let block = idKey ? toolBlocksByKey.get(idKey) : null;
        if (!block && indexedBlock && (!tc.id || indexedBlock.contentBlock.id.startsWith("toolu_native_"))) {
          block = indexedBlock;
        }
        if (!block) {
          emittedToolUse = true;
          deferContent = true;
          block = {
            blockIndex: null,
            emitted: false,
            arguments: "",
            contentBlock: { type: "tool_use", id: tc.id || `toolu_native_${Math.random().toString(36).slice(2, 12)}`, name: tc.function?.name || "", input: {} },
          };
          toolBlocksByKey.set(indexKey || `anonymous:${anonymousToolCallCount++}`, block);
          deferredEvents.push({ type: "native", block });
        }
        if (indexKey && !indexedBlock) toolBlocksByKey.set(indexKey, block);
        if (idKey) toolBlocksByKey.set(idKey, block);
        if (tc.id && block.contentBlock.id.startsWith("toolu_native_")) block.contentBlock.id = tc.id;
        if (tc.function?.name) block.contentBlock.name = tc.function.name;
        if (tc.function?.arguments) {
          const args = typeof tc.function.arguments === "string"
            ? tc.function.arguments
            : JSON.stringify(tc.function.arguments);
          block.arguments += args;
        }
      }
    }
    if (ev.done) {
      stopReason = FINISH_TO_STOP_REASON[ev.done_reason] || "end_turn";
      stopReason = stopReason === "end_turn" && emittedToolUse ? "tool_use" : stopReason;
    }
  };

  const reader = upstreamRes.body.getReader();
  const dec = new TextDecoder();
  let buffer = "";
  let frameStart = 0;
  let frameEnd;
  while ((frameEnd = buffer.indexOf("\n")) >= 0) {
    processFrame(buffer.slice(frameStart, frameEnd));
    buffer = buffer.slice(frameEnd + 1);
  }
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      processFrame(frame);
    }
  }
  buffer += dec.decode();
  while ((frameEnd = buffer.indexOf("\n")) >= 0) {
    processFrame(buffer.slice(0, frameEnd));
    buffer = buffer.slice(frameEnd + 1);
  }
  if (buffer.trim()) processFrame(buffer);

  emitDsmlParts(dsml.finish());
  emitDeferredEvents();
  closeTextBlock();
  reply.write(sse({ type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage }));
  reply.write(sse({ type: "message_stop" }));
  reply.end();
}

async function bufferTranslated(upstreamRes, reply, clientModel, reqId, offeredToolNames) {
  const json = await upstreamRes.json();
  const msg = json.message || {};
  const content = [];
  let dsmlToolUse = false;
  if (msg.content) {
    const dsml = createDsmlDecoder(offeredToolNames);
    for (const part of [...dsml.push(msg.content), ...dsml.finish()]) {
      if (part.type === "text") content.push({ type: "text", text: part.text });
      else {
        dsmlToolUse = true;
        content.push({
          type: "tool_use",
          id: `toolu_dsml_${Math.random().toString(36).slice(2, 12)}`,
          name: part.name,
          input: part.input,
        });
      }
    }
  }
  for (const tc of msg.tool_calls || []) {
    let input = {};
    try { input = typeof tc.function?.arguments === "string" ? JSON.parse(tc.function.arguments) : tc.function?.arguments || {}; } catch {}
    content.push({ type: "tool_use", id: tc.id || `toolu_native_${Math.random().toString(36).slice(2, 12)}`, name: tc.function?.name, input });
  }
  const upstreamStopReason = FINISH_TO_STOP_REASON[json.done_reason] || "end_turn";
  const stopReason = upstreamStopReason === "end_turn" && (dsmlToolUse || msg.tool_calls?.length)
    ? "tool_use"
    : upstreamStopReason;
  const usage = {
    input_tokens: json.prompt_eval_count || 0,
    output_tokens: json.eval_count || 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
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
  const offeredToolNames = new Set((anth.tools || []).map((tool) => tool.name).filter(Boolean));
  if (wantStream) {
    await streamTranslated(upstreamRes, reply, clientModel, reqId, offeredToolNames);
  } else {
    await bufferTranslated(upstreamRes, reply, clientModel, reqId, offeredToolNames);
  }
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
    reply.end(isHead ? "" : JSON.stringify({ ok: true, model: MODEL, think: THINK, hasKey: !!API_KEY }));
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
  const { port } = server.address();
  log(`ollama-anthropic-proxy listening on http://127.0.0.1:${port}`);
  log(`model: ${MODEL}`);
});

function log(msg) {
  console.error(`[${new Date().toISOString()}] ${msg}`);
}
