# Claude Max API Proxy — working notes

OpenAI-compatible HTTP proxy that runs the Claude Code CLI as a subprocess, so a
subscription answers requests that would otherwise need an API key. User-facing
documentation is [README.md](README.md); this file is what someone changing the code needs.

## Build and test

```bash
npm run build    # tsc
npm run dev      # tsc --watch
npm test         # offline suite, safe to run in a loop
npm run test:e2e # drives the real CLI and SPENDS SUBSCRIPTION TOKENS
```

`npm test` runs everything against a generated stand-in for the CLI
(`src/testing/fixture-cli.ts`), which replays recorded stream-json scenarios and records the
argv and stdin it was handed. Add a scenario there rather than reaching for the real binary.
`src/e2e.test.ts` makes real requests; it skips unless asked for by name or `RUN_E2E=1`, and
a pull request does not need it to have been run.

Conventions: TypeScript strict, `spawn()` with an argument array and never a shell, JSDoc on
exported functions, and a comment earns its place by saying why rather than what.

## Layout

| Path | Holds |
|---|---|
| `src/config.ts` | Configuration layers, validation, argument safety checks |
| `src/types/claude-cli.ts` | CLI stream-json message types and type guards |
| `src/types/openai.ts` | OpenAI request and response types |
| `src/adapter/openai-to-cli.ts` | OpenAI request → CLI input, model map, delta assembly |
| `src/adapter/cli-to-openai.ts` | CLI output → OpenAI response, usage, `finish_reason` |
| `src/subprocess/manager.ts` | Spawning the CLI, `buildArgs`, stream parsing |
| `src/subprocess/openclaw-prompt.ts` | Tool-name map, used by the `agent` preset only |
| `src/subprocess/session-store.ts` | Persisted session index and per-session mutex |
| `src/session/key.ts` | Conversation keys: prefix hash and anchor pair |
| `src/session/transcript-scan.ts` | Cold-index fallback that reads CLI transcripts |
| `src/server/index.ts` | Express app, body parsing, error handler |
| `src/server/routes.ts` | Route handlers, streaming and non-streaming |
| `src/server/standalone.ts` | Entry point |
| `src/testing/fixture-cli.ts` | Stand-in CLI and its scenarios |

## Seams worth knowing

- `binArgs` puts arguments before every CLI flag. The HTTP path constructs
  `ClaudeSubprocess` itself, so this is the only seam a test has for substituting the
  binary — that is how `fixture-cli.ts` gets in.
- `preset` selects the flag set: `economy` (plain model) or `agent` (the pre-preset
  behaviour). This fork ships `economy`; upstream should keep `agent`, and that one line in
  `DEFAULTS` is the intended divergence.
- `extraArgs` is configuration-only and never read from a request body. Flags the proxy owns
  per request (`--print`, `--output-format`, `--resume`, `--session-id`, …) are rejected at
  startup by `RESERVED_FLAGS`.
- Client mistakes must answer 4xx with `type: "invalid_request_error"`; only proxy failures
  are 5xx. OpenAI SDKs retry on 5xx, so a misclassified error is sent three times.

## What is known about the CLI

Message shapes live in `src/types/claude-cli.ts`. What follows is behaviour that the types
cannot state, measured against the real binary.

**Flags are not inherited on resume.** `--resume` restores the conversation, not the flags it
was created with, so `buildArgs` rebuilds the whole set every run. One session whose creation
cost 316 input tokens, resumed different ways:

| Resumed with | Input tokens |
|---|---|
| `--resume` alone | 36 289 |
| `+ --safe-mode` | 23 536 |
| `+ --tools ""` | 4 938 |
| `+ --system-prompt` (full set) | 381 |

**The system prompt is not stored in the session.** The `system` array is rebuilt from
arguments on every invocation and the session `.jsonl` holds no `system` record. It heads the
cached prefix, so it must be byte-identical across turns or the whole history re-caches:

```
resume with the same system prompt   cache_create   978   cache_read 9970
resume with one phrase changed       cache_create 10957   cache_read    0
resume with --system-prompt ''       cache_create 10934   cache_read    0
```

`--system-prompt-snapshot` does not help in `--print` mode; the new prompt wins whether it is
`on`, `off`, or absent.

**Flags.** `--system-prompt ""` removes the system block from the request; omitting the flag
substitutes Claude Code's built-in prompt (~13 890 characters). `--bare` cannot be used — it
forces `ANTHROPIC_API_KEY`/`apiKeyHelper` auth and the OAuth subscription stops working;
`--safe-mode` is the flag that gives the saving.

**Streaming.** With `--include-partial-messages` the CLI wraps the raw Anthropic events as
`stream_event`. Deltas seen in practice: `text_delta`, `thinking_delta`, `signature_delta`,
`input_json_delta`; block types in `content_block_start`: `text`, `thinking`, `tool_use`.
`message_start` carries the model and arrives before any delta, while the `assistant` message
arrives after the deltas it describes — read the model from `system/init` or `message_start`.
On sonnet-5 and opus-5 the visible `thinking` text comes through empty; on haiku it is real.
Besides `init`, a run also emits `system/status` and `system/thinking_tokens`; neither carries
content.

**`rate_limit_event` arrives on ordinary successful requests** with `status: "allowed"`. Only
a status that is not an allowed variant means the request was refused, and `resetsAt` (Unix
seconds) is what a `Retry-After` should be built from.

**`--json-schema` is a tool, not a prompt.** It is implemented as a `StructuredOutput` tool
whose description tells the model to call it once at the end; request bodies with and without
a schema differ only in the `tools` array. Therefore: the JSON arrives as `input_json_delta`
on the `tool_use` block while the text channel carries prose *about* the answer, so forwarding
`text_delta` to a client that asked for JSON hands it the wrong thing; the result message
carries both a serialised `result` and a parsed `structured_output`; `num_turns` is 2;
`--tools ""` does not disable it; and when the model does not call the tool the CLI appends an
undocumented `[structured-output-enforce]` user turn and asks again. A schema can also be
satisfied while empty — asked something outside it, the model returns `""` in the required
field.

**Transcripts** live in `~/.claude/projects/<working directory with every non-alphanumeric
character replaced by a dash>/<session-id>.jsonl`. Resolve the path through symlinks first —
on macOS `/tmp` points at `/private/tmp` and the folder is named after the resolved path. The
first line is usually a service record (`queue-operation`, `ai-title`, `mode`, `attachment`,
`last-prompt`, `atis-latch`) rather than a message, so read from the end of the file.

**The first user message carries an attachment.** The CLI prepends a `<system-reminder>` block
to the first user message of a session with the current date and, when signed in with a
subscription, the account's email address — roughly 150 tokens. It appears once per session,
not per turn, and `--safe-mode` does not remove it. No flag switches it off.

## Running as a service

[docs/macos-setup.md](docs/macos-setup.md) has the LaunchAgent plist and the `launchctl`
commands. launchd does not inherit a shell `PATH`, so the plist needs an absolute path to
`node` — an nvm upgrade moves it and the service stops starting — and `claude` has to be on
the `PATH` the plist declares.
