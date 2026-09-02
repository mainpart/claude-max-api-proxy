/**
 * Index of conversations to persisted Claude CLI sessions.
 *
 * Resuming a session is what keeps the API-side prompt cache warm: the CLI
 * replays its own transcript and only the new turn is appended, instead of
 * the whole history arriving as a fresh prompt string every time.
 *
 * The index is written to disk, so a proxy restart does not silently start
 * every conversation over. It also holds a per-session mutex: resume used to
 * be rare, and is now the ordinary path, so two concurrent requests for one
 * conversation would otherwise fight over the same .jsonl transcript.
 */

import fs from "fs";
import path from "path";

export interface SessionEntry {
  claudeSessionId: string;
  /** Messages the CLI session holds, i.e. where the next delta starts. */
  messageCount: number;
  /** Configuration the session was created under; a change is a miss. */
  profileHash: string;
  lastUsed: number;
}

const SESSION_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours of inactivity
const PRUNE_INTERVAL_MS = 30 * 60 * 1000; // sweep every 30 minutes
const PERSIST_DEBOUNCE_MS = 250;

export class SessionIndex {
  private readonly entries = new Map<string, SessionEntry>();
  private readonly busy = new Set<string>();
  private readonly waiters = new Map<string, Array<() => void>>();
  private persistTimer: NodeJS.Timeout | null = null;
  private readonly pruneTimer: NodeJS.Timeout;

  constructor(
    private readonly filePath: string | null,
    private readonly ttlMs: number = SESSION_TTL_MS
  ) {
    this.load();
    this.pruneTimer = setInterval(() => this.prune(), PRUNE_INTERVAL_MS);
    this.pruneTimer.unref();
  }

  get(key: string): SessionEntry | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.lastUsed > this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    entry.lastUsed = Date.now();
    return entry;
  }

  /** Record one session under every key a later request might look it up by. */
  set(keys: Array<string | undefined>, entry: Omit<SessionEntry, "lastUsed">): void {
    const stored: SessionEntry = { ...entry, lastUsed: Date.now() };
    for (const key of keys) {
      if (key) this.entries.set(key, stored);
    }
    this.schedulePersist();
  }

  /** Forget a session, by key or by the CLI session id it points at. */
  clear(keyOrSessionId: string | undefined): void {
    if (!keyOrSessionId) return;
    let changed = this.entries.delete(keyOrSessionId);
    for (const [key, entry] of this.entries) {
      if (entry.claudeSessionId === keyOrSessionId) {
        this.entries.delete(key);
        changed = true;
      }
    }
    if (changed) this.schedulePersist();
  }

  /**
   * Take the lock on a CLI session.
   *
   * Returns null if the wait ran out, and the caller should then start a new
   * session with the full history rather than queue behind the holder: a
   * request that answers is better than one that waits.
   */
  async acquire(sessionId: string, timeoutMs: number): Promise<(() => void) | null> {
    if (!this.busy.has(sessionId)) {
      this.busy.add(sessionId);
      return this.releaser(sessionId);
    }

    return new Promise((resolve) => {
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const queue = this.waiters.get(sessionId);
        if (queue) {
          const at = queue.indexOf(waiter);
          if (at >= 0) queue.splice(at, 1);
        }
        resolve(null);
      }, timeoutMs);
      timer.unref();

      const waiter = () => {
        if (settled) return false;
        settled = true;
        clearTimeout(timer);
        this.busy.add(sessionId);
        resolve(this.releaser(sessionId));
        return true;
      };

      const queue = this.waiters.get(sessionId) ?? [];
      queue.push(waiter);
      this.waiters.set(sessionId, queue);
    });
  }

  /** Stop the background sweep — for tests and clean shutdown. */
  close(): void {
    clearInterval(this.pruneTimer);
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
      this.persist();
    }
  }

  private releaser(sessionId: string): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.busy.delete(sessionId);

      const queue = this.waiters.get(sessionId);
      while (queue && queue.length > 0) {
        const next = queue.shift()!;
        if ((next as unknown as () => boolean)()) return;
      }
      this.waiters.delete(sessionId);
    };
  }

  private prune(): void {
    const now = Date.now();
    let changed = false;
    for (const [key, entry] of this.entries) {
      if (now - entry.lastUsed > this.ttlMs) {
        this.entries.delete(key);
        changed = true;
      }
    }
    if (changed) this.schedulePersist();
  }

  private load(): void {
    if (!this.filePath) return;
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Record<string, SessionEntry>;
      const now = Date.now();
      for (const [key, entry] of Object.entries(parsed)) {
        if (!entry?.claudeSessionId) continue;
        if (now - (entry.lastUsed ?? 0) > this.ttlMs) continue;
        this.entries.set(key, entry);
      }
    } catch {
      // Missing or unreadable index: start empty. Losing it costs one cold
      // conversation, not correctness.
    }
  }

  private schedulePersist(): void {
    if (!this.filePath || this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persist();
    }, PERSIST_DEBOUNCE_MS);
    this.persistTimer.unref();
  }

  private persist(): void {
    if (!this.filePath) return;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.entries)));
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      console.error("[SessionIndex] Could not persist:", (err as Error).message);
    }
  }
}

const indexes = new Map<string, SessionIndex>();

/** One index per file, shared by every request that uses that file. */
export function getSessionIndex(filePath: string): SessionIndex {
  let index = indexes.get(filePath);
  if (!index) {
    index = new SessionIndex(filePath);
    indexes.set(filePath, index);
  }
  return index;
}

/** Drop the cached indexes — for tests. */
export function resetSessionIndexes(): void {
  for (const index of indexes.values()) index.close();
  indexes.clear();
}
