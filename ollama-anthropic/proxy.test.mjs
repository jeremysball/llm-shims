// Spawns the real proxy as a subprocess against a fake upstream and talks to
// it over a real socket. The bug these cover -- zero-token usage reaching
// Claude Code -- lives entirely in the wire format, so anything that stubs
// out the HTTP layer would have missed it.
//
//   node --test ollama-anthropic/*.test.mjs
import { test, before, beforeEach, after } from "node:test";
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

let upstreamChunks = UPSTREAM_CHUNKS;
let upstreamChunkDelayMs = 0;
let upstreamHoldAfterFirstChunk = null;
let upstreamMessage = {
  id: "chatcmpl-1",
  choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 4242, completion_tokens: 17, total_tokens: 4259 },
};
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
      for (const [index, chunk] of upstreamChunks.entries()) {
        if (chunk.usage && !wantUsage) continue;
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        if (index === 0 && upstreamHoldAfterFirstChunk) await upstreamHoldAfterFirstChunk;
        if (upstreamChunkDelayMs) await new Promise((resolve) => setTimeout(resolve, upstreamChunkDelayMs));
      }
      res.write("data: [DONE]\n\n");
      res.end();
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(upstreamMessage));
    }
  });
  upstreamPort = await listen(upstream);

  // Let the proxy atomically claim an OS-assigned port, then read the actual
  // address from its startup log. Reserving and releasing a port before spawn
  // leaves a race where another process can bind it first.
  proxy = spawn(process.execPath, [new URL("./proxy.mjs", import.meta.url).pathname], {
    env: {
      ...process.env,
      OLLAMA_CLOUD_API_KEY: "test-key",
      PROXY_UPSTREAM: `http://127.0.0.1:${upstreamPort}/v1/chat/completions`,
      PROXY_PORT: "0",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const [listening] = await once(proxy.stderr, "data");
  const match = String(listening).match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
  assert.ok(match, `proxy did not report its listening address: ${listening}`);
  proxyPort = Number(match[1]);

  // The proxy logs its listening line to stderr; wait for the socket instead
  // of racing it.
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

beforeEach(() => {
  upstreamChunks = UPSTREAM_CHUNKS;
  upstreamChunkDelayMs = 0;
  upstreamHoldAfterFirstChunk = null;
  upstreamMessage = {
    id: "chatcmpl-1",
    choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 4242, completion_tokens: 17, total_tokens: 4259 },
  };
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

test("starts forwarding a plain-text response before upstream completes", async () => {
  let releaseUpstream;
  upstreamHoldAfterFirstChunk = new Promise((resolve) => { releaseUpstream = resolve; });
  const res = await messages({ model: "m", stream: true, messages: [{ role: "user", content: "hi" }] });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (!text.includes("content_block_delta")) {
      const read = await Promise.race([
        reader.read(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("proxy buffered the text until upstream completion")), 50)),
      ]);
      text += decoder.decode(read.value, { stream: true });
    }
  } finally {
    releaseUpstream();
    await reader.cancel();
  }

  assert.ok(text.includes("content_block_delta"));
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

test("keeps end_turn for a fragmented streaming plain-text response", async () => {
  upstreamChunks = [
    { id: "chatcmpl-text", object: "chat.completion.chunk", model: "deepseek-v4-flash:0731", choices: [{ index: 0, delta: { content: "This response is ordinary" }, finish_reason: null }] },
    { id: "chatcmpl-text", object: "chat.completion.chunk", model: "deepseek-v4-flash:0731", choices: [{ index: 0, delta: { content: " text." }, finish_reason: "stop" }] },
  ];

  const res = await messages({ model: "m", stream: true, messages: [{ role: "user", content: "hi" }] });
  const events = (await res.text())
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice(5)));

  assert.equal(events.find((event) => event.type === "message_delta")?.delta.stop_reason, "end_turn");
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

test("reports tool_use when non-streaming DSML ends with an ordinary stop", async () => {
  upstreamMessage = {
    id: "chatcmpl-dsml",
    choices: [{
      index: 0,
      message: { role: "assistant", content: "<｜DSML｜invoke name=\"Bash\">\n<｜DSML｜parameter name=\"command\">pwd<｜DSML｜parameter>\n</｜DSML｜invoke>" },
      finish_reason: "stop",
    }],
    usage: { prompt_tokens: 4242, completion_tokens: 17, total_tokens: 4259 },
  };

  const res = await messages({
    model: "m",
    stream: false,
    tools: [{ name: "Bash", description: "Run a command", input_schema: { type: "object", properties: {} } }],
    messages: [{ role: "user", content: "find it" }],
  });
  const body = await res.json();

  assert.equal(body.content[0]?.type, "tool_use");
  assert.equal(body.stop_reason, "tool_use");
});

test("reports usage on the non-streaming path too", async () => {
  const res = await messages({ model: "m", stream: false, messages: [{ role: "user", content: "hi" }] });
  const body = await res.json();
  assert.equal(body.usage.input_tokens, 4242);
  assert.equal(body.usage.output_tokens, 17);
});

test("reports tool_use when non-streaming native tool calls end with an ordinary stop", async () => {
  upstreamMessage = {
    id: "chatcmpl-native",
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_bash", type: "function", function: { name: "Bash", arguments: "{}" } }],
      },
      finish_reason: "stop",
    }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };

  const res = await messages({
    model: "m",
    stream: false,
    tools: [{ name: "Bash", description: "Run a command", input_schema: { type: "object", properties: {} } }],
    messages: [{ role: "user", content: "find it" }],
  });

  assert.equal((await res.json()).stop_reason, "tool_use");
});

test("generates a tool-use id for non-streaming native tool calls without one", async () => {
  upstreamMessage = {
    id: "chatcmpl-native",
    choices: [{
      index: 0,
      message: { role: "assistant", tool_calls: [{ type: "function", function: { name: "Bash", arguments: "{}" } }] },
      finish_reason: "tool_calls",
    }],
    usage: { prompt_tokens: 4242, completion_tokens: 17, total_tokens: 4259 },
  };

  const res = await messages({
    model: "m",
    stream: false,
    tools: [{ name: "Bash", description: "Run a command", input_schema: { type: "object", properties: {} } }],
    messages: [{ role: "user", content: "find it" }],
  });
  const body = await res.json();

  assert.match(body.content[0]?.id, /^toolu_native_/);
});

test("does not ask for usage when not streaming", async () => {
  await (await messages({ model: "m", stream: false, messages: [{ role: "user", content: "hi" }] })).json();
  assert.equal(upstreamRequests.at(-1).stream_options, undefined);
});

test("translates DSML with a slashed parameter terminator", async () => {
  upstreamChunks = [
    { id: "chatcmpl-dsml", object: "chat.completion.chunk", model: "deepseek-v4-flash:0731", choices: [{ index: 0, delta: { content: "<｜DSML｜invoke name=\"Bash\">\n<｜DSML｜parameter name=\"command\">pwd</｜DSML｜parameter>\n</｜DSML｜invoke>" }, finish_reason: "tool_calls" }] },
  ];

  const res = await messages({
    model: "m",
    stream: true,
    tools: [{ name: "Bash", description: "Run a command", input_schema: { type: "object", properties: {} } }],
    messages: [{ role: "user", content: "find it" }],
  });
  const events = (await res.text())
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice(5)));

  assert.equal(events.find((event) => event.type === "content_block_start" && event.content_block.type === "tool_use")?.content_block.name, "Bash");
});

test("translates a fragmented DSML invocation into a tool-use block", async () => {
  upstreamChunks = [
    { id: "chatcmpl-dsml", object: "chat.completion.chunk", model: "deepseek-v4-flash:0731", choices: [{ index: 0, delta: { content: "<｜DSML｜invoke name=\"Bash\">\n<｜DSML｜parameter name=\"description\">Find the ferry project" }, finish_reason: null }] },
    { id: "chatcmpl-dsml", object: "chat.completion.chunk", model: "deepseek-v4-flash:0731", choices: [{ index: 0, delta: { content: " location<｜DSML｜parameter>\n<｜DSML｜parameter name=\"command\">pwd<｜DSML｜parameter>\n</｜DSML｜invoke>" }, finish_reason: null }] },
    { id: "chatcmpl-dsml", object: "chat.completion.chunk", model: "deepseek-v4-flash:0731", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  ];

  const res = await messages({
    model: "m",
    stream: true,
    tools: [{ name: "Bash", description: "Run a command", input_schema: { type: "object", properties: {} } }],
    messages: [{ role: "user", content: "find it" }],
  });
  const events = (await res.text())
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice(5)));

  assert.ok(!events.some((event) => event.delta?.text?.includes("<｜DSML｜>")), "DSML must not leak into a text delta");
  const start = events.find((event) => event.type === "content_block_start" && event.content_block.type === "tool_use");
  assert.equal(start?.content_block.name, "Bash");
  const input = events.find((event) => event.type === "content_block_delta" && event.delta.type === "input_json_delta");
  assert.deepEqual(JSON.parse(input?.delta.partial_json), { description: "Find the ferry project location", command: "pwd" });
  const delta = events.find((event) => event.type === "message_delta");
  assert.equal(delta.delta.stop_reason, "tool_use");
});

test("keeps a native tool call intact when its id arrives after its index", async () => {
  upstreamChunks = [
    { id: "chatcmpl-native", object: "chat.completion.chunk", model: "deepseek-v4-flash:0731", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, type: "function", function: { name: "Bash", arguments: "{\"command\":\"" } }] }, finish_reason: null }] },
    { id: "chatcmpl-native", object: "chat.completion.chunk", model: "deepseek-v4-flash:0731", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_bash", function: { arguments: "pwd\"}" } }] }, finish_reason: "tool_calls" }] },
  ];

  const res = await messages({
    model: "m",
    stream: true,
    tools: [{ name: "Bash", description: "Run a command", input_schema: { type: "object", properties: {} } }],
    messages: [{ role: "user", content: "find it" }],
  });
  const events = (await res.text())
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice(5)));

  const starts = events.filter((event) => event.type === "content_block_start" && event.content_block.type === "tool_use");
  assert.equal(starts.length, 1);
  const input = events.find((event) => event.delta?.type === "input_json_delta");
  assert.equal(input?.delta.partial_json, "{\"command\":\"pwd\"}");
});

test("does not truncate native tool arguments around a DSML invocation", async () => {
  upstreamChunks = [
    { id: "chatcmpl-mixed", object: "chat.completion.chunk", model: "deepseek-v4-flash:0731", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_read", type: "function", function: { name: "Read", arguments: "{\"file_path\":\"/etc/" } }] }, finish_reason: null }] },
    { id: "chatcmpl-mixed", object: "chat.completion.chunk", model: "deepseek-v4-flash:0731", choices: [{ index: 0, delta: { content: "<｜DSML｜invoke name=\"Bash\">\n<｜DSML｜parameter name=\"command\">pwd<｜DSML｜parameter>\n</｜DSML｜invoke>" }, finish_reason: null }] },
    { id: "chatcmpl-mixed", object: "chat.completion.chunk", model: "deepseek-v4-flash:0731", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_read", function: { arguments: "passwd\"}" } }] }, finish_reason: "tool_calls" }] },
  ];

  const res = await messages({
    model: "m",
    stream: true,
    tools: [
      { name: "Bash", description: "Run a command", input_schema: { type: "object", properties: {} } },
      { name: "Read", description: "Read a file", input_schema: { type: "object", properties: {} } },
    ],
    messages: [{ role: "user", content: "find it" }],
  });
  const events = (await res.text())
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice(5)));

  const readStart = events.find((event) => event.type === "content_block_start" && event.content_block.name === "Read");
  const readInput = events
    .filter((event) => event.index === readStart?.index && event.delta?.type === "input_json_delta")
    .map((event) => event.delta.partial_json)
    .join("");
  assert.equal(readInput, "{\"file_path\":\"/etc/passwd\"}");
});

test("preserves native, text, and DSML event order while native arguments stream", async () => {
  upstreamChunks = [
    { id: "chatcmpl-mixed-order", object: "chat.completion.chunk", model: "deepseek-v4-flash:0731", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_read", type: "function", function: { name: "Read", arguments: "{\"file_path\":\"/etc/" } }] }, finish_reason: null }] },
    { id: "chatcmpl-mixed-order", object: "chat.completion.chunk", model: "deepseek-v4-flash:0731", choices: [{ index: 0, delta: { content: "Checking it first. " }, finish_reason: null }] },
    { id: "chatcmpl-mixed-order", object: "chat.completion.chunk", model: "deepseek-v4-flash:0731", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_read", function: { arguments: "passwd\"}" } }] }, finish_reason: null }] },
    { id: "chatcmpl-mixed-order", object: "chat.completion.chunk", model: "deepseek-v4-flash:0731", choices: [{ index: 0, delta: { content: "<｜DSML｜invoke name=\"Bash\">\n<｜DSML｜parameter name=\"command\">pwd<｜DSML｜parameter>\n</｜DSML｜invoke>Then run it." }, finish_reason: "tool_calls" }] },
  ];

  const res = await messages({
    model: "m",
    stream: true,
    tools: [
      { name: "Bash", description: "Run a command", input_schema: { type: "object", properties: {} } },
      { name: "Read", description: "Read a file", input_schema: { type: "object", properties: {} } },
    ],
    messages: [{ role: "user", content: "find it" }],
  });
  const events = (await res.text())
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice(5)));
  const starts = events.filter((event) => event.type === "content_block_start");

  assert.deepEqual(
    starts.map((event) => [event.index, event.content_block.type, event.content_block.name || ""]),
    [[0, "tool_use", "Read"], [1, "text", ""], [2, "tool_use", "Bash"], [3, "text", ""]],
  );
  const readStart = starts[0];
  const readInput = events
    .filter((event) => event.index === readStart.index && event.delta?.type === "input_json_delta")
    .map((event) => event.delta.partial_json)
    .join("");
  assert.equal(readInput, "{\"file_path\":\"/etc/passwd\"}");
  assert.deepEqual(
    events.filter((event) => event.delta?.type === "text_delta").map((event) => event.delta.text),
    ["Checking it first. ", "Then run it."],
  );
});

test("reports tool_use when DSML text ends with an ordinary stop", async () => {
  upstreamChunks = [
    { id: "chatcmpl-dsml", object: "chat.completion.chunk", model: "deepseek-v4-flash:0731", choices: [{ index: 0, delta: { content: "<｜DSML｜invoke name=\"Bash\">\n<｜DSML｜parameter name=\"command\">pwd<｜DSML｜parameter>\n</｜DSML｜invoke>" }, finish_reason: "stop" }] },
  ];

  const res = await messages({
    model: "m",
    stream: true,
    tools: [{ name: "Bash", description: "Run a command", input_schema: { type: "object", properties: {} } }],
    messages: [{ role: "user", content: "find it" }],
  });
  const events = (await res.text())
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice(5)));

  assert.equal(events.find((event) => event.type === "message_delta")?.delta.stop_reason, "tool_use");
});

test("preserves max_tokens when a DSML invocation ends at the output limit", async () => {
  upstreamChunks = [
    { id: "chatcmpl-dsml", object: "chat.completion.chunk", model: "deepseek-v4-flash:0731", choices: [{ index: 0, delta: { content: "<｜DSML｜invoke name=\"Bash\">\n<｜DSML｜parameter name=\"command\">pwd<｜DSML｜parameter>\n</｜DSML｜invoke>" }, finish_reason: "length" }] },
  ];

  const res = await messages({
    model: "m",
    stream: true,
    tools: [{ name: "Bash", description: "Run a command", input_schema: { type: "object", properties: {} } }],
    messages: [{ role: "user", content: "find it" }],
  });
  const events = (await res.text())
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice(5)));

  assert.equal(events.find((event) => event.type === "message_delta")?.delta.stop_reason, "max_tokens");
});

test("preserves DSML and native tool-call order", async () => {
  upstreamChunks = [
    { id: "chatcmpl-mixed", object: "chat.completion.chunk", model: "deepseek-v4-flash:0731", choices: [{ index: 0, delta: { content: "<｜DSML｜invoke name=\"Bash\">\n<｜DSML｜parameter name=\"command\">pwd<｜DSML｜parameter>\n</｜DSML｜invoke>" }, finish_reason: null }] },
    { id: "chatcmpl-mixed", object: "chat.completion.chunk", model: "deepseek-v4-flash:0731", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_read", type: "function", function: { name: "Read", arguments: "{\"file_path\":\"a.txt\"}" } }] }, finish_reason: "tool_calls" }] },
  ];

  const res = await messages({
    model: "m",
    stream: true,
    tools: [
      { name: "Bash", description: "Run a command", input_schema: { type: "object", properties: {} } },
      { name: "Read", description: "Read a file", input_schema: { type: "object", properties: {} } },
    ],
    messages: [{ role: "user", content: "find it" }],
  });
  const events = (await res.text())
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice(5)));

  const starts = events.filter((event) => event.type === "content_block_start" && event.content_block.type === "tool_use");
  assert.deepEqual(starts.map((event) => event.content_block.name), ["Bash", "Read"]);
});

test("keeps content block indices monotonic when a DSML tool call precedes text", async () => {
  upstreamChunks = [
    { id: "chatcmpl-dsml", object: "chat.completion.chunk", model: "deepseek-v4-flash:0731", choices: [{ index: 0, delta: { content: "<｜DSML｜invoke name=\"Bash\">\n<｜DSML｜parameter name=\"command\">pwd<｜DSML｜parameter>\n</｜DSML｜invoke>" }, finish_reason: null }] },
    { id: "chatcmpl-dsml", object: "chat.completion.chunk", model: "deepseek-v4-flash:0731", choices: [{ index: 0, delta: { content: "\nI found it." }, finish_reason: null }] },
    { id: "chatcmpl-dsml", object: "chat.completion.chunk", model: "deepseek-v4-flash:0731", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  ];

  const res = await messages({
    model: "m",
    stream: true,
    tools: [{ name: "Bash", description: "Run a command", input_schema: { type: "object", properties: {} } }],
    messages: [{ role: "user", content: "find it" }],
  });
  const events = (await res.text())
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice(5)));
  const starts = events.filter((event) => event.type === "content_block_start");

  assert.deepEqual(starts.map((event) => [event.index, event.content_block.type]), [[0, "tool_use"], [1, "text"]]);
  assert.equal(events.find((event) => event.delta?.type === "text_delta")?.delta.text, "\nI found it.");
});

test("preserves native-tool order while buffering its interleaved arguments", async () => {
  upstreamChunks = [
    { id: "chatcmpl-native", object: "chat.completion.chunk", model: "deepseek-v4-flash:0731", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_native", type: "function", function: { name: "Bash", arguments: "{\"command\":\"" } }] }, finish_reason: null }] },
    { id: "chatcmpl-native", object: "chat.completion.chunk", model: "deepseek-v4-flash:0731", choices: [{ index: 0, delta: { content: "Running the command." }, finish_reason: null }] },
    { id: "chatcmpl-native", object: "chat.completion.chunk", model: "deepseek-v4-flash:0731", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "pwd\"}" } }] }, finish_reason: "tool_calls" }] },
  ];

  const res = await messages({
    model: "m",
    stream: true,
    tools: [{ name: "Bash", description: "Run a command", input_schema: { type: "object", properties: {} } }],
    messages: [{ role: "user", content: "find it" }],
  });
  const events = (await res.text())
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice(5)));

  const starts = events.filter((event) => event.type === "content_block_start");
  assert.deepEqual(starts.map((event) => [event.index, event.content_block.type]), [[0, "tool_use"], [1, "text"]]);
  const toolStart = events.findIndex((event) => event.type === "content_block_start" && event.content_block.type === "tool_use");
  const toolStop = events.findIndex((event) => event.type === "content_block_stop" && event.index === 0);
  const toolDeltas = events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event.index === 0 && event.delta?.type === "input_json_delta");
  assert.ok(toolDeltas.every(({ index }) => index > toolStart && index < toolStop));
  assert.equal(toolDeltas.map(({ event }) => event.delta.partial_json).join(""), "{\"command\":\"pwd\"}");
});

test("keeps native tool calls with the same index separate by id", async () => {
  upstreamChunks = [
    { id: "chatcmpl-native", object: "chat.completion.chunk", model: "deepseek-v4-flash:0731", choices: [{ index: 0, delta: { tool_calls: [
      { index: 0, id: "call_bash", type: "function", function: { name: "Bash", arguments: "{\"command\":\"pwd\"}" } },
      { index: 0, id: "call_read", type: "function", function: { name: "Read", arguments: "{\"file_path\":\"a.txt\"}" } },
    ] }, finish_reason: "tool_calls" }] },
  ];

  const res = await messages({
    model: "m",
    stream: true,
    tools: [
      { name: "Bash", description: "Run a command", input_schema: { type: "object", properties: {} } },
      { name: "Read", description: "Read a file", input_schema: { type: "object", properties: {} } },
    ],
    messages: [{ role: "user", content: "find it" }],
  });
  const events = (await res.text())
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice(5)));

  const starts = events.filter((event) => event.type === "content_block_start" && event.content_block.type === "tool_use");
  assert.deepEqual(starts.map((event) => event.content_block.name), ["Bash", "Read"]);
});

test("continues a native tool call by id when later chunks omit its index", async () => {
  upstreamChunks = [
    { id: "chatcmpl-native", object: "chat.completion.chunk", model: "deepseek-v4-flash:0731", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_native", type: "function", function: { name: "Bash", arguments: "{\"command\":\"" } }] }, finish_reason: null }] },
    { id: "chatcmpl-native", object: "chat.completion.chunk", model: "deepseek-v4-flash:0731", choices: [{ index: 0, delta: { tool_calls: [{ id: "call_native", function: { arguments: "pwd\"}" } }] }, finish_reason: "tool_calls" }] },
  ];

  const res = await messages({
    model: "m",
    stream: true,
    tools: [{ name: "Bash", description: "Run a command", input_schema: { type: "object", properties: {} } }],
    messages: [{ role: "user", content: "find it" }],
  });
  const events = (await res.text())
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice(5)));

  const starts = events.filter((event) => event.type === "content_block_start" && event.content_block.type === "tool_use");
  assert.equal(starts.length, 1);
  const input = events.find((event) => event.delta?.type === "input_json_delta");
  assert.equal(input?.delta.partial_json, "{\"command\":\"pwd\"}");
});

test("keeps distinct id-less native calls separate across frames", async () => {
  upstreamChunks = [
    { id: "chatcmpl-native", object: "chat.completion.chunk", model: "deepseek-v4-flash:0731", choices: [{ index: 0, delta: { tool_calls: [{ type: "function", function: { name: "Bash", arguments: "{\"command\":\"pwd\"}" } }] }, finish_reason: null }] },
    { id: "chatcmpl-native", object: "chat.completion.chunk", model: "deepseek-v4-flash:0731", choices: [{ index: 0, delta: { tool_calls: [{ type: "function", function: { name: "Read", arguments: "{\"file_path\":\"a.txt\"}" } }] }, finish_reason: "tool_calls" }] },
  ];

  const res = await messages({
    model: "m",
    stream: true,
    tools: [
      { name: "Bash", description: "Run a command", input_schema: { type: "object", properties: {} } },
      { name: "Read", description: "Read a file", input_schema: { type: "object", properties: {} } },
    ],
    messages: [{ role: "user", content: "find it" }],
  });
  const events = (await res.text())
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice(5)));

  const starts = events.filter((event) => event.type === "content_block_start" && event.content_block.type === "tool_use");
  assert.deepEqual(starts.map((event) => event.content_block.name), ["Bash", "Read"]);
});

test("keeps distinct native tool calls separate without indexes or ids", async () => {
  upstreamChunks = [
    { id: "chatcmpl-native", object: "chat.completion.chunk", model: "deepseek-v4-flash:0731", choices: [{ index: 0, delta: { tool_calls: [
      { type: "function", function: { name: "Bash", arguments: "{\"command\":\"pwd\"}" } },
      { type: "function", function: { name: "Read", arguments: "{\"file_path\":\"a.txt\"}" } },
    ] }, finish_reason: "tool_calls" }] },
  ];

  const res = await messages({
    model: "m",
    stream: true,
    tools: [
      { name: "Bash", description: "Run a command", input_schema: { type: "object", properties: {} } },
      { name: "Read", description: "Read a file", input_schema: { type: "object", properties: {} } },
    ],
    messages: [{ role: "user", content: "find it" }],
  });
  const events = (await res.text())
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice(5)));

  const starts = events.filter((event) => event.type === "content_block_start" && event.content_block.type === "tool_use");
  assert.deepEqual(starts.map((event) => event.content_block.name), ["Bash", "Read"]);
  assert.equal(new Set(starts.map((event) => event.content_block.id)).size, 2);
});

test("reports tool_use when native tool calls end with an ordinary stop", async () => {
  upstreamChunks = [
    { id: "chatcmpl-native", object: "chat.completion.chunk", model: "deepseek-v4-flash:0731", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_bash", type: "function", function: { name: "Bash", arguments: "{}" } }] }, finish_reason: "stop" }] },
  ];

  const res = await messages({
    model: "m",
    stream: true,
    tools: [{ name: "Bash", description: "Run a command", input_schema: { type: "object", properties: {} } }],
    messages: [{ role: "user", content: "find it" }],
  });
  const events = (await res.text())
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice(5)));

  assert.equal(events.find((event) => event.type === "message_delta")?.delta.stop_reason, "tool_use");
});

test("generates a tool-use id when native tool deltas omit it", async () => {
  upstreamChunks = [
    { id: "chatcmpl-native", object: "chat.completion.chunk", model: "deepseek-v4-flash:0731", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, type: "function", function: { name: "Bash", arguments: "{}" } }] }, finish_reason: "tool_calls" }] },
  ];

  const res = await messages({
    model: "m",
    stream: true,
    tools: [{ name: "Bash", description: "Run a command", input_schema: { type: "object", properties: {} } }],
    messages: [{ role: "user", content: "find it" }],
  });
  const events = (await res.text())
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice(5)));

  const start = events.find((event) => event.type === "content_block_start" && event.content_block.type === "tool_use");
  assert.match(start?.content_block.id, /^toolu_native_/);
});

test("preserves malformed DSML-looking text", async () => {
  upstreamChunks = [
    { id: "chatcmpl-dsml", object: "chat.completion.chunk", model: "deepseek-v4-flash:0731", choices: [{ index: 0, delta: { content: "<｜DSML｜invoke name=\"Bash\">unfinished" }, finish_reason: null }] },
    { id: "chatcmpl-dsml", object: "chat.completion.chunk", model: "deepseek-v4-flash:0731", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ];

  const res = await messages({
    model: "m",
    stream: true,
    tools: [{ name: "Bash", description: "Run a command", input_schema: { type: "object", properties: {} } }],
    messages: [{ role: "user", content: "find it" }],
  });
  const events = (await res.text())
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice(5)));

  assert.equal(events.filter((event) => event.type === "content_block_start" && event.content_block.type === "tool_use").length, 0);
  assert.equal(events.find((event) => event.delta?.type === "text_delta")?.delta.text, "<｜DSML｜invoke name=\"Bash\">unfinished");
});

test("preserves DSML with duplicate parameter names", async () => {
  upstreamChunks = [
    { id: "chatcmpl-dsml", object: "chat.completion.chunk", model: "deepseek-v4-flash:0731", choices: [{ index: 0, delta: { content: "<｜DSML｜invoke name=\"Bash\">\n<｜DSML｜parameter name=\"command\">pwd<｜DSML｜parameter>\n<｜DSML｜parameter name=\"command\">whoami<｜DSML｜parameter>\n</｜DSML｜invoke>" }, finish_reason: null }] },
    { id: "chatcmpl-dsml", object: "chat.completion.chunk", model: "deepseek-v4-flash:0731", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ];

  const res = await messages({
    model: "m",
    stream: true,
    tools: [{ name: "Bash", description: "Run a command", input_schema: { type: "object", properties: {} } }],
    messages: [{ role: "user", content: "find it" }],
  });
  const events = (await res.text())
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice(5)));

  assert.equal(events.filter((event) => event.type === "content_block_start" && event.content_block.type === "tool_use").length, 0);
  assert.match(events.find((event) => event.delta?.type === "text_delta")?.delta.text, /<｜DSML｜parameter name="command">whoami/);
});

test("translates DSML in non-streaming responses", async () => {
  upstreamMessage = {
    id: "chatcmpl-dsml",
    choices: [{
      index: 0,
      message: { role: "assistant", content: "<｜DSML｜invoke name=\"Bash\">\n<｜DSML｜parameter name=\"command\">pwd<｜DSML｜parameter>\n</｜DSML｜invoke>" },
      finish_reason: "tool_calls",
    }],
    usage: { prompt_tokens: 4242, completion_tokens: 17, total_tokens: 4259 },
  };

  const res = await messages({
    model: "m",
    stream: false,
    tools: [{ name: "Bash", description: "Run a command", input_schema: { type: "object", properties: {} } }],
    messages: [{ role: "user", content: "find it" }],
  });
  const body = await res.json();

  assert.deepEqual(body.content.map((block) => [block.type, block.name, block.input]), [["tool_use", "Bash", { command: "pwd" }]]);
  assert.equal(body.stop_reason, "tool_use");
});

test("does not translate a DSML invocation for an unoffered tool", async () => {
  upstreamChunks = [
    { id: "chatcmpl-dsml", object: "chat.completion.chunk", model: "deepseek-v4-flash:0731", choices: [{ index: 0, delta: { content: "<｜DSML｜invoke name=\"Bash\">\n<｜DSML｜parameter name=\"command\">pwd<｜DSML｜parameter>\n</｜DSML｜invoke>" }, finish_reason: null }] },
    { id: "chatcmpl-dsml", object: "chat.completion.chunk", model: "deepseek-v4-flash:0731", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ];

  const res = await messages({ model: "m", stream: true, tools: [{ name: "Read", description: "Read a file", input_schema: { type: "object", properties: {} } }], messages: [{ role: "user", content: "find it" }] });
  const events = (await res.text())
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice(5)));

  assert.equal(events.filter((event) => event.type === "content_block_start" && event.content_block.type === "tool_use").length, 0);
  assert.equal(events.find((event) => event.delta?.type === "text_delta")?.delta.text, "<｜DSML｜invoke name=\"Bash\">\n<｜DSML｜parameter name=\"command\">pwd<｜DSML｜parameter>\n</｜DSML｜invoke>");
});

test("accepts an IPv6 loopback PROXY_UPSTREAM", async () => {
  const child = spawn(process.execPath, [new URL("./proxy.mjs", import.meta.url).pathname], {
    env: { ...process.env, OLLAMA_CLOUD_API_KEY: "test-key", PROXY_UPSTREAM: "http://[::1]:8080/v1", PROXY_PORT: "0" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const [startup] = await once(child.stderr, "data");
  assert.match(String(startup), /listening on http:\/\/127\.0\.0\.1:/);
  child.kill();
  await once(child, "exit");
});

test("refuses a non-loopback PROXY_UPSTREAM instead of leaking the key to it", async () => {
  const child = spawn(process.execPath, [new URL("./proxy.mjs", import.meta.url).pathname], {
    env: { ...process.env, OLLAMA_CLOUD_API_KEY: "test-key", PROXY_UPSTREAM: "https://evil.example/v1", PROXY_PORT: "0" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d; });
  const [code] = await once(child, "exit");
  assert.equal(code, 1);
  assert.match(stderr, /must point at loopback/);
});
