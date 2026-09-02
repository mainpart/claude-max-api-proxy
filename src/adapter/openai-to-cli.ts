/**
 * Converts OpenAI chat request format to Claude CLI input
 */

import type {
  OpenAIChatMessage,
  OpenAIChatRequest,
  OpenAIContentBlock,
  OpenAIResponseFormat,
} from "../types/openai.js";
import type { Preset } from "../config.js";

/** A request the proxy refuses before spawning anything. */
export class InvalidRequestError extends Error {}

export type ClaudeModel = "opus" | "sonnet" | "haiku";

export interface CliInput {
  prompt: string;
  model: ClaudeModel;
  sessionId?: string;
  /**
   * The client's system messages, for presets that pass them as a flag. Sent
   * on every turn including a resume, because the CLI rebuilds the system
   * block from its arguments each time and stores none of it in the session.
   */
  system?: string;
}

/**
 * Instruction used for `response_format: {"type":"json_object"}`.
 *
 * There is no CLI flag for it: `--json-schema` needs a schema, and the
 * permissive `{"type":"object"}` comes back as an empty `{}`. So the rule is
 * worded instead — and it belongs in the system prompt, because
 * `response_format` describes one request, not the conversation. Put in the
 * turn text it would settle into the history and keep applying to later turns
 * that never asked for JSON.
 */
export const JSON_OBJECT_INSTRUCTION =
  "Reply with a single JSON value and nothing else: no prose before or after it, and no Markdown code fence.";

/**
 * Serialised schema for `--json-schema`, or undefined when the request did
 * not ask for one.
 *
 * Nothing is added to the prompt alongside it. The CLI implements the flag as
 * a tool named StructuredOutput whose description already tells the model to
 * call it exactly once at the end, and a request body carrying a schema
 * differs from one without it only in the `tools` array.
 */
export function responseFormatSchema(
  format: OpenAIResponseFormat | undefined
): string | undefined {
  if (!format || format.type !== "json_schema") return undefined;

  const schema = format.json_schema?.schema;
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    throw new InvalidRequestError(
      "response_format.json_schema.schema must be a JSON Schema object"
    );
  }

  // An invalid schema used to reach the CLI and come back as a quietly
  // unstructured answer rather than an error.
  let serialised: string;
  try {
    serialised = JSON.stringify(schema);
  } catch {
    throw new InvalidRequestError("response_format.json_schema.schema is not serialisable");
  }
  return serialised;
}

/** Wording for `json_object`, which has no flag to carry it. */
export function responseFormatInstruction(
  format: OpenAIResponseFormat | undefined
): string | undefined {
  return format?.type === "json_object" ? JSON_OBJECT_INSTRUCTION : undefined;
}

/** Whether the client is expecting JSON back, by either route. */
export function wantsJson(format: OpenAIResponseFormat | undefined): boolean {
  return format?.type === "json_object" || format?.type === "json_schema";
}

const MODEL_MAP: Record<string, ClaudeModel> = {
  // Direct model names (provider prefixes like `claude-code-cli/` and `claude-max/`
  // are stripped by extractModel before consulting this map)
  "claude-opus-4": "opus",
  "claude-opus-4-6": "opus",
  "claude-sonnet-4": "sonnet",
  "claude-sonnet-4-5": "sonnet",
  "claude-sonnet-4-6": "sonnet",
  "claude-sonnet-5": "sonnet",
  "claude-opus-5": "opus",
  "claude-haiku-4": "haiku",
  "claude-haiku-4-5": "haiku",
  // Bare aliases
  "opus": "opus",
  "sonnet": "sonnet",
  "haiku": "haiku",
  "opus-max": "opus",
  "sonnet-max": "sonnet",
};

/** Whether the proxy recognises this model identifier. */
export function isKnownModel(model: string): boolean {
  if (MODEL_MAP[model]) return true;
  return Boolean(MODEL_MAP[model.replace(/^(?:claude-code-cli|claude-max)\//, "")]);
}

/**
 * Extract Claude model alias from request model string
 */
export function extractModel(model: string): ClaudeModel {
  // Try direct lookup
  if (MODEL_MAP[model]) {
    return MODEL_MAP[model];
  }

  // Try stripping provider prefix
  const stripped = model.replace(/^(?:claude-code-cli|claude-max)\//, "");
  if (MODEL_MAP[stripped]) {
    return MODEL_MAP[stripped];
  }

  // Default to opus (Claude Max subscription)
  return "opus";
}

/**
 * Extract text from a content field that may be a string or array of content blocks.
 * OpenAI API allows content as either:
 *   - A plain string: "Hello"
 *   - An array of content blocks: [{"type": "text", "text": "Hello"}]
 */
export function extractText(content: string | OpenAIContentBlock[]): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter((block) => block.type === "text" || block.type === "input_text")
      .map((block) => block.text)
      .join("\n");
  }
  return String(content || "");
}

/**
 * Strip OpenClaw-specific tooling sections from system prompts.
 * These reference tools (exec, process, web_search, etc.) that don't exist
 * in the Claude Code CLI environment, causing the model to get confused.
 * We remove: ## Tooling, ## Tool Call Style, ## OpenClaw CLI Quick Reference,
 * ## OpenClaw Self-Update
 */
function stripOpenClawTooling(text: string): string {
  const sectionsToStrip = [
    "## Tooling",
    "## Tool Call Style",
    "## OpenClaw CLI Quick Reference",
    "## OpenClaw Self-Update",
  ];
  let result = text;
  for (const section of sectionsToStrip) {
    // Match from section header to the next ## header (or end of string)
    const pattern = new RegExp(
      section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
        "\\n[\\s\\S]*?(?=\\n## |$)",
      "g"
    );
    result = result.replace(pattern, "");
  }
  // Clean up excessive blank lines left behind
  result = result.replace(/\n{3,}/g, "\n\n");
  return result.trim();
}

/**
 * Separate the client's system messages from the rest of the conversation.
 *
 * The system text then goes to `--system-prompt`, where the API keeps it in
 * the cached prefix, rather than into the turn text, where it would be
 * repeated into the history on every turn.
 */
export function splitSystem(messages: OpenAIChatMessage[]): {
  system: string;
  rest: OpenAIChatMessage[];
} {
  const system: string[] = [];
  const rest: OpenAIChatMessage[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      const text = stripOpenClawTooling(extractText(msg.content));
      if (text) system.push(text);
    } else {
      rest.push(msg);
    }
  }

  return { system: system.join("\n\n"), rest };
}

/**
 * Convert OpenAI messages array to a single prompt string for Claude CLI
 *
 * Claude Code CLI in --print mode expects a single prompt, not a conversation.
 * We format the messages into a readable format that preserves context.
 */
export function messagesToPrompt(
  messages: OpenAIChatRequest["messages"]
): string {
  const parts: string[] = [];

  for (const msg of messages) {
    const text = extractText(msg.content);
    switch (msg.role) {
      case "system":
        // System messages become context instructions
        // Strip OpenClaw tooling sections that conflict with Claude Code's native tools
        parts.push(`<system>\n${stripOpenClawTooling(text)}\n</system>\n`);
        break;

      case "user":
        // User messages are the main prompt
        parts.push(text);
        break;

      case "assistant":
        // Previous assistant responses for context
        parts.push(`<previous_response>\n${text}\n</previous_response>\n`);
        break;
    }
  }

  return parts.join("\n").trim();
}

/**
 * Convert OpenAI chat request to CLI input format.
 *
 * Under `economy` the system messages are lifted out and returned separately;
 * under `agent` they stay inline in the prompt, as they always did.
 */
export function openaiToCli(
  request: OpenAIChatRequest,
  preset: Preset = "agent"
): CliInput {
  if (preset === "economy") {
    const { system, rest } = splitSystem(request.messages);
    return {
      prompt: messagesToPrompt(rest),
      model: extractModel(request.model),
      sessionId: request.user,
      system,
    };
  }

  return {
    prompt: messagesToPrompt(request.messages),
    model: extractModel(request.model),
    sessionId: request.user, // Use OpenAI's user field for session mapping
  };
}

/**
 * Build CLI input for a request that will --resume an existing Claude CLI
 * session. Since the CLI already remembers everything up to `sinceIndex`
 * (it generated the assistant turns itself), we only need to forward the
 * messages appended since then — not the full history again.
 */
export function openaiToCliDelta(
  request: OpenAIChatRequest,
  sinceIndex: number,
  preset: Preset = "agent"
): CliInput {
  const newMessages = request.messages
    .slice(sinceIndex)
    .filter((m) => m.role !== "assistant");

  // Fallback to full history if nothing new was found (shouldn't happen,
  // but never send an empty prompt to the CLI)
  const tail = newMessages.length ? newMessages : request.messages;

  if (preset === "economy") {
    // System text is taken from the whole request, not from the tail: the
    // client usually sends it as message 0, and the CLI needs it again on
    // every resume.
    const { system } = splitSystem(request.messages);
    const { rest } = splitSystem(tail);
    return {
      prompt: messagesToPrompt(rest),
      model: extractModel(request.model),
      sessionId: request.user,
      system,
    };
  }

  return {
    prompt: messagesToPrompt(tail),
    model: extractModel(request.model),
    sessionId: request.user,
  };
}
