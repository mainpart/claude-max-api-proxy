/**
 * A stand-in for the Claude CLI, for tests that must not spend tokens.
 *
 * The existing Windows process-tree test already showed the shape: point
 * CLAUDE_BIN at `process.execPath` and hand it a `.cjs` script. The script
 * cannot be checked in as a resource, because `tsc` copies no non-TypeScript
 * files into `dist/` and the tests run from `dist/`. So it is generated into
 * a temporary directory instead.
 *
 * The fixture reads its scenario from a JSON file whose path is passed as its
 * first argument — that is what `binArgs` is for — and records the argv and
 * stdin it received, which is how `buildArgs`, flag repetition on resume, and
 * the contents of a delta prompt get asserted.
 */

import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";

export interface FixtureChunk {
  /** Raw bytes written to stdout — not necessarily whole lines. */
  text: string;
  /** Pause before writing this chunk. */
  delayMs?: number;
}

export interface FixtureSpec {
  chunks: FixtureChunk[];
  stderr?: string;
  exitCode?: number;
  /** Pause between the last chunk and exiting. */
  exitDelayMs?: number;
  /** Stay alive after writing everything, so a timeout can be exercised. */
  hang?: boolean;
}

export interface FixtureRecord {
  /** Arguments after the fixture's own two, i.e. what buildArgs produced. */
  argv: string[];
  stdin: string;
  cwd: string;
}

export interface FixtureCli {
  /** Value for CLAUDE_BIN. */
  bin: string;
  /** Value for config.binArgs. */
  binArgs: string[];
  /** Install the scenario the next run will replay. */
  use(spec: FixtureSpec): Promise<void>;
  /** What the last run received. */
  record(): Promise<FixtureRecord>;
  cleanup(): Promise<void>;
}

const FIXTURE_SOURCE = `
const fs = require("node:fs");

const specPath = process.argv[2];
const recordPath = process.argv[3];
const argv = process.argv.slice(4);
const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));

let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => { stdin += d; });
process.stdin.on("end", run);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run() {
  try {
    fs.writeFileSync(recordPath, JSON.stringify({ argv, stdin, cwd: process.cwd() }));
  } catch {}

  if (spec.stderr) process.stderr.write(spec.stderr);

  for (const chunk of spec.chunks || []) {
    if (chunk.delayMs) await sleep(chunk.delayMs);
    process.stdout.write(chunk.text);
  }

  if (spec.hang) {
    setInterval(() => {}, 1000);
    return;
  }

  if (spec.exitDelayMs) await sleep(spec.exitDelayMs);
  process.exit(spec.exitCode || 0);
}
`;

export async function createFixtureCli(): Promise<FixtureCli> {
  const dir = await mkdtemp(path.join(tmpdir(), "claude-fixture-cli-"));
  const scriptPath = path.join(dir, "fixture-cli.cjs");
  const specPath = path.join(dir, "spec.json");
  const recordPath = path.join(dir, "record.json");

  await writeFile(scriptPath, FIXTURE_SOURCE, "utf8");
  await writeFile(specPath, JSON.stringify({ chunks: [] }), "utf8");

  return {
    bin: process.execPath,
    binArgs: [scriptPath, specPath, recordPath],
    async use(spec: FixtureSpec): Promise<void> {
      await rm(recordPath, { force: true });
      await writeFile(specPath, JSON.stringify(spec), "utf8");
    },
    async record(): Promise<FixtureRecord> {
      return JSON.parse(await readFile(recordPath, "utf8")) as FixtureRecord;
    },
    async cleanup(): Promise<void> {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

// ─── Scenario building blocks ────────────────────────────────────────
//
// Shapes below are transcribed from a real `--output-format stream-json
// --include-partial-messages` run, including the parts the proxy currently
// ignores: system/status, system/thinking_tokens, signature_delta, and the
// rate_limit_event that arrives on ordinary successful requests.

export const FIXTURE_SESSION_ID = "11111111-2222-3333-4444-555555555555";
export const FIXTURE_MODEL = "claude-haiku-4-5-20251001";

const base = { session_id: FIXTURE_SESSION_ID, uuid: "00000000-0000-4000-8000-000000000000" };

function streamEvent(event: unknown): unknown {
  return { type: "stream_event", event, ...base };
}

export function initEvent(overrides: Record<string, unknown> = {}): unknown {
  return {
    type: "system",
    subtype: "init",
    cwd: "/tmp",
    tools: [],
    mcp_servers: [],
    model: FIXTURE_MODEL,
    permissionMode: "default",
    slash_commands: [],
    skills: [],
    plugins: [],
    ...base,
    ...overrides,
  };
}

export function messageStart(model = FIXTURE_MODEL): unknown {
  return streamEvent({
    type: "message_start",
    message: {
      model,
      id: "msg_fixture",
      type: "message",
      role: "assistant",
      content: [],
      stop_reason: null,
      usage: { input_tokens: 244, output_tokens: 4 },
    },
  });
}

export function textBlockStart(index = 0): unknown {
  return streamEvent({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
}

export function textDelta(text: string, index = 0): unknown {
  return streamEvent({ type: "content_block_delta", index, delta: { type: "text_delta", text } });
}

export function thinkingBlockStart(index = 0): unknown {
  return streamEvent({
    type: "content_block_start",
    index,
    content_block: { type: "thinking", thinking: "", signature: "" },
  });
}

export function thinkingDelta(thinking: string, index = 0): unknown {
  return streamEvent({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking } });
}

export function signatureDelta(index = 0): unknown {
  return streamEvent({
    type: "content_block_delta",
    index,
    delta: { type: "signature_delta", signature: "EqUFCrIB" },
  });
}

export function toolUseBlockStart(name: string, index = 0): unknown {
  return streamEvent({
    type: "content_block_start",
    index,
    content_block: { type: "tool_use", id: "toolu_fixture", name },
  });
}

export function inputJsonDelta(partial_json: string, index = 0): unknown {
  return streamEvent({
    type: "content_block_delta",
    index,
    delta: { type: "input_json_delta", partial_json },
  });
}

export function blockStop(index = 0): unknown {
  return streamEvent({ type: "content_block_stop", index });
}

export function messageDelta(stop_reason: string | null = "end_turn"): unknown {
  return streamEvent({
    type: "message_delta",
    delta: { stop_reason, stop_sequence: null },
    usage: { input_tokens: 244, output_tokens: 12 },
  });
}

export function messageStop(): unknown {
  return streamEvent({ type: "message_stop" });
}

export function assistantMessage(
  content: unknown[],
  model = FIXTURE_MODEL,
  stop_reason: string | null = null
): unknown {
  return {
    type: "assistant",
    message: {
      model,
      id: "msg_fixture",
      type: "message",
      role: "assistant",
      content,
      stop_reason,
      usage: { input_tokens: 244, output_tokens: 12 },
    },
    ...base,
  };
}

/** A rate limit notice. The CLI emits one with status "allowed" per request. */
export function rateLimitEvent(status: string = "allowed", resetsAt = 1788348000): unknown {
  return {
    type: "rate_limit_event",
    rate_limit_info: {
      status,
      resetsAt,
      rateLimitType: "five_hour",
      overageStatus: "rejected",
      isUsingOverage: false,
    },
    ...base,
  };
}

export interface ResultOverrides {
  result?: string;
  subtype?: string;
  is_error?: boolean;
  num_turns?: number;
  stop_reason?: string | null;
  usage?: Record<string, unknown>;
  structured_output?: unknown;
  model?: string;
}

export function resultMessage(overrides: ResultOverrides = {}): unknown {
  const { model = FIXTURE_MODEL, ...rest } = overrides;
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 1000,
    duration_api_ms: 900,
    num_turns: 1,
    result: "Hello there",
    total_cost_usd: 0.001,
    stop_reason: "end_turn",
    usage: {
      input_tokens: 244,
      output_tokens: 12,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    modelUsage: {
      [model]: { inputTokens: 244, outputTokens: 12, costUSD: 0.001 },
    },
    permission_denials: [],
    ...base,
    ...rest,
  };
}

/** One NDJSON line per chunk, which is how the CLI usually writes them. */
export function linesToChunks(lines: unknown[], delayMs = 1): FixtureChunk[] {
  return lines.map((line) => ({ text: JSON.stringify(line) + "\n", delayMs }));
}

// ─── Named scenarios ─────────────────────────────────────────────────

export const HAPPY_TEXT: FixtureSpec = {
  chunks: linesToChunks([
    initEvent(),
    { type: "system", subtype: "status", status: "requesting", ...base },
    messageStart(),
    rateLimitEvent("allowed"),
    textBlockStart(),
    textDelta("Hello"),
    textDelta(" there"),
    assistantMessage([{ type: "text", text: "Hello there" }]),
    blockStop(),
    messageDelta(),
    messageStop(),
    resultMessage({ result: "Hello there" }),
  ]),
};

/** An older CLI, or one run without --include-partial-messages: no deltas. */
export const NO_PARTIAL_MESSAGES: FixtureSpec = {
  chunks: linesToChunks([
    initEvent(),
    assistantMessage([{ type: "text", text: "Whole answer at once" }], FIXTURE_MODEL, "end_turn"),
    resultMessage({ result: "Whole answer at once" }),
  ]),
};

export const MULTI_TEXT_BLOCKS: FixtureSpec = {
  chunks: linesToChunks([
    initEvent(),
    messageStart(),
    textBlockStart(0),
    textDelta("First block", 0),
    blockStop(0),
    textBlockStart(1),
    textDelta("Second block", 1),
    blockStop(1),
    assistantMessage([
      { type: "text", text: "First block" },
      { type: "text", text: "Second block" },
    ]),
    messageDelta(),
    messageStop(),
    resultMessage({ result: "First block\n\nSecond block" }),
  ]),
};

export const THINKING_THEN_TEXT: FixtureSpec = {
  chunks: linesToChunks([
    initEvent(),
    messageStart(),
    thinkingBlockStart(0),
    thinkingDelta("The user is asking", 0),
    { type: "system", subtype: "thinking_tokens", estimated_tokens: 8, ...base },
    thinkingDelta(" for a greeting.", 0),
    signatureDelta(0),
    blockStop(0),
    textBlockStart(1),
    textDelta("Hi", 1),
    blockStop(1),
    assistantMessage([
      { type: "thinking", thinking: "The user is asking for a greeting." },
      { type: "text", text: "Hi" },
    ]),
    messageDelta(),
    messageStop(),
    resultMessage({ result: "Hi" }),
  ]),
};

/** Blocked by the subscription rate limit before any content is produced. */
export const RATE_LIMIT: FixtureSpec = {
  chunks: linesToChunks([initEvent(), rateLimitEvent("rejected")]),
  exitCode: 1,
};

/** The CLI dies without ever producing a result. */
export const ERROR_EXIT: FixtureSpec = {
  chunks: [],
  stderr: "No conversation found with session ID: deadbeef\n",
  exitCode: 1,
};

/**
 * A result line torn across two stdout chunks, mid-JSON — the shape that
 * breaks any parser that assumes a chunk is a whole line.
 */
export const SPLIT_JSON_LINE: FixtureSpec = (() => {
  const long = "x".repeat(60_000);
  const lines = [initEvent(), messageStart(), textBlockStart(), textDelta(long), blockStop()];
  const tail = JSON.stringify(resultMessage({ result: long })) + "\n";
  const cut = Math.floor(tail.length / 2);
  return {
    chunks: [
      ...linesToChunks(lines),
      { text: tail.slice(0, cut) },
      { text: tail.slice(cut), delayMs: 5 },
    ],
  };
})();

/**
 * A --json-schema run: prose in the text channel, the answer as
 * StructuredOutput tool arguments, both `result` and `structured_output` set.
 */
export const SCHEMA_STREAM: FixtureSpec = {
  chunks: linesToChunks([
    initEvent(),
    messageStart(),
    textBlockStart(0),
    textDelta("The capital of France is Paris.", 0),
    blockStop(0),
    toolUseBlockStart("StructuredOutput", 0),
    inputJsonDelta("", 0),
    inputJsonDelta('{"city": "Paris', 0),
    inputJsonDelta('", "population": 2100000', 0),
    inputJsonDelta("}", 0),
    blockStop(0),
    {
      type: "user",
      message: {
        role: "user",
        content: [
          {
            tool_use_id: "toolu_fixture",
            type: "tool_result",
            content: "Structured output provided successfully",
          },
        ],
      },
      ...base,
    },
    messageDelta("tool_use"),
    messageStop(),
    resultMessage({
      result: '{"city":"Paris","population":2100000}',
      structured_output: { city: "Paris", population: 2100000 },
      num_turns: 2,
      stop_reason: "tool_use",
    }),
  ]),
};

/** A json_object answer the model wrapped in a Markdown fence on its own. */
export const FENCED_JSON: FixtureSpec = {
  chunks: linesToChunks([
    initEvent(),
    messageStart(),
    textBlockStart(),
    textDelta('```json\n{"city": "Paris"'),
    textDelta("}\n```"),
    blockStop(),
    messageDelta(),
    messageStop(),
    resultMessage({ result: '```json\n{"city": "Paris"}\n```' }),
  ]),
};

/** Minimal successful run — used when the test only cares about argv/stdin. */
export const RESUME_ECHO: FixtureSpec = {
  chunks: linesToChunks([initEvent(), resultMessage({ result: "ok" })]),
};
