# Plan: closing the gaps in OpenAI tool-call compatibility

Tool calls now work end to end (`src/adapter/tool-emulation.ts`). The CLI never sees the
caller's function schemas — it runs its own agent loop with its own tools — so the proxy
describes the offered tools in the system prompt and pins the answer to a wrapper schema
through `--json-schema`, then unpacks that wrapper into `tool_calls`.

Measured against a running proxy on 2026-09-07: parallel calls, the full round trip through
`role: "tool"` messages, all four `tool_choice` modes and the streaming shape all behave as a
client expects. What follows is what still differs from the OpenAI contract, ordered by what
it costs the caller rather than by how far it strays from the spec.

## Fix

### 1. A tool result can be matched to the wrong call

**Problem.** A caller asks about two cities at once, gets two calls to the same tool, runs
both and sends both results back. Nothing in what reaches the model says which result belongs
to which call — it can only go by the order they arrive in. When the order is not enough, the
model answers confidently with the two swapped, and the caller has no way to tell.

**Fix.** Carry the call identifier through the conversation, so a result names the call it
answers.

**Details.** `callId()` mints a fresh `call_<random>` per response and it is never written
into the transcript: `messagesToPrompt` replays a call as `<tool_call name="get_weather">` and
a result as `<tool_result name="${msg.name ?? msg.tool_call_id ?? "tool"}">`. Most clients omit
`name` on the result message, so the tag holds an identifier the model has never seen. Emit
`<tool_call id="…" name="…">` and `<tool_result for="…">`, keeping `msg.name` as a label
rather than as the key.

### 2. An older client is answered with prose instead of a call

**Problem.** A client written against the pre-2023 format sends `functions` and
`function_call`. The proxy ignores both, the model answers in words, and from the caller's side
the tool was simply never invoked — with no error to explain it.

**Fix.** Say no out loud. Support the old format only if a client that needs it actually turns
up.

**Details.** Nothing in `src/` reads either field. Minimum: reject the request with 400 and
`type: "invalid_request_error"` naming `tools` as the replacement. The full alternative is a
translation in `resolveJsonMode` — `functions` to `tools`, `function_call` to `tool_choice`,
and `tool_calls[0]` back to a `function_call` on the response — roughly thirty lines.

### 3. `content` is `""` where the protocol says `null`

**Problem.** A client that distinguishes "no text" from "empty text" sees a tool-only turn as
one carrying an empty message.

**Fix.** Send `null`, as the API being imitated does.

**Details.** `contentFromResult` returns `emulated.content`, which is `""` for a pure call.
Pass `null` to `cliResultToOpenai` when the turn produced calls and no text. The type already
allows it (`OpenAIChatResponseChoice["message"]["content"]`).

### 4. `parallel_tool_calls: false` is ignored

**Problem.** A caller whose tools have side effects asks for one call at a time and gets
three. Two of them run when they should not have.

**Fix.** Honour the flag: at most one call per turn when it is false.

**Details.** The field is absent from `OpenAIChatRequest`. Add it, thread it into
`buildToolSchema` (`maxItems: 1` on the `tool_calls` array), adjust the wording in
`toolsPrompt`, and truncate in `parseEmulatedAnswer` as a backstop. Verified 2026-09-07: two
calls came back with the flag set to false.

## Worth doing, not urgent

### 5. `json_object` could coexist with tools

**Problem.** A client that always asks for JSON output and also offers tools — LangChain does
this — is refused outright, though only one of the two features needs the scarce resource.

**Fix.** Refuse the combination that genuinely collides, allow the one that does not.

**Details.** `resolveJsonMode` rejects any `response_format` other than `text` when tools are
present, but `json_object` never touches `--json-schema`: it is wording in the system prompt.
Keep the refusal for `json_schema` alone. The instruction has to be re-worded to apply to the
wrapper's `content` field, otherwise it fights the wrapper it sits next to.

### 6. `usage` in the stream ignores `stream_options.include_usage`

**Problem.** A strict client gets counters it did not ask for, attached to a chunk the API
being imitated does not put them on.

**Fix.** Send usage only when asked, in a chunk of its own with an empty `choices` array.

**Details.** The streaming `result` handler sets `doneChunk.usage` whenever the CLI reported
usage, with no reference to `stream_options`.

### 7. Argument validation, as a log line

**Problem.** The wrapper schema declares `arguments` as a bare `{"type": "object"}`, so
constrained decoding guarantees the tool *name* and nothing about its arguments. A malformed
call reaches the caller unremarked.

**Fix.** Notice it, do not act on it. Check the arguments against the tool's own
`parameters` and log a mismatch.

**Details.** Rejecting would break a working loop, and the loop already self-heals: the caller
runs the tool, it fails, the error text goes back as a tool result and the model corrects
itself. A 400 on the proxy's own judgement is worse than that.

## Deliberately left alone

**A `tool_call_id` with no matching call.** OpenAI answers 400; this proxy answers. The only
effect of matching that would be to turn working requests into failures — clients whose history
has been trimmed to a context window routinely send a tool message whose assistant turn has
already fallen off the front.

**`strict`.** There is one constrained-decoding slot and the wrapper occupies it. A
post-hoc check would advertise a guarantee that does not exist, which is worse than having
none. Document it as ignored.

**Streaming argument fragments.** Arguments arrive in one chunk rather than dribbling in.
Emitting fragments would mean incrementally parsing the partial wrapper JSON to find the
current call's `arguments` — a lot of machinery for a smoother progress bar. The spec does not
promise fragmentation.

**`tools` together with `response_format: json_schema`.** Both need `--json-schema` and
there is no defensible winner. The 400 already explains itself.

**`tool_choice: "required"` answered with an empty list.** Recoverable only by retrying, which
costs a full turn. `parseEmulatedAnswer` declines to report an empty list as a call, and the
comment there says why.

## Larger than any of the above: the prompt cache never hits

Every request that offered tools reported `cached_tokens: 0`, including the second turn of a
resumed conversation. A prompt carrying the wrapper schema and the tool descriptions starts
around 1 500 tokens, and on a miss the whole of it is paid again each turn — in subscription
allowance and in latency both.

The likely cause is that `--json-schema` changes the `tools` array of the underlying API
request and so breaks the cacheable prefix, but that is a guess. Measure before changing
anything: compare `cache_read_input_tokens` across turns with and without tools, and check
whether the schema is byte-identical between turns of one conversation. The system prompt is
already known to re-cache the whole history when a single phrase in it changes (see
`CLAUDE.md`), and `toolsPrompt` is rebuilt on every request.
