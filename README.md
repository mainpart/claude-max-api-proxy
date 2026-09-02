# Claude Max API Proxy

> Actively maintained fork of [atalovesyou/claude-max-api-proxy](https://github.com/atalovesyou/claude-max-api-proxy) with OpenClaw integration, improved streaming, and expanded model support.

**Use your existing Claude Code subscription (Pro, Max, or Team) with any OpenAI-compatible client — no separate API costs!**

This proxy wraps the Claude Code CLI as a subprocess and exposes an OpenAI-compatible HTTP API, allowing tools like OpenClaw, Continue.dev, or any OpenAI-compatible client to use your Claude subscription instead of paying per-API-call. It works with any subscription tier that Claude Code itself supports — Pro, Max, or Team — not just Max.

## Why This Exists

| Approach | Cost | Limitation |
|----------|------|------------|
| Claude API | ~$15/M input, ~$75/M output tokens | Pay per use |
| Claude subscription (Pro/Max/Team) | Flat monthly fee | OAuth blocked for third-party API use |
| **This Proxy** | $0 extra (uses your existing subscription) | Routes through CLI |

Anthropic blocks OAuth tokens from being used directly with third-party API clients. However, the Claude Code CLI *can* use OAuth tokens from any subscription tier. This proxy bridges that gap by wrapping the CLI and exposing a standard API.

## How It Works

```
Your App (OpenClaw, Continue.dev, etc.)
         ↓
    HTTP Request (OpenAI format)
         ↓
   Claude Max API Proxy (this project)
         ↓
   Claude Code CLI (subprocess)
         ↓
   OAuth Token (from your Claude Code subscription)
         ↓
   Anthropic API
         ↓
   Response → OpenAI format → Your App
```

## Features

- **OpenAI-compatible API** — Works with any client that supports OpenAI's API format
- **Streaming support** — Real-time token streaming via Server-Sent Events
- **Multiple models** — Claude Opus, Sonnet, and Haiku with flexible model aliases
- **Economy mode** — Runs the CLI as a plain model: no CLAUDE.md, memory, skills, MCP servers or tools
- **Prompt caching** — Resumes the CLI session so long conversations hit the cache
- **`response_format`** — Both `json_schema` and `json_object`
- **Configurable** — Config file, environment variables, or command line
- **Auto-start service** — Optional LaunchAgent for macOS
- **Secure by design** — Uses `spawn()` to prevent shell injection

## What's Different from the Original

- **Economy preset (default here)** — 246 prompt tokens for a question that cost 24 603 with the CLI unrestricted, measured through the proxy on one machine
- **Session lookup without `user`** — Conversations are identified from their own messages, so resume and prompt caching work with clients that never send that optional field
- **Persisted session index** — A proxy restart no longer starts every conversation over
- **`response_format` support** — `json_schema` maps to `--json-schema`; `json_object` is instructed in the system prompt
- **Streaming repairs** — Correct model name, honest HTTP status on startup failures, `[DONE]` on every path, cache-aware `usage`, mapped `finish_reason`, rate-limit handling, thinking blocks modelled
- **Configuration layer** — Port, host, working directory, timeout, preset, tools, extra CLI flags
- **Offline test suite** — `npm test` drives a stand-in CLI and spends no tokens

## Prerequisites

1. **A Claude Code subscription** (Pro, Max, or Team) — [Subscribe here](https://claude.ai)
2. **Claude Code CLI** installed and authenticated:
   ```bash
   npm install -g @anthropic-ai/claude-code
   claude auth login
   ```

## Installation

```bash
# Clone the repository
git clone https://github.com/wende/claude-max-api-proxy.git
cd claude-max-api-proxy

# Install dependencies
npm install

# Build
npm run build
```

## Usage

### Start the server

```bash
npm start
# or
node dist/server/standalone.js
```

The server runs at `http://localhost:3456` by default. Pass a custom port as an argument:

```bash
node dist/server/standalone.js 8080
```

## Configuration

Settings resolve in this order, each layer overriding the one before it:

1. built-in defaults
2. `~/.claude-max-api-proxy/config.json` (or `--config <path>`, or `CLAUDE_PROXY_CONFIG`)
3. `CLAUDE_PROXY_*` environment variables
4. command-line arguments

```json
{
  "port": 3456,
  "host": "127.0.0.1",
  "preset": "economy",
  "cwd": "/Users/you/.claude-max-api-proxy/workspace",
  "timeoutMs": 900000,
  "streaming": { "thinking": "drop" }
}
```

| Key | CLI flag | Environment | Default | Meaning |
|---|---|---|---|---|
| `port` | `--port`, first positional | `CLAUDE_PROXY_PORT` | `3456` | Listening port |
| `host` | `--host` | `CLAUDE_PROXY_HOST` | `127.0.0.1` | Listening address |
| `preset` | `--preset` | `CLAUDE_PROXY_PRESET` | `economy` | `economy` or `agent`, see below |
| `cwd` | `--cwd` | `CLAUDE_PROXY_CWD` | `~/.claude-max-api-proxy/workspace` | Working directory of the CLI subprocess; `inherit` uses the proxy's own |
| `tools` | `--tools` | `CLAUDE_PROXY_TOOLS` | preset decides | Value for the CLI's `--tools` |
| `timeoutMs` | `--timeout-ms` | `CLAUDE_PROXY_TIMEOUT_MS` | `900000` | Per-request timeout |
| `extraArgs` | `--extra-arg` (repeatable) | `CLAUDE_PROXY_EXTRA_ARGS` | `[]` | Extra CLI flags |
| `binArgs` | `--bin-arg` (repeatable) | `CLAUDE_PROXY_BIN_ARGS` | `[]` | Arguments before every CLI flag, for wrapper binaries |
| `sessionIndexPath` | `--session-index` | `CLAUDE_PROXY_SESSION_INDEX` | `~/.claude-max-api-proxy/sessions.json` | Where the session index is kept |
| `sessionStrategy` | `--session-strategy` | `CLAUDE_PROXY_SESSION_STRATEGY` | `user,anchor,prefix,scan` | Which session lookups to try |
| `sessionLockTimeoutMs` | `--session-lock-ms` | `CLAUDE_PROXY_SESSION_LOCK_MS` | `30000` | Wait for a busy session before starting a fresh one |
| `streaming.thinking` | `--thinking` | `CLAUDE_PROXY_THINKING` | `drop` | `drop`, or `reasoning_content` to forward thinking text |
| `streaming.headerFlushMs` | `--header-flush-ms` | `CLAUDE_PROXY_HEADER_FLUSH_MS` | `1000` | How long SSE headers are held back so failures can still be an HTTP status |
| `streaming.resultGraceMs` | `--result-grace-ms` | `CLAUDE_PROXY_RESULT_GRACE_MS` | `2000` | Grace before the subprocess is killed, so it can finish its transcript |

`CLAUDE_BIN`, `DEBUG` and `DEBUG_SUBPROCESS` continue to work as before.

`extraArgs` is read from configuration only, never from a request body. Flags
such as `--mcp-config`, `--settings` or `--add-dir` combined with tools enabled
amount to running code on the machine holding your subscription, and an HTTP
client has no business choosing them. Flags the proxy sets per request
(`--print`, `--output-format`, `--resume`, `--session-id`, …) are rejected at
startup with a message naming the flag.

### Presets

`economy` (the default here) runs the CLI as a plain model behind HTTP:

```
--safe-mode --tools "" --system-prompt "<what the client sent>"
```

`--safe-mode` drops your customisations — CLAUDE.md, automatic memory, skills,
MCP servers. `--system-prompt` replaces the built-in Claude Code prompt with
the client's own system messages; when the client sends none, the empty string
removes the system block from the request entirely.

The same one-word question on haiku, through this proxy, on one machine:

| Preset | Prompt tokens |
|---|---|
| `agent` | 24 603 |
| `economy` | 246 |

The `agent` figure is whatever your own CLAUDE.md, memory, skills and MCP
servers add up to, so it varies by machine. The `economy` figure does not.

`agent` reproduces the behaviour this proxy had before presets existed:
permissions skipped, the CLI's own tool set, and the OpenClaw tool-name map
appended to the system prompt. Use it if you want the model to actually run
tools on your machine.

The working directory matters more than it looks. By default the CLI runs in
`~/.claude-max-api-proxy/workspace`, an empty directory the proxy owns, so
there is no CLAUDE.md or git status to pull in, the proxy's session
transcripts stay out of your interactive ones, and a run with tools enabled
cannot wander into whatever repository the proxy was started from. Set
`"cwd": "inherit"` for the old behaviour.

## Sessions and prompt caching

Each conversation is continued in a persisted CLI session, so only the new
turn is sent and the rest is served from the API-side prompt cache. The
conversation is recognised from its own messages — a hash of the history, plus
an anchor on the last exchange that survives a client truncating old turns —
so this works whether or not the client sends the optional OpenAI `user`
field. If the index is cold, the proxy reads the tail of the CLI's own
transcripts for the working directory, limited to files touched within the
last hour.

`usage.prompt_tokens_details.cached_tokens` in the response is how you check
that it is working. Three turns of one conversation, measured:

```
turn 1   cached_tokens 0
turn 2   cached_tokens 5848
turn 3   cached_tokens 6064
```

Zeros across every turn usually mean the client changes its system prompt
between turns — the current time, a turn counter. The system block heads the
cached prefix, so changing it re-caches the whole conversation. That is worth
fixing in the client, not in the proxy.

Two notes on the trade-offs behind this:

- Sessions are persisted, so the CLI writes a transcript per conversation
  under `~/.claude/projects/`. That file is exactly what makes resume work.
- Prompt caching has a minimum cacheable prefix (about 2 048 tokens for
  haiku). Short conversations show `cached_tokens: 0` simply because there is
  not enough to cache.

## JSON responses

`response_format` is supported in both forms.

```json
{
  "model": "claude-sonnet-4",
  "messages": [{"role": "user", "content": "Capital of France and its population?"}],
  "response_format": {
    "type": "json_schema",
    "json_schema": {"name": "city", "schema": {"type": "object", "properties": {"city": {"type": "string"}}}}
  }
}
```

The inner `schema` goes to the CLI's `--json-schema`. `name` and `strict` are
accepted and ignored — the CLI takes a bare schema. It works with `stream:
true` as well: the JSON is streamed as it is generated.

`{"type": "json_object"}` has no CLI flag behind it, so the proxy instructs the
model in the system prompt and strips a Markdown code fence from the answer if
the model added one.

One thing to know before you trust the output: a schema can be satisfied
formally and still be empty. Asked something its schema does not cover, the
model returns `""` in the required field — right type, right key, no content.
The proxy cannot tell that from an answer, so validate values, not just
structure.

## Privacy

In `economy` mode the request the CLI sends contains your client's system
prompt and messages, and little else. One exception is worth knowing about:
Claude Code attaches a `<system-reminder>` block to the **first** user message
of a session containing the current date and, if the CLI is signed in with a
subscription, the account's email address. Verified by intercepting the
request body — it appears once per session, not on every turn, and
`--safe-mode` does not remove it. There is no flag to switch it off.

### Test it

```bash
# Health check
curl http://localhost:3456/health

# List models
curl http://localhost:3456/v1/models

# Chat completion (non-streaming)
curl -X POST http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'

# Chat completion (streaming)
curl -N -X POST http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/v1/models` | GET | List available models |
| `/v1/chat/completions` | POST | Chat completions (streaming & non-streaming) |

Supported request fields: `model`, `messages`, `stream`, `stream_options`,
`response_format`, `user`. Sampling parameters (`temperature`, `top_p`,
`max_tokens`, the penalties) are accepted and ignored — the CLI does not
expose them.

## Available Models

| Model ID | Alias | CLI Model |
|----------|-------|-----------|
| `claude-opus-4` | `opus` | Claude Opus |
| `claude-sonnet-4` | `sonnet` | Claude Sonnet |
| `claude-haiku-4` | `haiku` | Claude Haiku |

All model IDs also accept a `claude-code-cli/` prefix (e.g., `claude-code-cli/claude-opus-4`). Unknown models default to Opus.

## Configuration with Popular Tools

### OpenClaw

OpenClaw works with this proxy out of the box. The proxy automatically maps OpenClaw tool names to Claude Code equivalents and strips conflicting tooling sections from system prompts.

### Continue.dev

Add to your Continue config:

```json
{
  "models": [{
    "title": "Claude (Max)",
    "provider": "openai",
    "model": "claude-sonnet-4",
    "apiBase": "http://localhost:3456/v1",
    "apiKey": "not-needed"
  }]
}
```

### Generic OpenAI Client (Python)

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3456/v1",
    api_key="not-needed"  # Any value works
)

response = client.chat.completions.create(
    model="claude-sonnet-4",
    messages=[{"role": "user", "content": "Hello!"}]
)
```

## Auto-Start on macOS

The proxy can run as a macOS LaunchAgent on port 3456.

**Plist location:** `~/Library/LaunchAgents/com.openclaw.claude-max-proxy.plist`

```bash
# Start the service
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.openclaw.claude-max-proxy.plist

# Restart
launchctl kickstart -k gui/$(id -u)/com.openclaw.claude-max-proxy

# Stop
launchctl bootout gui/$(id -u)/com.openclaw.claude-max-proxy

# Check status
launchctl list com.openclaw.claude-max-proxy
```

## Architecture

```
src/
├── types/
│   ├── claude-cli.ts      # Claude CLI JSON streaming types + type guards
│   └── openai.ts          # OpenAI API types (including tool calls)
├── adapter/
│   ├── openai-to-cli.ts   # Convert OpenAI requests → CLI format
│   └── cli-to-openai.ts   # Convert CLI responses → OpenAI format
├── subprocess/
│   ├── manager.ts         # Claude CLI subprocess, argument assembly
│   ├── openclaw-prompt.ts # Tool-name map used only by the `agent` preset
│   └── session-store.ts   # Persisted session index + per-session mutex
├── session/
│   ├── key.ts             # Conversation keys: prefix hash and anchor
│   └── transcript-scan.ts # Cold-index fallback: read the CLI's transcripts
├── server/
│   ├── index.ts           # Express server setup
│   ├── routes.ts          # API route handlers
│   └── standalone.ts      # Entry point
├── testing/
│   └── fixture-cli.ts     # Stand-in CLI for the offline tests
├── config.ts              # Configuration layer
└── index.ts               # Package exports
```

## Tests

```bash
npm test          # offline, drives a stand-in CLI, spends nothing
npm run test:e2e  # drives the real CLI and spends subscription tokens
```

## Security

- Uses Node.js `spawn()` instead of shell execution to prevent injection attacks
- No API keys stored or transmitted by this proxy
- All authentication handled by Claude CLI's secure keychain storage
- Prompts passed as CLI arguments, not through shell interpretation

## Troubleshooting

### "Claude CLI not found"

Install and authenticate the CLI:
```bash
npm install -g @anthropic-ai/claude-code
claude auth login
```

### `cached_tokens` is always 0

Either the conversation is shorter than the cacheable minimum (about 2 048
tokens on haiku), or the client sends a different system prompt on each turn.
Compare two consecutive requests from your client and see whether their system
messages are byte-identical.

### Answers ignore my CLAUDE.md, skills or MCP servers

That is `economy` doing its job. Set `"preset": "agent"` if you want them.

### Streaming returns immediately with no content

Ensure you're using `-N` flag with curl (disables buffering):
```bash
curl -N -X POST http://localhost:3456/v1/chat/completions ...
```

### Server won't start

Check that the Claude CLI is in your PATH:
```bash
which claude
```

## Contributing

Contributions welcome! Please submit PRs with tests.

## License

MIT

## Acknowledgments

- Originally created by [atalovesyou](https://github.com/atalovesyou/claude-max-api-proxy)
- Built for use with [OpenClaw](https://openclaw.com)
- Powered by [Claude Code CLI](https://github.com/anthropics/claude-code)
