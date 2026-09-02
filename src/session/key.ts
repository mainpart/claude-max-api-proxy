/**
 * Keys under which a conversation is looked up.
 *
 * Resume used to require `request.user`, an optional OpenAI field that many
 * clients never send. Without it the proxy replayed the whole history as one
 * prompt string on every turn, and the cache never hit — because the history
 * grew at the front of the prefix each time.
 *
 * Two keys are derived from the request itself instead:
 *
 * - the prefix key, a hash of every message but the last. Exact, and it
 *   changes if the client rewrites any earlier turn.
 * - the anchor key, a hash of the last assistant message together with the
 *   user message before it. It survives a client that truncates old history,
 *   and it is a pair rather than a single message because one message on its
 *   own collides between conversations — plenty of them end with "Done."
 *
 * The anchor also says where the new turn begins, computed from the request
 * rather than remembered, which is what makes it survive truncation.
 */

import { createHash } from "crypto";
import { extractText } from "../adapter/openai-to-cli.js";
import type { OpenAIChatMessage } from "../types/openai.js";

/** Collapse whitespace so cosmetic reformatting does not change the key. */
function canonical(message: OpenAIChatMessage): string {
  const text = extractText(message.content).replace(/\s+/g, " ").trim();
  return `${message.role}:${text}`;
}

/** First 16 bytes of sha256 — long enough here, short enough to read in a log. */
function digest(parts: string[]): string {
  return createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 32);
}

export interface LookupKeys {
  /** Absent on a first turn, where there is no prefix to hash. */
  prefix?: string;
  anchor?: string;
  /** Index in `messages` where the turn the CLI has not seen begins. */
  anchorIndex?: number;
}

/** Keys for finding the session that already holds this conversation. */
export function lookupKeys(messages: OpenAIChatMessage[]): LookupKeys {
  // A single-message request has no prefix. Hashing the empty list would give
  // one constant key shared by every first turn ever made.
  const prefix =
    messages.length > 1 ? digest(messages.slice(0, -1).map(canonical)) : undefined;

  const lastAssistant = findLastIndex(messages, (m) => m.role === "assistant");
  if (lastAssistant < 0) return { prefix };

  const lastUser = findLastIndex(messages.slice(0, lastAssistant), (m) => m.role === "user");
  if (lastUser < 0) return { prefix };

  return {
    prefix,
    anchor: digest([canonical(messages[lastUser]), canonical(messages[lastAssistant])]),
    anchorIndex: lastAssistant + 1,
  };
}

export interface StoreKeys {
  prefix: string;
  anchor?: string;
  /** Messages the CLI session now holds, including the answer just given. */
  messageCount: number;
}

/**
 * Keys for a turn that just finished. The client will send our answer back as
 * the last assistant message next time, so it is appended here to produce
 * exactly the keys that request will look up.
 */
export function storeKeys(messages: OpenAIChatMessage[], answer: string): StoreKeys {
  const assistant: OpenAIChatMessage = { role: "assistant", content: answer };
  const full = [...messages, assistant];
  const prefix = digest(full.map(canonical));
  const lastUser = findLastIndex(messages, (m) => m.role === "user");

  return {
    prefix,
    anchor:
      lastUser >= 0 ? digest([canonical(messages[lastUser]), canonical(assistant)]) : undefined,
    messageCount: full.length,
  };
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) {
    if (predicate(items[i])) return i;
  }
  return -1;
}

/**
 * Identity of the configuration a session was created under.
 *
 * The model is deliberately absent: switching model mid-conversation should
 * continue the conversation, not start a new one. Nor is the system prompt
 * part of it — a client is free to change that between turns, and the session
 * carries on, paying only a cache miss on that turn.
 */
export function profileHash(profile: {
  cwd: string;
  tools: string | null;
  preset: string;
  extraArgs: string[];
}): string {
  return digest([
    profile.cwd,
    String(profile.tools),
    profile.preset,
    profile.extraArgs.join(" "),
  ]);
}
