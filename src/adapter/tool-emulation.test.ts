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

  it("fences the list in tags the model can see the end of", () => {
    const prompt = toolsPrompt([WRITE, READ], "auto");
    const open = prompt.indexOf("<available_tools>");
    const close = prompt.indexOf("</available_tools>");
    assert.ok(open >= 0 && close > open, "expected the list to be fenced");
    assert.ok(prompt.indexOf("daily_write") > open, "names belong inside the fence");
    assert.ok(prompt.indexOf("### read") < close, "names belong inside the fence");
  });

  it("repeats the frame after the list, not only before it", () => {
    // On a long list the opening frame is thousands of tokens behind by the
    // time the model reaches the end, and it starts trying to run the tools.
    const prompt = toolsPrompt([WRITE, READ], "auto");
    const close = prompt.indexOf("</available_tools>");
    assert.match(prompt.slice(0, prompt.indexOf("<available_tools>")), /do not execute anything yourself/i);
    assert.match(prompt.slice(close), /caller's tools, not yours/i);
    assert.match(prompt.slice(close), /no(ne)? of your own/i);
  });

  it("forbids the refusal we actually saw", () => {
    // "No such tool available", relayed as prose, on a turn that called nothing.
    const prompt = toolsPrompt([WRITE], "auto");
    assert.match(prompt, /never reply that a tool is unavailable/i);
    assert.match(prompt, /never try to invoke one/i);
  });

  it("keeps every name on a list the size ReMe actually sends", () => {
    const many: OpenAIFunctionTool[] = Array.from({ length: 31 }, (_, i) => ({
      type: "function",
      function: {
        name: `tool_${i}`,
        description: `Tool number ${i}`,
        parameters: {
          type: "object",
          properties: { path: { type: "string" }, limit: { type: "integer" } },
          required: ["path"],
        },
      },
    }));

    const prompt = toolsPrompt(many, "auto");
    for (const tool of many) assert.match(prompt, new RegExp(`### ${tool.function.name}\\b`));

    const schema = buildToolSchema(many, "auto") as any;
    assert.deepEqual(
      schema.properties.tool_calls.items.properties.name.enum,
      many.map((t) => t.function.name)
    );
  });
});

describe("parseEmulatedAnswer", () => {
  it("reads a plain answer", () => {
    const answer = parseEmulatedAnswer({ kind: "message", content: "готово" });
    assert.deepEqual(answer, { content: "готово", toolCalls: [], issues: [] });
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
    assert.deepEqual(answer, { content: "", toolCalls: [], issues: ["empty_tool_call"] });
  });

  it("skips entries with no name rather than failing the turn", () => {
    const answer = parseEmulatedAnswer({
      kind: "tool_call",
      tool_calls: [{ arguments: {} }, { name: "read", arguments: {} }],
    });
    assert.equal(answer?.toolCalls.length, 1);
    assert.deepEqual(answer?.issues, ["nameless_entry"]);
  });

  it("reports a name the request never offered, without dropping the call", () => {
    // Passing it through is the old behaviour and stays; what is new is that
    // the caller now hears about it.
    const answer = parseEmulatedAnswer(
      { kind: "tool_call", tool_calls: [{ name: "rm_rf", arguments: {} }] },
      ["daily_write", "read"]
    );
    assert.equal(answer?.toolCalls[0].function.name, "rm_rf");
    assert.deepEqual(answer?.issues, ["unknown_tool"]);
  });

  it("says nothing is wrong when the call is one of the offered names", () => {
    const answer = parseEmulatedAnswer(
      { kind: "tool_call", tool_calls: [{ name: "read", arguments: {} }] },
      ["daily_write", "read"]
    );
    assert.deepEqual(answer?.issues, []);
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
