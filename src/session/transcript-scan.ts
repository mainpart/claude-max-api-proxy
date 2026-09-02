/**
 * Last-resort lookup: find a CLI session by reading the CLI's own transcripts.
 *
 * Used when the in-process index has nothing — a fresh proxy, or an index
 * file that was lost. A miss is always safe: the caller simply starts a new
 * session with the full history, which is what it would have done anyway.
 *
 * Two things make this affordable. The search is confined to the transcript
 * folder for the CLI's working directory, and to files touched within the
 * last hour — the API-side cache lives an hour, so an older session has
 * nothing left worth resuming into. And only the tail of each file is read:
 * a naive scan of one machine's transcripts was 1.2 GB and 2.5 seconds, while
 * fifty tails of 64 KB is about 3 MB.
 *
 * The tail, not the head. The first line of a transcript is often a service
 * record — queue-operation, ai-title, mode — rather than the first message.
 */

import fs from "fs/promises";
import os from "os";
import path from "path";
import { anchorFromTexts } from "./key.js";

const DEFAULT_MAX_AGE_MS = 60 * 60 * 1000;
const DEFAULT_MAX_FILES = 50;
const DEFAULT_TAIL_BYTES = 64 * 1024;
const DEFAULT_DEADLINE_MS = 250;
const NEGATIVE_TTL_MS = 5 * 60 * 1000;
const NEGATIVE_CACHE_LIMIT = 512;

/**
 * The CLI's own encoding of a working directory into a folder name: every
 * character that is not a letter or a digit becomes a dash. Verified against
 * paths containing dots and underscores.
 */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

export interface ScanOptions {
  /** Working directory the CLI runs in. */
  cwd: string;
  /** Anchor digest to look for. */
  anchor: string;
  projectsRoot?: string;
  maxAgeMs?: number;
  maxFiles?: number;
  tailBytes?: number;
  deadlineMs?: number;
  now?: number;
}

const missed = new Map<string, number>();

function rememberMiss(anchor: string, now: number): void {
  // A conversation that cannot be found would otherwise cause a scan on every
  // single turn.
  if (missed.size >= NEGATIVE_CACHE_LIMIT) missed.clear();
  missed.set(anchor, now);
}

function recentlyMissed(anchor: string, now: number): boolean {
  const at = missed.get(anchor);
  if (at === undefined) return false;
  if (now - at > NEGATIVE_TTL_MS) {
    missed.delete(anchor);
    return false;
  }
  return true;
}

/** Forget cached misses — for tests. */
export function resetScanCache(): void {
  missed.clear();
}

/** Session id whose transcript ends with this exchange, or null. */
export async function findSessionByAnchor(options: ScanOptions): Promise<string | null> {
  const now = options.now ?? Date.now();
  const {
    anchor,
    projectsRoot = path.join(os.homedir(), ".claude", "projects"),
    maxAgeMs = DEFAULT_MAX_AGE_MS,
    maxFiles = DEFAULT_MAX_FILES,
    tailBytes = DEFAULT_TAIL_BYTES,
    deadlineMs = DEFAULT_DEADLINE_MS,
  } = options;

  if (recentlyMissed(anchor, now)) return null;

  const deadline = now + deadlineMs;
  const dir = path.join(projectsRoot, encodeProjectDir(options.cwd));

  let candidates: Array<{ file: string; mtimeMs: number }>;
  try {
    const names = await fs.readdir(dir);
    const stats = await Promise.all(
      names
        .filter((name) => name.endsWith(".jsonl"))
        .map(async (name) => {
          const file = path.join(dir, name);
          try {
            const stat = await fs.stat(file);
            return { file, mtimeMs: stat.mtimeMs };
          } catch {
            return null;
          }
        })
    );
    candidates = stats
      .filter((s): s is { file: string; mtimeMs: number } => s !== null)
      .filter((s) => now - s.mtimeMs <= maxAgeMs)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, maxFiles);
  } catch {
    // No transcript folder for this directory yet.
    rememberMiss(anchor, now);
    return null;
  }

  for (const candidate of candidates) {
    if (Date.now() > deadline) break; // out of budget: a miss, which is safe
    try {
      const exchange = await readLastExchange(candidate.file, tailBytes);
      if (!exchange) continue;
      if (anchorFromTexts(exchange.user, exchange.assistant) !== anchor) continue;
      return exchange.sessionId ?? path.basename(candidate.file, ".jsonl");
    } catch {
      // Unreadable or unparsable file: skip it. The format is undocumented,
      // and a change to it must degrade to a miss, not to an error.
      continue;
    }
  }

  rememberMiss(anchor, now);
  return null;
}

interface Exchange {
  user: string;
  assistant: string;
  sessionId?: string;
}

/** The last user question and the answer to it, read from a file's tail. */
async function readLastExchange(file: string, tailBytes: number): Promise<Exchange | null> {
  const handle = await fs.open(file, "r");
  let text: string;
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - tailBytes);
    const length = size - start;
    if (length <= 0) return null;
    const buffer = Buffer.allocUnsafe(length);
    await handle.read(buffer, 0, length, start);
    text = buffer.toString("utf8");
    // A tail almost always begins mid-line.
    if (start > 0) text = text.slice(text.indexOf("\n") + 1);
  } finally {
    await handle.close();
  }

  const records: Array<Record<string, unknown>> = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed) as Record<string, unknown>);
    } catch {
      continue;
    }
  }

  let index = records.length - 1;
  while (index >= 0 && !isAssistantText(records[index])) index--;
  if (index < 0) return null;

  const sessionId = typeof records[index].sessionId === "string"
    ? (records[index].sessionId as string)
    : undefined;

  // An answer can span several assistant records (thinking, then text).
  const assistantParts: string[] = [];
  while (index >= 0 && records[index].type === "assistant") {
    const text = messageText(records[index]);
    if (text) assistantParts.unshift(text);
    index--;
  }

  while (index >= 0 && !isUserText(records[index])) index--;
  if (index < 0) return null;

  const user = messageText(records[index]);
  if (!user) return null;

  return { user, assistant: assistantParts.join("\n\n"), sessionId };
}

function isAssistantText(record: Record<string, unknown>): boolean {
  return record.type === "assistant" && messageText(record).length > 0;
}

/** A user record carrying an actual question, not a tool result. */
function isUserText(record: Record<string, unknown>): boolean {
  return record.type === "user" && messageText(record).length > 0;
}

function messageText(record: Record<string, unknown>): string {
  const message = record.message as { content?: unknown } | undefined;
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .filter((block): block is { type: string; text: string } => {
      return (
        typeof block === "object" &&
        block !== null &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string"
      );
    })
    .map((block) => block.text)
    .join("\n\n");
}
