/**
 * Configuration layer.
 *
 * Resolution order, lowest priority first: built-in defaults, a JSON config
 * file, environment variables, then command-line arguments. Every key is
 * optional at every layer; whatever is missing falls through to the layer
 * below.
 *
 * No dependency is added for this — the project ships with express and uuid
 * only, and an argv parser small enough to read in one screen is cheaper than
 * a dependency in a package meant to be audited before it is trusted with a
 * subscription.
 */

import fs from "fs";
import os from "os";
import path from "path";

export type Preset = "economy" | "agent";

/**
 * Ways of matching a request to an existing CLI session, tried in this order.
 *
 * - `user`: the OpenAI `user` field, when the client sends one.
 * - `anchor`: the last assistant message plus the user message before it.
 * - `prefix`: a hash of the whole history except the last message.
 * - `scan`: read the CLI's own transcripts, for a cold index.
 */
export const SESSION_STRATEGIES = ["user", "anchor", "prefix", "scan"] as const;
export type SessionStrategy = (typeof SESSION_STRATEGIES)[number];

/** How thinking blocks reach the client. */
export type ThinkingMode = "drop" | "reasoning_content";

export interface StreamingConfig {
  /**
   * Thinking blocks are dropped by default: most OpenAI clients render an
   * unknown field as nothing, and the visible text of a thinking block is
   * empty on sonnet-5 and opus-5 anyway.
   */
  thinking: ThinkingMode;
  /**
   * How long to hold SSE headers back waiting for the first event from the
   * CLI. Until they are flushed a startup failure can still be reported as an
   * honest HTTP status instead of a dead stream.
   */
  headerFlushMs: number;
  /**
   * Grace period after the CLI reports its `result` before the subprocess is
   * killed, so it can finish writing its session transcript.
   */
  resultGraceMs: number;
}

export interface ProxyConfig {
  port: number;
  host: string;
  /**
   * Working directory for the CLI subprocess. `"inherit"` means the proxy's
   * own cwd (the behaviour before this option existed).
   */
  cwd: string;
  timeoutMs: number;
  preset: Preset;
  /**
   * Value passed to `--tools`. `null` omits the flag entirely, leaving the
   * CLI's own default tool set in place. The empty string disables tools.
   */
  tools: string | null;
  /** Extra CLI flags, appended after the preset's own flags. */
  extraArgs: string[];
  /** Arguments placed before every CLI flag — for wrapper binaries and tests. */
  binArgs: string[];
  /** Where the session index is persisted across proxy restarts. */
  sessionIndexPath: string;
  /** Which lookups to try, in order. Narrow it for a stricter proxy. */
  sessionStrategy: SessionStrategy[];
  /**
   * How long a request waits for another request on the same session. On
   * expiry it starts a fresh session with the full history rather than queue.
   */
  sessionLockTimeoutMs: number;
  streaming: StreamingConfig;
}

/** Directory the proxy owns: workspace, session index, default config file. */
export const PROXY_HOME = path.join(os.homedir(), ".claude-max-api-proxy");

export const DEFAULT_CONFIG_PATH = path.join(PROXY_HOME, "config.json");

/**
 * Working directory the proxy gives the CLI unless told otherwise.
 *
 * A dedicated empty directory means: the proxy's transcripts stay out of the
 * user's interactive sessions, there is no CLAUDE.md or git status to pull
 * into the context, and a run with tools enabled cannot wander into whatever
 * repository the proxy happened to be started from.
 */
export const DEFAULT_WORKSPACE = path.join(PROXY_HOME, "workspace");

export const DEFAULTS: ProxyConfig = {
  port: 3456,
  host: "127.0.0.1",
  cwd: DEFAULT_WORKSPACE,
  timeoutMs: 900_000,
  // Fork default. Upstream keeps "agent", where economy is opt-in and nothing
  // changes for existing users; here the point of the fork is the cheap path,
  // so it is the default. Deliberately a one-line divergence.
  preset: "economy",
  tools: null,
  extraArgs: [],
  binArgs: [],
  sessionIndexPath: path.join(PROXY_HOME, "sessions.json"),
  sessionStrategy: [...SESSION_STRATEGIES],
  sessionLockTimeoutMs: 30_000,
  streaming: {
    thinking: "drop",
    headerFlushMs: 1_000,
    resultGraceMs: 2_000,
  },
};

/**
 * Flags the proxy owns. Letting any of them through from configuration would
 * not customise the CLI, it would break the protocol the proxy speaks to it:
 * the output format, the print mode, and session selection are all decided
 * per request from the request itself.
 */
const RESERVED_FLAGS = new Set([
  "-p",
  "--print",
  "--output-format",
  "--input-format",
  "--verbose",
  "--include-partial-messages",
  "--resume",
  "-r",
  "--session-id",
  "--continue",
  "-c",
  "--no-session-persistence",
  "--bg",
  "--cloud",
]);

export class ConfigError extends Error {}

/**
 * Reject flags that would break the proxy↔CLI protocol.
 *
 * This is not a security boundary — `extraArgs` can still start MCP servers
 * or widen the tool set, which is why it is only ever read from the config
 * file, the environment or argv, and never from an HTTP request body.
 */
export function assertSafeArgs(args: string[], source: string): void {
  for (const arg of args) {
    const flag = arg.split("=", 1)[0];
    if (RESERVED_FLAGS.has(flag)) {
      throw new ConfigError(
        `${source}: ${flag} is set by the proxy per request and cannot be overridden`
      );
    }
  }
}

function asPort(value: unknown, source: string): number {
  const port = typeof value === "number" ? value : parseInt(String(value), 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new ConfigError(`${source}: invalid port ${JSON.stringify(value)}`);
  }
  return port;
}

function asPositiveInt(value: unknown, source: string): number {
  const n = typeof value === "number" ? value : parseInt(String(value), 10);
  if (!Number.isInteger(n) || n < 0) {
    throw new ConfigError(
      `${source}: expected a non-negative integer, got ${JSON.stringify(value)}`
    );
  }
  return n;
}

function asPreset(value: unknown, source: string): Preset {
  if (value === "economy" || value === "agent") return value;
  throw new ConfigError(
    `${source}: preset must be "economy" or "agent", got ${JSON.stringify(value)}`
  );
}

function asThinking(value: unknown, source: string): ThinkingMode {
  if (value === "drop" || value === "reasoning_content") return value;
  throw new ConfigError(
    `${source}: streaming.thinking must be "drop" or "reasoning_content", got ${JSON.stringify(value)}`
  );
}

function asStrategies(value: unknown, source: string): SessionStrategy[] {
  const list = asStringArray(value, source);
  for (const item of list) {
    if (!SESSION_STRATEGIES.includes(item as SessionStrategy)) {
      throw new ConfigError(
        `${source}: unknown session strategy "${item}"; expected one of ${SESSION_STRATEGIES.join(", ")}`
      );
    }
  }
  return list as SessionStrategy[];
}

function asStringArray(value: unknown, source: string): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new ConfigError(`${source}: expected an array of strings`);
  }
  return value as string[];
}

function asString(value: unknown, source: string): string {
  if (typeof value !== "string") {
    throw new ConfigError(`${source}: expected a string`);
  }
  return value;
}

/**
 * Split a whitespace-separated argument list, honouring quotes so a flag
 * value containing spaces survives a trip through an environment variable.
 */
export function splitArgs(input: string): string[] {
  const out: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(input)) !== null) {
    out.push(match[1] ?? match[2] ?? match[3]);
  }
  return out;
}

/** A config layer: every key optional, `streaming` merged one level deep. */
export type ConfigLayer = Partial<Omit<ProxyConfig, "streaming">> & {
  streaming?: Partial<StreamingConfig>;
};

function validateLayer(raw: Record<string, unknown>, source: string): ConfigLayer {
  const layer: ConfigLayer = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined || value === null) {
      if (key !== "tools") continue;
    }
    switch (key) {
      case "port":
        layer.port = asPort(value, `${source}.port`);
        break;
      case "host":
        layer.host = asString(value, `${source}.host`);
        break;
      case "cwd":
        layer.cwd = asString(value, `${source}.cwd`);
        break;
      case "timeoutMs":
        layer.timeoutMs = asPositiveInt(value, `${source}.timeoutMs`);
        break;
      case "preset":
        layer.preset = asPreset(value, `${source}.preset`);
        break;
      case "tools":
        layer.tools = value === null ? null : asString(value, `${source}.tools`);
        break;
      case "extraArgs":
        layer.extraArgs = asStringArray(value, `${source}.extraArgs`);
        assertSafeArgs(layer.extraArgs, `${source}.extraArgs`);
        break;
      case "binArgs":
        layer.binArgs = asStringArray(value, `${source}.binArgs`);
        assertSafeArgs(layer.binArgs, `${source}.binArgs`);
        break;
      case "sessionIndexPath":
        layer.sessionIndexPath = asString(value, `${source}.sessionIndexPath`);
        break;
      case "sessionStrategy":
        layer.sessionStrategy = asStrategies(value, `${source}.sessionStrategy`);
        break;
      case "sessionLockTimeoutMs":
        layer.sessionLockTimeoutMs = asPositiveInt(value, `${source}.sessionLockTimeoutMs`);
        break;
      case "streaming": {
        if (typeof value !== "object" || Array.isArray(value)) {
          throw new ConfigError(`${source}.streaming: expected an object`);
        }
        const streaming: Partial<StreamingConfig> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
          if (v === undefined || v === null) continue;
          switch (k) {
            case "thinking":
              streaming.thinking = asThinking(v, source);
              break;
            case "headerFlushMs":
              streaming.headerFlushMs = asPositiveInt(v, `${source}.streaming.headerFlushMs`);
              break;
            case "resultGraceMs":
              streaming.resultGraceMs = asPositiveInt(v, `${source}.streaming.resultGraceMs`);
              break;
            default:
              throw new ConfigError(`${source}.streaming: unknown key "${k}"`);
          }
        }
        layer.streaming = streaming;
        break;
      }
      default:
        throw new ConfigError(`${source}: unknown key "${key}"`);
    }
  }
  return layer;
}

export function loadConfigFile(filePath: string): ConfigLayer {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new ConfigError(`config file ${filePath}: ${(err as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(`config file ${filePath}: ${(err as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ConfigError(`config file ${filePath}: expected a JSON object`);
  }
  return validateLayer(parsed as Record<string, unknown>, `config file ${filePath}`);
}

type EnvTarget = keyof ProxyConfig | "streaming.thinking" | "streaming.headerFlushMs" | "streaming.resultGraceMs";

const ENV_KEYS: Record<string, EnvTarget> = {
  CLAUDE_PROXY_PORT: "port",
  CLAUDE_PROXY_HOST: "host",
  CLAUDE_PROXY_CWD: "cwd",
  CLAUDE_PROXY_TIMEOUT_MS: "timeoutMs",
  CLAUDE_PROXY_PRESET: "preset",
  CLAUDE_PROXY_TOOLS: "tools",
  CLAUDE_PROXY_EXTRA_ARGS: "extraArgs",
  CLAUDE_PROXY_BIN_ARGS: "binArgs",
  CLAUDE_PROXY_SESSION_INDEX: "sessionIndexPath",
  CLAUDE_PROXY_SESSION_STRATEGY: "sessionStrategy",
  CLAUDE_PROXY_SESSION_LOCK_MS: "sessionLockTimeoutMs",
  CLAUDE_PROXY_THINKING: "streaming.thinking",
  CLAUDE_PROXY_HEADER_FLUSH_MS: "streaming.headerFlushMs",
  CLAUDE_PROXY_RESULT_GRACE_MS: "streaming.resultGraceMs",
};

export function readEnvLayer(env: NodeJS.ProcessEnv = process.env): ConfigLayer {
  const raw: Record<string, unknown> = {};
  const streaming: Record<string, unknown> = {};

  for (const [envKey, target] of Object.entries(ENV_KEYS)) {
    const value = env[envKey];
    if (value === undefined) continue;
    if (target === "extraArgs" || target === "binArgs") {
      raw[target] = splitArgs(value);
    } else if (target === "sessionStrategy") {
      raw[target] = value.split(",").map((s) => s.trim()).filter(Boolean);
    } else if (target.startsWith("streaming.")) {
      streaming[target.slice("streaming.".length)] = value;
    } else {
      raw[target] = value;
    }
  }
  if (Object.keys(streaming).length > 0) raw.streaming = streaming;

  return validateLayer(raw, "env");
}

export interface ArgvResult {
  layer: ConfigLayer;
  /** Explicit `--config <path>`, if given. */
  configPath?: string;
}

/**
 * Parse command-line arguments.
 *
 * Accepts `--flag value` and `--flag=value`. A bare first positional is the
 * port, which is how the standalone server has always been started.
 */
export function parseArgv(argv: string[]): ArgvResult {
  const raw: Record<string, unknown> = {};
  const streaming: Record<string, unknown> = {};
  const extraArgs: string[] = [];
  const binArgs: string[] = [];
  let configPath: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (!arg.startsWith("--")) {
      if (raw.port === undefined) {
        raw.port = arg; // legacy positional port
        continue;
      }
      throw new ConfigError(`argv: unexpected argument "${arg}"`);
    }

    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg : arg.slice(0, eq);
    const inlineValue = eq === -1 ? undefined : arg.slice(eq + 1);
    const takeValue = (): string => {
      if (inlineValue !== undefined) return inlineValue;
      const next = argv[++i];
      if (next === undefined) throw new ConfigError(`argv: ${name} needs a value`);
      return next;
    };

    switch (name) {
      case "--config": configPath = takeValue(); break;
      case "--port": raw.port = takeValue(); break;
      case "--host": raw.host = takeValue(); break;
      case "--cwd": raw.cwd = takeValue(); break;
      case "--timeout-ms": raw.timeoutMs = takeValue(); break;
      case "--preset": raw.preset = takeValue(); break;
      case "--tools": raw.tools = takeValue(); break;
      case "--session-index": raw.sessionIndexPath = takeValue(); break;
      case "--session-strategy":
        raw.sessionStrategy = takeValue().split(",").map((v) => v.trim()).filter(Boolean);
        break;
      case "--session-lock-ms": raw.sessionLockTimeoutMs = takeValue(); break;
      case "--thinking": streaming.thinking = takeValue(); break;
      case "--header-flush-ms": streaming.headerFlushMs = takeValue(); break;
      case "--result-grace-ms": streaming.resultGraceMs = takeValue(); break;
      case "--extra-arg": extraArgs.push(takeValue()); break;
      case "--bin-arg": binArgs.push(takeValue()); break;
      default:
        throw new ConfigError(`argv: unknown option "${name}"`);
    }
  }

  if (extraArgs.length > 0) raw.extraArgs = extraArgs;
  if (binArgs.length > 0) raw.binArgs = binArgs;
  if (Object.keys(streaming).length > 0) raw.streaming = streaming;

  return { layer: validateLayer(raw, "argv"), configPath };
}

function mergeLayers(base: ProxyConfig, layer: ConfigLayer): ProxyConfig {
  const { streaming, ...rest } = layer;
  return {
    ...base,
    ...rest,
    streaming: { ...base.streaming, ...streaming },
  };
}

export interface ResolveOptions {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  /** Programmatic overrides, applied last — used by embedders and tests. */
  overrides?: ConfigLayer;
  /** Skip reading any config file (tests). */
  skipFile?: boolean;
}

/**
 * Build the effective configuration: defaults, then file, then env, then
 * argv, then programmatic overrides.
 */
export function resolveConfig(options: ResolveOptions = {}): ProxyConfig {
  const env = options.env ?? process.env;
  const { layer: argvLayer, configPath: argvConfigPath } = parseArgv(options.argv ?? []);

  let config = DEFAULTS;

  if (!options.skipFile) {
    const filePath = argvConfigPath ?? env.CLAUDE_PROXY_CONFIG ?? DEFAULT_CONFIG_PATH;
    // A config file the user pointed at explicitly must exist; the default
    // one is allowed to be absent.
    const explicit = Boolean(argvConfigPath ?? env.CLAUDE_PROXY_CONFIG);
    if (explicit && !fs.existsSync(filePath)) {
      throw new ConfigError(`config file ${filePath}: not found`);
    }
    config = mergeLayers(config, loadConfigFile(filePath));
  }

  config = mergeLayers(config, readEnvLayer(env));
  config = mergeLayers(config, argvLayer);
  if (options.overrides) {
    const overrides = { ...options.overrides };
    if (overrides.extraArgs) assertSafeArgs(overrides.extraArgs, "overrides.extraArgs");
    if (overrides.binArgs) assertSafeArgs(overrides.binArgs, "overrides.binArgs");
    config = mergeLayers(config, overrides);
  }

  return config;
}

/**
 * Absolute working directory for the CLI subprocess, creating it when the
 * proxy owns it. `"inherit"` keeps the proxy's own cwd.
 */
export function resolveCwd(config: ProxyConfig): string {
  if (config.cwd === "inherit") return realpath(process.cwd());
  const dir = path.resolve(config.cwd);
  fs.mkdirSync(dir, { recursive: true });
  return realpath(dir);
}

/**
 * Resolve symlinks. The CLI names its transcript folder after the directory
 * it actually runs in, and on macOS /tmp is a link to /private/tmp — so a
 * proxy that keeps the unresolved path looks in a folder that does not exist.
 */
function realpath(dir: string): string {
  try {
    return fs.realpathSync(dir);
  } catch {
    return dir;
  }
}
