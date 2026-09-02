/**
 * Claude Code CLI Subprocess Manager
 *
 * Handles spawning, managing, and parsing output from Claude CLI subprocesses.
 * Uses spawn() instead of exec() to prevent shell injection vulnerabilities.
 */

import { spawn, spawnSync, ChildProcess } from "child_process";
import { EventEmitter } from "events";
import fs from "fs/promises";
import { readFileSync } from "fs";
import path from "path";
import type {
  ClaudeCliMessage,
  ClaudeCliAssistant,
  ClaudeCliInit,
  ClaudeCliRateLimitEvent,
  ClaudeCliResult,
  ClaudeCliStreamEvent,
} from "../types/claude-cli.js";
import {
  isAssistantMessage,
  isResultMessage,
  isContentDelta,
  isTextBlockStart,
  isToolUseBlockStart,
  isInputJsonDelta,
  isContentBlockStop,
  isMessageStart,
  isRateLimitEvent,
  isSystemInit,
  isThinkingDelta,
} from "../types/claude-cli.js";
import type { ClaudeModel } from "../adapter/openai-to-cli.js";
import { OPENCLAW_TOOL_MAPPING_PROMPT } from "./openclaw-prompt.js";
import type { ProxyConfig } from "../config.js";
import { DEFAULTS, resolveCwd } from "../config.js";

export interface SubprocessOptions {
  model: ClaudeModel;
  sessionId?: string;
  /** Resume an existing persisted session (sessionId) instead of creating a new one */
  resume?: boolean;
  /** Overrides `config.cwd` for this run. */
  cwd?: string;
  /** Overrides `config.timeoutMs` for this run. */
  timeout?: number;
  /** Serialised JSON Schema for `--json-schema`. */
  jsonSchema?: string;
  /** Extra wording appended to the system prompt for this request. */
  systemSuffix?: string;
  /** The client's own system message, passed verbatim in `economy`. */
  systemPrompt?: string;
}

export interface SubprocessEvents {
  message: (msg: ClaudeCliMessage) => void;
  init: (msg: ClaudeCliInit) => void;
  message_start: (event: ClaudeCliStreamEvent) => void;
  thinking_delta: (event: ClaudeCliStreamEvent) => void;
  rate_limit: (event: ClaudeCliRateLimitEvent) => void;
  assistant: (msg: ClaudeCliAssistant) => void;
  result: (result: ClaudeCliResult) => void;
  error: (error: Error) => void;
  close: (code: number | null) => void;
  raw: (line: string) => void;
}

const DEFAULT_TIMEOUT = 900000; // 15 minutes


/**
 * Resolve the real Claude CLI binary to spawn.
 *
 * On Windows, the global `claude` command is an npm shim (`claude.cmd`) that
 * just execs a bundled `claude.exe`. Running the shim requires `shell: true`,
 * which routes our argv through cmd.exe — and cmd.exe treats characters our
 * appended system prompt legitimately contains (`<`, `>`, `(`, `)`, `&`) as
 * redirection/grouping/chaining operators, corrupting the argument list that
 * follows (notably `--session-id`/`--resume`, which silently stop working).
 * Resolving straight to the `.exe` lets us spawn with `shell: false` and
 * skip cmd.exe entirely. Falls back to the shim (with shell:true) if the
 * `.exe` can't be located.
 */
let resolvedClaudeBin: { bin: string; shell: boolean } | null = null;

function resolveClaudeBin(): { bin: string; shell: boolean } {
  if (process.env.CLAUDE_BIN) {
    // Environment overrides are intentionally not cached. This lets callers
    // temporarily select a binary without contaminating later resolutions.
    return { bin: process.env.CLAUDE_BIN, shell: false };
  }

  if (resolvedClaudeBin) return resolvedClaudeBin;

  if (process.platform === "win32") {
    try {
      const where = spawnSync("where.exe", ["claude"], { encoding: "utf8" });
      const shimPath = (where.stdout || "")
        .split(/\r?\n/)
        .map((p) => p.trim())
        .find((p) => p.toLowerCase().endsWith(".cmd"));

      if (shimPath) {
        const shimDir = path.dirname(shimPath);
        const shimContent = readFileSync(shimPath, "utf8");
        const match = shimContent.match(/"%dp0%\\(.+?\.exe)"/i);
        if (match) {
          const exePath = path.join(shimDir, match[1]);
          resolvedClaudeBin = { bin: exePath, shell: false };
          return resolvedClaudeBin;
        }
      }
    } catch {
      // Fall through to shim fallback below
    }

    resolvedClaudeBin = { bin: "claude", shell: true };
    return resolvedClaudeBin;
  }

  resolvedClaudeBin = { bin: "claude", shell: false };
  return resolvedClaudeBin;
}

/**
 * Kill a process and its full descendant tree.
 *
 * `ChildProcess.kill()` only signals the direct child. On Windows this is
 * insufficient because the Claude CLI spawns its own subprocesses (e.g. for
 * Bash tool calls) that aren't part of a job object — killing just the
 * parent leaves them running in the background even after a client
 * disconnect or timeout. `taskkill /T` walks the whole tree instead.
 */
function killProcessTree(
  child: ChildProcess,
  signal: NodeJS.Signals = "SIGTERM"
): boolean {
  const pid = child.pid;
  if (!pid) return false;

  if (process.platform === "win32") {
    const taskkill = process.env.SystemRoot
      ? path.join(process.env.SystemRoot, "System32", "taskkill.exe")
      : "taskkill.exe";
    const result = spawnSync(taskkill, ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    if (!result.error && result.status === 0) {
      return true;
    }

    // If taskkill could not be started or rejected the request, still make a
    // best-effort attempt to stop the managed root process. This must not be
    // reported as a successful tree termination: descendants may still be
    // running, and callers must remain able to retry.
    try {
      child.kill(signal);
    } catch {}
    return false;
  }

  try {
    return child.kill(signal);
  } catch {
    // Process may have already exited
    return false;
  }
}

export class ClaudeSubprocess extends EventEmitter {
  private process: ChildProcess | null = null;
  private buffer: string = "";
  private timeoutId: NodeJS.Timeout | null = null;
  private isKilled: boolean = false;
  private spawnFailed: boolean = false;
  private readonly config: ProxyConfig;

  constructor(config: ProxyConfig = DEFAULTS) {
    super();
    this.config = config;
  }

  /**
   * Start the Claude CLI subprocess with the given prompt
   */
  async start(prompt: string, options: SubprocessOptions): Promise<void> {
    const args = this.buildArgs(options);
    const timeout = options.timeout ?? this.config.timeoutMs ?? DEFAULT_TIMEOUT;
    const cwd = options.cwd ?? resolveCwd(this.config);
    if (process.env.DEBUG_SUBPROCESS) {
      console.error(`[Subprocess] args: ${JSON.stringify(args)}`);
      console.error(`[Subprocess] prompt: ${prompt.slice(0, 200)}`);
    }

    return new Promise((resolve, reject) => {
      try {
        // Use spawn() for security - no shell interpretation
        const { bin, shell } = resolveClaudeBin();
        this.process = spawn(bin, args, {
          cwd,
          env: Object.fromEntries(
            Object.entries(process.env).filter(([k]) => k !== "CLAUDECODE")
          ),
          stdio: ["pipe", "pipe", "pipe"],
          shell,
        });

        this.armTimeout(timeout);

        // Handle spawn errors (e.g., claude not found)
        this.process.on("error", (err) => {
          this.clearTimeout();
          // A process that never started also emits "close", with a synthetic
          // exit code. Reporting that instead of the spawn failure would tell
          // the caller "exited with code -2" where the truth is "no binary".
          this.spawnFailed = true;

          const startError = err.message.includes("ENOENT")
            ? new Error(
                "Claude CLI not found. Install with: npm install -g @anthropic-ai/claude-code"
              )
            : err;

          // start() resolves as soon as the process is spawned, because the
          // caller streams from there on. A spawn failure arrives after that,
          // when rejecting the promise is already a no-op, so it has to reach
          // the caller as an event too.
          reject(startError);
          if (this.listenerCount("error") > 0) {
            this.emit("error", startError);
          }
        });

        // Pass prompt via stdin to avoid E2BIG on large inputs
        this.process.stdin?.write(prompt);
        this.process.stdin?.end();

        if (process.env.DEBUG_SUBPROCESS) {
          console.error(`[Subprocess] Process spawned with PID: ${this.process.pid}`);
        }

        // Parse JSON stream from stdout
        this.process.stdout?.on("data", (chunk: Buffer) => {
          const data = chunk.toString();
          if (process.env.DEBUG_SUBPROCESS) {
            console.error(`[Subprocess] Received ${data.length} bytes of stdout`);
          }
          this.buffer += data;
          this.processBuffer();
        });

        // Capture stderr for debugging
        this.process.stderr?.on("data", (chunk: Buffer) => {
          const errorText = chunk.toString().trim();
          if (errorText) {
            // Don't emit as error unless it's actually an error
            // Claude CLI may write debug info to stderr
            if (process.env.DEBUG_SUBPROCESS) {
              console.error("[Subprocess stderr]:", errorText.slice(0, 200));
            }
          }
        });

        // Handle process close
        this.process.on("close", (code) => {
          if (process.env.DEBUG_SUBPROCESS) {
            console.error(`[Subprocess] Process closed with code: ${code}`);
          }
          this.clearTimeout();
          // Process any remaining buffer
          if (this.buffer.trim()) {
            this.processBuffer();
          }
          if (this.spawnFailed) return;
          this.emit("close", code);
        });

        // Resolve immediately since we're streaming
        resolve();
      } catch (err) {
        this.clearTimeout();
        reject(err);
      }
    });
  }

  /**
   * Build CLI arguments array.
   *
   * Order matters: wrapper arguments first, then the flags the proxy needs to
   * speak its protocol, then the preset and configured flags, then the user's
   * own `extraArgs`, and finally session selection. Session flags go last so
   * that `extraArgs` cannot displace them, and the whole set is rebuilt from
   * configuration on every run — including `--resume`, where the CLI inherits
   * nothing from the session being resumed.
   */
  private buildArgs(options: SubprocessOptions): string[] {
    const args = [
      ...this.config.binArgs,
      "--print", // Non-interactive mode
      "--output-format",
      "stream-json", // JSON streaming output
      "--verbose", // Required for stream-json
      "--include-partial-messages", // Enable streaming chunks
      "--model",
      options.model, // Model alias (opus/sonnet/haiku)
      // Prompt is passed via stdin (avoids E2BIG on large inputs)
    ];

    if (options.jsonSchema) {
      args.push("--json-schema", options.jsonSchema);
    }

    args.push(...this.presetArgs(options));
    args.push(...this.config.extraArgs);

    // --tools is variadic, so it must be followed by something starting with
    // a dash. Session flags always are; an arbitrary extraArgs value is not.
    args.push(...this.toolsArgs());

    if (options.sessionId && options.resume) {
      // Continue a previously persisted session — avoids replaying full history
      args.push("--resume", options.sessionId);
    } else if (options.sessionId) {
      // First turn for this session key — create it under a known ID so we
      // can --resume it on subsequent turns
      args.push("--session-id", options.sessionId);
    } else {
      // No stable session key (e.g. request.user missing) — don't leave
      // orphaned session files behind
      args.push("--no-session-persistence");
    }

    return args;
  }

  /**
   * Flags contributed by the active preset.
   *
   * `economy` asks the CLI to behave as a plain model behind HTTP: --safe-mode
   * drops the user's customisations (CLAUDE.md, memory, skills, MCP servers),
   * and --system-prompt replaces the built-in Claude Code prompt with whatever
   * the client sent — an empty string when it sent nothing, which removes the
   * system block entirely.
   *
   * `agent` reproduces the behaviour this proxy had before presets existed.
   */
  private presetArgs(options: SubprocessOptions): string[] {
    if (this.config.preset === "economy") {
      const system = [options.systemPrompt, options.systemSuffix]
        .filter(Boolean)
        .join("\n\n");
      return ["--safe-mode", "--system-prompt", system];
    }

    const appended = [OPENCLAW_TOOL_MAPPING_PROMPT, options.systemSuffix]
      .filter(Boolean)
      .join("\n\n");

    return [
      "--dangerously-skip-permissions", // Skip permission prompts
      "--append-system-prompt",
      appended,
    ];
  }

  /**
   * `--tools`, when there is anything to say. Configuration wins; otherwise
   * `economy` disables tools and `agent` leaves the CLI's own set alone.
   */
  private toolsArgs(): string[] {
    if (this.config.tools !== null) return ["--tools", this.config.tools];
    if (this.config.preset === "economy") return ["--tools", ""];
    return [];
  }

  /**
   * Process the buffer and emit parsed messages
   */
  private processBuffer(): void {
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() || ""; // Keep incomplete line

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const message: ClaudeCliMessage = JSON.parse(trimmed);
        this.emit("message", message);

        // Both carry the model, and both arrive before any text delta —
        // unlike the `assistant` message, which only lands after them.
        if (isSystemInit(message)) {
          this.emit("init", message);
        }

        if (isMessageStart(message)) {
          this.emit("message_start", message);
        }

        if (isRateLimitEvent(message)) {
          this.emit("rate_limit", message);
        }

        if (isThinkingDelta(message)) {
          this.emit("thinking_delta", message as ClaudeCliStreamEvent);
        }

        if (isTextBlockStart(message)) {
          // Emit when a new text content block starts (for inserting separators)
          this.emit("text_block_start", message as ClaudeCliStreamEvent);
        }

        if (isToolUseBlockStart(message)) {
          this.emit("tool_use_start", message as ClaudeCliStreamEvent);
        }

        if (isInputJsonDelta(message)) {
          this.emit("input_json_delta", message as ClaudeCliStreamEvent);
        }

        if (isContentBlockStop(message)) {
          this.emit("content_block_stop", message as ClaudeCliStreamEvent);
        }

        if (isContentDelta(message)) {
          // Emit content delta for streaming (text_delta only)
          this.emit("content_delta", message as ClaudeCliStreamEvent);
        } else if (isAssistantMessage(message)) {
          this.emit("assistant", message);
        } else if (isResultMessage(message)) {
          this.emit("result", message);
        }
      } catch {
        // Non-JSON output, emit as raw
        this.emit("raw", trimmed);
      }
    }
  }

  /**
   * Clear the timeout timer
   */
  private clearTimeout(): void {
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
  }

  /**
   * Kill the subprocess
   */
  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    if (!this.isKilled && this.process) {
      this.clearTimeout();
      this.isKilled = killProcessTree(this.process, signal);
    }
  }

  /**
   * Arm the request timeout. Kept narrow so tests can deterministically re-arm
   * the production timeout behavior after their fixture process tree is ready.
   */
  private armTimeout(timeout: number): void {
    this.clearTimeout();
    this.timeoutId = setTimeout(() => {
      if (!this.isKilled) {
        if (this.process) {
          this.isKilled = killProcessTree(this.process, "SIGTERM");
        }
        this.emit("error", new Error(`Request timed out after ${timeout}ms`));
      }
    }, timeout);
  }

  /**
   * Check if the process is still running
   */
  isRunning(): boolean {
    return this.process !== null && !this.isKilled && this.process.exitCode === null;
  }
}

/**
 * Verify that Claude CLI is installed and accessible
 */
export async function verifyClaude(): Promise<{ ok: boolean; error?: string; version?: string }> {
  return new Promise((resolve) => {
    const { bin, shell } = resolveClaudeBin();
    const proc = spawn(bin, ["--version"], { stdio: "pipe", shell });
    let output = "";

    proc.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });

    proc.on("error", () => {
      resolve({
        ok: false,
        error:
          "Claude CLI not found. Install with: npm install -g @anthropic-ai/claude-code",
      });
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve({ ok: true, version: output.trim() });
      } else {
        resolve({
          ok: false,
          error: "Claude CLI returned non-zero exit code",
        });
      }
    });
  });
}

/**
 * Check if Claude CLI is authenticated
 *
 * Claude Code stores credentials in the OS keychain, not a file.
 * We verify authentication by checking if we can call the CLI successfully.
 * If the CLI is installed, it typically has valid credentials from `claude auth login`.
 */
export async function verifyAuth(): Promise<{ ok: boolean; error?: string }> {
  // If Claude CLI is installed and the user has run `claude auth login`,
  // credentials are stored in the OS keychain and will be used automatically.
  // We can't easily check the keychain, so we'll just return true if the CLI exists.
  // Authentication errors will surface when making actual API calls.
  return { ok: true };
}
