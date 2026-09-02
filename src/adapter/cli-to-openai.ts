/**
 * Converts Claude CLI output to OpenAI-compatible response format
 */

import type { ClaudeCliAssistant, ClaudeCliResult } from "../types/claude-cli.js";
import type {
  OpenAIChatResponse,
  OpenAIChatChunk,
  OpenAIToolCall,
  OpenAIUsage,
} from "../types/openai.js";
import { isKnownModel } from "./openai-to-cli.js";

export type FinishReason = OpenAIChatResponse["choices"][0]["finish_reason"];

/**
 * Extract text content from Claude CLI assistant message
 */
export function extractTextContent(message: ClaudeCliAssistant): string {
  return message.message.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n\n");
}

/**
 * Convert Claude CLI assistant message to OpenAI streaming chunk
 */
export function cliToOpenaiChunk(
  message: ClaudeCliAssistant,
  requestId: string,
  isFirst: boolean = false
): OpenAIChatChunk {
  const text = extractTextContent(message);

  return {
    id: `chatcmpl-${requestId}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: normalizeModelName(message.message.model),
    choices: [
      {
        index: 0,
        delta: {
          role: isFirst ? "assistant" : undefined,
          content: text,
        },
        finish_reason: message.message.stop_reason ? "stop" : null,
      },
    ],
  };
}

/**
 * Create a final "done" chunk for streaming
 */
export function createDoneChunk(
  requestId: string,
  model: string,
  finishReason: FinishReason = "stop"
): OpenAIChatChunk {
  return {
    id: `chatcmpl-${requestId}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: finishReason,
      },
    ],
  };
}

/**
 * Prompt tokens as the client should see them: fresh input plus cache reads
 * plus cache writes. `input_tokens` alone counts only what was neither read
 * from nor written to the cache, which on a resumed conversation is a couple
 * of hundred tokens against twenty thousand actually sent.
 */
export function usageFromResult(result: ClaudeCliResult): OpenAIUsage {
  const usage = result.usage ?? ({} as ClaudeCliResult["usage"]);
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const promptTokens = (usage.input_tokens ?? 0) + cacheRead + cacheWrite;
  const completionTokens = usage.output_tokens ?? 0;

  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    prompt_tokens_details: { cached_tokens: cacheRead },
  };
}

/**
 * Map the CLI's outcome onto an OpenAI finish reason. Anything that is not
 * recognisably a length or refusal outcome is reported as "stop", which is
 * what a client expects for an ordinary completed answer.
 */
export function finishReasonFromResult(result: ClaudeCliResult): FinishReason {
  if (result.stop_reason === "max_tokens" || result.subtype === "error_max_turns") {
    return "length";
  }
  if (result.stop_reason === "refusal") {
    return "content_filter";
  }
  return "stop";
}

/**
 * Model identifier to report back. The client's own identifier is echoed
 * when the proxy recognises it, so a caller sees the model it asked for;
 * otherwise the CLI's name is normalised.
 */
export function resolveResponseModel(
  requestedModel: string | undefined,
  cliModel: string | undefined
): string {
  if (requestedModel && isKnownModel(requestedModel)) return requestedModel;
  return normalizeModelName(cliModel);
}

/**
 * Convert Claude CLI result to OpenAI non-streaming response
 */
export function cliResultToOpenai(
  result: ClaudeCliResult,
  requestId: string,
  options: { model?: string; content?: string; toolCalls?: OpenAIToolCall[] } = {}
): OpenAIChatResponse {
  const cliModel = result.modelUsage ? Object.keys(result.modelUsage)[0] : undefined;

  const message: OpenAIChatResponse["choices"][0]["message"] = {
    role: "assistant",
    content: options.content ?? result.result,
  };

  if (options.toolCalls && options.toolCalls.length > 0) {
    message.tool_calls = options.toolCalls;
  }

  return {
    id: `chatcmpl-${requestId}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: resolveResponseModel(options.model, cliModel),
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReasonFromResult(result),
      },
    ],
    usage: usageFromResult(result),
  };
}

/**
 * Normalize Claude model names to a consistent format
 * e.g., "claude-sonnet-4-5-20250929" -> "claude-sonnet-4"
 */
export function normalizeModelName(model: string | undefined): string {
  if (!model) return "claude-sonnet-4";
  if (model.includes("opus")) return "claude-opus-4";
  if (model.includes("sonnet")) return "claude-sonnet-4";
  if (model.includes("haiku")) return "claude-haiku-4";
  return model;
}
