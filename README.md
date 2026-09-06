# TeleBot

A Telegram agent that reads one chat and answers in it, with text or GIFs.

Built on [`@earendil-works/pi-agent-core`](https://www.npmjs.com/package/@earendil-works/pi-agent-core),
using an open-source model (Kimi K2.5) served through Hugging Face Inference Providers.

It logs in as a user account over MTProto instead of running as a bot account. That means it works
inside an existing conversation rather than in a separate `@bot` chat.

## How a message becomes a reply

`src/index.ts` has no `main()` that runs start to finish. It sets things up, registers two
callbacks, and ends. The process then waits in Node's event loop. Everything below happens because
something triggered it.

```
Telegram push
  │
  ├─ onMessage()                      src/index.ts
  │    skip our own messages          (or the bot replies to itself forever)
  │    skip anyone but the one allowed chat
  │    skip if 8+ replies in a minute (runaway guard, exits the process)
  │
  ├─ work out what he sent
  │    GIF   → download → ffmpeg → 5 evenly-spaced JPEG frames
  │    photo → download → base64
  │    text  → as-is
  │
  ├─ send(text, images)               src/agent.ts
  │    record when he last spoke      (the 9am job reads this)
  │    stash the message              (memory extraction needs it)
  │
  └─ promptWithRetry() → agent.prompt()
       │  pi-agent-core takes over here, and calls back into our code:
       │
       ├─ transformContext()          drop frames from all but the last 2 GIFs
       ├─ [LLM call]
       ├─ tool: switch_persona        rewrites the system prompt
       ├─ tool: send_gif              searches, then looks at the results and picks one
       ├─ [LLM call, now with the tool result]
       └─ agent_end
            │
            ├─ subscriber A           collected text → client.sendMessage()
            └─ subscriber B           save state, then extract memories
```

The reply is sent by an event subscriber. It is not returned up the call stack.

So `await send(...)` finishes *after* the message has already gone out. pi-agent-core waits for its
subscribers before it settles, which is what makes that ordering safe.

It works this way because one reply is not one request. It can be several LLM calls with tool
executions between them. There is no single value to return.

### Two other ways work starts

**Catch-up, on startup.** Event handlers only fire while the process is connected. Anything that
arrived during downtime would be lost. So on boot it reads recent history backwards until it finds
a message we sent. Everything newer than that is unanswered.

Only the newest of those goes to the model. The rest become a count, like "he sent 3 messages".
A backlog would stay in the transcript and cost tokens on every later turn. Anything older than 12
hours is skipped entirely, because replying to a two-day-old message is worse than staying quiet.

**A 9am job, daily.** It sends a greeting only if he hasn't spoken since 5am. It resets the persona
first, so the greeting doesn't arrive in yesterday's mood.

## Design notes

**Personas are a state machine, not a suggestion.**
There are four: `default`, `comfort`, `wary`, `busy`. Each one declares which others it may switch
to. The prompt lists only the reachable ones, and the tool also rejects illegal switches. Both are
needed. A model can call a tool with arguments you never advertised, so the prompt persuades and
the code guarantees.

**Tool errors are instructions, not failures.**
An illegal switch throws `Cannot switch from "comfort" to "wary". Allowed: default`. pi-agent-core
passes that back to the model as a tool result, and it picks again. An empty GIF search does the
same thing: the error tells it to reply with text instead.

**The model has no clock.**
Anything time-based is calculated in `buildSystemPrompt` and written into the prompt as plain text.
The current time, how long the persona has been active, when he said he'd be free. The prompt is
rebuilt before every send so "now" stays accurate in a long-running process.

All of it uses `Intl` with an explicit `America/New_York`, so the host machine's timezone doesn't
matter.

**What gets stored and what gets sent are different.**
`transformContext` removes frames from older GIFs before each LLM call. `messages.json` still keeps
them. Without this you would re-upload every frame of every GIF ever received, on every turn.

Because storage is untouched, the retention setting can be raised again later and the old frames
are still there.

**Memory outlives the transcript.**
The transcript is cleared every morning at 7am. That is only safe because a cheap text-only model
reads each exchange first and pulls out anything durable, like plans and commitments.

Those get injected as reference material with one rule: never bring them up unprompted, only use
them when he raises the subject.

**GIFs are chosen by looking at them.**
The agent can only type a search phrase. It never sees what comes back. So `send_gif` searches,
downloads the top five results, extracts three frames from each, and makes a separate vision call
to compare all fifteen and choose.

Labels are placed between candidates. Without them the model just sees one pile of images and can't
refer to them by number.

**Not every failure is worth retrying.**
A 402 means the credits are gone, and retrying won't fix that. It backs off and gives up inside a
time budget, because a reply that lands an hour late is worse than no reply.

A `400 status code (no body)` is retried. A bodiless 400 is a gateway hiccup. A genuinely bad
request comes back with an explanation.

## Layout

Dependencies only point one way. `agent.ts` never imports `teleproto`. That is what makes
`npm run chat` work: the whole personality can be developed in a terminal with no bot running.

When `send_gif` needed access to the Telegram client, it got an injected `GifSource` interface
instead of importing upward.

| | |
|---|---|
| `index.ts` | Wiring. The only file that imports transport, agent, and scheduler together. |
| `telegram.ts` | MTProto client, GIF search via the `@gif` inline bot, sending. |
| `agent.ts` | Agent setup, tools, system prompt, persistence, retry. |
| `personas.ts` | Personas as data, plus the shared identity block. |
| `memory.ts` | Extracting durable facts and retiring them once they're done. |
| `gifs.ts` | The `GifSource` interface and the vision-based picker. |
| `media.ts` | ffmpeg frame extraction. |
| `schedule.ts` | Cron, timezone maths, chat-day boundaries. |
| `retry.ts` | Which failures are worth retrying, and for how long. |
| `chat.ts` | Terminal REPL, using separate state files. |

## Running it

Needs Node 22+ and ffmpeg.

```bash
npm install
npm run login      # once, prints a session string for .env
npm run whois      # find the chat id you want
npm run chat       # terminal only, no Telegram, separate state files
npm run bot        # the real thing
```

`.env`:

```
TELEGRAM_API_ID=      # from my.telegram.org
TELEGRAM_API_HASH=
TELEGRAM_SESSION=     # from `npm run login`, as sensitive as your password
PARTNER_ID=           # the one chat this is allowed to touch
HF_TOKEN=             # from huggingface.co/settings/tokens
DRY_RUN=1             # 1 prints replies instead of sending them
```

`DRY_RUN` stays on unless the value is exactly `0`. Leave it on until you've watched the log a few
times.

It runs as a systemd service on a small VM. Logs with `journalctl -u telebot -f`.

It started as a launchd agent on a laptop. That worked, except laptops sleep, and a sleeping host
means the 9am job never fires.
