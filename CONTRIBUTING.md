# Contributing to Claude Code CLI Provider

Thank you for your interest in contributing!

## Development Setup

1. Clone the repository
2. Install dependencies: `npm install`
3. Build: `npm run build`
4. Run: `node dist/server/standalone.js`

## Making Changes

1. Create a feature branch: `git checkout -b feature/your-feature`
2. Make your changes
3. Build and test: `npm run build`
4. Commit with a descriptive message
5. Push and create a PR

## Code Style

- TypeScript with strict mode
- Use `spawn()` instead of shell execution for security
- Add JSDoc comments to public functions
- Keep functions focused and small

## Testing

```bash
npm test          # offline suite; spends nothing, safe to run in a loop
npm run test:e2e  # drives the real CLI and SPENDS SUBSCRIPTION TOKENS
```

`npm test` runs everything against a generated stand-in for the CLI
(`src/testing/fixture-cli.ts`), which replays recorded stream-json scenarios
and records the argv and stdin it was given. Add a scenario there rather than
reaching for the real binary.

`src/e2e.test.ts` makes real requests on your subscription. It skips unless
you ask for it by name or set `RUN_E2E=1`, and a pull request does not need it
to have been run.

Manual checks against a live server:

```bash
# Start the server
node dist/server/standalone.js

# Test non-streaming
curl -X POST http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "claude-haiku-4", "messages": [{"role": "user", "content": "Hi"}]}'

# Test streaming
curl -N -X POST http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "claude-haiku-4", "messages": [{"role": "user", "content": "Hi"}], "stream": true}'
```

## Reporting Issues

Please include:
- Node.js version (`node --version`)
- Claude CLI version (`claude --version`)
- Operating system
- Steps to reproduce
- Error messages/logs

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
