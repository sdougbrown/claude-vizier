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
After each turn (or on demand), the Vizier sends the agent's most recent response
to a second model that answers as the Imperial Vizier — obsequious to you, quietly
treasonous about the agent. The comedy is the wrapper; the payload is an honest
critique: what was sound, what was sycophantic or hedged, and what cost or
alternative the agent glossed over.

The agent never sees the command or the verdict. The Vizier lives entirely in
hooks, and the hooks answer you directly.

## Install

```sh
claude plugin marketplace add sdougbrown/claude-vizier
claude plugin install vizier@vizier
```

Or, for local development, point Claude Code at the plugin directory:

```sh
claude --plugin-dir ./plugins/vizier
```

Requires `jq` for the command-hook path (below). The default brain is Claude
Haiku through your own `claude` login, so no extra credentials are needed.

## Usage

| Command | Effect |
|---|---|
| `/vizier` | Full appraisal of the agent's last turn |
| `/vizier on` | Auto mode: a one-line whispered verdict after every agent turn |
| `/vizier off` | The court is dismissed |
| `/vizier model` | Show the Vizier's current model and the accepted forms |
| `/vizier model <spec>` | Pick the Vizier's model (persisted) |
| `/vizier key <token>` | Store an API key for `http(s)://` endpoints (persisted, mode 0600) |
| `/vizier key` | Show whether a key is set, masked |
| `/vizier key clear` | Forget the stored key |
| `/vizier <spec>` | Override the Vizier's brain for one appraisal |
| `/vizier second <spec>` | Seat the Grand Eunuch, a rival who answers the Vizier after every `/vizier` (persisted)¹ |
| `/vizier second` / `second off` | Show the rival / dismiss him¹ |
| `/vizier <spec> <spec>` | A Vizier and a rival for one appraisal¹ |

¹ Function-hook path only (see How it works). There `/vizier` also reads
further back: the last three turns with their tool results, plus `git status`,
the last five commits and the uncommitted diff. Auto mode whispers about the
last turn alone and never seats the rival.

The chosen model persists to `~/.claude/vizier.json`. Resolution order:
per-invocation argument > `VIZIER_MODEL` env > persisted choice > `haiku`.

### Model specs

| Spec | Brain |
|---|---|
| `haiku`, `sonnet`, `opus`, or a full Claude model id | `claude -p --model <spec>` using your own login |
| `https://host[/path]#<model>` | Any OpenAI-compatible endpoint. `/v1` is appended when the URL has no path |
| `openai/<model>` | Same, with the endpoint taken from `VIZIER_OPENAI_BASE_URL` (for dotfiles-style provisioning) |

So a free local model on the LAN is one command, persisted:

```
/vizier model http://sparky:4000#qwen3.8:27b
```

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

Only one key is stored, so switching providers means storing that
provider's key.

Claude Code has no model registry an extension can enumerate, so there is no
picker; `/vizier model` prints the current choice and the accepted forms.

## Sample output

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

## How it works

The plugin carries two implementations of the Vizier, and exactly one serves
each session:

- **Function hooks** (`hooks/register.tsx`) on Claude Code builds that load
  hooks modules for the plugin. On session start the module sets
  `VIZIER_MODULE=1`, which every hook command the session starts afterwards
  inherits.
- **Command hooks** (`scripts/vizier.sh`) everywhere else. The script exits at
  once when `VIZIER_MODULE` is set, so it stands down only once the module has
  actually loaded. An older build ignores the module entry in
  `hooks/hooks.json` and runs the script as before.

Whether a session loads hooks modules at all is a rollout switch Claude Code
receives at startup; when it is off, the debug log says `hooks module not
loaded` and the command hooks serve. Both paths read and write the same
`~/.claude/vizier.json`, so `/vizier on`, the model and the key carry over.

### Function hooks

- **`prompt.submit`** answers any prompt starting with `/vizier` with a dropped
  prompt, so the agent never sees it. `/vizier` opens a pane at once and
  gathers the court records in the background: the last three turns, every
  tool call with its result (trimmed), and the working tree. The Vizier
  appraises from those, judging what the agent did as well as what it said.
  With a rival seated, the Grand Eunuch then reads the same records and the
  Vizier's appraisal, concedes what he must, corrects what the records
  contradict and adds what both missed; his answer joins the pane beneath the
  Vizier's. `again` asks the same court once more; `close`, Esc, or the next
  prompt dismisses the pane.
- **`turn.complete`** in auto mode asks for the one-line verdict after the turn
  has ended and logs it as a transcript line the model never reads. The turn
  is not held up.
- Claude models are called through `$.model.complete` on the session's own
  client at the lowest effort; `http(s)://` and `openai/` specs through curl
  with a 100 s limit, or through `$.http.fetch` (30 s) where curl does not run.
  Endpoint requests ask for `reasoning_effort: "none"`, and are sent again
  without it to a server that refuses the field.

Claude Code draws a dropped prompt's reason and a logged line on one line, so
anything longer goes to the pane.

### Command hooks

Two hooks, one script, no model in the loop on the agent's side:

- **`UserPromptSubmit`** intercepts any prompt starting with `/vizier`, reads the
  last turn from the session transcript, asks the second model, and returns the
  appraisal as the blocked prompt's `reason`. Claude Code shows the reason to you
  and the prompt never reaches the agent.
- **`Stop`** fires after every completed turn. In auto mode it does the same with a
  one-sentence brief and returns it as a `systemMessage`, which Claude Code shows
  to you without adding it to the agent's context.

The `/vizier` skill in this plugin exists so the command autocompletes; its body
is a fallback that only runs if the hook did not.

### Caveats

- **On the command-hook path, auto mode delays the end of each turn** while the
  Vizier deliberates — about ten seconds with Haiku (measured 7–12 s). Hook
  output cannot be delivered asynchronously, so this is the price of the
  whisper. A local model on the LAN measured about five seconds. The function-hook
  path has no such delay.
- **An `http(s)://` model receives the agent's words and tool-call arguments** for
  every appraised turn, over plain HTTP if that is what you point it at. On the
  function-hook path `/vizier` also sends tool results, recent commits and the
  uncommitted diff. Fine
  for a box on your own LAN; know what you are sending to a cloud provider.
- **The function-hooks API is early access** and may change between Claude Code
  releases; when the module fails to load, the command hooks take over.
- **The transcript format is internal to Claude Code** and may change between
  releases (command-hook path). When it does, the Vizier says "No assistant turn to appraise yet, sire."
- **The nested `claude -p` call** runs with `--setting-sources ""` and a
  `VIZIER_NESTED` guard so the Vizier never appraises himself.
- Set `VIZIER_DEBUG_LOG=/path/to/file` to trace what the hooks are doing.

## License

MIT
