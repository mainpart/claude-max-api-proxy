/**
 * Tool-call emulation over the CLI's structured output.
 *
 * The CLI runs its own agent loop with its own tools and never sees the
 * caller's function schemas, so the proxy cannot forward them. What it can do
 * is ask the model *which* tool it would call and translate the answer into
 * the OpenAI shape.
 *
 * That sidesteps the hard part. The OpenAI protocol wants the server to stop
 * at a tool call and hand it back; the CLI's loop expects a tool to run in
 * place and return a result. Because the CLI is never given a tool here, the
 * two never meet: every HTTP round trip is one finished CLI turn, with no
 * blocked handler waiting on a later request.
 *
 * The wrapper shape is enforced by `--json-schema`, which the CLI implements
 * as a StructuredOutput tool it must call exactly once at the end. Per-tool
 * argument schemas live in the prompt instead, because one schema cannot
 * express "arguments matching whichever tool `name` names".
 */

import { InvalidRequestError } from "./openai-to-cli.js";
import type {
  OpenAIFunctionTool,
  OpenAIToolCall,
  OpenAIToolChoice,
} from "../types/openai.js";

/**
 * A way the wrapper came back unusable. None of these fails the request — the
 * client gets an ordinary-looking answer either way — which is exactly why
 * they are named: otherwise the emulation degrades in silence.
 */
export type EmulationIssue =
  /** The payload is not the wrapper at all; the CLI's own prose goes out instead. */
  | "not_wrapper"
  /** `kind: "tool_call"` with nothing in `tool_calls`. */
  | "empty_tool_call"
  /** An entry with no `name`, dropped. */
  | "nameless_entry"
  /** A name the request never offered, passed through as the client's problem. */
  | "unknown_tool";

/** What the model answered, once the wrapper is unpacked. */
export interface EmulatedAnswer {
  content: string;
  toolCalls: OpenAIToolCall[];
  /** How the wrapper degraded, if it did. Empty on a clean turn. */
  issues: EmulationIssue[];
}

/** Tools the request actually offers, or undefined when it offers none. */
export function activeTools(
  tools: OpenAIFunctionTool[] | undefined,
  choice: OpenAIToolChoice | undefined
): OpenAIFunctionTool[] | undefined {
  if (choice === "none") return undefined;
  if (!Array.isArray(tools) || tools.length === 0) return undefined;

  for (const tool of tools) {
    if (tool?.type !== "function" || typeof tool.function?.name !== "string" || !tool.function.name) {
      throw new InvalidRequestError("each entry in `tools` must be a function with a name");
    }
  }
  return tools;
}

/** Names the model may answer with, narrowed by a forced `tool_choice`. */
function allowedNames(
  tools: OpenAIFunctionTool[],
  choice: OpenAIToolChoice | undefined
): string[] {
  if (typeof choice === "object" && choice?.type === "function") {
    const forced = choice.function?.name;
    if (!tools.some((t) => t.function.name === forced)) {
      throw new InvalidRequestError(`tool_choice names ${forced}, which is not in \`tools\``);
    }
    return [forced];
  }
  return tools.map((t) => t.function.name);
}

/** Whether the model is still allowed to answer with plain text. */
function mayReplyWithText(choice: OpenAIToolChoice | undefined): boolean {
  if (choice === "required") return false;
  return !(typeof choice === "object" && choice?.type === "function");
}

/**
 * Schema for `--json-schema`: a wrapper saying whether this turn is an answer
 * or a call, and which call.
 */
export function buildToolSchema(
  tools: OpenAIFunctionTool[],
  choice: OpenAIToolChoice | undefined
): Record<string, unknown> {
  const kinds = mayReplyWithText(choice) ? ["message", "tool_call"] : ["tool_call"];

  return {
    type: "object",
    properties: {
      kind: {
        type: "string",
        enum: kinds,
        description: "`tool_call` to invoke a tool, `message` to answer the user directly.",
      },
      content: {
        type: "string",
        description: "The reply text when kind is `message`; empty otherwise.",
      },
      tool_calls: {
        type: "array",
        description: "The calls to make when kind is `tool_call`.",
        items: {
          type: "object",
          properties: {
            name: { type: "string", enum: allowedNames(tools, choice) },
            arguments: {
              type: "object",
              description: "Arguments for that tool, matching its documented schema.",
            },
          },
          required: ["name", "arguments"],
          additionalProperties: false,
        },
      },
    },
    required: ["kind"],
    additionalProperties: false,
  };
}

/**
 * The contract, for the system prompt. It goes there rather than into the
 * turn text because it describes one request: in the turn text it would
 * settle into the transcript and keep applying to later turns that offer
 * different tools, or none.
 */
export function toolsPrompt(
  tools: OpenAIFunctionTool[],
  choice: OpenAIToolChoice | undefined
): string {
  const lines: string[] = [
    "## Available tools",
    "",
    "You are deciding which tool to call. You do not execute anything yourself:",
    "do not read, write or run anything, and do not use any tool of your own.",
    "Name the call and the caller will perform it, then send you the result.",
    "",
    // Tags, because the list can run to tens of kilobytes and the model has to
    // be able to tell where the caller's schemas stop and the instructions
    // resume.
    "<available_tools>",
    "",
  ];

  for (const tool of tools) {
    const fn = tool.function;
    lines.push(`### ${fn.name}`);
    if (fn.description) lines.push(fn.description);
    lines.push("Arguments (JSON Schema):");
    lines.push("```json");
    lines.push(JSON.stringify(fn.parameters ?? { type: "object", properties: {} }, null, 2));
    lines.push("```");
    lines.push("");
  }

  lines.push("</available_tools>");
  lines.push("");

  // The same frame as above, repeated below the list. On a long list the
  // opening frame is thousands of tokens behind by the time the model reaches
  // the end, and it starts trying to *run* what it has just read. The CLI has
  // none of those tools, so its "No such tool available" comes back to the
  // client as prose — a turn that looks answered and called nothing.
  lines.push(
    "Those are the caller's tools, not yours. You have none of your own here, and",
    "that is expected, not a fault. Naming a call is the whole action being asked",
    "of you: the caller runs it and sends you the result on the next turn."
  );
  lines.push("");

  lines.push("## How to answer");
  lines.push("");
  if (mayReplyWithText(choice)) {
    lines.push(
      "Call a tool when one moves the task forward. Set `kind` to `tool_call` and fill",
      "`tool_calls` with the name and its arguments. When you have what you need and",
      "the task is done, set `kind` to `message` and put your reply in `content`."
    );
  } else {
    lines.push(
      "You must call a tool this turn. Set `kind` to `tool_call` and fill `tool_calls`",
      "with the name and its arguments. Do not answer with plain text."
    );
  }
  lines.push("");
  lines.push("`arguments` is a JSON object matching that tool's schema above — not a string.");
  lines.push(
    "Never reply that a tool is unavailable, missing, not initialised or not",
    "connected, and never try to invoke one — running it is the caller's job, and",
    "it can only run what you name."
  );
  lines.push("Results of earlier calls appear in the conversation inside <tool_result> tags.");

  return lines.join("\n");
}

/** Short, stable-ish id in the shape clients expect. */
function callId(index: number): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `call_${random}${index}`;
}

/**
 * Unpack the wrapper the model produced. Returns undefined when the payload
 * is not the wrapper at all, so the caller can fall back to plain text rather
 * than fail the request.
 */
export function parseEmulatedAnswer(
  structured: unknown,
  /** Names the request offered, when the caller has them to hand. */
  known?: readonly string[]
): EmulatedAnswer | undefined {
  if (typeof structured !== "object" || structured === null || Array.isArray(structured)) {
    return undefined;
  }
  const payload = structured as Record<string, unknown>;
  if (payload.kind !== "message" && payload.kind !== "tool_call") return undefined;

  const content = typeof payload.content === "string" ? payload.content : "";
  const raw = Array.isArray(payload.tool_calls) ? payload.tool_calls : [];
  const issues: EmulationIssue[] = [];

  const toolCalls: OpenAIToolCall[] = [];
  for (const [index, entry] of raw.entries()) {
    if (typeof entry !== "object" || entry === null) {
      issues.push("nameless_entry");
      continue;
    }
    const call = entry as Record<string, unknown>;
    if (typeof call.name !== "string" || !call.name) {
      issues.push("nameless_entry");
      continue;
    }
    if (known && !known.includes(call.name)) issues.push("unknown_tool");

    // Models sometimes send the arguments already serialised. Both are fine;
    // what leaves here is always a string, as the OpenAI shape requires.
    const args = call.arguments;
    const serialised =
      typeof args === "string" ? args : JSON.stringify(args ?? {});

    toolCalls.push({
      id: callId(index),
      type: "function",
      function: { name: call.name, arguments: serialised },
    });
  }

  // `kind: "tool_call"` with nothing in it is not a call. Reporting it as one
  // would leave the client waiting for a tool it was never told to run.
  if (payload.kind === "tool_call" && toolCalls.length === 0) {
    issues.push("empty_tool_call");
    return { content, toolCalls: [], issues };
  }
  return { content, toolCalls: payload.kind === "tool_call" ? toolCalls : [], issues };
}
