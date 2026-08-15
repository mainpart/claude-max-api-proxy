import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { ClaudeSubprocess } from "./manager.js";

const WINDOWS_ONLY = process.platform !== "win32";
const WAIT_TIMEOUT_MS = 5_000;
const GENEROUS_REQUEST_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 100;

describe("Windows process-tree termination", { skip: WINDOWS_ONLY }, () => {
  let fixtureDir: string;
  let fixturePath: string;
  let previousClaudeBin: string | undefined;
  const cleanupPids = new Set<number>();

  before(async () => {
    previousClaudeBin = process.env.CLAUDE_BIN;
    fixtureDir = await mkdtemp(path.join(tmpdir(), "claude-process-tree-"));
    const descendantPath = path.join(fixtureDir, "descendant.cjs");
    fixturePath = path.join(fixtureDir, "process-tree.cjs");
    await writeFile(
      descendantPath,
      [
        'const { writeFileSync } = require("node:fs");',
        "writeFileSync(process.argv[2], \"ready\");",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      fixturePath,
      [
        'const { spawn } = require("node:child_process");',
        'const { existsSync, unlinkSync } = require("node:fs");',
        'const { join } = require("node:path");',
        'const readyPath = join(__dirname, `descendant-${process.pid}.ready`);',
        'try { unlinkSync(readyPath); } catch {}',
        `const descendant = spawn(process.execPath, [${JSON.stringify(descendantPath)}, readyPath], { detached: true, stdio: "ignore" });`,
        "descendant.unref();",
        "const readinessCheck = setInterval(() => {",
        "  if (!existsSync(readyPath)) return;",
        "  clearInterval(readinessCheck);",
        '  process.stdout.write(JSON.stringify({ descendantPid: descendant.pid }) + "\\n");',
        "}, 10);",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
      "utf8"
    );

    // Use a controlled binary for every ClaudeSubprocess in this suite.
    process.env.CLAUDE_BIN = process.execPath;
  });

  afterEach(async () => {
    await cleanupTrackedProcesses(cleanupPids);
  });

  after(async () => {
    let cleanupError: unknown;
    try {
      await cleanupTrackedProcesses(cleanupPids);
      if (cleanupPids.size > 0) {
        cleanupError = new Error(
          `failed to terminate fixture processes: ${[...cleanupPids].join(", ")}`
        );
      }
    } catch (error) {
      cleanupError = error;
    } finally {
      restoreEnvironmentVariable("CLAUDE_BIN", previousClaudeBin);
      try {
        await rm(fixtureDir, { recursive: true, force: true });
      } catch (error) {
        cleanupError = cleanupError
          ? new AggregateError([cleanupError, error], "fixture cleanup failed")
          : error;
      }
    }
    if (cleanupError) throw cleanupError;
  });

  it("demonstrates that killing only the direct child leaves its descendant alive", async () => {
    const parent = spawn(process.execPath, [fixturePath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    trackChild(parent, cleanupPids);
    const descendantPid = await readDescendantPid(parent);
    cleanupPids.add(descendantPid);

    assert.equal(parent.kill(), true, "the direct parent should accept termination");
    await waitForExit(parent);

    assert.equal(
      isProcessAlive(descendantPid),
      true,
      "direct-child termination should reproduce the leaked descendant"
    );
  });

  it("kills the full process tree when kill() is called", async () => {
    const subprocess = createFixtureSubprocess();
    const descendantPidPromise = readManagerDescendantPid(subprocess);
    subprocess.on("error", () => {});

    await subprocess.start("", { model: "haiku", timeout: WAIT_TIMEOUT_MS });
    const rootPid = trackManagerProcess(subprocess, cleanupPids);
    const descendantPid = await descendantPidPromise;
    cleanupPids.add(descendantPid);

    subprocess.kill();

    await waitForProcessToStop(rootPid);
    await waitForProcessToStop(descendantPid);
    assert.equal(isProcessAlive(rootPid), false);
    assert.equal(isProcessAlive(descendantPid), false);
  });

  it("kills the full process tree when the request times out", async () => {
    const subprocess = createFixtureSubprocess();
    const descendantPidPromise = readManagerDescendantPid(subprocess);
    const timeoutErrorPromise = new Promise<Error>((resolve) => {
      subprocess.once("error", resolve);
    });

    await subprocess.start("", {
      model: "haiku",
      timeout: GENEROUS_REQUEST_TIMEOUT_MS,
    });
    const rootPid = trackManagerProcess(subprocess, cleanupPids);
    const descendantPid = await descendantPidPromise;
    cleanupPids.add(descendantPid);
    const testable = subprocess as unknown as {
      armTimeout: (timeout: number) => void;
    };
    testable.armTimeout(REQUEST_TIMEOUT_MS);
    const timeoutError = await timeoutErrorPromise;

    assert.match(timeoutError.message, new RegExp(`Request timed out after ${REQUEST_TIMEOUT_MS}ms`));
    await waitForProcessToStop(rootPid);
    await waitForProcessToStop(descendantPid);
    assert.equal(isProcessAlive(rootPid), false);
    assert.equal(isProcessAlive(descendantPid), false);
  });

  it("keeps isKilled false when taskkill cannot launch", async () => {
    const subprocess = createFixtureSubprocess();
    const descendantPidPromise = readManagerDescendantPid(subprocess);
    subprocess.on("error", () => {});

    await subprocess.start("", {
      model: "haiku",
      timeout: GENEROUS_REQUEST_TIMEOUT_MS,
    });
    const rootPid = trackManagerProcess(subprocess, cleanupPids);
    const descendantPid = await descendantPidPromise;
    cleanupPids.add(descendantPid);

    const testable = subprocess as unknown as {
      process: ChildProcess | null;
      isKilled: boolean;
    };
    assert.ok(testable.process, "manager did not retain its root process");
    const managedProcess = testable.process;
    const originalKill = managedProcess.kill.bind(managedProcess);
    let directKillSucceeded = false;
    managedProcess.kill = ((signal?: NodeJS.Signals | number) => {
      directKillSucceeded = originalKill(signal);
      return directKillSucceeded;
    }) as ChildProcess["kill"];

    const previousSystemRoot = process.env.SystemRoot;
    try {
      process.env.SystemRoot = path.join(fixtureDir, "missing-system-root");
      subprocess.kill();
    } finally {
      restoreEnvironmentVariable("SystemRoot", previousSystemRoot);
    }

    assert.equal(directKillSucceeded, true, "direct child kill should succeed");
    assert.equal(testable.isKilled, false, "failed taskkill must not set isKilled");
    await waitForProcessToStop(rootPid);
    assert.equal(isProcessAlive(rootPid), false);
    assert.equal(
      isProcessAlive(descendantPid),
      true,
      "failed tree termination should leave the detached descendant for retry"
    );
  });

  function createFixtureSubprocess(): ClaudeSubprocess {
    const subprocess = new ClaudeSubprocess();
    const testable = subprocess as unknown as { buildArgs: () => string[] };
    testable.buildArgs = () => [fixturePath];
    return subprocess;
  }
});

function trackChild(child: ChildProcess, cleanupPids: Set<number>): number {
  const pid = child.pid;
  assert.equal(typeof pid, "number", "fixture root did not receive a PID");
  cleanupPids.add(pid as number);
  return pid as number;
}

function trackManagerProcess(
  subprocess: ClaudeSubprocess,
  cleanupPids: Set<number>
): number {
  const managed = subprocess as unknown as { process: ChildProcess | null };
  assert.ok(managed.process, "manager did not retain its root process");
  return trackChild(managed.process, cleanupPids);
}

function readManagerDescendantPid(subprocess: ClaudeSubprocess): Promise<number> {
  return withTimeout(
    new Promise<number>((resolve, reject) => {
      subprocess.on("message", (message: { descendantPid?: number }) => {
        if (typeof message.descendantPid !== "number") {
          reject(new Error("manager fixture reported an invalid descendant PID"));
          return;
        }
        resolve(message.descendantPid);
      });
    }),
    "manager fixture did not report its descendant PID"
  );
}

function readDescendantPid(parent: ChildProcess): Promise<number> {
  return withTimeout(
    new Promise<number>((resolve, reject) => {
      let stdout = "";
      parent.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
        const newline = stdout.indexOf("\n");
        if (newline !== -1) {
          try {
            const message = JSON.parse(stdout.slice(0, newline)) as {
              descendantPid?: number;
            };
            if (typeof message.descendantPid !== "number") {
              reject(new Error("fixture reported an invalid descendant PID"));
              return;
            }
            resolve(message.descendantPid);
          } catch (error) {
            reject(error);
          }
        }
      });
      parent.once("error", reject);
    }),
    "direct-child fixture did not report its descendant PID"
  );
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return withTimeout(
    new Promise<void>((resolve) => child.once("close", () => resolve())),
    "direct child did not exit"
  );
}

async function waitForProcessToStop(pid: number): Promise<void> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`process ${pid} was still alive after ${WAIT_TIMEOUT_MS}ms`);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function terminateTree(pid: number): Promise<boolean> {
  if (!isProcessAlive(pid)) return true;
  const taskkill = process.env.SystemRoot
    ? path.join(process.env.SystemRoot, "System32", "taskkill.exe")
    : "taskkill.exe";
  const result = spawnSync(taskkill, ["/PID", String(pid), "/T", "/F"], {
    stdio: "ignore",
    windowsHide: true,
  });
  if (result.error || result.status !== 0) return false;
  return waitForProcessToStopWithoutAssertion(pid);
}

async function cleanupTrackedProcesses(cleanupPids: Set<number>): Promise<void> {
  for (const pid of [...cleanupPids]) {
    if (await terminateTree(pid)) {
      cleanupPids.delete(pid);
    }
  }
}

async function waitForProcessToStopWithoutAssertion(pid: number): Promise<boolean> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !isProcessAlive(pid);
}

function restoreEnvironmentVariable(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), WAIT_TIMEOUT_MS);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}
