# Claude Max API Proxy

OpenAI-compatible API proxy that wraps the Claude Code CLI.

## Build and test

```bash
npm run build    # Compile TypeScript
npm run dev      # Watch mode for development
npm test         # Offline suite; drives a generated stand-in CLI
npm run test:e2e # Drives the real CLI and spends subscription tokens
```

`npm test` is safe to run in a loop. `npm run test:e2e` is not — it makes real
requests on the subscription, which is why it skips unless asked for by name
(or with `RUN_E2E=1`).

## Configuration

Defaults, then `~/.claude-max-api-proxy/config.json`, then `CLAUDE_PROXY_*`,
then argv. Every key is listed in the README. Two that matter while working on
the code:

- `binArgs` puts arguments before every CLI flag. The HTTP path constructs
  `ClaudeSubprocess` itself, so this is the only seam a test has for
  substituting the binary — that is how `src/testing/fixture-cli.ts` works.
- `preset` selects the flag set: `economy` (plain model) or `agent` (the
  pre-preset behaviour). The fork ships `economy`; upstream should keep
  `agent`, and that one line in `DEFAULTS` is the intended divergence.

## Things worth knowing about the CLI

- Flags are **not** inherited when a session is resumed. `buildArgs` therefore
  rebuilds the whole set on every run.
- The system prompt is not stored in the session file. It is rebuilt from
  arguments on each invocation, and it must be byte-identical across turns or
  the prompt cache misses the whole conversation.
- `--system-prompt ""` removes the system block from the request; omitting the
  flag substitutes the built-in Claude Code prompt (~13 890 characters).
- `--bare` cannot be used: it forces `ANTHROPIC_API_KEY`/`apiKeyHelper` auth
  and the OAuth subscription stops working. `--safe-mode` is the flag that
  gives the saving.
- `rate_limit_event` arrives on ordinary successful requests with status
  `"allowed"`. Only a non-allowed status means the request was refused.
- Transcripts live in `~/.claude/projects/<cwd with every non-alphanumeric
  character replaced by a dash>/`. The path must be resolved through symlinks
  first, or the folder will not be found on macOS.

## Service Management

The proxy runs as a macOS LaunchAgent on port 3456.

**Plist location:** `~/Library/LaunchAgents/com.openclaw.claude-max-proxy.plist`

**Logs:**
- stdout: `~/.openclaw/logs/claude-max-proxy.log`
- stderr: `~/.openclaw/logs/claude-max-proxy.err.log`

### Restart the service

```bash
launchctl kickstart -k gui/$(id -u)/com.openclaw.claude-max-proxy
```

### Stop the service

```bash
launchctl bootout gui/$(id -u)/com.openclaw.claude-max-proxy
```

### Start the service (after stop or plist change)

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.openclaw.claude-max-proxy.plist
```

### Reload after plist changes

```bash
launchctl bootout gui/$(id -u)/com.openclaw.claude-max-proxy
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.openclaw.claude-max-proxy.plist
```

### Check status

```bash
launchctl list com.openclaw.claude-max-proxy
```

## Architecture

- `src/config.ts` - Configuration layer and argument safety checks
- `src/types/claude-cli.ts` - Claude CLI JSON streaming types and type guards
- `src/types/openai.ts` - OpenAI-compatible API types
- `src/adapter/openai-to-cli.ts` - Converts OpenAI requests to CLI input
- `src/adapter/cli-to-openai.ts` - Converts CLI output to OpenAI responses
- `src/subprocess/manager.ts` - Spawns and manages Claude CLI subprocesses
- `src/subprocess/openclaw-prompt.ts` - Tool-name map, `agent` preset only
- `src/subprocess/session-store.ts` - Persisted session index and mutex
- `src/session/key.ts` - Conversation keys (prefix hash, anchor pair)
- `src/session/transcript-scan.ts` - Cold-index fallback over CLI transcripts
- `src/server/routes.ts` - Express route handlers (streaming + non-streaming)
- `src/server/standalone.ts` - Server entry point
- `src/testing/fixture-cli.ts` - Generated stand-in CLI and its scenarios
