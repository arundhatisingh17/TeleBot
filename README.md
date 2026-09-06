# TeleBot

A Telegram agent that reads one chat and answers in it — text and GIFs both — built on
[`@earendil-works/pi-agent-core`](https://www.npmjs.com/package/@earendil-works/pi-agent-core)
with an open-source model (Kimi K2.5) served through Hugging Face Inference Providers.

It runs as a user client over MTProto rather than as a bot account, so it operates inside an
existing conversation instead of a separate `@bot` chat.

## How a message becomes a reply

There is no `main()` that runs top to bottom. `src/index.ts` sets things up, registers two
callbacks, and exits — after which the process sits in Node's event loop. Everything below is
triggered, not called.

```
Telegram push
  │
  ├─ onMessage()                      src/index.ts
  │    guard: skip our own messages (infinite-loop protection)
  │    guard: skip anyone who isn't the one allowed chat
  │    guard: runaway limiter — 8 replies/min and the process exits
  │
  ├─ classify the payload
  │    GIF   → download → ffmpeg → 5 evenly-spaced JPEG frames
  │    photo → download → base64
  │    text  → as-is
  │
  ├─ send(text, images)               src/agent.ts
  │    records lastInboundAt (the 9am job reads this)
  │    stashes the message for memory extraction
  │
  └─ promptWithRetry() → agent.prompt()
       │  control passes to pi-agent-core, which calls back into us:
       │
       ├─ transformContext()          strips frames from all but the last 2 GIFs
       ├─ [LLM call]
       ├─ tool: switch_persona        mutates the system prompt
       ├─ tool: send_gif              searches, then *looks* at candidates and picks
       ├─ [LLM call with tool result]
       └─ agent_end
            │
            ├─ subscriber A           accumulated text → client.sendMessage()
            └─ subscriber B           persist state, then extract memories
```

The reply is dispatched by an event subscriber, not returned up the call stack. `await send(...)`
resolves *after* the message has already gone out, because pi-agent-core awaits its subscribers
before settling. That indirection exists because one "reply" may be several LLM calls with tool
executions in between — there's no single return value to hand back.

### Two other entry points

**Catch-up**, on startup. Event handlers only fire while connected, so a restart would otherwise
lose whatever arrived during the downtime. It walks history backwards until it hits a message we
sent; anything newer is unanswered. Only the most recent one enters context — the rest are
summarised as a count, since a stale backlog would sit in the transcript costing tokens on every
subsequent turn. Nothing older than 12 hours is answered at all.

**A daily 9am job**, via cron. Sends a greeting only if he hasn't already spoken since 5am, and
resets the persona first so the greeting doesn't arrive in yesterday's mood.

## Design notes

**Personas are a state machine, not a suggestion.** Four personas (`default`, `comfort`, `wary`,
`busy`), each declaring which others it may switch to. The prompt lists only reachable targets,
*and* the tool rejects illegal transitions — because a model can always call a tool with arguments
you never advertised. Prompt-level constraints persuade; code-level ones guarantee.

**Tool errors are guidance, not failures.** An illegal transition throws
`Cannot switch from "comfort" to "wary". Allowed: default`, which pi-agent-core hands back to the
model as a tool result. It reads the message and picks again. Same pattern when a GIF search comes
back empty: the error tells it to reply with text instead.

**The model has no clock.** Anything time-dependent is computed in `buildSystemPrompt` and injected
as text — the current time, how long the active persona has been held, and when he said he'd be
free. The system prompt is rebuilt before every send, so "now" stays true in a long-running
process. All of it uses `Intl` with an explicit `America/New_York`, which is why the host's own
timezone is irrelevant.

**What's stored and what's sent are different things.** `transformContext` strips frames from older
GIFs before each LLM call, but `messages.json` keeps everything. Without it you'd re-upload every
frame of every GIF ever received, on every turn, forever. Because storage is untouched, the
retention knob stays reversible.

**Memory outlives the transcript.** The transcript is flushed each morning at 7am, which is only
safe because a cheap text-only model reads each exchange first and extracts anything durable —
plans, commitments, facts. Those are injected as reference material with a strict rule: never
raised unprompted, only used when he brings the subject up.

**GIFs are chosen by looking at them.** The agent can only type a search phrase; it never sees what
comes back. So `send_gif` searches, downloads the top five, extracts three frames each, and makes a
separate vision call that compares all fifteen and picks. Labels are interleaved between candidates
— without them the model sees one undifferentiated pile of images.

**Not everything is retryable.** A 402 means credits are gone and retrying won't help, so it backs
off hard and gives up inside a budget; a reply arriving an hour late is worse than none. A `400
status code (no body)` *is* retried — a bodiless 400 is a gateway hiccup, whereas a real bad
request comes back with an explanation.

## Layout

The dependency graph only points one way. `agent.ts` never imports `teleproto`, which is what makes
`npm run chat` possible — the whole personality can be developed in a terminal with no bot running.
When `send_gif` needed the Telegram client, it got an injected `GifSource` interface rather than an
upward import.

| | |
|---|---|
| `index.ts` | Wiring. The only file that imports transport, agent, and scheduler together. |
| `telegram.ts` | MTProto client, GIF search via the `@gif` inline bot, sending. |
| `agent.ts` | Agent construction, tools, system prompt, persistence, retry. |
| `personas.ts` | Personas as data, plus the shared identity block. |
| `memory.ts` | Extraction and lifecycle of durable facts. |
| `gifs.ts` | `GifSource` interface and the vision-based picker. |
| `media.ts` | ffmpeg frame extraction. |
| `schedule.ts` | Cron, timezone maths, chat-day boundaries. |
| `retry.ts` | Which failures are worth retrying, and for how long. |
| `chat.ts` | Terminal REPL against separate state files. |

## Running it

Requires Node 22+ and ffmpeg.

```bash
npm install
npm run login      # once — prints a session string for .env
npm run whois      # find the chat id you want
npm run chat       # terminal only, no Telegram, separate state
npm run bot        # the real thing
```

`.env`:

```
TELEGRAM_API_ID=      # my.telegram.org
TELEGRAM_API_HASH=
TELEGRAM_SESSION=     # from `npm run login` — as sensitive as your password
PARTNER_ID=           # the one chat this is allowed to touch
HF_TOKEN=             # huggingface.co/settings/tokens
DRY_RUN=1             # 1 prints replies instead of sending them
```

`DRY_RUN` defaults to on unless the value is exactly `0`. Leave it on until you've watched the log
a few times.

Deployed as a systemd service on a small VM; `journalctl -u telebot -f` for logs. It was originally
a launchd agent on a laptop, which worked fine except that laptops sleep — and a sleeping host
means the morning job silently never fires.
