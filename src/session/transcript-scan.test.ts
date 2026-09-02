import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import {
  encodeProjectDir,
  findSessionByAnchor,
  resetScanCache,
} from "./transcript-scan.js";
import { anchorFromTexts } from "./key.js";

const CWD = "/private/tmp/claude_proxy.workspace";

let root: string;
let projectDir: string;

/**
 * Transcript records in the shape the CLI writes them, including the service
 * lines that make the first line of a file useless as a message.
 */
function transcript(sessionId: string, turns: Array<[string, string]>): string {
  const lines: unknown[] = [
    { type: "queue-operation", operation: "enqueue", sessionId },
    { type: "ai-title", aiTitle: "A conversation", sessionId },
  ];

  for (const [question, answer] of turns) {
    lines.push({ type: "user", message: { role: "user", content: question }, sessionId });
    lines.push({ type: "attachment", attachment: {}, sessionId });
    lines.push({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }] },
      sessionId,
    });
    lines.push({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: answer }] },
      sessionId,
    });
    lines.push({ type: "last-prompt", lastPrompt: question, sessionId });
  }

  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

async function writeTranscript(
  sessionId: string,
  turns: Array<[string, string]>,
  ageMs = 0
): Promise<string> {
  const file = path.join(projectDir, `${sessionId}.jsonl`);
  await writeFile(file, transcript(sessionId, turns), "utf8");
  if (ageMs > 0) {
    const when = new Date(Date.now() - ageMs);
    await utimes(file, when, when);
  }
  return file;
}

describe("transcript scan", () => {
  before(async () => {
    root = await mkdtemp(path.join(tmpdir(), "claude-proxy-scan-"));
    projectDir = path.join(root, encodeProjectDir(CWD));
    await mkdir(projectDir, { recursive: true });
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    resetScanCache();
  });

  it("encodes a working directory the way the CLI does", () => {
    assert.equal(encodeProjectDir("/private/tmp/a.b_c"), "-private-tmp-a-b-c");
  });

  it("finds the session whose transcript ends with this exchange", async () => {
    await writeTranscript("11111111-1111-4111-8111-111111111111", [
      ["question one", "answer one"],
      ["question two", "answer two"],
    ]);

    const found = await findSessionByAnchor({
      cwd: CWD,
      anchor: anchorFromTexts("question two", "answer two"),
      projectsRoot: root,
    });
    assert.equal(found, "11111111-1111-4111-8111-111111111111");
  });

  it("does not match an earlier exchange in the same file", async () => {
    const found = await findSessionByAnchor({
      cwd: CWD,
      anchor: anchorFromTexts("question one", "answer one"),
      projectsRoot: root,
    });
    assert.equal(found, null, "only the tail of a conversation can be resumed");
  });

  it("tells two conversations apart", async () => {
    await writeTranscript("22222222-2222-4222-8222-222222222222", [
      ["deploy the app", "Done."],
    ]);
    await writeTranscript("33333333-3333-4333-8333-333333333333", [
      ["delete the branch", "Done."],
    ]);

    assert.equal(
      await findSessionByAnchor({
        cwd: CWD,
        anchor: anchorFromTexts("delete the branch", "Done."),
        projectsRoot: root,
      }),
      "33333333-3333-4333-8333-333333333333"
    );
  });

  it("ignores transcripts older than the cache window", async () => {
    await writeTranscript(
      "44444444-4444-4444-8444-444444444444",
      [["stale question", "stale answer"]],
      2 * 60 * 60 * 1000
    );

    const found = await findSessionByAnchor({
      cwd: CWD,
      anchor: anchorFromTexts("stale question", "stale answer"),
      projectsRoot: root,
    });
    assert.equal(found, null);
  });

  it("reads the tail of a large file, not its head", async () => {
    const filler: Array<[string, string]> = Array.from({ length: 400 }, (_, i) => [
      `padding question ${i}`,
      "x".repeat(300),
    ]);
    await writeTranscript("55555555-5555-4555-8555-555555555555", [
      ...filler,
      ["the last question", "the last answer"],
    ]);

    const found = await findSessionByAnchor({
      cwd: CWD,
      anchor: anchorFromTexts("the last question", "the last answer"),
      projectsRoot: root,
    });
    assert.equal(found, "55555555-5555-4555-8555-555555555555");
  });

  it("misses quietly on a folder that does not exist", async () => {
    const found = await findSessionByAnchor({
      cwd: "/nowhere/at/all",
      anchor: anchorFromTexts("q", "a"),
      projectsRoot: root,
    });
    assert.equal(found, null);
  });

  it("misses quietly on a corrupt transcript", async () => {
    await writeFile(
      path.join(projectDir, "66666666-6666-4666-8666-666666666666.jsonl"),
      "not json at all\n{\n",
      "utf8"
    );
    const found = await findSessionByAnchor({
      cwd: CWD,
      anchor: anchorFromTexts("nothing", "here"),
      projectsRoot: root,
    });
    assert.equal(found, null);
  });

  it("caches a miss so a hopeless conversation does not rescan every turn", async () => {
    const anchor = anchorFromTexts("never written", "never answered");
    assert.equal(
      await findSessionByAnchor({ cwd: CWD, anchor, projectsRoot: root }),
      null
    );

    await writeTranscript("77777777-7777-4777-8777-777777777777", [
      ["never written", "never answered"],
    ]);

    assert.equal(
      await findSessionByAnchor({ cwd: CWD, anchor, projectsRoot: root }),
      null,
      "the cached miss stands until it expires"
    );

    resetScanCache();
    assert.equal(
      await findSessionByAnchor({ cwd: CWD, anchor, projectsRoot: root }),
      "77777777-7777-4777-8777-777777777777"
    );
  });
});
