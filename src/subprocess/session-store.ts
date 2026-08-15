/**
 * In-memory mapping from OpenAI request.user (Hermes conversation key) to a
 * persisted Claude CLI session. Lets the proxy --resume an existing CLI
 * session instead of cold-starting a fresh one and replaying the entire
 * message history on every request.
 */

interface SessionEntry {
  claudeSessionId: string;
  messageCount: number;
  lastUsed: number;
}

const SESSION_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours of inactivity
const PRUNE_INTERVAL_MS = 30 * 60 * 1000; // sweep every 30 minutes

const sessions = new Map<string, SessionEntry>();

function pruneExpired(): void {
  const now = Date.now();
  for (const [key, entry] of sessions) {
    if (now - entry.lastUsed > SESSION_TTL_MS) {
      sessions.delete(key);
    }
  }
}

// Sessions that are set once and never queried again (e.g. a client that
// stops sending `user`) would otherwise sit in memory forever, since TTL
// was previously only enforced on read. Sweep periodically so idle server
// processes don't accumulate unbounded entries.
setInterval(pruneExpired, PRUNE_INTERVAL_MS).unref();

export function getSession(key: string): SessionEntry | undefined {
  const entry = sessions.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.lastUsed > SESSION_TTL_MS) {
    sessions.delete(key);
    return undefined;
  }
  return entry;
}

export function setSession(
  key: string,
  claudeSessionId: string,
  messageCount: number
): void {
  sessions.set(key, { claudeSessionId, messageCount, lastUsed: Date.now() });
}

export function clearSession(key: string): void {
  sessions.delete(key);
}
