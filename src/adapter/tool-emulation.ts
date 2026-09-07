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

/** What the model answered, once the wrapper is unpacked. */
export interface EmulatedAnswer {
  content: string;
  toolCalls: OpenAIToolCall[];
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
export function parseEmulatedAnswer(structured: unknown): EmulatedAnswer | undefined {
  if (typeof structured !== "object" || structured === null || Array.isArray(structured)) {
    return undefined;
  }
  const payload = structured as Record<string, unknown>;
  if (payload.kind !== "message" && payload.kind !== "tool_call") return undefined;

  const content = typeof payload.content === "string" ? payload.content : "";
  const raw = Array.isArray(payload.tool_calls) ? payload.tool_calls : [];

  const toolCalls: OpenAIToolCall[] = [];
  for (const [index, entry] of raw.entries()) {
    if (typeof entry !== "object" || entry === null) continue;
    const call = entry as Record<string, unknown>;
    if (typeof call.name !== "string" || !call.name) continue;

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
    return { content, toolCalls: [] };
  }
  return { content, toolCalls: payload.kind === "tool_call" ? toolCalls : [] };
}
