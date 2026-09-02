/**
 * Types for OpenAI-compatible API
 * Used for Clawdbot integration
 */

export interface OpenAIContentBlock {
  type: "text" | "input_text";
  text: string;
}

export interface OpenAIChatMessage {
  role: "system" | "user" | "assistant";
  content: string | OpenAIContentBlock[];
}

/**
 * Shapes accepted in `response_format`. `json_schema.name` and
 * `json_schema.strict` are parsed but unused — the CLI takes a bare schema
 * and has nowhere to put them.
 */
export type OpenAIResponseFormat =
  | { type: "text" }
  | { type: "json_object" }
  | {
      type: "json_schema";
      json_schema: {
        name?: string;
        strict?: boolean;
        schema: Record<string, unknown>;
      };
    };

export interface OpenAIStreamOptions {
  include_usage?: boolean;
}

export interface OpenAIChatRequest {
  model: string;
  messages: OpenAIChatMessage[];
  stream?: boolean;
  stream_options?: OpenAIStreamOptions;
  response_format?: OpenAIResponseFormat;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  user?: string; // Used for session mapping
}

export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface OpenAIToolCallChunk {
  index: number;
  id?: string;
  type?: "function";
  function?: {
    name?: string;
    arguments?: string;
  };
}

export interface OpenAIChatResponseChoice {
  index: number;
  message: {
    role: "assistant";
    content: string;
    tool_calls?: OpenAIToolCall[];
  };
  finish_reason: "stop" | "length" | "content_filter" | null;
}

/**
 * Usage counters. `prompt_tokens` includes cache reads and cache writes:
 * those are prompt tokens the request actually carried, and reporting only
 * `input_tokens` understates a cached 20k-token conversation as a couple of
 * hundred. `prompt_tokens_details.cached_tokens` is how a caller sees from
 * the HTTP response alone whether prompt caching is working.
 */
export interface OpenAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: {
    cached_tokens: number;
  };
}

export interface OpenAIChatResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: OpenAIChatResponseChoice[];
  usage: OpenAIUsage;
}

export interface OpenAIChatChunkDelta {
  role?: "assistant";
  content?: string;
  /** Thinking text, for clients that render it. Off by default. */
  reasoning_content?: string;
  tool_calls?: OpenAIToolCallChunk[];
}

export interface OpenAIChatChunkChoice {
  index: number;
  delta: OpenAIChatChunkDelta;
  finish_reason: "stop" | "length" | "content_filter" | null;
}

export interface OpenAIChatChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: OpenAIChatChunkChoice[];
  usage?: OpenAIUsage;
}

export interface OpenAIModel {
  id: string;
  object: "model";
  owned_by: string;
  created?: number;
}

export interface OpenAIModelList {
  object: "list";
  data: OpenAIModel[];
}

export interface OpenAIError {
  error: {
    message: string;
    type: string;
    code: string | null;
  };
}
