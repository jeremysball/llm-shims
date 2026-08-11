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

// Frames copied from a real ollama.com /api/chat NDJSON stream: content,
// then a terminal done:true frame carrying the token usage.
const UPSTREAM_CHUNKS = [
  { model: "deepseek-v4-flash:0731", message: { role: "assistant", content: "hi" }, done: false },
  { model: "deepseek-v4-flash:0731", message: { role: "assistant", content: "" }, done: true, done_reason: "stop", prompt_eval_count: 4242, eval_count: 17 },
];

let upstreamChunks = UPSTREAM_CHUNKS;
let upstreamChunkDelayMs = 0;
let upstreamHoldAfterFirstChunk = null;
let upstreamMessage = {
  model: "deepseek-v4-flash:0731",
  message: { role: "assistant", content: "hi" },
  done: true,
  done_reason: "stop",
  prompt_eval_count: 4242,
  eval_count: 17,
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
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      for (const [index, chunk] of upstreamChunks.entries()) {
        res.write(`${JSON.stringify(chunk)}\n`);
        if (index === 0 && upstreamHoldAfterFirstChunk) await upstreamHoldAfterFirstChunk;
        if (upstreamChunkDelayMs) await new Promise((resolve) => setTimeout(resolve, upstreamChunkDelayMs));
      }
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
      PROXY_UPSTREAM: `http://127.0.0.1:${upstreamPort}/api/chat`,
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
    model: "deepseek-v4-flash:0731",
    message: { role: "assistant", content: "hi" },
    done: true,
    done_reason: "stop",
    prompt_eval_count: 4242,
    eval_count: 17,
  };
});

async function messages(body) {
  return fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("passes thinking through by default so the model emits message.thinking", async () => {
  await (await messages({ model: "m", stream: true, messages: [{ role: "user", content: "hi" }] })).text();
  assert.equal(upstreamRequests.at(-1).think, true);
});

test("streams and forwards usage from the done frame on message_delta", async () => {
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

test("keeps end_turn for a fragmented streaming plain-text response", async () => {
  upstreamChunks = [
    { model: "deepseek-v4-flash:0731", message: { role: "assistant", content: "This response is ordinary" }, done: false },
    { model: "deepseek-v4-flash:0731", message: { role: "assistant", content: " text." }, done: true, done_reason: "stop", prompt_eval_count: 3, eval_count: 2 },
  ];

  const res = await messages({ model: "m", stream: true, messages: [{ role: "user", content: "hi" }] });
  const events = (await res.text())
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice(5)));

  assert.equal(events.find((event) => event.type === "message_delta")?.delta.stop_reason, "end_turn");
});

test("reports usage on the non-streaming path too", async () => {
  const res = await messages({ model: "m", stream: false, messages: [{ role: "user", content: "hi" }] });
  const body = await res.json();
  assert.equal(body.usage.input_tokens, 4242);
  assert.equal(body.usage.output_tokens, 17);
});

test("reports tool_use when non-streaming native tool calls end with an ordinary stop", async () => {
  upstreamMessage = {
    model: "deepseek-v4-flash:0731",
    message: {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "call_bash", function: { index: 0, name: "Bash", arguments: {} } }],
    },
    done: true,
    done_reason: "stop",
    prompt_eval_count: 1,
    eval_count: 1,
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
    model: "deepseek-v4-flash:0731",
    message: { role: "assistant", tool_calls: [{ function: { index: 0, name: "Bash", arguments: {} } }] },
    done: true,
    done_reason: "tool_calls",
    prompt_eval_count: 4242,
    eval_count: 17,
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

// Reproduces a live 400 from Ollama Cloud: "Value looks like object, but
// can't find closing '}' symbol". Native /api/chat rejects a prior turn's
// tool_calls[].function.arguments when it arrives as a JSON-encoded string
// instead of a real object -- confirmed by replaying a captured request
// directly against ollama.com on 2026-08-10.
test("sends a prior tool_use turn's arguments upstream as an object, not a JSON string", async () => {
  await messages({
    model: "m",
    stream: true,
    tools: [{ name: "Bash", description: "Run a command", input_schema: { type: "object", properties: {} } }],
    messages: [
      { role: "user", content: "find it" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call_bash", name: "Bash", input: { command: "pwd" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call_bash", content: "/tmp" }],
      },
      { role: "user", content: "now what" },
    ],
  });

  const sent = upstreamRequests.at(-1).messages.find((m) => m.role === "assistant" && m.tool_calls);
  assert.deepEqual(sent.tool_calls[0].function.arguments, { command: "pwd" });
});

test("translates DSML with a slashed parameter terminator", async () => {
  upstreamChunks = [
    { model: "deepseek-v4-flash:0731", message: { role: "assistant", content: "<｜DSML｜invoke name=\"Bash\">\n<｜DSML｜parameter name=\"command\">pwd</｜DSML｜parameter>\n</｜DSML｜invoke>" }, done: false },
    { model: "deepseek-v4-flash:0731", message: { role: "assistant", content: "" }, done: true, done_reason: "tool_calls", prompt_eval_count: 3, eval_count: 2 },
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
    { model: "deepseek-v4-flash:0731", message: { role: "assistant", content: "<｜DSML｜invoke name=\"Bash\">\n<｜DSML｜parameter name=\"description\">Find the ferry project" }, done: false },
    { model: "deepseek-v4-flash:0731", message: { role: "assistant", content: " location<｜DSML｜parameter>\n<｜DSML｜parameter name=\"command\">pwd<｜DSML｜parameter>\n</｜DSML｜invoke>" }, done: false },
    { model: "deepseek-v4-flash:0731", message: { role: "assistant", content: "" }, done: true, done_reason: "tool_calls", prompt_eval_count: 3, eval_count: 2 },
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

  assert.ok(!events.some((event) => event.delta?.text?.includes("<｜DSML｜invoke>")), "DSML must not leak into a text delta");
  const start = events.find((event) => event.type === "content_block_start" && event.content_block.type === "tool_use");
  assert.equal(start?.content_block.name, "Bash");
  const input = events.find((event) => event.type === "content_block_delta" && event.delta.type === "input_json_delta");
  assert.deepEqual(JSON.parse(input?.delta.partial_json), { description: "Find the ferry project location", command: "pwd" });
  const delta = events.find((event) => event.type === "message_delta");
  assert.equal(delta.delta.stop_reason, "tool_use");
});

test("keeps a native tool call intact when its id arrives after its index", async () => {
  upstreamChunks = [
    { model: "deepseek-v4-flash:0731", message: { role: "assistant", content: "", tool_calls: [{ function: { index: 0, name: "Bash", arguments: { command: "pwd" } } }] }, done: false },
    { model: "deepseek-v4-flash:0731", message: { role: "assistant", content: "" }, done: true, done_reason: "tool_calls", prompt_eval_count: 3, eval_count: 2 },
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
    { model: "deepseek-v4-flash:0731", message: { role: "assistant", content: "", tool_calls: [{ id: "call_read", function: { index: 0, name: "Read", arguments: { file_path: "/etc/passwd" } } }] }, done: false },
    { model: "deepseek-v4-flash:0731", message: { role: "assistant", content: "<｜DSML｜invoke name=\"Bash\">\n<｜DSML｜parameter name=\"command\">pwd<｜DSML｜parameter>\n</｜DSML｜invoke>" }, done: false },
    { model: "deepseek-v4-flash:0731", message: { role: "assistant", content: "" }, done: true, done_reason: "tool_calls", prompt_eval_count: 3, eval_count: 2 },
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
    { model: "deepseek-v4-flash:0731", message: { role: "assistant", content: "", tool_calls: [{ id: "call_read", function: { index: 0, name: "Read", arguments: { file_path: "/etc/passwd" } } }] }, done: false },
    { model: "deepseek-v4-flash:0731", message: { role: "assistant", content: "Checking it first. " }, done: false },
    { model: "deepseek-v4-flash:0731", message: { role: "assistant", content: "<｜DSML｜invoke name=\"Bash\">\n<｜DSML｜parameter name=\"command\">pwd<｜DSML｜parameter>\n</｜DSML｜invoke>Then run it." }, done: true, done_reason: "tool_calls", prompt_eval_count: 3, eval_count: 2 },
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
    { model: "deepseek-v4-flash:0731", message: { role: "assistant", content: "<｜DSML｜invoke name=\"Bash\">\n<｜DSML｜parameter name=\"command\">pwd<｜DSML｜parameter>\n</｜DSML｜invoke>" }, done: true, done_reason: "stop", prompt_eval_count: 3, eval_count: 2 },
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
    { model: "deepseek-v4-flash:0731", message: { role: "assistant", content: "<｜DSML｜invoke name=\"Bash\">\n<｜DSML｜parameter name=\"command\">pwd<｜DSML｜parameter>\n</｜DSML｜invoke>" }, done: true, done_reason: "length", prompt_eval_count: 3, eval_count: 2 },
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
    { model: "deepseek-v4-flash:0731", message: { role: "assistant", content: "<｜DSML｜invoke name=\"Bash\">\n<｜DSML｜parameter name=\"command\">pwd<｜DSML｜parameter>\n</｜DSML｜invoke>" }, done: false },
    { model: "deepseek-v4-flash:0731", message: { role: "assistant", content: "", tool_calls: [{ id: "call_read", function: { index: 0, name: "Read", arguments: { file_path: "a.txt" } } }] }, done: true, done_reason: "tool_calls", prompt_eval_count: 3, eval_count: 2 },
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
    { model: "deepseek-v4-flash:0731", message: { role: "assistant", content: "<｜DSML｜invoke name=\"Bash\">\n<｜DSML｜parameter name=\"command\">pwd<｜DSML｜parameter>\n</｜DSML｜invoke>" }, done: false },
    { model: "deepseek-v4-flash:0731", message: { role: "assistant", content: "\nI found it." }, done: true, done_reason: "tool_calls", prompt_eval_count: 3, eval_count: 2 },
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
    { model: "deepseek-v4-flash:0731", message: { role: "assistant", content: "", tool_calls: [{ id: "call_native", function: { index: 0, name: "Bash", arguments: { command: "pwd" } } }] }, done: false },
    { model: "deepseek-v4-flash:0731", message: { role: "assistant", content: "Running the command." }, done: true, done_reason: "tool_calls", prompt_eval_count: 3, eval_count: 2 },
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
    { model: "deepseek-v4-flash:0731", message: { role: "assistant", content: "", tool_calls: [
      { id: "call_bash", function: { index: 0, name: "Bash", arguments: { command: "pwd" } } },
      { id: "call_read", function: { index: 0, name: "Read", arguments: { file_path: "a.txt" } } },
    ] }, done: true, done_reason: "tool_calls", prompt_eval_count: 3, eval_count: 2 },
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
    { model: "deepseek-v4-flash:0731", message: { role: "assistant", content: "", tool_calls: [{ id: "call_native", function: { index: 0, name: "Bash", arguments: { command: "pwd" } } }] }, done: false },
    { model: "deepseek-v4-flash:0731", message: { role: "assistant", content: "", tool_calls: [{ id: "call_native", function: { name: "Bash", arguments: { command: "ls" } } }] }, done: true, done_reason: "tool_calls", prompt_eval_count: 3, eval_count: 2 },
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
});

test("keeps distinct id-less native calls separate across frames", async () => {
  upstreamChunks = [
    { model: "deepseek-v4-flash:0731", message: { role: "assistant", content: "", tool_calls: [{ function: { index: 0, name: "Bash", arguments: { command: "pwd" } } }] }, done: false },
    { model: "deepseek-v4-flash:0731", message: { role: "assistant", content: "", tool_calls: [{ function: { index: 1, name: "Read", arguments: { file_path: "a.txt" } } }] }, done: true, done_reason: "tool_calls", prompt_eval_count: 3, eval_count: 2 },
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
    { model: "deepseek-v4-flash:0731", message: { role: "assistant", content: "", tool_calls: [
      { function: { name: "Bash", arguments: { command: "pwd" } } },
      { function: { name: "Read", arguments: { file_path: "a.txt" } } },
    ] }, done: true, done_reason: "tool_calls", prompt_eval_count: 3, eval_count: 2 },
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
    { model: "deepseek-v4-flash:0731", message: { role: "assistant", content: "", tool_calls: [{ id: "call_bash", function: { index: 0, name: "Bash", arguments: {} } }] }, done: true, done_reason: "stop", prompt_eval_count: 3, eval_count: 2 },
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
    { model: "deepseek-v4-flash:0731", message: { role: "assistant", content: "", tool_calls: [{ function: { index: 0, name: "Bash", arguments: {} } }] }, done: true, done_reason: "tool_calls", prompt_eval_count: 3, eval_count: 2 },
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
    { model: "deepseek-v4-flash:0731", message: { role: "assistant", content: "<｜DSML｜invoke name=\"Bash\">unfinished" }, done: true, done_reason: "stop", prompt_eval_count: 3, eval_count: 2 },
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
    { model: "deepseek-v4-flash:0731", message: { role: "assistant", content: "<｜DSML｜invoke name=\"Bash\">\n<｜DSML｜parameter name=\"command\">pwd<｜DSML｜parameter>\n<｜DSML｜parameter name=\"command\">whoami<｜DSML｜parameter>\n</｜DSML｜invoke>" }, done: true, done_reason: "stop", prompt_eval_count: 3, eval_count: 2 },
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
    model: "deepseek-v4-flash:0731",
    message: { role: "assistant", content: "<｜DSML｜invoke name=\"Bash\">\n<｜DSML｜parameter name=\"command\">pwd<｜DSML｜parameter>\n</｜DSML｜invoke>" },
    done: true,
    done_reason: "tool_calls",
    prompt_eval_count: 4242,
    eval_count: 17,
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

// Reads a streamed response into the parsed SSE payloads, in wire order.
async function streamEvents(body) {
  const res = await messages(body);
  return (await res.text())
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice(5)));
}

// Block lifecycle on the wire: every start is matched by a stop, and no block
// stays open while another one starts. This is the invariant that makes the
// stream reconstructible by index or by stop order — they must agree.
function assertBlocksAreSequential(events) {
  let open = null;
  const closed = [];
  for (const event of events) {
    if (event.type === "content_block_start") {
      assert.equal(open, null, `block ${event.index} started while block ${open} was still open`);
      open = event.index;
    } else if (event.type === "content_block_delta") {
      assert.equal(event.index, open, `delta for block ${event.index} outside its start/stop`);
    } else if (event.type === "content_block_stop") {
      assert.equal(event.index, open, `stop for block ${event.index} but block ${open} was open`);
      closed.push(event.index);
      open = null;
    }
  }
  assert.equal(open, null, `block ${open} was never closed`);
  assert.deepEqual(closed, [...closed].sort((a, b) => a - b), "blocks closed out of index order");
  return closed;
}

test("coalesces fragmented streaming message.thinking into one Anthropic thinking block", async () => {
  // Native streams thinking as incremental chunks across frames; all of them
  // must fold into a single block with one start/stop and one delta per chunk.
  upstreamChunks = [
    { model: "deepseek-v4-flash:0731", message: { role: "assistant", content: "", thinking: "Let" }, done: false },
    { model: "deepseek-v4-flash:0731", message: { role: "assistant", content: "", thinking: " me reason" }, done: false },
    { model: "deepseek-v4-flash:0731", message: { role: "assistant", content: "Result", thinking: " about this." }, done: true, done_reason: "stop", prompt_eval_count: 3, eval_count: 2 },
  ];

  const events = await streamEvents({ model: "m", stream: true, messages: [{ role: "user", content: "hi" }] });

  const thinkingStarts = events.filter((event) => event.type === "content_block_start" && event.content_block.type === "thinking");
  assert.equal(thinkingStarts.length, 1, "fragments must coalesce into a single thinking block");
  // Flat string fields, per the Anthropic thinking block — not a nested object.
  assert.deepEqual(thinkingStarts[0].content_block, { type: "thinking", thinking: "", signature: "" });
  const thinkingDeltas = events.filter((event) => event.delta?.type === "thinking_delta").map((event) => event.delta.thinking);
  assert.deepEqual(thinkingDeltas, ["Let", " me reason", " about this."]);
  assert.ok(!events.some((event) => event.delta?.text?.includes("Let")), "thinking must not leak into a text delta");
  assertBlocksAreSequential(events);
});

test("opens the streaming thinking block before the text block", async () => {
  // Anthropic puts thinking ahead of text, so a frame carrying both must not
  // let the text block claim the lower index.
  upstreamChunks = [
    { model: "deepseek-v4-flash:0731", message: { role: "assistant", content: "Result", thinking: "Let me reason." }, done: true, done_reason: "stop", prompt_eval_count: 3, eval_count: 2 },
  ];

  const events = await streamEvents({ model: "m", stream: true, messages: [{ role: "user", content: "hi" }] });

  const starts = events.filter((event) => event.type === "content_block_start");
  assert.deepEqual(starts.map((event) => event.content_block.type), ["thinking", "text"]);
  assert.ok(starts[0].index < starts[1].index, "thinking must take the lower block index");
  assertBlocksAreSequential(events);
});

test("closes the streaming thinking block before a native tool_use block opens", async () => {
  // Thinking rides the same defer queue as text, so a fragment arriving after a
  // tool call cannot leave its block open across the deferred tool_use block.
  upstreamChunks = [
    { model: "deepseek-v4-flash:0731", message: { role: "assistant", content: "", thinking: "Need the time." }, done: false },
    { model: "deepseek-v4-flash:0731", message: { role: "assistant", content: "Checking", tool_calls: [{ id: "call_1", function: { name: "Bash", index: 0, arguments: '{"command":"date"}' } }] }, done: false },
    { model: "deepseek-v4-flash:0731", message: { role: "assistant", content: "", thinking: " Still thinking." }, done: true, done_reason: "stop", prompt_eval_count: 3, eval_count: 2 },
  ];

  const events = await streamEvents({
    model: "m",
    stream: true,
    tools: [{ name: "Bash", input_schema: { type: "object" } }],
    messages: [{ role: "user", content: "hi" }],
  });

  const closed = assertBlocksAreSequential(events);
  assert.ok(closed.length >= 3, `expected thinking, text and tool_use blocks, got ${closed.length}`);
  assert.ok(
    events.some((event) => event.type === "content_block_start" && event.content_block.type === "tool_use"),
    "no tool_use block emitted",
  );
});

test("translates a non-streaming message.thinking into a leading thinking content block", async () => {
  upstreamMessage = {
    model: "deepseek-v4-flash:0731",
    message: { role: "assistant", content: "Result", thinking: "Let me reason about this." },
    done: true,
    done_reason: "stop",
    prompt_eval_count: 4242,
    eval_count: 17,
  };

  const res = await messages({ model: "m", stream: false, messages: [{ role: "user", content: "hi" }] });
  const body = await res.json();

  // Thinking first, and the same flat shape the streaming path emits.
  assert.deepEqual(body.content, [
    { type: "thinking", thinking: "Let me reason about this.", signature: "" },
    { type: "text", text: "Result" },
  ]);
});

test("forwards an echoed thinking block upstream as message.thinking", async () => {
  await (await messages({
    model: "m",
    stream: true,
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "thinking", thinking: "Prior reasoning.", signature: "sig" }, { type: "text", text: "Prior answer." }] },
      { role: "user", content: "and now?" },
    ],
  })).text();

  const sent = upstreamRequests.at(-1).messages;
  const assistant = sent.find((m) => m.role === "assistant");
  assert.equal(assistant.thinking, "Prior reasoning.");
  assert.equal(assistant.content, "Prior answer.");
});

test("does not translate a DSML invocation for an unoffered tool", async () => {
  upstreamChunks = [
    { model: "deepseek-v4-flash:0731", message: { role: "assistant", content: "<｜DSML｜invoke name=\"Bash\">\n<｜DSML｜parameter name=\"command\">pwd<｜DSML｜parameter>\n</｜DSML｜invoke>" }, done: true, done_reason: "stop", prompt_eval_count: 3, eval_count: 2 },
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
    env: { ...process.env, OLLAMA_CLOUD_API_KEY: "test-key", PROXY_UPSTREAM: "http://[::1]:8080/api/chat", PROXY_PORT: "0" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const [startup] = await once(child.stderr, "data");
  assert.match(String(startup), /listening on http:\/\/127\.0\.0\.1:/);
  child.kill();
  await once(child, "exit");
});

test("refuses a non-loopback PROXY_UPSTREAM instead of leaking the key to it", async () => {
  const child = spawn(process.execPath, [new URL("./proxy.mjs", import.meta.url).pathname], {
    env: { ...process.env, OLLAMA_CLOUD_API_KEY: "test-key", PROXY_UPSTREAM: "https://evil.example/api/chat", PROXY_PORT: "0" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d; });
  const [code] = await once(child, "exit");
  assert.equal(code, 1);
  assert.match(stderr, /must point at loopback/);
});

// Boots the real proxy with PROXY_THINK set to `value` and reads back the flag
// the proxy resolved from it. The env is parsed once at module load, so a
// subprocess is the only way to exercise it.
async function resolvedThinkFlag(value) {
  const env = { ...process.env, OLLAMA_CLOUD_API_KEY: "test-key", PROXY_PORT: "0" };
  delete env.PROXY_THINK;
  if (value !== undefined) env.PROXY_THINK = value;
  const child = spawn(process.execPath, [new URL("./proxy.mjs", import.meta.url).pathname], {
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  try {
    const [startup] = await once(child.stderr, "data");
    const port = String(startup).match(/127\.0\.0\.1:(\d+)/)[1];
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    return (await res.json()).think;
  } finally {
    child.kill();
    await once(child, "exit");
  }
}

test("reads every ordinary off spelling of PROXY_THINK as off", async () => {
  // An operator who writes PROXY_THINK=0 means off. Treating anything but the
  // literal string "false" as on would pass thinking through anyway.
  assert.equal(await resolvedThinkFlag(undefined), true, "default is on");
  assert.equal(await resolvedThinkFlag("false"), false);
  assert.equal(await resolvedThinkFlag("0"), false);
  assert.equal(await resolvedThinkFlag("OFF"), false);
});
