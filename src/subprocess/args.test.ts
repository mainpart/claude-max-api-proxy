import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ClaudeSubprocess } from "./manager.js";
import { DEFAULTS, resolveConfig } from "../config.js";
import type { ProxyConfig } from "../config.js";
import type { SubprocessOptions } from "./manager.js";

/** `buildArgs` is internal; tests reach it directly rather than via a spawn. */
function buildArgs(config: ProxyConfig, options: SubprocessOptions): string[] {
  const subprocess = new ClaudeSubprocess(config) as unknown as {
    buildArgs(options: SubprocessOptions): string[];
  };
  return subprocess.buildArgs(options);
}

function config(overrides: Partial<ProxyConfig> = {}): ProxyConfig {
  return { ...DEFAULTS, ...overrides };
}

describe("buildArgs", () => {
  it("keeps the protocol flags the stream parser depends on", () => {
    const args = buildArgs(config(), { model: "sonnet" });
    for (const flag of ["--print", "--verbose", "--include-partial-messages"]) {
      assert.ok(args.includes(flag), `expected ${flag}`);
    }
    assert.equal(args[args.indexOf("--output-format") + 1], "stream-json");
    assert.equal(args[args.indexOf("--model") + 1], "sonnet");
  });

  it("puts binArgs first and extraArgs before the session flags", () => {
    const args = buildArgs(
      config({ binArgs: ["/wrapper.js"], extraArgs: ["--add-dir", "/tmp"] }),
      { model: "haiku", sessionId: "abc", resume: true }
    );

    assert.equal(args[0], "/wrapper.js");
    assert.ok(args.indexOf("--add-dir") < args.indexOf("--resume"));
    assert.deepEqual(args.slice(-2), ["--resume", "abc"]);
  });

  it("omits --tools unless configured", () => {
    assert.ok(!buildArgs(config(), { model: "sonnet" }).includes("--tools"));

    const args = buildArgs(config({ tools: "" }), { model: "sonnet" });
    assert.equal(args[args.indexOf("--tools") + 1], "");
  });

  it("selects the session flag from the request", () => {
    const fresh = buildArgs(config(), { model: "sonnet", sessionId: "s1" });
    assert.deepEqual(fresh.slice(-2), ["--session-id", "s1"]);

    const resumed = buildArgs(config(), { model: "sonnet", sessionId: "s1", resume: true });
    assert.deepEqual(resumed.slice(-2), ["--resume", "s1"]);

    const anonymous = buildArgs(config(), { model: "sonnet" });
    assert.equal(anonymous.at(-1), "--no-session-persistence");
  });

  it("rebuilds every flag on resume, since the CLI inherits none of them", () => {
    const cfg = config({ tools: "", extraArgs: ["--add-dir", "/tmp"] });
    const first = buildArgs(cfg, { model: "sonnet", sessionId: "s1" });
    const resumed = buildArgs(cfg, { model: "sonnet", sessionId: "s1", resume: true });

    assert.deepEqual(first.slice(0, -2), resumed.slice(0, -2));
  });

  it("defaults reproduce the pre-config behaviour", () => {
    const args = buildArgs(resolveConfig({ argv: [], env: {}, skipFile: true }), {
      model: "opus",
    });

    assert.ok(args.includes("--dangerously-skip-permissions"));
    assert.ok(args.includes("--append-system-prompt"));
    assert.ok(!args.includes("--tools"));
    assert.ok(!args.includes("--safe-mode"));
  });
});
