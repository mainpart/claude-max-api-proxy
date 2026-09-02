/**
 * API Route Handlers
 *
 * Implements OpenAI-compatible endpoints for Clawdbot integration
 */

import type { Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { ClaudeSubprocess } from "../subprocess/manager.js";
import {
  InvalidRequestError,
  openaiToCli,
  openaiToCliDelta,
  responseFormatInstruction,
  responseFormatSchema,
} from "../adapter/openai-to-cli.js";
import {
  cliResultToOpenai,
  createDoneChunk,
  extractTextContent,
  finishReasonFromResult,
  resolveResponseModel,
  unwrapJsonFence,
  usageFromResult,
} from "../adapter/cli-to-openai.js";
import { getSession, setSession, clearSession } from "../subprocess/session-store.js";
import type { OpenAIChatRequest, OpenAIChatChunk, OpenAIChatChunkDelta } from "../types/openai.js";
import type {
  ClaudeCliAssistant,
  ClaudeCliInit,
  ClaudeCliRateLimitEvent,
  ClaudeCliResult,
  ClaudeCliStreamEvent,
} from "../types/claude-cli.js";
import { isRateLimited } from "../types/claude-cli.js";
import type { ProxyConfig } from "../config.js";
import { DEFAULTS } from "../config.js";

interface SessionContext {
  sessionKey: string | undefined;
  resume: boolean;
  messageCount: number;
}

/**
 * What `response_format` asked for, in the terms the CLI understands.
 *
 * The two routes are quite different. A schema becomes a `--json-schema`
 * flag, which the CLI implements as a StructuredOutput tool: the JSON then
 * arrives as tool arguments while the text channel carries incidental prose.
 * `json_object` has no flag at all, so it becomes wording in the system
 * prompt and the answer arrives as ordinary text — possibly inside a code
 * fence the model added on its own.
 */
interface JsonMode {
  /** Serialised schema for --json-schema. */
  schema?: string;
  /** Wording appended to the system prompt. */
  systemSuffix?: string;
  /** Hold the text back so a code fence can be stripped before sending it. */
  bufferText: boolean;
}

function resolveJsonMode(body: OpenAIChatRequest): JsonMode {
  return {
    schema: responseFormatSchema(body.response_format),
    systemSuffix: responseFormatInstruction(body.response_format),
    bufferText: body.response_format?.type === "json_object",
  };
}

/** Text of a finished answer, whichever route produced it. */
function contentFromResult(
  result: ClaudeCliResult,
  jsonMode: JsonMode,
  fallback: string
): string {
  if (jsonMode.schema && result.structured_output !== undefined) {
    return JSON.stringify(result.structured_output);
  }
  const raw = result.result || fallback;
  return jsonMode.bufferText ? unwrapJsonFence(raw) : raw;
}

/**
 * Resolve CLI input for a request, resuming a persisted Claude CLI session
 * when we have one for this `request.user` key instead of replaying the
 * full message history on every turn.
 */
function resolveCliInput(body: OpenAIChatRequest): {
  cliInput: ReturnType<typeof openaiToCli>;
  sessionKey: string | undefined;
  resume: boolean;
} {
  // Session resume requires a stable per-client identifier. Without `user`
  // we have no way to distinguish callers, so skip resume entirely rather
  // than fall back to a shared key that would cross-contaminate unrelated
  // conversations.
  const sessionKey = body.user;
  const existing = sessionKey ? getSession(sessionKey) : undefined;

  if (existing) {
    const cliInput = openaiToCliDelta(body, existing.messageCount);
    cliInput.sessionId = existing.claudeSessionId;
    return { cliInput, sessionKey, resume: true };
  }

  const cliInput = openaiToCli(body);
  if (sessionKey) {
    cliInput.sessionId = uuidv4(); // pin a known ID so we can --resume it later
  }
  return { cliInput, sessionKey, resume: false };
}

/**
 * Handle POST /v1/chat/completions
 *
 * Main endpoint for chat requests, supports both streaming and non-streaming
 */
export async function handleChatCompletions(
  req: Request,
  res: Response,
  config: ProxyConfig = DEFAULTS
): Promise<void> {
  const requestId = uuidv4().replace(/-/g, "").slice(0, 24);
  const body = req.body as OpenAIChatRequest;
  const stream = body.stream === true;

  try {
    // Validate request
    if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
      res.status(400).json({
        error: {
          message: "messages is required and must be a non-empty array",
          type: "invalid_request_error",
          code: "invalid_messages",
        },
      });
      return;
    }

    let jsonMode: JsonMode;
    try {
      jsonMode = resolveJsonMode(body);
    } catch (error) {
      if (!(error instanceof InvalidRequestError)) throw error;
      res.status(400).json({
        error: {
          message: error.message,
          type: "invalid_request_error",
          code: "invalid_response_format",
        },
      });
      return;
    }

    // Convert to CLI input format, resuming a persisted session when we have one
    const { cliInput, sessionKey, resume } = resolveCliInput(body);
    const subprocess = new ClaudeSubprocess(config);
    const sessionCtx: SessionContext = { sessionKey, resume, messageCount: body.messages.length };

    if (stream) {
      await handleStreamingResponse(res, subprocess, cliInput, requestId, sessionCtx, config, body, jsonMode);
    } else {
      await handleNonStreamingResponse(res, subprocess, cliInput, requestId, sessionCtx, config, body, jsonMode);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[handleChatCompletions] Error:", message);

    if (!res.headersSent) {
      res.status(500).json({
        error: {
          message,
          type: "server_error",
          code: null,
        },
      });
    }
  }
}

/**
 * Convert Claude tool_use ID to OpenAI-compatible call ID.
 * Claude uses "toolu_abc123", OpenAI uses "call_abc123".
 *
 * Unused while the CLI handles its tools internally; kept for the day the
 * proxy forwards them.
 */
export function toOpenAICallId(claudeId: string): string {
  return `call_${claudeId.replace("toolu_", "")}`;
}

/**
 * An SSE response that flushes its headers late.
 *
 * Flushing immediately, as this used to, commits the proxy to a 200 before
 * the CLI has even started — so a failure to spawn it, or a rejected request,
 * reached the client as a stream that simply never produced anything. Holding
 * the headers back until there is something to say keeps an honest HTTP
 * status available for as long as possible, and the timer makes sure a slow
 * model still gets its connection established.
 */
class SseStream {
  private flushed = false;
  private ended = false;
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(private readonly res: Response, flushDelayMs: number) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    // nginx buffers proxied responses by default, which turns a token-by-token
    // stream into one delivery at the end.
    res.setHeader("X-Accel-Buffering", "no");

    if (flushDelayMs > 0) {
      this.flushTimer = setTimeout(() => this.flushHeaders(), flushDelayMs);
      this.flushTimer.unref();
    }
  }

  get headersFlushed(): boolean {
    return this.flushed;
  }

  flushHeaders(): void {
    if (this.flushed) return;
    this.flushed = true;
    this.clearFlushTimer();
    if (this.res.writableEnded) return;
    this.res.flushHeaders();
    // A comment line confirms to the client that the connection is alive.
    this.res.write(":ok\n\n");
  }

  send(chunk: unknown): void {
    this.flushHeaders();
    if (this.ended || this.res.writableEnded) return;
    this.res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  }

  /** Terminate the stream. Safe to call more than once. */
  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.clearFlushTimer();
    if (this.res.writableEnded) return;
    this.flushHeaders();
    this.res.write("data: [DONE]\n\n");
    this.res.end();
  }

  /**
   * Report a failure: an HTTP status while that is still possible, otherwise
   * an error event followed by a proper end of stream. Either way the client
   * is left with a finished response rather than a hanging one.
   */
  fail(status: number, message: string, headers: Record<string, string> = {}): void {
    if (!this.flushed) {
      this.clearFlushTimer();
      this.ended = true;
      if (!this.res.writableEnded) {
        for (const [name, value] of Object.entries(headers)) {
          this.res.setHeader(name, value);
        }
        this.res.status(status).json({
          error: { message, type: "server_error", code: null },
        });
      }
      return;
    }
    this.send({ error: { message, type: "server_error", code: null } });
    this.end();
  }

  private clearFlushTimer(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }
}

/** Seconds a client should wait before retrying, from a rate limit notice. */
function retryAfterSeconds(event: ClaudeCliRateLimitEvent): number {
  const resetsAt = event.rate_limit_info?.resetsAt;
  if (typeof resetsAt !== "number") return 60;
  return Math.max(1, Math.ceil(resetsAt - Date.now() / 1000));
}

/** Read a string field off a stream delta whose exact shape varies by type. */
function deltaString(
  event: ClaudeCliStreamEvent,
  type: string,
  field: string
): string {
  const delta = event.event.delta as Record<string, unknown> | undefined;
  if (!delta || delta.type !== type) return "";
  const value = delta[field];
  return typeof value === "string" ? value : "";
}

function statusForError(message: string): number {
  return /timed out/i.test(message) ? 504 : 500;
}

/**
 * Handle streaming response (SSE)
 *
 * IMPORTANT: The Express req.on("close") event fires when the request body
 * is fully received, NOT when the client disconnects. For SSE connections,
 * we use res.on("close") to detect actual client disconnection.
 */
async function handleStreamingResponse(
  res: Response,
  subprocess: ClaudeSubprocess,
  cliInput: ReturnType<typeof openaiToCli>,
  requestId: string,
  sessionCtx: SessionContext,
  config: ProxyConfig,
  body: OpenAIChatRequest,
  jsonMode: JsonMode
): Promise<void> {
  const sse = new SseStream(res, config.streaming.headerFlushMs);

  return new Promise<void>((resolve) => {
    let isFirst = true;
    let cliModel: string | undefined;
    let isComplete = false;
    let hasEmittedText = false;
    let settled = false;
    let inStructuredOutput = false;
    let buffered = "";

    const model = () => resolveResponseModel(body.model, cliModel);

    const chunk = (delta: OpenAIChatChunkDelta): OpenAIChatChunk => {
      const withRole: OpenAIChatChunkDelta = isFirst ? { role: "assistant", ...delta } : delta;
      isFirst = false;
      return {
        id: `chatcmpl-${requestId}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: model(),
        choices: [{ index: 0, delta: withRole, finish_reason: null }],
      };
    };

    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };

    /**
     * Let the CLI write out its session transcript before killing it. The
     * transcript is what a later --resume reads, so a kill the instant the
     * result arrives can cost the whole conversation.
     */
    const reap = (): void => {
      const timer = setTimeout(() => subprocess.kill(), config.streaming.resultGraceMs);
      timer.unref();
    };

    // Handle actual client disconnect (response stream closed)
    res.on("close", () => {
      if (!isComplete) {
        // Client disconnected before response completed - kill subprocess
        subprocess.kill();
      }
      finish();
    });

    // The model identifier is known from the first event of the run. Reading
    // it from the `assistant` message instead, as this used to, meant every
    // streamed chunk carried a hardcoded guess, because that message only
    // arrives after the deltas it is supposed to describe.
    subprocess.on("init", (msg: ClaudeCliInit) => {
      cliModel = msg.model ?? cliModel;
    });

    subprocess.on("message_start", (event: ClaudeCliStreamEvent) => {
      cliModel = event.event.message?.model ?? cliModel;
    });

    subprocess.on("assistant", (message: ClaudeCliAssistant) => {
      cliModel = message.message.model ?? cliModel;
    });

    subprocess.on("rate_limit", (event: ClaudeCliRateLimitEvent) => {
      if (!isRateLimited(event)) return;
      subprocess.kill();
      isComplete = true;
      sse.fail(429, `Claude subscription rate limit reached (${event.rate_limit_info.status})`, {
        "Retry-After": String(retryAfterSeconds(event)),
      });
      finish();
    });

    subprocess.on("thinking_delta", (event: ClaudeCliStreamEvent) => {
      if (config.streaming.thinking !== "reasoning_content") return;
      const text = deltaString(event, "thinking_delta", "thinking");
      if (text) sse.send(chunk({ reasoning_content: text }));
    });

    // When a new text content block starts after we've already emitted text,
    // insert a separator so text from different blocks doesn't run together
    subprocess.on("text_block_start", () => {
      if (jsonMode.schema || jsonMode.bufferText) return;
      if (hasEmittedText) sse.send(chunk({ content: "\n\n" }));
    });

    // Handle streaming content deltas
    subprocess.on("content_delta", (event: ClaudeCliStreamEvent) => {
      const text = deltaString(event, "text_delta", "text");
      if (!text) return;

      // With a schema in play the text channel carries the model's prose
      // about the answer, while the answer itself arrives as tool arguments.
      if (jsonMode.schema) return;

      // A fence can only be stripped once the whole value is in hand.
      if (jsonMode.bufferText) {
        buffered += text;
        return;
      }

      sse.send(chunk({ content: text }));
      hasEmittedText = true;
    });

    // The JSON of a --json-schema answer streams as the arguments of the
    // StructuredOutput tool call.
    subprocess.on("tool_use_start", (event: ClaudeCliStreamEvent) => {
      const block = event.event.content_block;
      inStructuredOutput =
        Boolean(jsonMode.schema) && block?.type === "tool_use" && block.name === "StructuredOutput";
    });

    subprocess.on("input_json_delta", (event: ClaudeCliStreamEvent) => {
      if (!inStructuredOutput) return;
      const partial = deltaString(event, "input_json_delta", "partial_json");
      if (!partial) return;
      sse.send(chunk({ content: partial }));
      hasEmittedText = true;
    });

    subprocess.on("content_block_stop", () => {
      inStructuredOutput = false;
    });

    subprocess.on("result", (result: ClaudeCliResult) => {
      isComplete = true;
      if (sessionCtx.sessionKey && cliInput.sessionId) {
        setSession(sessionCtx.sessionKey, cliInput.sessionId, sessionCtx.messageCount);
      }

      // Held-back text (json_object) goes out here, fence removed.
      if (jsonMode.bufferText) {
        const content = contentFromResult(result, jsonMode, buffered);
        if (content) {
          sse.send(chunk({ content }));
          hasEmittedText = true;
        }
      }

      // A CLI that produced no partial messages — an older build, or one
      // whose answer arrived in a single block — would otherwise leave the
      // client with an empty stream. The same fallback covers a schema run
      // whose StructuredOutput call never streamed.
      if (!hasEmittedText) {
        const content = contentFromResult(result, jsonMode, "");
        if (content) {
          sse.send(chunk({ content }));
          hasEmittedText = true;
        }
      }

      const doneChunk = createDoneChunk(requestId, model(), finishReasonFromResult(result));
      if (result.usage) doneChunk.usage = usageFromResult(result);
      sse.send(doneChunk);
      sse.end();
      reap();
      finish();
    });

    subprocess.on("error", (error: Error) => {
      console.error("[Streaming] Error:", error.message);
      // Resume may have failed (e.g. stale/missing session) — drop it so the
      // next turn self-heals with a fresh full-history session
      if (sessionCtx.resume && sessionCtx.sessionKey) {
        clearSession(sessionCtx.sessionKey);
      }
      sse.fail(statusForError(error.message), error.message);
      finish();
    });

    subprocess.on("close", (code: number | null) => {
      if (isComplete) {
        finish();
        return;
      }
      if (code !== 0) {
        if (sessionCtx.resume && sessionCtx.sessionKey) {
          clearSession(sessionCtx.sessionKey);
        }
        sse.fail(statusForError(""), `Claude CLI exited with code ${code} without a result`);
      } else {
        // Clean exit with nothing to say — still terminate the stream.
        sse.end();
      }
      finish();
    });

    // Start the subprocess
    subprocess
      .start(cliInput.prompt, {
        model: cliInput.model,
        sessionId: cliInput.sessionId,
        resume: sessionCtx.resume,
        jsonSchema: jsonMode.schema,
        systemSuffix: jsonMode.systemSuffix,
      })
      .catch((err: Error) => {
        console.error("[Streaming] Subprocess start error:", err.message);
        sse.fail(statusForError(err.message), err.message);
        finish();
      });
  });
}

/**
 * Handle non-streaming response
 */
async function handleNonStreamingResponse(
  res: Response,
  subprocess: ClaudeSubprocess,
  cliInput: ReturnType<typeof openaiToCli>,
  requestId: string,
  sessionCtx: SessionContext,
  config: ProxyConfig,
  body: OpenAIChatRequest,
  jsonMode: JsonMode
): Promise<void> {
  return new Promise((resolve) => {
    let responded = false;
    let lastAssistant: ClaudeCliAssistant | null = null;

    /**
     * Exactly one response per request. A timeout used to answer 500 and then
     * the subprocess `close` handler answered a second time, which Express
     * reports as "Cannot set headers after they are sent".
     */
    const respond = (send: () => void): void => {
      if (responded) return;
      responded = true;
      send();
      resolve();
    };

    subprocess.on("assistant", (message: ClaudeCliAssistant) => {
      lastAssistant = message;
    });

    subprocess.on("rate_limit", (event: ClaudeCliRateLimitEvent) => {
      if (!isRateLimited(event)) return;
      subprocess.kill();
      respond(() => {
        res
          .status(429)
          .set("Retry-After", String(retryAfterSeconds(event)))
          .json({
            error: {
              message: `Claude subscription rate limit reached (${event.rate_limit_info.status})`,
              type: "server_error",
              code: "rate_limit_exceeded",
            },
          });
      });
    });

    // Answer as soon as the CLI reports its result rather than waiting for
    // the process to exit, which on a wedged subprocess meant holding the
    // request open until the 15-minute timeout.
    subprocess.on("result", (result: ClaudeCliResult) => {
      if (sessionCtx.sessionKey && cliInput.sessionId) {
        setSession(sessionCtx.sessionKey, cliInput.sessionId, sessionCtx.messageCount);
      }
      const content = contentFromResult(
        result,
        jsonMode,
        lastAssistant ? extractTextContent(lastAssistant) : ""
      );
      respond(() => {
        res.json(cliResultToOpenai(result, requestId, { model: body.model, content }));
      });
      const timer = setTimeout(() => subprocess.kill(), config.streaming.resultGraceMs);
      timer.unref();
    });

    subprocess.on("error", (error: Error) => {
      console.error("[NonStreaming] Error:", error.message);
      if (sessionCtx.resume && sessionCtx.sessionKey) {
        clearSession(sessionCtx.sessionKey);
      }
      respond(() => {
        res.status(statusForError(error.message)).json({
          error: { message: error.message, type: "server_error", code: null },
        });
      });
    });

    subprocess.on("close", (code: number | null) => {
      if (responded) {
        resolve();
        return;
      }
      if (sessionCtx.resume && sessionCtx.sessionKey) {
        clearSession(sessionCtx.sessionKey);
      }
      respond(() => {
        res.status(500).json({
          error: {
            message: `Claude CLI exited with code ${code} without response`,
            type: "server_error",
            code: null,
          },
        });
      });
    });

    // Start the subprocess
    subprocess
      .start(cliInput.prompt, {
        model: cliInput.model,
        sessionId: cliInput.sessionId,
        resume: sessionCtx.resume,
        jsonSchema: jsonMode.schema,
        systemSuffix: jsonMode.systemSuffix,
      })
      .catch((error: Error) => {
        respond(() => {
          res.status(statusForError(error.message)).json({
            error: { message: error.message, type: "server_error", code: null },
          });
        });
      });
  });
}

/**
 * Handle GET /v1/models
 *
 * Returns available models
 */
export function handleModels(_req: Request, res: Response): void {
  const now = Math.floor(Date.now() / 1000);
  const modelIds = [
    "claude-opus-4",
    "claude-opus-4-6",
    "claude-sonnet-4",
    "claude-sonnet-4-5",
    "claude-sonnet-4-6",
    "claude-sonnet-5",
    "claude-opus-5",
    "claude-haiku-4",
    "claude-haiku-4-5",
  ];
  res.json({
    object: "list",
    data: modelIds.map((id) => ({
      id,
      object: "model",
      owned_by: "anthropic",
      created: now,
    })),
  });
}

/**
 * Handle GET /health
 *
 * Health check endpoint
 */
export function handleHealth(_req: Request, res: Response): void {
  res.json({
    status: "ok",
    provider: "claude-code-cli",
    timestamp: new Date().toISOString(),
  });
}
