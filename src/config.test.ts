import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import {
  ConfigError,
  DEFAULTS,
  DEFAULT_WORKSPACE,
  assertSafeArgs,
  parseArgv,
  readEnvLayer,
  resolveConfig,
  resolveCwd,
  splitArgs,
} from "./config.js";


describe("config", () => {
  let dir: string;

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "claude-proxy-config-"));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("falls back to defaults when nothing is configured", () => {
    const config = resolveConfig({ argv: [], env: {}, skipFile: true });
    assert.deepEqual(config, DEFAULTS);
  });

  it("keeps the legacy positional port", () => {
    const config = resolveConfig({ argv: ["4000"], env: {}, skipFile: true });
    assert.equal(config.port, 4000);
  });

  it("accepts both --flag value and --flag=value", () => {
    assert.equal(parseArgv(["--port", "4001"]).layer.port, 4001);
    assert.equal(parseArgv(["--port=4002"]).layer.port, 4002);
  });

  it("collects repeatable --extra-arg and --bin-arg", () => {
    const { layer } = parseArgv(["--extra-arg", "--foo", "--bin-arg", "wrapper.js"]);
    assert.deepEqual(layer.extraArgs, ["--foo"]);
    assert.deepEqual(layer.binArgs, ["wrapper.js"]);
  });

  it("reads env with CLAUDE_PROXY_ prefixes", () => {
    const layer = readEnvLayer({
      CLAUDE_PROXY_PORT: "4100",
      CLAUDE_PROXY_PRESET: "economy",
      CLAUDE_PROXY_TOOLS: "",
      CLAUDE_PROXY_EXTRA_ARGS: '--add-dir "/tmp/a b"',
      CLAUDE_PROXY_THINKING: "reasoning_content",
    } as NodeJS.ProcessEnv);

    assert.equal(layer.port, 4100);
    assert.equal(layer.preset, "economy");
    assert.equal(layer.tools, "");
    assert.deepEqual(layer.extraArgs, ["--add-dir", "/tmp/a b"]);
    assert.equal(layer.streaming?.thinking, "reasoning_content");
  });

  it("layers file under env under argv", async () => {
    const file = path.join(dir, "config.json");
    await writeFile(
      file,
      JSON.stringify({ port: 1111, host: "0.0.0.0", timeoutMs: 1000 }),
      "utf8"
    );

    const config = resolveConfig({
      argv: ["--port", "3333"],
      env: { CLAUDE_PROXY_CONFIG: file, CLAUDE_PROXY_PORT: "2222", CLAUDE_PROXY_HOST: "::1" },
    });

    assert.equal(config.port, 3333, "argv wins");
    assert.equal(config.host, "::1", "env wins over file");
    assert.equal(config.timeoutMs, 1000, "file wins over defaults");
    assert.equal(config.preset, DEFAULTS.preset, "untouched keys keep defaults");
  });

  it("merges the streaming section one level deep", () => {
    const config = resolveConfig({
      argv: ["--thinking", "reasoning_content"],
      env: {},
      skipFile: true,
    });
    assert.equal(config.streaming.thinking, "reasoning_content");
    assert.equal(config.streaming.headerFlushMs, DEFAULTS.streaming.headerFlushMs);
  });

  it("rejects flags the proxy sets per request", () => {
    assert.throws(() => assertSafeArgs(["--resume"], "test"), ConfigError);
    assert.throws(() => assertSafeArgs(["--output-format=json"], "test"), ConfigError);
    assert.throws(
      () => resolveConfig({ argv: ["--extra-arg", "--session-id"], env: {}, skipFile: true }),
      ConfigError
    );
    assert.doesNotThrow(() => assertSafeArgs(["--add-dir", "/tmp"], "test"));
  });

  it("reports bad values instead of silently coercing them", () => {
    assert.throws(() => resolveConfig({ argv: ["--port", "70000"], env: {}, skipFile: true }), ConfigError);
    assert.throws(() => resolveConfig({ argv: ["--preset", "cheap"], env: {}, skipFile: true }), ConfigError);
    assert.throws(() => resolveConfig({ argv: ["--nope"], env: {}, skipFile: true }), ConfigError);
    assert.throws(() => resolveConfig({ argv: ["--port"], env: {}, skipFile: true }), ConfigError);
  });

  it("rejects unknown keys in a config file", async () => {
    const file = path.join(dir, "bad.json");
    await writeFile(file, JSON.stringify({ prot: 1234 }), "utf8");
    assert.throws(
      () => resolveConfig({ argv: [], env: { CLAUDE_PROXY_CONFIG: file } }),
      ConfigError
    );
  });

  it("fails loudly when an explicitly named config file is missing", () => {
    assert.throws(
      () => resolveConfig({ argv: ["--config", path.join(dir, "absent.json")], env: {} }),
      ConfigError
    );
  });

  it("splits quoted argument strings", () => {
    assert.deepEqual(splitArgs('--a "one two" --b \'three\''), ["--a", "one two", "--b", "three"]);
    assert.deepEqual(splitArgs("   "), []);
  });
});

describe("workspace", () => {
  let dir: string;

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "claude-proxy-workspace-"));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("defaults the subprocess cwd to a directory the proxy owns", () => {
    const config = resolveConfig({ argv: [], env: {}, skipFile: true });
    assert.equal(config.cwd, DEFAULT_WORKSPACE);
    assert.notEqual(config.cwd, "inherit");
  });

  it("still allows the old behaviour explicitly", async () => {
    const config = resolveConfig({ argv: ["--cwd", "inherit"], env: {}, skipFile: true });
    assert.equal(resolveCwd(config), await realpath(process.cwd()));
  });

  it("creates the working directory it hands to the CLI", async () => {
    const target = path.join(dir, "nested", "workspace");
    const config = resolveConfig({ argv: ["--cwd", target], env: {}, skipFile: true });
    // Resolved through symlinks: the CLI names its transcript folder after
    // the directory it actually runs in.
    assert.equal(resolveCwd(config), await realpath(target));
    await stat(target);
  });
});
