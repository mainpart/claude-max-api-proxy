import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  activeTools,
  buildToolSchema,
  parseEmulatedAnswer,
  toolsPrompt,
} from "./tool-emulation.js";
import { InvalidRequestError, messagesToPrompt } from "./openai-to-cli.js";
import type { OpenAIFunctionTool } from "../types/openai.js";

const WRITE: OpenAIFunctionTool = {
  type: "function",
  function: {
    name: "daily_write",
    description: "Write a note",
    parameters: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
  },
};
const READ: OpenAIFunctionTool = {
  type: "function",
  function: { name: "read", description: "Read a note" },
};

describe("activeTools", () => {
  it("treats an absent, empty or withdrawn tool set as no tools at all", () => {
    assert.equal(activeTools(undefined, undefined), undefined);
    assert.equal(activeTools([], undefined), undefined);
    assert.equal(activeTools([WRITE], "none"), undefined);
  });

  it("passes a usable set through", () => {
    assert.deepEqual(activeTools([WRITE, READ], "auto"), [WRITE, READ]);
  });

  it("rejects an entry that is not a named function", () => {
    assert.throws(
      () => activeTools([{ type: "function", function: {} } as OpenAIFunctionTool], undefined),
      InvalidRequestError
    );
  });
});

describe("buildToolSchema", () => {
  it("offers both a plain answer and a call by default", () => {
    const schema = buildToolSchema([WRITE, READ], "auto") as any;
    assert.deepEqual(schema.properties.kind.enum, ["message", "tool_call"]);
    assert.deepEqual(schema.properties.tool_calls.items.properties.name.enum, [
      "daily_write",
      "read",
    ]);
  });

  it("removes the plain answer when a call is required", () => {
    const schema = buildToolSchema([WRITE, READ], "required") as any;
    assert.deepEqual(schema.properties.kind.enum, ["tool_call"]);
  });

  it("narrows to one name when the caller forces a tool", () => {
    const schema = buildToolSchema([WRITE, READ], {
      type: "function",
      function: { name: "read" },
    }) as any;
    assert.deepEqual(schema.properties.kind.enum, ["tool_call"]);
    assert.deepEqual(schema.properties.tool_calls.items.properties.name.enum, ["read"]);
  });

  it("refuses to force a tool the request never offered", () => {
    assert.throws(
      () => buildToolSchema([WRITE], { type: "function", function: { name: "nope" } }),
      InvalidRequestError
    );
  });
});

describe("toolsPrompt", () => {
  it("carries each name, its description and its argument schema", () => {
    const prompt = toolsPrompt([WRITE, READ], "auto");
    assert.match(prompt, /daily_write/);
    assert.match(prompt, /Write a note/);
    assert.match(prompt, /"required"/);
    assert.match(prompt, /read/);
  });

  it("says outright that the model executes nothing itself", () => {
    assert.match(toolsPrompt([WRITE], "auto"), /do not execute anything yourself/i);
  });

  it("drops the plain-answer option when a call is required", () => {
    assert.match(toolsPrompt([WRITE], "required"), /must call a tool/i);
  });
});

describe("parseEmulatedAnswer", () => {
  it("reads a plain answer", () => {
    const answer = parseEmulatedAnswer({ kind: "message", content: "готово" });
    assert.deepEqual(answer, { content: "готово", toolCalls: [] });
  });

  it("reads a call and serialises its arguments", () => {
    const answer = parseEmulatedAnswer({
      kind: "tool_call",
      tool_calls: [{ name: "daily_write", arguments: { name: "podeli-cdn" } }],
    });
    assert.equal(answer?.toolCalls.length, 1);
    assert.equal(answer?.toolCalls[0].function.name, "daily_write");
    assert.deepEqual(JSON.parse(answer!.toolCalls[0].function.arguments), {
      name: "podeli-cdn",
    });
    assert.match(answer!.toolCalls[0].id, /^call_/);
  });

  it("accepts arguments the model already serialised", () => {
    const answer = parseEmulatedAnswer({
      kind: "tool_call",
      tool_calls: [{ name: "read", arguments: '{"path":"a.md"}' }],
    });
    assert.deepEqual(JSON.parse(answer!.toolCalls[0].function.arguments), { path: "a.md" });
  });

  it("does not report a call when the list came back empty", () => {
    // Otherwise the client waits forever for a tool it was never named.
    const answer = parseEmulatedAnswer({ kind: "tool_call", tool_calls: [] });
    assert.deepEqual(answer, { content: "", toolCalls: [] });
  });

  it("skips entries with no name rather than failing the turn", () => {
    const answer = parseEmulatedAnswer({
      kind: "tool_call",
      tool_calls: [{ arguments: {} }, { name: "read", arguments: {} }],
    });
    assert.equal(answer?.toolCalls.length, 1);
  });

  it("returns nothing for a payload that is not the wrapper", () => {
    assert.equal(parseEmulatedAnswer({ city: "Paris" }), undefined);
    assert.equal(parseEmulatedAnswer("text"), undefined);
    assert.equal(parseEmulatedAnswer(null), undefined);
    assert.equal(parseEmulatedAnswer([1, 2]), undefined);
  });
});

describe("messagesToPrompt with a tool round trip", () => {
  it("replays the calls made and the results that came back", () => {
    const prompt = messagesToPrompt([
      { role: "user", content: "запиши заметку" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "daily_write", arguments: '{"name":"podeli-cdn"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", name: "daily_write", content: "Wrote 182 bytes" },
    ]);

    assert.match(prompt, /<tool_call name="daily_write">\{"name":"podeli-cdn"\}<\/tool_call>/);
    assert.match(prompt, /<tool_result name="daily_write">\nWrote 182 bytes\n<\/tool_result>/);
  });

  it("leaves an assistant turn out entirely when it carried nothing", () => {
    const prompt = messagesToPrompt([
      { role: "user", content: "привет" },
      { role: "assistant", content: null },
    ]);
    assert.doesNotMatch(prompt, /previous_response/);
  });
});
