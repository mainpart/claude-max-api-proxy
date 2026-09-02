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

  it("omits --tools unless the preset or configuration asks for it", () => {
    assert.ok(!buildArgs(config({ preset: "agent" }), { model: "sonnet" }).includes("--tools"));

    const args = buildArgs(config({ preset: "agent", tools: "" }), { model: "sonnet" });
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

  it("reproduces the pre-preset behaviour under `agent`", () => {
    const args = buildArgs(config({ preset: "agent" }), { model: "opus" });

    assert.ok(args.includes("--dangerously-skip-permissions"));
    assert.match(args[args.indexOf("--append-system-prompt") + 1], /Tool Name Mapping/);
    assert.ok(!args.includes("--tools"));
    assert.ok(!args.includes("--safe-mode"));
    assert.ok(!args.includes("--system-prompt"));
  });
});

describe("presets", () => {
  it("economy strips the CLI down to a plain model", () => {
    const args = buildArgs(config({ preset: "economy" }), {
      model: "sonnet",
      systemPrompt: "You are terse.",
    });

    assert.ok(args.includes("--safe-mode"));
    assert.equal(args[args.indexOf("--system-prompt") + 1], "You are terse.");
    assert.equal(args[args.indexOf("--tools") + 1], "");
    assert.ok(!args.includes("--append-system-prompt"), "no OpenClaw tool map");
    assert.ok(!args.includes("--dangerously-skip-permissions"), "nothing to permit");
  });

  it("economy sends an empty system prompt when the client sent none", () => {
    const args = buildArgs(config({ preset: "economy" }), { model: "sonnet" });
    const index = args.indexOf("--system-prompt");
    assert.ok(index >= 0, "the flag is always present");
    assert.equal(args[index + 1], "");
  });

  it("keeps --tools next to a flag, because it is variadic", () => {
    const args = buildArgs(
      config({ preset: "economy", extraArgs: ["--add-dir", "/tmp"] }),
      { model: "sonnet", sessionId: "s1" }
    );

    const after = args[args.indexOf("--tools") + 2];
    assert.ok(after.startsWith("-"), `expected a flag after --tools "", got ${after}`);
  });

  it("lets configuration override the preset's tool set", () => {
    const args = buildArgs(config({ preset: "economy", tools: "Read,Bash" }), {
      model: "sonnet",
    });
    assert.equal(args[args.indexOf("--tools") + 1], "Read,Bash");
  });

  it("appends the json_object rule to whichever system prompt the preset uses", () => {
    const economy = buildArgs(config({ preset: "economy" }), {
      model: "sonnet",
      systemPrompt: "You are terse.",
      systemSuffix: "Reply with JSON.",
    });
    assert.equal(
      economy[economy.indexOf("--system-prompt") + 1],
      "You are terse.\n\nReply with JSON."
    );

    const agent = buildArgs(config({ preset: "agent" }), {
      model: "sonnet",
      systemSuffix: "Reply with JSON.",
    });
    assert.match(agent[agent.indexOf("--append-system-prompt") + 1], /Reply with JSON\.$/);
  });

  it("ships economy as the fork default", () => {
    assert.equal(resolveConfig({ argv: [], env: {}, skipFile: true }).preset, "economy");
  });
});
