// Spawns the real ollama-mods proxy as a subprocess against a fake upstream
// and talks to it over a real socket, so the wire format (think injection,
// bearer auth, NDJSON relabel) is exercised exactly as it runs in production.
//
//   node --test ollama-mods/*.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";

let upstream;
let upstreamPort;
let proxy;
let proxyPort;
/** { method, path, headers, body } as received by the fake upstream. */
const upstreamRequests = [];
/** The last upstream response the proxy saw, controllable per test. */
let upstreamStatus = 200;
let upstreamContentType = "application/x-ndjson";
let upstreamBody = "";
let upstreamAuth = null;

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

before(async () => {
  upstream = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    upstreamRequests.push({ method: req.method, path: req.url, headers: req.headers, body });
    if (req.url === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(upstreamStatus, { "Content-Type": upstreamContentType });
    res.end(upstreamBody);
  });
  upstreamPort = await listen(upstream);

  proxy = spawn(process.execPath, [new URL("./proxy.mjs", import.meta.url).pathname], {
    env: {
      ...process.env,
      OLLAMA_CLOUD_API_KEY: "test-key",
      PROXY_UPSTREAM: `http://127.0.0.1:${upstreamPort}`,
      PROXY_PORT: "0",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const [listening] = await once(proxy.stderr, "data");
  const match = String(listening).match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
  assert.ok(match, `proxy did not report its listening address: ${listening}`);
  proxyPort = Number(match[1]);

  // Wait for the socket to be bound rather than racing it.
  let healthy = false;
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${proxyPort}/healthz`);
      if (res.ok) {
        healthy = true;
        break;
      }
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  assert.ok(healthy, "proxy never became healthy");
});

after(() => {
  proxy?.kill();
  upstream?.close();
});

/** Send a raw request through the proxy and return (status, headers, body). */
async function proxied({ method, path, body, headers = {}, contentType }) {
  const res = await fetch(`http://127.0.0.1:${proxyPort}${path}`, {
    method,
    headers: { "Content-Type": contentType || "application/json", ...headers },
    body: method === "GET" || method === "HEAD" ? undefined : body,
  });
  return { status: res.status, contentType: res.headers.get("content-type"), body: await res.text() };
}

function resetUpstream() {
  upstreamRequests.length = 0;
  upstreamStatus = 200;
  upstreamContentType = "application/x-ndjson";
  upstreamBody = "";
  upstreamAuth = null;
}

test("adds the bearer token and forces think off on a native /api/chat request", async () => {
  resetUpstream();
  const req = { model: "deepseek-v4-flash:0731", messages: [{ role: "user", content: "hi" }], stream: false };
  upstreamBody = JSON.stringify({ model: req.model, message: { role: "assistant", content: "hi" }, done: true });
  upstreamContentType = "application/json";

  await proxied({ method: "POST", path: "/api/chat", body: JSON.stringify(req) });

  const sent = upstreamRequests[0];
  assert.equal(sent.headers.authorization, "Bearer test-key");
  const parsed = JSON.parse(sent.body);
  assert.equal(parsed.think, false);
  assert.equal(parsed.stream, false);
});

test("strips a client that explicitly asked for thinking on", async () => {
  resetUpstream();
  const req = { model: "deepseek-v4-flash:0731", messages: [], think: true };
  upstreamBody = JSON.stringify({ done: true });
  await proxied({ method: "POST", path: "/api/chat", body: JSON.stringify(req) });

  const parsed = JSON.parse(upstreamRequests[0].body);
  assert.equal(parsed.think, false);
});

test("relabels a streaming native response from application/json to x-ndjson", async () => {
  resetUpstream();
  upstreamContentType = "application/json"; // what Ollama Cloud actually sends
  upstreamBody = "{\"done\":false}\n{\"done\":true}\n";

  const res = await proxied({ method: "POST", path: "/api/chat", body: JSON.stringify({ stream: true }) });

  assert.equal(res.contentType, "application/x-ndjson");
});

test("passes a non-streaming response content-type through unchanged", async () => {
  resetUpstream();
  upstreamContentType = "application/json";
  upstreamBody = JSON.stringify({ done: true });

  const res = await proxied({ method: "POST", path: "/api/chat", body: JSON.stringify({ stream: false }) });

  assert.equal(res.contentType, "application/json");
});

test("reports upstream non-2xx status and body", async () => {
  resetUpstream();
  upstreamStatus = 400;
  upstreamContentType = "application/json";
  upstreamBody = JSON.stringify({ error: "Value looks like object, but can't find closing '}' symbol" });

  const res = await proxied({ method: "POST", path: "/api/chat", body: JSON.stringify({ stream: true }) });

  assert.equal(res.status, 400);
  assert.equal(JSON.parse(res.body).error, "Value looks like object, but can't find closing '}' symbol");
});
