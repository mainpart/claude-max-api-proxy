import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import { startServer, stopServer } from "./index.js";
import type { ServerConfig } from "./index.js";
import {
  createFixtureCli,
  HAPPY_TEXT,
  MULTI_TEXT_BLOCKS,
  NO_PARTIAL_MESSAGES,
  RESUME_ECHO,
  SPLIT_JSON_LINE,
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
  return { port: 0, binArgs: fixture.binArgs, cwd: sandbox, ...overrides };
}

async function startWith(overrides: ServerConfig = {}): Promise<void> {
  await stopServer();
  server = await startServer(testConfig(overrides));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function chat(body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
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
    assert.deepEqual(secondRecord.argv.slice(-2), ["--resume", sessionId]);
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
