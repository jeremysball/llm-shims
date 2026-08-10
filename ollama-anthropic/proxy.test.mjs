// Spawns the real proxy as a subprocess against a fake upstream and talks to
// it over a real socket. The bug these cover -- zero-token usage reaching
// Claude Code -- lives entirely in the wire format, so anything that stubs
// out the HTTP layer would have missed it.
//
//   node --test ollama-anthropic/
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";

// Chunks copied from a real ollama.com response, including the final
// usage-only chunk with its empty choices array.
const UPSTREAM_CHUNKS = [
  { id: "chatcmpl-1", object: "chat.completion.chunk", model: "deepseek-v4-flash:0731", choices: [{ index: 0, delta: { role: "assistant", content: "hi" }, finish_reason: null }] },
  { id: "chatcmpl-1", object: "chat.completion.chunk", model: "deepseek-v4-flash:0731", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  { id: "chatcmpl-1", object: "chat.completion.chunk", model: "deepseek-v4-flash:0731", choices: [], usage: { prompt_tokens: 4242, completion_tokens: 17, total_tokens: 4259 } },
];

let upstream;
let upstreamPort;
let proxy;
let proxyPort;
/** Bodies the proxy sent upstream, newest last. */
const upstreamRequests = [];

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

before(async () => {
  upstream = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    upstreamRequests.push(JSON.parse(body));
    const parsed = JSON.parse(body);

    if (parsed.stream) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      // Ollama Cloud only emits the usage chunk when it is asked for --
      // verified against ollama.com, and the whole reason the real proxy saw
      // zeroes. Withholding it here keeps the tests honest.
      const wantUsage = parsed.stream_options?.include_usage === true;
      for (const chunk of UPSTREAM_CHUNKS) {
        if (chunk.usage && !wantUsage) continue;
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
      res.write("data: [DONE]\n\n");
      res.end();
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        id: "chatcmpl-1",
        choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 4242, completion_tokens: 17, total_tokens: 4259 },
      }));
    }
  });
  upstreamPort = await listen(upstream);

  // Borrow a free port from the OS and hand it straight to the proxy.
  const probe = http.createServer();
  proxyPort = await listen(probe);
  probe.close();
  await once(probe, "close");

  proxy = spawn(process.execPath, [new URL("./proxy.mjs", import.meta.url).pathname], {
    env: {
      ...process.env,
      OLLAMA_CLOUD_API_KEY: "test-key",
      PROXY_UPSTREAM: `http://127.0.0.1:${upstreamPort}/v1/chat/completions`,
      PROXY_PORT: String(proxyPort),
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  // The proxy logs its listening line to stderr; wait for the socket instead
  // of racing it.
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${proxyPort}/healthz`);
      if (res.ok) break;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
});

after(() => {
  proxy?.kill();
  upstream?.close();
});

async function messages(body) {
  return fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("asks upstream for usage when streaming", async () => {
  await (await messages({ model: "m", stream: true, messages: [{ role: "user", content: "hi" }] })).text();
  const sent = upstreamRequests.at(-1);
  assert.deepEqual(sent.stream_options, { include_usage: true });
});

test("forwards real token counts on message_delta", async () => {
  const res = await messages({ model: "m", stream: true, messages: [{ role: "user", content: "hi" }] });
  const text = await res.text();

  const delta = text
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => JSON.parse(l.slice(5)))
    .find((e) => e.type === "message_delta");

  assert.ok(delta, "no message_delta in the translated stream");
  assert.equal(delta.usage.input_tokens, 4242);
  assert.equal(delta.usage.output_tokens, 17);
});

test("does not drop the usage-only chunk's stop reason", async () => {
  const res = await messages({ model: "m", stream: true, messages: [{ role: "user", content: "hi" }] });
  const text = await res.text();
  const delta = text
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => JSON.parse(l.slice(5)))
    .find((e) => e.type === "message_delta");
  assert.equal(delta.delta.stop_reason, "end_turn");
});

test("reports usage on the non-streaming path too", async () => {
  const res = await messages({ model: "m", stream: false, messages: [{ role: "user", content: "hi" }] });
  const body = await res.json();
  assert.equal(body.usage.input_tokens, 4242);
  assert.equal(body.usage.output_tokens, 17);
});

test("does not ask for usage when not streaming", async () => {
  await (await messages({ model: "m", stream: false, messages: [{ role: "user", content: "hi" }] })).json();
  assert.equal(upstreamRequests.at(-1).stream_options, undefined);
});
