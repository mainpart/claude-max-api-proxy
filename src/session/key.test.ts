import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { lookupKeys, profileHash, storeKeys } from "./key.js";
import type { OpenAIChatMessage } from "../types/openai.js";

const user = (content: string): OpenAIChatMessage => ({ role: "user", content });
const assistant = (content: string): OpenAIChatMessage => ({ role: "assistant", content });
const system = (content: string): OpenAIChatMessage => ({ role: "system", content });

describe("session keys", () => {
  it("a stored turn is found by the request that follows it", () => {
    const turn1 = [system("Be terse."), user("first question")];
    const stored = storeKeys(turn1, "first answer");

    const turn2 = [...turn1, assistant("first answer"), user("second question")];
    const lookup = lookupKeys(turn2);

    assert.equal(lookup.prefix, stored.prefix);
    assert.equal(lookup.anchor, stored.anchor);
    assert.equal(lookup.anchorIndex, 3, "the new turn starts after the last assistant");
    assert.equal(stored.messageCount, 3);
  });

  it("the anchor survives a client that drops old history", () => {
    const full = [user("q1"), assistant("a1"), user("q2")];
    const stored = storeKeys(full, "a2");

    const truncated = [user("q2"), assistant("a2"), user("q3")];
    const lookup = lookupKeys(truncated);

    assert.equal(lookup.anchor, stored.anchor, "anchor matches");
    assert.notEqual(lookup.prefix, stored.prefix, "the prefix does not, and should not");
  });

  it("ignores cosmetic whitespace but not content", () => {
    const a = lookupKeys([user("hello   there"), assistant("hi"), user("x")]);
    const b = lookupKeys([user("hello there"), assistant("hi"), user("x")]);
    const c = lookupKeys([user("hello here"), assistant("hi"), user("x")]);

    assert.equal(a.prefix, b.prefix);
    assert.notEqual(a.prefix, c.prefix);
  });

  it("separates two conversations that end with the same reply", () => {
    const a = storeKeys([user("deploy the app")], "Done.");
    const b = storeKeys([user("delete the branch")], "Done.");
    assert.notEqual(a.anchor, b.anchor, "the anchor is a pair for exactly this reason");
  });

  it("has no prefix or anchor on a first turn", () => {
    const keys = lookupKeys([user("hello")]);
    assert.equal(keys.prefix, undefined);
    assert.equal(keys.anchor, undefined);
  });

  it("keys the same content identically whether it is a string or blocks", () => {
    const plain = storeKeys([user("hello")], "hi");
    const blocks = storeKeys(
      [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      "hi"
    );
    assert.equal(plain.prefix, blocks.prefix);
  });

  it("profileHash ignores the model but not the flags", () => {
    const base = { cwd: "/w", tools: "", preset: "economy", extraArgs: [] as string[] };
    assert.equal(profileHash(base), profileHash({ ...base }));
    assert.notEqual(profileHash(base), profileHash({ ...base, preset: "agent" }));
    assert.notEqual(profileHash(base), profileHash({ ...base, tools: null }));
    assert.notEqual(profileHash(base), profileHash({ ...base, extraArgs: ["--add-dir", "/t"] }));
  });
});
