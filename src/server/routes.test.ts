import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import { startServer, stopServer } from "./index.js";
import { resetSessionIndexes } from "../subprocess/session-store.js";
import type { ServerConfig } from "./index.js";
import {
  createFixtureCli,
  initEvent,
  linesToChunks,
  messageStart,
  resultMessage,
  textBlockStart,
  textDelta,
  ERROR_EXIT,
  FENCED_JSON,
  FIXTURE_SESSION_ID,
  FIXTURE_MODEL,
  HAPPY_TEXT,
  MULTI_TEXT_BLOCKS,
  NO_PARTIAL_MESSAGES,
  RATE_LIMIT,
  RESUME_ECHO,
  SCHEMA_STREAM,
  SPLIT_JSON_LINE,
  THINKING_THEN_TEXT,
  blockStop,
  inputJsonDelta,
  toolUseBlockStart,
  type FixtureCli,
  type FixtureSpec,
} from "../testing/fixture-cli.js";

let fixture: FixtureCli;
let server: Server;
let baseUrl: string;
let sandbox: string;
let previousBin: string | undefined;
let previousConfig: string | undefined;

/** Everything the fixture needs to stand in for the real CLI. */
function testConfig(overrides: ServerConfig = {}): ServerConfig {
  return {
    port: 0,
    binArgs: fixture.binArgs,
    cwd: sandbox,
    sessionIndexPath: path.join(sandbox, "sessions.json"),
    ...overrides,
  };
}

async function startWith(overrides: ServerConfig = {}): Promise<void> {
  await stopServer();
  server = await startServer(testConfig(overrides));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function chat(
  body: unknown
): Promise<{ status: number; json: any; headers: Headers }> {
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null, headers: res.headers };
}

/** Bypasses JSON.stringify so the test can send a body the parser will reject. */
async function postRaw(
  body: string,
  contentType = "application/json"
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": contentType },
    body,
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

interface StreamResult {
  status: number;
  /** Payloads of `data:` lines, `[DONE]` excluded. */
  events: any[];
  sawDone: boolean;
  text: string;
}

async function chatStream(body: unknown): Promise<StreamResult> {
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...(body as object), stream: true }),
  });
  const raw = await res.text();
  const events: any[] = [];
  let sawDone = false;
  let text = "";

  for (const line of raw.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice("data: ".length).trim();
    if (payload === "[DONE]") {
      sawDone = true;
      continue;
    }
    const event = JSON.parse(payload);
    events.push(event);
    text += event.choices?.[0]?.delta?.content ?? "";
  }

  return { status: res.status, events, sawDone, text };
}

/** Fixture subprocesses still alive, identified by the generated script path. */
async function countFixtureProcesses(): Promise<number> {
  const { execFileSync } = await import("node:child_process");
  try {
    const out = execFileSync("ps", ["-Ao", "args"], { encoding: "utf8" });
    return out.split("\n").filter((line) => line.includes(fixture.binArgs[0])).length;
  } catch {
    return 0;
  }
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("chat completions over a fixture CLI", () => {
  before(async () => {
    fixture = await createFixtureCli();
    sandbox = await mkdtemp(path.join(tmpdir(), "claude-proxy-sandbox-"));

    // Keep the operator's real settings out of the test run.
    previousConfig = process.env.CLAUDE_PROXY_CONFIG;
    const emptyConfig = path.join(sandbox, "config.json");
    await writeFile(emptyConfig, "{}", "utf8");
    process.env.CLAUDE_PROXY_CONFIG = emptyConfig;

    previousBin = process.env.CLAUDE_BIN;
    process.env.CLAUDE_BIN = fixture.bin;

    await startWith();
  });

  after(async () => {
    await stopServer();
    if (previousBin === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = previousBin;
    if (previousConfig === undefined) delete process.env.CLAUDE_PROXY_CONFIG;
    else process.env.CLAUDE_PROXY_CONFIG = previousConfig;
    await fixture.cleanup();
    await rm(sandbox, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await fixture.use(HAPPY_TEXT);
  });

  it("rejects a request without messages", async () => {
    const { status, json } = await chat({ model: "claude-sonnet-4", messages: [] });
    assert.equal(status, 400);
    assert.equal(json.error.code, "invalid_messages");
  });

  it("rejects a truncated JSON body as a client error", async () => {
    const { status, json } = await postRaw('{"model":"sonnet","messages":[{"role":"user",');
    assert.equal(status, 400);
    assert.equal(json.error.type, "invalid_request_error");
    assert.equal(json.error.code, "invalid_json");
    assert.match(json.error.message, /position/);
  });

  it("rejects a JSON body that parses but is not a request object", async () => {
    const { status, json } = await postRaw("[]");
    assert.equal(status, 400);
    assert.equal(json.error.code, "invalid_messages");
  });

  it("rejects an empty body", async () => {
    const { status, json } = await postRaw("");
    assert.equal(status, 400);
    assert.equal(json.error.code, "invalid_messages");
  });

  it("rejects a body larger than the configured limit", async () => {
    // A 1kb limit keeps the test from pushing 11 MB through the loopback.
    await startWith({ bodyLimit: "1kb" });
    try {
      const content = "x".repeat(2000);
      const { status, json } = await postRaw(
        JSON.stringify({ model: "claude-sonnet-4", messages: [{ role: "user", content }] })
      );
      assert.equal(status, 413);
      assert.equal(json.error.type, "invalid_request_error");
    } finally {
      await startWith();
    }
  });

  it("answers a non-streaming request in OpenAI shape", async () => {
    const { status, json } = await chat({
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "hi" }],
    });

    assert.equal(status, 200);
    assert.equal(json.object, "chat.completion");
    assert.equal(json.choices[0].message.role, "assistant");
    assert.equal(json.choices[0].message.content, "Hello there");
    assert.equal(json.choices[0].finish_reason, "stop");
  });

  it("streams text deltas and terminates the stream", async () => {
    const { status, events, sawDone, text } = await chatStream({
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "hi" }],
    });

    assert.equal(status, 200);
    assert.equal(text, "Hello there");
    assert.ok(sawDone, "the stream must end with [DONE]");
    assert.ok(events.length > 1, "text should arrive as deltas, not one blob");
    assert.equal(
      events.filter((e) => e.choices?.[0]?.delta?.role).length,
      1,
      "exactly one chunk carries delta.role"
    );
    assert.equal(events.at(-1).choices[0].finish_reason, "stop");
  });

  it("does not double the text when the CLI also sends whole assistant messages", async () => {
    const { text } = await chatStream({
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(text, "Hello there", "deltas and the assistant echo must not both be forwarded");
  });

  it("separates consecutive text blocks", async () => {
    await fixture.use(MULTI_TEXT_BLOCKS);
    const { text } = await chatStream({
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(text, "First block\n\nSecond block");
  });

  it("reassembles a JSON line torn across stdout chunks", async () => {
    await fixture.use(SPLIT_JSON_LINE);
    const { json } = await chat({
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(json.choices[0].message.content.length, 60_000);
  });

  it("passes the prompt on stdin and the flags on argv", async () => {
    await fixture.use(RESUME_ECHO);
    await chat({
      model: "claude-opus-4",
      messages: [{ role: "user", content: "remember this" }],
    });

    const record = await fixture.record();
    assert.match(record.stdin, /remember this/);
    assert.ok(record.argv.includes("--print"));
    assert.equal(record.argv[record.argv.indexOf("--model") + 1], "opus");
    assert.equal(record.cwd, await realpath(sandbox));
  });

  it("reuses a Claude session for the same `user` and sends only the new turn", async () => {
    await fixture.use(RESUME_ECHO);
    const first = [{ role: "user", content: "first question" }];
    await chat({ model: "claude-sonnet-4", messages: first, user: "conversation-1" });

    const firstRecord = await fixture.record();
    const sessionIndex = firstRecord.argv.indexOf("--session-id");
    assert.ok(sessionIndex >= 0, "the first turn pins a session id");
    const sessionId = firstRecord.argv[sessionIndex + 1];

    await fixture.use(RESUME_ECHO);
    await chat({
      model: "claude-sonnet-4",
      messages: [...first, { role: "assistant", content: "an answer" }, { role: "user", content: "second question" }],
      user: "conversation-1",
    });

    const secondRecord = await fixture.record();
    // The id recorded is the one the CLI reported, not the one we proposed:
    // only that one can actually be resumed.
    assert.notEqual(sessionId, FIXTURE_SESSION_ID);
    assert.deepEqual(secondRecord.argv.slice(-2), ["--resume", FIXTURE_SESSION_ID]);
    assert.match(secondRecord.stdin, /second question/);
    assert.doesNotMatch(secondRecord.stdin, /first question/);
  });

  it("falls back to the whole result when no partial messages arrive", async () => {
    await fixture.use(NO_PARTIAL_MESSAGES);
    const { json } = await chat({
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(json.choices[0].message.content, "Whole answer at once");
  });
});

describe("streaming defects", () => {
  before(async () => {
    fixture = await createFixtureCli();
    sandbox = await mkdtemp(path.join(tmpdir(), "claude-proxy-stream-"));

    previousConfig = process.env.CLAUDE_PROXY_CONFIG;
    const emptyConfig = path.join(sandbox, "config.json");
    await writeFile(emptyConfig, "{}", "utf8");
    process.env.CLAUDE_PROXY_CONFIG = emptyConfig;

    previousBin = process.env.CLAUDE_BIN;
    process.env.CLAUDE_BIN = fixture.bin;

    await startWith();
  });

  after(async () => {
    await stopServer();
    if (previousBin === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = previousBin;
    if (previousConfig === undefined) delete process.env.CLAUDE_PROXY_CONFIG;
    else process.env.CLAUDE_PROXY_CONFIG = previousConfig;
    await fixture.cleanup();
    await rm(sandbox, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await fixture.use(HAPPY_TEXT);
  });

  const ask = { model: "claude-haiku-4-5", messages: [{ role: "user", content: "hi" }] };

  it("reports the model in every chunk, not a hardcoded guess", async () => {
    const { events } = await chatStream(ask);
    const models = new Set(events.map((e) => e.model));
    assert.deepEqual([...models], ["claude-haiku-4-5"]);
  });

  it("falls back to the CLI's model when the client asked for an unknown one", async () => {
    const { events } = await chatStream({ ...ask, model: "gpt-4o" });
    assert.deepEqual([...new Set(events.map((e) => e.model))], ["claude-haiku-4"]);
    assert.ok(FIXTURE_MODEL.includes("haiku"));
  });

  it("counts cache reads and writes as prompt tokens", async () => {
    await fixture.use({
      chunks: linesToChunks([
        initEvent(),
        messageStart(),
        textBlockStart(),
        textDelta("hi"),
        resultMessage({
          result: "hi",
          usage: {
            input_tokens: 96,
            output_tokens: 12,
            cache_creation_input_tokens: 230,
            cache_read_input_tokens: 21_750,
          },
        }),
      ]),
    });

    const { events } = await chatStream(ask);
    const usage = events.at(-1).usage;
    assert.equal(usage.prompt_tokens, 96 + 230 + 21_750);
    assert.equal(usage.completion_tokens, 12);
    assert.equal(usage.total_tokens, 96 + 230 + 21_750 + 12);
    assert.equal(usage.prompt_tokens_details.cached_tokens, 21_750);
  });

  it("maps finish_reason from the result instead of always saying stop", async () => {
    await fixture.use({
      chunks: linesToChunks([
        initEvent(),
        messageStart(),
        textBlockStart(),
        textDelta("truncated"),
        resultMessage({ result: "truncated", stop_reason: "max_tokens" }),
      ]),
    });

    const { events } = await chatStream(ask);
    assert.equal(events.at(-1).choices[0].finish_reason, "length");

    const { json } = await (async () => {
      await fixture.use({
        chunks: linesToChunks([
          initEvent(),
          resultMessage({ result: "truncated", stop_reason: "max_tokens" }),
        ]),
      });
      return chat(ask);
    })();
    assert.equal(json.choices[0].finish_reason, "length");
  });

  it("streams the result text when the CLI sent no partial messages", async () => {
    await fixture.use(NO_PARTIAL_MESSAGES);
    const { text, sawDone } = await chatStream(ask);
    assert.equal(text, "Whole answer at once");
    assert.ok(sawDone);
  });

  it("drops thinking by default and forwards it on request", async () => {
    await fixture.use(THINKING_THEN_TEXT);
    const quiet = await chatStream(ask);
    assert.equal(quiet.text, "Hi");
    assert.ok(quiet.events.every((e) => !e.choices?.[0]?.delta?.reasoning_content));

    await startWith({ streaming: { thinking: "reasoning_content" } });
    await fixture.use(THINKING_THEN_TEXT);
    const loud = await chatStream(ask);
    const reasoning = loud.events
      .map((e) => e.choices?.[0]?.delta?.reasoning_content ?? "")
      .join("");
    assert.equal(reasoning, "The user is asking for a greeting.");
    assert.equal(loud.text, "Hi");
    await startWith();
  });

  it("answers a rate limit rejection with 429 and Retry-After", async () => {
    await fixture.use(RATE_LIMIT);
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...ask, stream: true }),
    });
    assert.equal(res.status, 429);
    assert.ok(Number(res.headers.get("retry-after")) > 0);
    await res.text();
  });

  it("does not treat the ordinary allowed notice as a rate limit", async () => {
    const { status, text } = await chatStream(ask);
    assert.equal(status, 200);
    assert.equal(text, "Hello there");
  });

  it("reports a CLI that dies before any output as an HTTP error", async () => {
    await fixture.use(ERROR_EXIT);
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...ask, stream: true }),
    });
    assert.equal(res.status, 500);
    const body = await res.json() as any;
    assert.match(body.error.message, /exited with code 1/);
  });

  it("reports a missing CLI binary as an HTTP error, not a dead stream", async () => {
    process.env.CLAUDE_BIN = path.join(sandbox, "no-such-binary");
    try {
      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...ask, stream: true }),
      });
      assert.equal(res.status, 500);
      const body = await res.json() as any;
      assert.match(body.error.message, /Claude CLI not found/);
    } finally {
      process.env.CLAUDE_BIN = fixture.bin;
    }
  });

  it("terminates the stream with [DONE] even when the CLI crashes mid-answer", async () => {
    await fixture.use({
      chunks: linesToChunks([initEvent(), messageStart(), textBlockStart(), textDelta("half an ")]),
      exitCode: 1,
    });

    const { events, sawDone, text } = await chatStream(ask);
    assert.equal(text, "half an ");
    assert.ok(sawDone, "a crashed CLI must still close the stream");
    assert.ok(events.some((e) => e.error), "the error should be reported in-band");
  });

  it("answers once when the request times out", async () => {
    await startWith({ timeoutMs: 150 });
    await fixture.use({ chunks: linesToChunks([initEvent()]), hang: true });

    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(ask),
    });
    assert.equal(res.status, 504);
    const body = await res.json() as any;
    assert.match(body.error.message, /timed out/);
    await startWith();
  });

  it("stops the subprocess after the result instead of leaving it running", async () => {
    await startWith({ streaming: { resultGraceMs: 10 } });
    await fixture.use({
      chunks: linesToChunks([
        initEvent(),
        messageStart(),
        textBlockStart(),
        textDelta("done"),
        resultMessage({ result: "done" }),
      ]),
      hang: true,
    });

    const before = await countFixtureProcesses();
    await chatStream(ask);
    await waitFor(async () => (await countFixtureProcesses()) <= before, 5_000);
    assert.ok((await countFixtureProcesses()) <= before);
    await startWith();
  });
});

describe("response_format", () => {
  before(async () => {
    fixture = await createFixtureCli();
    sandbox = await mkdtemp(path.join(tmpdir(), "claude-proxy-format-"));

    previousConfig = process.env.CLAUDE_PROXY_CONFIG;
    const emptyConfig = path.join(sandbox, "config.json");
    await writeFile(emptyConfig, "{}", "utf8");
    process.env.CLAUDE_PROXY_CONFIG = emptyConfig;

    previousBin = process.env.CLAUDE_BIN;
    process.env.CLAUDE_BIN = fixture.bin;

    await startWith();
  });

  after(async () => {
    await stopServer();
    if (previousBin === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = previousBin;
    if (previousConfig === undefined) delete process.env.CLAUDE_PROXY_CONFIG;
    else process.env.CLAUDE_PROXY_CONFIG = previousConfig;
    await fixture.cleanup();
    await rm(sandbox, { recursive: true, force: true });
  });

  const schema = {
    type: "object",
    properties: { city: { type: "string" }, population: { type: "integer" } },
    required: ["city"],
    additionalProperties: false,
  };
  const withSchema = {
    model: "claude-haiku-4-5",
    messages: [{ role: "user", content: "capital of France?" }],
    response_format: { type: "json_schema", json_schema: { name: "city", strict: true, schema } },
  };

  it("passes the inner schema to --json-schema, unwrapped", async () => {
    await fixture.use(SCHEMA_STREAM);
    await chat(withSchema);

    const record = await fixture.record();
    const flag = record.argv.indexOf("--json-schema");
    assert.ok(flag >= 0, "expected --json-schema");
    assert.deepEqual(JSON.parse(record.argv[flag + 1]), schema);
  });

  it("returns structured_output rather than reparsing the result text", async () => {
    await fixture.use(SCHEMA_STREAM);
    const { json } = await chat(withSchema);
    assert.deepEqual(JSON.parse(json.choices[0].message.content), {
      city: "Paris",
      population: 2100000,
    });
  });

  it("survives a result with no structured_output", async () => {
    await fixture.use({
      chunks: linesToChunks([
        initEvent(),
        resultMessage({ result: '{"city":"Paris"}' }),
      ]),
    });
    const { status, json } = await chat(withSchema);
    assert.equal(status, 200);
    assert.equal(json.choices[0].message.content, '{"city":"Paris"}');
  });

  it("streams the JSON, not the prose that accompanies it", async () => {
    await fixture.use(SCHEMA_STREAM);
    const { text, sawDone } = await chatStream(withSchema);
    assert.deepEqual(JSON.parse(text), { city: "Paris", population: 2100000 });
    assert.ok(sawDone);
    assert.doesNotMatch(text, /capital of France/);
  });

  it("adds no schema flag and no instruction without response_format", async () => {
    await fixture.use(RESUME_ECHO);
    await chat({ model: "claude-haiku-4-5", messages: [{ role: "user", content: "hi" }] });

    const record = await fixture.record();
    assert.ok(!record.argv.includes("--json-schema"));
    assert.equal(record.argv[record.argv.indexOf("--system-prompt") + 1], "");
  });

  it("carries the json_object rule in the system prompt, not the turn text", async () => {
    await fixture.use(FENCED_JSON);
    await chat({
      model: "claude-haiku-4-5",
      messages: [
        { role: "system", content: "You are terse." },
        { role: "user", content: "capital of France?" },
      ],
      response_format: { type: "json_object" },
    });

    const record = await fixture.record();
    assert.ok(!record.argv.includes("--json-schema"));
    const system = record.argv[record.argv.indexOf("--system-prompt") + 1];
    assert.match(system, /You are terse\./);
    assert.match(system, /single JSON value/);
    assert.doesNotMatch(record.stdin, /single JSON value/);
  });

  it("strips a code fence the model added around a json_object answer", async () => {
    await fixture.use(FENCED_JSON);
    const body = {
      model: "claude-haiku-4-5",
      messages: [{ role: "user", content: "capital of France?" }],
      response_format: { type: "json_object" as const },
    };

    const { json } = await chat(body);
    assert.deepEqual(JSON.parse(json.choices[0].message.content), { city: "Paris" });

    await fixture.use(FENCED_JSON);
    const streamed = await chatStream(body);
    assert.deepEqual(JSON.parse(streamed.text), { city: "Paris" });
  });

  it("leaves prose alone when the fence does not wrap valid JSON", async () => {
    const notJson = "```json\nnot really json\n```";
    await fixture.use({
      chunks: linesToChunks([initEvent(), resultMessage({ result: notJson })]),
    });
    const { json } = await chat({
      model: "claude-haiku-4-5",
      messages: [{ role: "user", content: "hi" }],
      response_format: { type: "json_object" },
    });
    assert.equal(json.choices[0].message.content, notJson);
  });

  it("rejects a malformed json_schema with 400 instead of a silent plain answer", async () => {
    const { status, json } = await chat({
      model: "claude-haiku-4-5",
      messages: [{ role: "user", content: "hi" }],
      response_format: { type: "json_schema", json_schema: { name: "x" } },
    });
    assert.equal(status, 400);
    assert.equal(json.error.code, "invalid_response_format");
  });

  it("treats {\"type\":\"text\"} as the default", async () => {
    await fixture.use(HAPPY_TEXT);
    const { json } = await chat({
      model: "claude-haiku-4-5",
      messages: [{ role: "user", content: "hi" }],
      response_format: { type: "text" },
    });
    assert.equal(json.choices[0].message.content, "Hello there");
    const record = await fixture.record();
    assert.ok(!record.argv.includes("--json-schema"));
  });
});

describe("economy preset over HTTP", () => {
  before(async () => {
    fixture = await createFixtureCli();
    sandbox = await mkdtemp(path.join(tmpdir(), "claude-proxy-economy-"));

    previousConfig = process.env.CLAUDE_PROXY_CONFIG;
    const emptyConfig = path.join(sandbox, "config.json");
    await writeFile(emptyConfig, "{}", "utf8");
    process.env.CLAUDE_PROXY_CONFIG = emptyConfig;

    previousBin = process.env.CLAUDE_BIN;
    process.env.CLAUDE_BIN = fixture.bin;

    await startWith();
  });

  after(async () => {
    await stopServer();
    if (previousBin === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = previousBin;
    if (previousConfig === undefined) delete process.env.CLAUDE_PROXY_CONFIG;
    else process.env.CLAUDE_PROXY_CONFIG = previousConfig;
    await fixture.cleanup();
    await rm(sandbox, { recursive: true, force: true });
  });

  it("sends the client's system message as a flag, not as turn text", async () => {
    await fixture.use(RESUME_ECHO);
    await chat({
      model: "claude-haiku-4-5",
      messages: [
        { role: "system", content: "You are a pirate." },
        { role: "user", content: "hello" },
      ],
    });

    const record = await fixture.record();
    assert.equal(record.argv[record.argv.indexOf("--system-prompt") + 1], "You are a pirate.");
    assert.doesNotMatch(record.stdin, /pirate/);
    assert.doesNotMatch(record.stdin, /<system>/);
    assert.match(record.stdin, /hello/);
  });

  it("repeats the system prompt on resume, where the CLI inherits nothing", async () => {
    const system = { role: "system", content: "You are a pirate." };
    const first = [system, { role: "user", content: "first question" }];

    await fixture.use(RESUME_ECHO);
    await chat({ model: "claude-haiku-4-5", messages: first, user: "economy-1" });

    await fixture.use(RESUME_ECHO);
    await chat({
      model: "claude-haiku-4-5",
      messages: [...first, { role: "assistant", content: "arr" }, { role: "user", content: "second question" }],
      user: "economy-1",
    });

    const record = await fixture.record();
    assert.ok(record.argv.includes("--resume"));
    assert.equal(record.argv[record.argv.indexOf("--system-prompt") + 1], "You are a pirate.");
    assert.ok(record.argv.includes("--safe-mode"));
    assert.equal(record.argv[record.argv.indexOf("--tools") + 1], "");
    assert.match(record.stdin, /second question/);
    assert.doesNotMatch(record.stdin, /first question/);
  });

  it("agent keeps the system message inline in the prompt", async () => {
    await startWith({ preset: "agent" });
    await fixture.use(RESUME_ECHO);
    await chat({
      model: "claude-haiku-4-5",
      messages: [
        { role: "system", content: "You are a pirate." },
        { role: "user", content: "hello" },
      ],
    });

    const record = await fixture.record();
    assert.ok(!record.argv.includes("--system-prompt"));
    assert.match(record.stdin, /<system>\s*You are a pirate\./);
    await startWith();
  });
});

describe("session lookup without `user`", () => {
  before(async () => {
    fixture = await createFixtureCli();
    sandbox = await mkdtemp(path.join(tmpdir(), "claude-proxy-session-"));

    previousConfig = process.env.CLAUDE_PROXY_CONFIG;
    const emptyConfig = path.join(sandbox, "config.json");
    await writeFile(emptyConfig, "{}", "utf8");
    process.env.CLAUDE_PROXY_CONFIG = emptyConfig;

    previousBin = process.env.CLAUDE_BIN;
    process.env.CLAUDE_BIN = fixture.bin;

    await startWith();
  });

  after(async () => {
    await stopServer();
    if (previousBin === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = previousBin;
    if (previousConfig === undefined) delete process.env.CLAUDE_PROXY_CONFIG;
    else process.env.CLAUDE_PROXY_CONFIG = previousConfig;
    await fixture.cleanup();
    await rm(sandbox, { recursive: true, force: true });
  });

  const model = "claude-haiku-4-5";

  it("resumes a conversation the client never labelled", async () => {
    await fixture.use({
      chunks: linesToChunks([initEvent(), resultMessage({ result: "first answer" })]),
    });
    await chat({ model, messages: [{ role: "user", content: "first question" }] });

    await fixture.use(RESUME_ECHO);
    await chat({
      model,
      messages: [
        { role: "user", content: "first question" },
        { role: "assistant", content: "first answer" },
        { role: "user", content: "second question" },
      ],
    });

    const record = await fixture.record();
    assert.deepEqual(record.argv.slice(-2), ["--resume", FIXTURE_SESSION_ID]);
    assert.match(record.stdin, /second question/);
    assert.doesNotMatch(record.stdin, /first question/);
  });

  it("resumes by anchor after the client truncates the history", async () => {
    await fixture.use({
      chunks: linesToChunks([initEvent(), resultMessage({ result: "answer two" })]),
    });
    await chat({
      model,
      messages: [
        { role: "user", content: "question one" },
        { role: "assistant", content: "answer one" },
        { role: "user", content: "question two" },
      ],
    });

    await fixture.use(RESUME_ECHO);
    await chat({
      model,
      messages: [
        { role: "user", content: "question two" },
        { role: "assistant", content: "answer two" },
        { role: "user", content: "question three" },
      ],
    });

    const record = await fixture.record();
    assert.deepEqual(record.argv.slice(-2), ["--resume", FIXTURE_SESSION_ID]);
    assert.match(record.stdin, /question three/);
    assert.doesNotMatch(record.stdin, /question two/);
  });

  it("starts fresh when the configuration changed under the session", async () => {
    await fixture.use({
      chunks: linesToChunks([initEvent(), resultMessage({ result: "kept" })]),
    });
    await chat({ model, messages: [{ role: "user", content: "remember" }] });

    await startWith({ preset: "agent" });
    await fixture.use(RESUME_ECHO);
    await chat({
      model,
      messages: [
        { role: "user", content: "remember" },
        { role: "assistant", content: "kept" },
        { role: "user", content: "and now?" },
      ],
    });

    const record = await fixture.record();
    assert.ok(!record.argv.includes("--resume"), "a different profile is a miss");
    assert.match(record.stdin, /remember/, "so the full history is replayed");
    await startWith();
  });

  it("honours a narrowed session strategy", async () => {
    await startWith({ sessionStrategy: ["user"] });
    await fixture.use({
      chunks: linesToChunks([initEvent(), resultMessage({ result: "an answer" })]),
    });
    await chat({ model, messages: [{ role: "user", content: "a question" }] });

    await fixture.use(RESUME_ECHO);
    await chat({
      model,
      messages: [
        { role: "user", content: "a question" },
        { role: "assistant", content: "an answer" },
        { role: "user", content: "another" },
      ],
    });

    const record = await fixture.record();
    assert.ok(!record.argv.includes("--resume"));
    await startWith();
  });

  it("survives a proxy restart", async () => {
    await fixture.use({
      chunks: linesToChunks([initEvent(), resultMessage({ result: "persisted answer" })]),
    });
    await chat({ model, messages: [{ role: "user", content: "persisted question" }] });

    // A restart with the same index file must find the session again.
    resetSessionIndexes();
    await startWith();

    await fixture.use(RESUME_ECHO);
    await chat({
      model,
      messages: [
        { role: "user", content: "persisted question" },
        { role: "assistant", content: "persisted answer" },
        { role: "user", content: "after the restart" },
      ],
    });

    const record = await fixture.record();
    assert.deepEqual(record.argv.slice(-2), ["--resume", FIXTURE_SESSION_ID]);
  });

  it("gives a second concurrent request its own session", async () => {
    await startWith({ sessionLockTimeoutMs: 50 });
    await fixture.use({
      chunks: linesToChunks([initEvent(), resultMessage({ result: "shared answer" })]),
    });
    await chat({ model, messages: [{ role: "user", content: "shared question" }] });

    const follow = {
      model,
      messages: [
        { role: "user", content: "shared question" },
        { role: "assistant", content: "shared answer" },
        { role: "user", content: "at the same time" },
      ],
    };

    await fixture.use({
      chunks: linesToChunks([initEvent(), resultMessage({ result: "ok" })], 120),
    });
    const [a, b] = await Promise.all([chat(follow), chat(follow)]);

    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    await startWith();
  });
});

describe("tool calling", () => {
  before(async () => {
    fixture = await createFixtureCli();
    sandbox = await mkdtemp(path.join(tmpdir(), "claude-proxy-tools-"));

    previousConfig = process.env.CLAUDE_PROXY_CONFIG;
    const emptyConfig = path.join(sandbox, "config.json");
    await writeFile(emptyConfig, "{}", "utf8");
    process.env.CLAUDE_PROXY_CONFIG = emptyConfig;

    previousBin = process.env.CLAUDE_BIN;
    process.env.CLAUDE_BIN = fixture.bin;

    await startWith();
  });

  after(async () => {
    await stopServer();
    if (previousBin === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = previousBin;
    if (previousConfig === undefined) delete process.env.CLAUDE_PROXY_CONFIG;
    else process.env.CLAUDE_PROXY_CONFIG = previousConfig;
    await fixture.cleanup();
    await rm(sandbox, { recursive: true, force: true });
  });

  const tools = [
    {
      type: "function",
      function: {
        name: "daily_write",
        description: "Write a note",
        parameters: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
        },
      },
    },
  ];
  const withTools = {
    model: "claude-haiku-4-5",
    messages: [{ role: "user", content: "запиши заметку про CDN" }],
    tools,
  };

  /** A run whose StructuredOutput call carries the proxy's own wrapper. */
  function wrapperRun(payload: unknown): FixtureSpec {
    const json = JSON.stringify(payload);
    return {
      chunks: linesToChunks([
        initEvent(),
        messageStart(),
        textBlockStart(0),
        textDelta("Sure, let me record that.", 0),
        blockStop(0),
        toolUseBlockStart("StructuredOutput", 0),
        inputJsonDelta(json, 0),
        blockStop(0),
        resultMessage({ result: "Sure, let me record that.", structured_output: payload }),
      ]),
    };
  }

  const CALL = {
    kind: "tool_call",
    tool_calls: [{ name: "daily_write", arguments: { name: "podeli-cdn" } }],
  };

  it("hands the CLI a wrapper schema, not the caller's own", async () => {
    await fixture.use(wrapperRun(CALL));
    await chat(withTools);

    const record = await fixture.record();
    const flag = record.argv.indexOf("--json-schema");
    assert.ok(flag >= 0, "expected --json-schema");
    const schema = JSON.parse(record.argv[flag + 1]);
    assert.deepEqual(schema.properties.kind.enum, ["message", "tool_call"]);
    assert.deepEqual(schema.properties.tool_calls.items.properties.name.enum, ["daily_write"]);
  });

  it("describes the tools in the system prompt", async () => {
    await fixture.use(wrapperRun(CALL));
    await chat(withTools);

    const record = await fixture.record();
    const system = record.argv.join("\n");
    assert.match(system, /daily_write/);
    assert.match(system, /Write a note/);
  });

  it("returns the call as tool_calls with finish_reason tool_calls", async () => {
    await fixture.use(wrapperRun(CALL));
    const { status, json } = await chat(withTools);

    assert.equal(status, 200);
    const choice = json.choices[0];
    assert.equal(choice.finish_reason, "tool_calls");
    assert.equal(choice.message.tool_calls.length, 1);
    assert.equal(choice.message.tool_calls[0].type, "function");
    assert.equal(choice.message.tool_calls[0].function.name, "daily_write");
    assert.deepEqual(JSON.parse(choice.message.tool_calls[0].function.arguments), {
      name: "podeli-cdn",
    });
  });

  it("returns a plain answer when the model chose not to call anything", async () => {
    await fixture.use(wrapperRun({ kind: "message", content: "уже записано" }));
    const { json } = await chat(withTools);

    assert.equal(json.choices[0].finish_reason, "stop");
    assert.equal(json.choices[0].message.content, "уже записано");
    assert.equal(json.choices[0].message.tool_calls, undefined);
  });

  it("never leaks the wrapper into content", async () => {
    await fixture.use(wrapperRun(CALL));
    const { json } = await chat(withTools);
    assert.doesNotMatch(String(json.choices[0].message.content ?? ""), /tool_calls|kind/);
  });

  it("streams the call once, at the end, and closes on tool_calls", async () => {
    await fixture.use(wrapperRun(CALL));
    const { events, sawDone, text } = await chatStream(withTools);

    // The wrapper streams as StructuredOutput arguments; none of it is content.
    assert.equal(text, "");
    const calls = events.flatMap((e: any) => e.choices?.[0]?.delta?.tool_calls ?? []);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].function.name, "daily_write");
    assert.equal(calls[0].index, 0);
    const last = events.at(-1);
    assert.equal(last.choices[0].finish_reason, "tool_calls");
    assert.ok(sawDone);
  });

  it("forwards the results of earlier calls back to the CLI", async () => {
    await fixture.use(wrapperRun({ kind: "message", content: "готово" }));
    await chat({
      ...withTools,
      messages: [
        { role: "user", content: "запиши заметку про CDN" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "daily_write", arguments: '{"name":"podeli-cdn"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_1", name: "daily_write", content: "Wrote 182 bytes" },
      ],
    });

    // The turn text reaches the CLI on stdin; only the flags are in argv.
    const record = await fixture.record();
    assert.match(record.stdin, /<tool_result name="daily_write">/);
    assert.match(record.stdin, /Wrote 182 bytes/);
  });

  it("refuses tools and response_format together", async () => {
    const { status, json } = await chat({
      ...withTools,
      response_format: { type: "json_object" },
    });
    assert.equal(status, 400);
    assert.match(json.error.message, /response_format/);
  });

  it("ignores the tool set when tool_choice withdraws it", async () => {
    await fixture.use(RESUME_ECHO);
    await chat({ ...withTools, tool_choice: "none" });

    const record = await fixture.record();
    assert.ok(!record.argv.includes("--json-schema"), "no wrapper schema");
  });

  it("reports the session and the emulation in headers", async () => {
    await fixture.use(wrapperRun(CALL));
    const { headers } = await chat(withTools);

    assert.match(String(headers.get("x-claude-session-id")), /^[0-9a-f-]{36}$/);
    assert.equal(headers.get("x-claude-session-resumed"), "false");
    assert.equal(headers.get("x-tool-emulation"), "tool_call");
    assert.ok(Number(headers.get("x-claude-cli-turns")) >= 1);
  });

  it("marks a turn where the wrapper never appeared", async () => {
    // The failure this whole thing was built to catch: the model answered
    // about the tools instead of naming one, and the client saw a normal reply.
    await fixture.use(wrapperRun({ answer: "No such tool available: search" }));
    const { json, headers } = await chat(withTools);

    assert.equal(json.choices[0].finish_reason, "stop");
    assert.equal(headers.get("x-tool-emulation"), "not_wrapper");
  });

  it("marks a turn that announced a call and named none", async () => {
    await fixture.use(wrapperRun({ kind: "tool_call", tool_calls: [] }));
    const { headers } = await chat(withTools);
    assert.equal(headers.get("x-tool-emulation"), "empty_tool_call");
  });

  it("counts the degradations for /health", async () => {
    const res = await fetch(`${baseUrl}/health`);
    const health = (await res.json()) as any;
    assert.ok(health.tool_emulation.turns > 0);
    assert.ok(health.tool_emulation.degraded > 0);
    assert.ok(health.tool_emulation.issues.not_wrapper > 0);
    // Calls against messages is the ratio that catches the refusal the three
    // checks miss: a well-formed wrapper that simply never names a tool.
    assert.ok(health.tool_emulation.calls > 0);
    assert.ok(health.tool_emulation.messages > 0);
    assert.equal(
      health.tool_emulation.calls + health.tool_emulation.messages,
      health.tool_emulation.turns
    );
  });

  it("says a resumed turn is resumed", async () => {
    await fixture.use(wrapperRun({ kind: "message", content: "первый" }));
    const first = { ...withTools, user: "carla" };
    await chat(first);

    await fixture.use(wrapperRun({ kind: "message", content: "второй" }));
    const { headers } = await chat({
      ...first,
      messages: [
        ...first.messages,
        { role: "assistant", content: "первый" },
        { role: "user", content: "и ещё" },
      ],
    });
    assert.equal(headers.get("x-claude-session-resumed"), "true");
  });
});
