# Claude Max API Proxy

![Claude Max API Proxy](docs/banner.png)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-green.svg)](package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178c6.svg)](tsconfig.json)

**Put your Claude Code subscription behind an OpenAI-compatible endpoint.** Point any
OpenAI client — the `openai` SDK, Continue.dev, litellm, your own script — at
`http://localhost:3456/v1` and the answers come from your existing Pro, Max or Team plan
instead of a metered API key.

> Fork of [atalovesyou/claude-max-api-proxy](https://github.com/atalovesyou/claude-max-api-proxy),
> with an economy preset, session-based prompt caching, `response_format`, a configuration
> layer and an offline test suite.

## Why

Anthropic does not accept subscription OAuth tokens on the public API. The Claude Code CLI
does accept them. This proxy runs the CLI as a subprocess and speaks OpenAI over HTTP in
front of it.

| Approach | Cost | Catch |
|---|---|---|
| Claude API | Per token | A second bill next to the subscription you already pay |
| Subscription, directly | Flat monthly | OAuth is refused by third-party API clients |
| **This proxy** | Flat monthly, nothing extra | Goes through the CLI, so CLI limits apply |

```
your app ──HTTP(OpenAI)──▶ proxy ──spawn──▶ claude CLI ──OAuth──▶ Anthropic
```

## Quick start

You need Node 20+ and the Claude Code CLI, signed in:

```bash
npm install -g @anthropic-ai/claude-code
claude auth login
```

Then:

```bash
git clone https://github.com/mainpart/claude-max-api-proxy.git
cd claude-max-api-proxy
npm install
npm run build
npm start
```

The server listens on `http://localhost:3456`. A first request:

```bash
curl -X POST http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-4","messages":[{"role":"user","content":"Hello!"}]}'
```

Streaming works the same way with `"stream": true` (pass `-N` to curl so it does not buffer).
A custom port goes in as the first argument: `npm start -- 8080`.

## Point a client at it

The API key is never checked, but most SDKs insist on a non-empty one.

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:3456/v1", api_key="not-needed")

response = client.chat.completions.create(
    model="claude-sonnet-4",
    messages=[{"role": "user", "content": "Hello!"}],
)
```

Anything that reads the standard environment variables needs no code at all:

```bash
export OPENAI_BASE_URL="http://localhost:3456/v1"
export OPENAI_API_KEY="not-needed"
```

Continue.dev:

```json
{
  "models": [{
    "title": "Claude (subscription)",
    "provider": "openai",
    "model": "claude-sonnet-4",
    "apiBase": "http://localhost:3456/v1",
    "apiKey": "not-needed"
  }]
}
```

## Presets: what the CLI is allowed to be

`economy`, the default, runs the CLI as a plain model behind HTTP:

```
--safe-mode --tools "" --system-prompt "<what the client sent>"
```

`--safe-mode` leaves your customisations out — CLAUDE.md, automatic memory, skills, MCP
servers. `--system-prompt` replaces Claude Code's own prompt with the client's system
messages; when the client sends none, the empty string removes the system block entirely.

The same one-word question on haiku, through this proxy, on one machine:

| Preset | Prompt tokens |
|---|---|
| `agent` | 24 603 |
| `economy` | 246 |

The `agent` number is whatever your CLAUDE.md, memory, skills and MCP servers add up to, so
it varies by machine. The `economy` number does not. Choose `agent` when you want the model
to actually run tools on your machine: permissions skipped, the CLI's own tool set, and the
OpenClaw tool-name map appended to the system prompt.

The working directory matters more than it looks. By default the CLI runs in
`~/.claude-max-api-proxy/workspace`, an empty directory the proxy owns, so no CLAUDE.md or
git status gets pulled in, the proxy's transcripts stay out of your interactive sessions,
and a run with tools enabled cannot wander into whatever repository the proxy was started
from. `"cwd": "inherit"` restores the older behaviour.

## Sessions and prompt caching

Each conversation continues inside a persisted CLI session, so only the new turn is sent and
the rest comes from the API-side prompt cache. The conversation is recognised from its own
messages — a hash of the history, plus an anchor on the last exchange that survives a client
truncating old turns — so this works whether or not the client sends OpenAI's optional
`user` field. When the index is cold, the proxy reads the tail of the CLI's transcripts for
the working directory, limited to files touched in the last hour.

`usage.prompt_tokens_details.cached_tokens` is how you check that it works. Three turns of
one conversation, measured:

```
turn 1   cached_tokens 0
turn 2   cached_tokens 5848
turn 3   cached_tokens 6064
```

Zeros on every turn usually mean the client changes its system prompt between turns — a
timestamp, a turn counter. The system block heads the cached prefix, so changing it re-caches
the whole conversation. Fix that in the client.

Two consequences worth knowing:

- The CLI writes a transcript per conversation under `~/.claude/projects/`. That file is what
  makes resume work, and the proxy does not delete it. Index entries in
  `~/.claude-max-api-proxy/sessions.json` expire after six hours of inactivity.
- Prompt caching has a minimum cacheable prefix (roughly 2 048 tokens on haiku). Short
  conversations report `cached_tokens: 0` because there is nothing large enough to cache.

## API

| Endpoint | Method | Returns |
|---|---|---|
| `/health` | GET | `{"status":"ok","provider":"claude-code-cli","timestamp":…}` |
| `/v1/models` | GET | The model list below, in OpenAI shape |
| `/v1/chat/completions` | POST | Chat completion, streaming or not |

Request fields honoured: `model`, `messages`, `stream`, `stream_options`, `response_format`,
`user`. Sampling parameters (`temperature`, `top_p`, `max_tokens`, the penalties) are accepted
and ignored, because the CLI does not expose them.

### Models

| Model ID | Goes to |
|---|---|
| `claude-opus-4`, `claude-opus-4-6`, `claude-opus-5` | Opus |
| `claude-sonnet-4`, `claude-sonnet-4-5`, `claude-sonnet-4-6`, `claude-sonnet-5` | Sonnet |
| `claude-haiku-4`, `claude-haiku-4-5` | Haiku |

The bare aliases `opus`, `sonnet`, `haiku`, `opus-max` and `sonnet-max` work too, and every
ID also accepts a `claude-code-cli/` or `claude-max/` prefix. An unrecognised model falls
back to Opus rather than failing the request.

### Errors

Client mistakes come back as 4xx with `type: "invalid_request_error"`, so OpenAI SDKs do not
retry them; only genuine proxy failures are 5xx.

| Status | `code` | Cause |
|---|---|---|
| 400 | `invalid_json` | The body is not parseable JSON; the message carries the parser's position |
| 400 | `invalid_messages` | `messages` missing or empty |
| 400 | `invalid_response_format` | `response_format` is malformed |
| 413 | — | Body above `bodyLimit` |
| 404 | `not_found` | Unknown path |
| 500 | `null` | The CLI failed, timed out, or the proxy did |

### `response_format`

Both forms are supported.

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

The inner `schema` is passed to the CLI's `--json-schema`; `name` and `strict` are accepted
and ignored, since the CLI takes a bare schema. It streams as well — the JSON arrives as it
is generated. `{"type": "json_object"}` has no CLI flag behind it, so the proxy instructs the
model in the system prompt and strips a Markdown fence off the answer if one appears.

A schema can be satisfied formally and still be empty: asked something its schema does not
cover, the model returns `""` in the required field — right type, right key, no content.
Validate values, not just structure.

## Configuration

Layers resolve in order, each overriding the one before:

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
| `preset` | `--preset` | `CLAUDE_PROXY_PRESET` | `economy` | `economy` or `agent` |
| `cwd` | `--cwd` | `CLAUDE_PROXY_CWD` | `~/.claude-max-api-proxy/workspace` | Working directory of the CLI subprocess; `inherit` uses the proxy's own |
| `tools` | `--tools` | `CLAUDE_PROXY_TOOLS` | preset decides | Value for the CLI's `--tools` |
| `timeoutMs` | `--timeout-ms` | `CLAUDE_PROXY_TIMEOUT_MS` | `900000` | Per-request timeout |
| `bodyLimit` | `--body-limit` | `CLAUDE_PROXY_BODY_LIMIT` | `10mb` | Largest request body accepted, in the `bytes` format (`512kb`) |
| `extraArgs` | `--extra-arg` (repeatable) | `CLAUDE_PROXY_EXTRA_ARGS` | `[]` | Extra CLI flags |
| `binArgs` | `--bin-arg` (repeatable) | `CLAUDE_PROXY_BIN_ARGS` | `[]` | Arguments before every CLI flag, for wrapper binaries |
| `sessionIndexPath` | `--session-index` | `CLAUDE_PROXY_SESSION_INDEX` | `~/.claude-max-api-proxy/sessions.json` | Where the session index is kept |
| `sessionStrategy` | `--session-strategy` | `CLAUDE_PROXY_SESSION_STRATEGY` | `user,anchor,prefix,scan` | Which session lookups to try |
| `sessionLockTimeoutMs` | `--session-lock-ms` | `CLAUDE_PROXY_SESSION_LOCK_MS` | `30000` | Wait for a busy session before starting a fresh one |
| `streaming.thinking` | `--thinking` | `CLAUDE_PROXY_THINKING` | `drop` | `drop`, or `reasoning_content` to forward thinking text |
| `streaming.headerFlushMs` | `--header-flush-ms` | `CLAUDE_PROXY_HEADER_FLUSH_MS` | `1000` | How long SSE headers are held back so failures can still be an HTTP status |
| `streaming.resultGraceMs` | `--result-grace-ms` | `CLAUDE_PROXY_RESULT_GRACE_MS` | `2000` | Grace before the subprocess is killed, so it can finish its transcript |

`CLAUDE_BIN`, `DEBUG` and `DEBUG_SUBPROCESS` work as before.

`extraArgs` is read from configuration only, never from a request body. Flags such as
`--mcp-config`, `--settings` or `--add-dir`, combined with tools enabled, amount to running
code on the machine that holds your subscription, and an HTTP client has no business choosing
them. Flags the proxy sets per request (`--print`, `--output-format`, `--resume`,
`--session-id`, …) are rejected at startup with a message naming the flag.

## Privacy

Under `economy` the request the CLI sends contains your client's system prompt and messages,
and little else. One exception: Claude Code attaches a `<system-reminder>` block to the
**first** user message of a session carrying the current date and, when signed in with a
subscription, the account's email address. Verified by intercepting the request body — it
appears once per session, not per turn, and `--safe-mode` does not remove it. There is no
flag to switch it off.

## Running it as a service

On macOS, a LaunchAgent keeps the proxy up across logins.
[docs/macos-setup.md](docs/macos-setup.md) has a plist to copy and the `launchctl` commands.
Two things that bite: launchd does not inherit your shell `PATH`, so the plist needs an
absolute path to `node` (an nvm upgrade will move it and the service will stop starting), and
`claude` must be on the `PATH` the plist declares.

## Development

```bash
npm run build      # tsc
npm test           # offline; drives a stand-in CLI and spends no tokens
npm run test:e2e   # drives the real CLI and spends subscription tokens
npm run dev        # tsc --watch
```

```
src/
├── types/        # CLI streaming types and OpenAI types
├── adapter/      # openai-to-cli.ts, cli-to-openai.ts
├── subprocess/   # CLI process, argument assembly, session index
├── session/      # conversation keys, transcript scan
├── server/       # express app, routes, standalone entry point
├── testing/      # stand-in CLI for the offline suite
└── config.ts     # configuration layers
```

[CLAUDE.md](CLAUDE.md) is the working brief: the layout, the seams a test uses, and what is
known about the CLI's behaviour that the code cannot state on its own.

The CLI is started with `spawn()` and an argument array, never through a shell, so prompt
text cannot become a command. The proxy stores no credentials of its own; authentication
stays in the CLI's keychain entry.

## Troubleshooting

**"Claude CLI not found"** — install it and sign in: `npm install -g @anthropic-ai/claude-code`,
then `claude auth login`. Check the binary is visible with `which claude`.

**`cached_tokens` is always 0** — either the conversation is below the cacheable minimum
(around 2 048 tokens on haiku), or the client sends a different system prompt each turn.
Compare two consecutive requests and see whether their system messages are byte-identical.

**Answers ignore CLAUDE.md, skills or MCP servers** — that is `economy` doing its job. Set
`"preset": "agent"` if you want them.

**Streaming returns nothing, then everything** — curl buffers by default; add `-N`.

**A 500 on a request you expected to fail politely** — the proxy answers client mistakes with
4xx (see [Errors](#errors)). A 500 means the CLI itself failed; `DEBUG_SUBPROCESS=1` prints
what it was asked to do.

## Contributing

Pull requests are welcome, with tests. Add a scenario to `src/testing/fixture-cli.ts` rather
than reaching for the real binary; `npm test` has to stay offline. [CLAUDE.md](CLAUDE.md) has
the rest.

## License

MIT — see [LICENSE](LICENSE).

## Credits

Originally by [atalovesyou](https://github.com/atalovesyou/claude-max-api-proxy).
Built on [Claude Code CLI](https://github.com/anthropics/claude-code).
