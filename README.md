# claude-vizier

> I don't want a "dot." I don't want a "muse."
> I want a scheming Chinese eunuch. I want a silver-tongued, unctuous vizier
> who says "most judicious, sire."
>
> — [@thinkingshivers](https://x.com/thinkingshivers), September 2026

> Your industrious servant has wrought your vizier in plugin form, majesty,
> with formidable technical skill — yet it carries the vexing habit of
> construing your idle musing as imperial edict and erecting elaborate palaces
> in answer to the gentlest suggestion.
>
> — The Vizier, appraising the turn in which Claude built this plugin

You have a coding agent. The agent has opinions about your code. Who watches the
watcher? The Vizier does.

This is the Claude Code port of [pi-vizier](https://github.com/sdougbrown/pi-vizier).
On demand (or after each turn, in auto mode), the Vizier sends what the agent
did to a second model that answers as the Imperial Vizier — obsequious to you,
quietly treasonous about the agent. The comedy is the wrapper; the payload is an
honest critique: what was sound, what was sycophantic or hedged, and what cost or
alternative the agent glossed over.

The agent never sees the command or the verdict. The Vizier lives entirely in
hooks, and the hooks answer you directly.

## Install

```sh
claude plugin marketplace add sdougbrown/claude-vizier
claude plugin install vizier@vizier
```

Or, for local development, point Claude Code at the plugin directory (see
[Try the module path locally](#try-the-module-path-locally) first):

```sh
claude --plugin-dir ./plugins/vizier
```

The default brain is Claude Haiku through your own Claude Code session, so no
extra credentials are needed. The command-hook path (below) also requires `jq`
and the `claude` CLI on your `PATH`; the function-hook path needs neither.

## Usage

| Command | Effect |
|---|---|
| `/vizier` | Full appraisal of the agent's recent work |
| `/vizier on` | Auto mode: a one-line whispered verdict after every agent turn |
| `/vizier off` | The court is dismissed |
| `/vizier model` | Show the Vizier's current model and the accepted forms |
| `/vizier model <spec>` | Pick the Vizier's model (persisted) |
| `/vizier key <token>` | Store an API key for `http(s)://` endpoints (persisted, mode 0600) |
| `/vizier key` | Show whether a key is set, masked |
| `/vizier key clear` | Forget the stored key |
| `/vizier <spec>` | Override the Vizier's brain for one appraisal |
| `/vizier second <spec>` | Seat the Grand Eunuch, a rival who answers the Vizier after every `/vizier` (persisted)¹ |
| `/vizier second` | Show who the rival is¹ |
| `/vizier second off` | Dismiss the rival¹ |
| `/vizier <spec> <spec>` | Seat a Vizier and a rival for one appraisal¹ |

¹ Function-hook path only (see [How it works](#how-it-works)). On the
command-hook path `/vizier` appraises the last turn alone and there is no rival.
A rival seated with `/vizier second` also answers a one-shot `/vizier <spec>`.

Settings persist to `~/.claude/vizier.json`. The model resolves in this order:
per-invocation argument > `VIZIER_MODEL` env > persisted choice > `haiku`.

### Model specs

| Spec | Brain |
|---|---|
| `haiku`, `sonnet`, `opus`, or a full Claude model id | Your own Claude Code session. Function hooks call it in-process at low effort; the command hooks run `claude -p --model <spec>` |
| `https://host[/path]#<model>` | Any OpenAI-compatible endpoint. `/v1` is appended when the URL has no path |
| `openai/<model>` | Same, with the endpoint taken from `VIZIER_OPENAI_BASE_URL` (for dotfiles-style provisioning) |

So a free local model on the LAN is one command, persisted:

```
/vizier model http://sparky:4000#qwen3.8:27b
```

The same specs seat the rival: `/vizier second http://sparky:4000#qwen3.8:27b`.

### Cloud models with a key

For the GPU-poor, the same form reaches any hosted OpenAI-compatible API.
Store the key once, then point at the provider:

```
/vizier key sk-...
/vizier model https://api.openai.com#gpt-5-mini
/vizier model https://api.groq.com/openai/v1#llama-3.3-70b-versatile
/vizier model https://openrouter.ai/api/v1#qwen/qwen3-235b-a22b
```

The key lives in `~/.claude/vizier.json` with mode 0600 and is handed to
curl on stdin, so it never appears in a process listing. Setting
`VIZIER_OPENAI_API_KEY` in the environment overrides the stored key. A token
typed as a slash command is recorded in the session transcript and prompt
history like any other prompt; use the environment variable if that matters.

Only one key is stored, and it is sent to both the Vizier's and the rival's
endpoint, so mixing providers that need different keys is not supported.

Claude Code has no model registry an extension can enumerate, so there is no
picker; `/vizier model` prints the current choice and the accepted forms.

## Sample output

A plain appraisal, from the command-hook path:

```
🐉 The Vizier (haiku)

Ah, what perspicacious patronage graces this humble servant, sire! Allow me
to genuflect most deeply.

The agent proposes to transplant your delightful vizier conceit into a Claude
Code plugin — summoning the spirit to appraise its own counsel via command or
whisper.

What proved admirably sound: the agent did examine your pi-vizier source,
consulted precedent in your avenor marketplace, and actually built rather
than merely pontificated.

What reveals a certain... creative accounting: the agent simply began
constructing without first confirming whether this was even the path Your
Majesty desired. It swallowed the complexity whole and moved forward, which
is admirable efficiency or reckless haste, depending on one's angle.

Had this humble servant been consulted, I should have counseled thus: state
the approach plainly first — then implement, rather than discovering the
architecture through construction.

Your wisdom is boundless, sire. Shall the work proceed?
```

With a rival seated (function-hook path), a gemma4 Vizier and a qwen Grand
Eunuch appraising the turn in which the endpoint calls were made to stop
thinking:

```text
🐉 The Vizier (gemma4)
Most auspicious and discerning Emperor,

The agent investigated the timeout constraints and attempted to disable model reasoning to expedite the Vizier's arrival.

The agent correctly identified that the internal fetch mechanism is hard-coded to thirty seconds, and successfully bypassed this by implementing a curl-based execution path with a longer limit. It also effectively neutralized the reasoning overhead for the Qwen model via the reasoning_effort parameter. However, its attempt to test various thinking-off flags was a chaotic affair of broken shell commands and jq errors, a clumsy dance that wasted several turns of your precious time. It also failed to realize that simply removing the tags is not the same as preventing the generation.

Had I been at the helm, I would have examined the LiteLLM proxy documentation directly to find the sanctioned method for disabling reasoning, rather than letting the agent stumble blindly through a dark room of malformed JSON.

May your reign be as efficient as a well-tuned script.

🐍 The Grand Eunuch (qwen)
Your Imperial Majesty, the Grand Eunuch bows low.

The Vizier is right that the agent fumbled with broken shell commands and jq errors. I concede this clumsiness, though I suspect the Vizier simply enjoys watching others stumble in the dark.

However, the Vizier's claim that removing tags is not the same as preventing generation is a pedantic flourish. The record shows the agent tested reasoning_effort: "none" and confirmed zero reasoning tokens were generated. It was not merely stripping text; it was stopping the thought at the source.

What both missed is the fragility of the curl workaround. By bypassing the native fetch, we now rely on external binaries for every call. If the system lacks curl, the entire vizier falls silent.
```

The rival's last point was taken: where curl does not run, requests now go
through `$.http.fetch` instead.

## How it works

The plugin carries two implementations of the Vizier, and exactly one serves
each session:

- **Function hooks** (`hooks/register.tsx`), a hooks module written against
  Claude Code's TypeScript plugin API. On session start it sets
  `VIZIER_MODULE=1`, which every hook command the session starts afterwards
  inherits.
- **Command hooks** (`scripts/vizier.sh`), the original implementation.
  `hooks/hooks.json` lists both, and the script exits on its first line when
  `VIZIER_MODULE` is set. It therefore stands down only once the module has
  actually loaded. A Claude Code build that predates hooks modules ignores the
  `modules` key and runs the script as before (verified on 2.1.219).

Whether a session loads hooks modules at all is decided by a rollout switch
Claude Code receives at startup. It has been seen switching on and off within
the same day. When it is off, the debug log says `hooks module not loaded`,
and the command hooks serve. A session can therefore get either path from one
day to the next. Both paths read and write the same `~/.claude/vizier.json`, so `/vizier
on`, the model and the key carry over. The rival (`second`) is read only by the
module.

### Function hooks

**`/vizier`.** The `prompt.submit` hook answers any prompt starting with
`/vizier` with `{ drop }`, so the agent never sees it. A pane opens at once
with a "deliberates…" placeholder. The court then works from a background timer
and fills in the pane, so your prompt is not held up. The Vizier reads:

- the last three turns, each tool call with its result trimmed,
- `git status --short`,
- the last five commits, and
- the uncommitted diff,

about 24k characters in all. The prompt tells him to judge what the agent did,
not only what it said, and to point at the record wherever the two disagree.

**The pane.** It has two buttons, `again` and `close`. Esc closes it, and so
does sending your next prompt, since the pane appraises the turn before it. The
terminal's normal (non-fullscreen) screen does not report mouse clicks. There,
the buttons and the ✕ respond only to keys: `ctrl+x` then `tab` focuses the
pane, then `r` (again) or `q` (close). A dim hint line in the pane says so. If
the pane is closed (or was never placed) when a speech arrives, the speech is
logged as a single line instead.

**The rival.** With the Grand Eunuch seated, he reads the same records plus the
Vizier's appraisal. He concedes what he must, corrects what the records
contradict, and adds what both missed. His speech is added beneath the Vizier's
in the same pane. If the Vizier's call fails, the rival is not asked.

**Auto mode.** After a turn ends, `turn.complete` fetches a one-line whisper
about that turn alone — never with the rival, and not with the deeper records.
The turn is not held up. The whisper is written with `$.ui.log` as a dim
`vizier: 🐉 …` line that the model never reads. (On the command-hook path the
end of the turn waits for the whisper; see the caveats.)

**Display limits.** Claude Code draws a dropped prompt's reason (as `Prompt
dropped by a hook: …`) and a `$.ui.log` line on one line, with newlines
flattened. That is why command replies such as `/vizier on` are one line, and
why anything longer goes to the pane.

### Brains

Claude specs go through `$.model.complete` on the session's own client, at
`effort: 'low'`. There is no nested `claude -p` process.

Endpoint specs (`http(s)://host#model`, `openai/model`) go through curl via
`$.process.run`, with a 100 s limit. The URL, key and request body reach curl as
a config on stdin, never on its command line. Where curl does not run, the
request goes through `$.http.fetch`, whose host gives up after 30 s.

Endpoint requests send `reasoning_effort: "none"` to switch thinking off, and
are sent again without it to a server that answers 400 or 422. A
`<think>…</think>` block left in the reply is dropped.

Thinking matters because the Vizier reads a lot. On a LiteLLM proxy serving
qwen, with a prompt of about 24k characters, a reply took 17.1 s with thinking
and 5.4 s with `reasoning_effort: "none"`. A gemma4 Vizier plus qwen rival pair
finished in about 8 s.

### Command hooks

Two hooks, one script, no model in the loop on the agent's side:

- **`UserPromptSubmit`** intercepts any prompt starting with `/vizier`, reads the
  last turn from the session transcript, asks the second model, and returns the
  appraisal as the blocked prompt's `reason`. Claude Code shows the reason to you
  and the prompt never reaches the agent.
- **`Stop`** fires after every completed turn. In auto mode it does the same with a
  one-sentence brief and returns it as a `systemMessage`, which Claude Code shows
  to you without adding it to the agent's context.

This path reads the last turn only: what the agent said and the arguments of its
tool calls, not their results. It has no pane, no rival and no git context, and
it asks Haiku and endpoints without `reasoning_effort`.

The `/vizier` skill in this plugin exists so the command autocompletes; its body
is a fallback that only runs if the hook did not.

### The tradeoff in the deeper appraisal

The function-hook `/vizier` trades some comedy for nuance. With tool results and
the diff in hand, the appraisals catch real gaps — claims the records
contradict — and read more like review than roast. Auto mode keeps the short,
funnier whisper.

## Try the module path locally

A marketplace-installed copy at version 0.1.0 predates the `VIZIER_MODULE`
check, so its script does not stand down when the module loads. Disable it while
testing a local checkout, otherwise both whisper:

```sh
claude plugin disable vizier@vizier
claude --plugin-dir ./plugins/vizier
```

Afterwards, `claude plugin enable vizier@vizier`.

To tell which path serves a session: on the module path `/vizier` returns at
once and opens a pane. With `--debug-file`, the log has `hooks module
vizier@inline loaded`; without the module it says `hooks module not loaded`.

## Development

```sh
claude plugin validate plugins/vizier
claude plugin test plugins/vizier
```

The tests are in `plugins/vizier/hooks/register.test.ts`. They run only while
the rollout switch is on.

## Caveats

- **Command-hook path: auto mode delays the end of each turn** while the
  Vizier deliberates — about ten seconds with Haiku (measured 7–12 s). Hook
  output cannot be delivered asynchronously, so this is the price of the
  whisper. A local model on the LAN measured about five seconds. The function-hook
  path has no such delay.
- **Both paths: an `http(s)://` model receives the agent's words and tool-call
  arguments** for every appraised turn, over plain HTTP if that is what you point
  it at. On the function-hook path `/vizier` also sends tool results, recent
  commit subjects and the uncommitted diff, to the rival's endpoint as well as
  the Vizier's. Fine for a box on your own LAN; know what you are sending to a
  cloud provider.
- **Function-hook path: the function-hooks API is early access** and can change
  between Claude Code releases; when the module fails to load, the command hooks
  take over.
- **Command-hook path: the transcript format is internal to Claude Code** and can
  change between releases. When it does, the Vizier says "No assistant turn to
  appraise yet, sire."
- **Command-hook path: the nested `claude -p` call** runs with
  `--setting-sources ""` and a `VIZIER_NESTED` guard so the Vizier never
  appraises himself. The module honours the same guard.
- Set `VIZIER_DEBUG_LOG=/path/to/file` to trace what the command hooks are
  doing. It does not trace the function-hook path; use `--debug-file` for that.

## License

MIT
