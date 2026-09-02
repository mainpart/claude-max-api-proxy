# Claude Code CLI JSON Streaming Protocol

Research findings for Task #1.

## CLI Flags for Programmatic Use

```bash
claude --print \
  --output-format stream-json \
  --input-format stream-json \
  --verbose \
  --include-partial-messages \
  --model <opus|sonnet|haiku> \
  --session-id <uuid> \
  --resume <session-id>
```

### Key Flags

| Flag | Description |
|------|-------------|
| `--print` | Non-interactive mode, required for piping |
| `--output-format stream-json` | JSON line output (requires `--verbose`) |
| `--input-format stream-json` | JSON line input for messages |
| `--verbose` | Required for stream-json output |
| `--include-partial-messages` | Get streaming chunks as they arrive |
| `--session-id <uuid>` | Use specific session ID |
| `--resume <id>` | Resume existing conversation |
| `--model <alias>` | Model: opus, sonnet, haiku |
| `--no-session-persistence` | Don't save sessions to disk |

## Output Message Types

### 1. System Init (`type: "system", subtype: "init"`)

Sent at session start with full context:

```json
{
  "type": "system",
  "subtype": "init",
  "cwd": "/Users/atal/Desktop/ClaudeTest",
  "session_id": "72db4887-c10b-4445-89fa-26e4fc184df9",
  "tools": ["Task", "Bash", "Read", "Edit", ...],
  "mcp_servers": [...],
  "model": "claude-sonnet-4-5-20250929",
  "permissionMode": "bypassPermissions",
  "slash_commands": [...],
  "skills": [...],
  "plugins": [...],
  "uuid": "1121b09e-d912-4fd7-91b6-ff72a513e8e4"
}
```

### 2. Hook Messages (`type: "system", subtype: "hook_*"`)

```json
{
  "type": "system",
  "subtype": "hook_started",
  "hook_id": "...",
  "hook_name": "SessionStart:startup",
  "hook_event": "SessionStart",
  "session_id": "..."
}
```

```json
{
  "type": "system",
  "subtype": "hook_response",
  "hook_id": "...",
  "output": "...",
  "exit_code": 0,
  "outcome": "success"
}
```

### 3. Assistant Message (`type: "assistant"`)

Contains model response:

```json
{
  "type": "assistant",
  "message": {
    "model": "claude-sonnet-4-5-20250929",
    "id": "msg_01Avr9xkb5daf79U5oDRrHQ9",
    "type": "message",
    "role": "assistant",
    "content": [
      {"type": "text", "text": "Hello!"}
    ],
    "stop_reason": null,
    "usage": {
      "input_tokens": 2,
      "output_tokens": 1,
      "cache_creation_input_tokens": 42255
    }
  },
  "session_id": "...",
  "uuid": "..."
}
```

### 3b. Stream Events (`type: "stream_event"`)

With `--include-partial-messages` the CLI forwards the raw Anthropic streaming
events, wrapped:

```json
{"type": "stream_event", "event": {"type": "content_block_delta", "index": 0,
 "delta": {"type": "text_delta", "text": "Hel"}},
 "session_id": "...", "uuid": "..."}
```

Delta types seen in practice: `text_delta`, `thinking_delta`,
`signature_delta`, `input_json_delta`. Block types in `content_block_start`:
`text`, `thinking`, `tool_use`.

`message_start` carries the model, and it arrives before any delta — unlike
the `assistant` message, which arrives after the deltas it describes. Either
`system/init` or `message_start` is the right place to read the model from.

Thinking blocks: on sonnet-5 and opus-5 the visible `thinking` text comes
through empty; on haiku it is real text. The signature is opaque.

### 3c. Rate Limit Events (`type: "rate_limit_event"`)

```json
{"type": "rate_limit_event",
 "rate_limit_info": {"status": "allowed", "resetsAt": 1788348000,
                     "rateLimitType": "five_hour",
                     "unifiedWindows": {"five_hour": {"utilization": 0.18}}},
 "session_id": "...", "uuid": "..."}
```

This arrives on ordinary successful requests, with `status: "allowed"`. Only a
status that is not an "allowed" variant means the request was refused, and
`resetsAt` (Unix seconds) is then what a `Retry-After` should be built from.

### 3d. Other system subtypes

Besides `init`, `hook_started` and `hook_response`, a run emits
`system/status` (`{"status": "requesting"}`) and, while a thinking block is
being generated, a stream of `system/thinking_tokens` with running estimates.
Neither carries content.

### 4. Result Message (`type: "result"`)

Final message with stats:

```json
{
  "type": "result",
  "subtype": "success",
  "is_error": false,
  "duration_ms": 3613,
  "duration_api_ms": 5187,
  "num_turns": 1,
  "result": "The final text response",
  "session_id": "72db4887-c10b-4445-89fa-26e4fc184df9",
  "total_cost_usd": 0.15939125,
  "usage": {
    "input_tokens": 2,
    "output_tokens": 13,
    "cache_creation_input_tokens": 42255,
    "cache_read_input_tokens": 0
  },
  "modelUsage": {
    "claude-sonnet-4-5-20250929": {
      "inputTokens": 2,
      "outputTokens": 13,
      "costUSD": 0.15865725
    }
  }
}
```

## Input Format (stream-json)

When using `--input-format stream-json`, send JSON lines to stdin:

```json
{"type": "user_message", "content": "Hello, how are you?"}
```

**TODO:** Need to verify exact input format with testing.

### 5. Structured Output (`--json-schema`)

The flag is implemented as a tool named `StructuredOutput` whose description
already tells the model to call it exactly once at the end. Intercepting the
request bodies with and without a schema shows they differ only in the `tools`
array — nothing is added to the prompt, and `tool_choice` stays `null`.

Consequences for a consumer of the stream:

- The JSON arrives as `input_json_delta` on the `tool_use` block. The text
  channel carries the model's prose *about* the answer, so forwarding
  `text_delta` to a client that asked for JSON hands it the wrong thing.
- The result message carries both a serialised `result` and a parsed
  `structured_output`.
- `num_turns` is 2: the prose, then a separate turn for the tool call.
- `--tools ""` does not disable it; `StructuredOutput` is added regardless.
- When the model does not call the tool, the CLI appends a
  `[structured-output-enforce]` user turn and asks again. Undocumented, so
  worth having a fallback for.
- A schema can be satisfied and still be empty: asked something outside its
  schema, the model returns `""` in the required field.

## Session Management

- Sessions are identified by UUID
- Use `--session-id <uuid>` to specify
- Use `--resume <id>` to continue conversation
- Sessions persist by default; use `--no-session-persistence` to disable

### Flags are not inherited on resume

`--resume` restores the conversation, not the flags it was created with. Every
flag has to be passed again on every turn. Measured on one session whose
creation cost 316 input tokens:

| Resumed with | Input tokens |
|---|---|
| `--resume` alone | 36 289 |
| `+ --safe-mode` | 23 536 |
| `+ --tools ""` | 4 938 |
| `+ --system-prompt` (full set) | 381 |

### The system prompt is not stored in the session

The `system` array is rebuilt from arguments on every invocation, and the
session `.jsonl` has no `system` record at all. Because the system block heads
the cached prefix, it must be byte-identical across the turns of a
conversation or the entire history is re-cached:

```
resume with the same system prompt   cache_create   978   cache_read 9970
resume with one phrase changed       cache_create 10957   cache_read    0
resume with --system-prompt ''       cache_create 10934   cache_read    0
```

`--system-prompt-snapshot` does not help in `--print` mode; the new prompt
wins whether it is set to `on`, `off`, or left out.

### Transcript files

Sessions are written to
`~/.claude/projects/<working directory with every non-alphanumeric character
replaced by a dash>/<session-id>.jsonl`. The path must be resolved through
symlinks first — on macOS `/tmp` is a link to `/private/tmp`, and the folder
is named after the resolved path.

The first line of a transcript is usually a service record
(`queue-operation`, `ai-title`, `mode`, `attachment`, `last-prompt`,
`atis-latch`), not a message, so a reader looking for the conversation should
start from the end of the file.

### The first user message carries an attachment

The CLI prepends a `<system-reminder>` block to the **first** user message of
a session, carrying the current date and, when signed in with a subscription,
the account's email address — roughly 150 tokens. Verified by interception: it
appears once per session rather than on every turn, and `--safe-mode` does not
remove it.

## Important Notes

1. **OAuth Token Usage**: Claude CLI uses the logged-in user's OAuth token automatically
2. **Cost Tracking**: Each response includes `total_cost_usd` - this is subscription usage, not API billing
3. **Tools**: Claude Code has its own tools (Bash, Read, Edit, etc.) - may need to disable or bridge
4. **MCP Servers**: Session init includes MCP server status
5. **Streaming**: With `--include-partial-messages`, get real-time chunks

## Message Flow for Clawdbot Integration

```
Clawdbot User Message
        │
        ▼
┌───────────────────────────┐
│ Format as JSON input      │
│ {"type":"user_message"..} │
└───────────────────────────┘
        │
        ▼ (stdin)
┌───────────────────────────┐
│   Claude Code CLI         │
│   (subprocess)            │
└───────────────────────────┘
        │
        ▼ (stdout - JSON lines)
┌───────────────────────────┐
│ Parse JSON stream         │
│ - Filter system messages  │
│ - Extract assistant text  │
│ - Capture result stats    │
└───────────────────────────┘
        │
        ▼
Clawdbot Response to User
```
