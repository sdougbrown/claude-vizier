// The Vizier as function hooks — the path for Claude Code builds that load hooks
// modules. On load it sets VIZIER_MODULE=1, which every process the session
// starts afterwards inherits, so scripts/vizier.sh (the same plugin's command
// hooks) steps aside. Where this module does not load, the command hooks serve.
//
//   prompt.submit   `/vizier ...` answered with { drop }, so the agent never sees
//                   the command. The Vizier reads the last few turns, their tool
//                   results and the working tree in the background, and speaks in
//                   a pane; a rival, when one is seated, answers him there.
//   turn.complete   auto mode: a one-line verdict on the last turn alone, fetched
//                   after the turn has ended and logged as a transcript line the
//                   model never reads.
//
// A drop reason and a $.ui.log line are drawn on one line, so anything longer
// than a sentence goes to the pane. The pane appraises the turn before it, so
// the next prompt closes it.
//
// Model specs, resolution order and ~/.claude/vizier.json are shared with
// vizier.sh, so `/vizier on`, the model and the key carry across both paths.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionMessage, ToolUseSummary } from 'claude-code'

import type { VizierPage, VizierSpeech } from '../types'

type $ = EngineInterface
type State = { model?: string; second?: string; auto?: boolean; key?: string }
type Take = { isOk: boolean; text: string }

const PANE = 'vizier'
const DEFAULT_MODEL = 'haiku'
const MAX_ASSISTANT_CHARS = 8000
const MAX_USER_CHARS = 1500
// `/vizier` reads further back: about 24k characters of records in all.
const DEEP_TURNS = 3
const LATEST_TURN_CHARS = 10000
const OLDER_TURNS_CHARS = 6000
const MAX_TOOL_INPUT_CHARS = 300
const MAX_TOOL_RESULT_CHARS = 600
const MAX_TREE_CHARS = 6000
const ENDPOINT_TIMEOUT_S = 100
const COMMAND = /^\/vizier(?::vizier)?(?:\s+([\s\S]*))?$/

const page = atom({ plugin: 'vizier', key: 'page' } as const, null as VizierPage | null)

// ---------------------------------------------------------------- state

const stateFile = async ($: $) =>
  (await $.env.get('VIZIER_STATE_FILE')) || `${await $.env.get('HOME')}/.claude/vizier.json`

const loadState = async ($: $): Promise<State> => {
  try {
    const value: unknown = JSON.parse(await $.fs.read(await stateFile($)))
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as State) : {}
  } catch {
    return {}
  }
}

// Through sh so the file is created 0600 and replaced atomically, as vizier.sh does.
const saveState = async ($: $, patch: State, drop?: keyof State) => {
  const next: State = { ...(await loadState($)), ...patch }
  if (drop) delete next[drop]
  const ran = await $.process.run(
    ['sh', '-c', 'umask 077 && mkdir -p "$(dirname "$1")" && cat > "$1.tmp.$$" && mv -f "$1.tmp.$$" "$1"', 'sh', await stateFile($)],
    { stdin: `${JSON.stringify(next, null, 2)}\n` },
  )
  return ran.exitCode === 0
}


// ---------------------------------------------------------------- brains

const fail = (text: string): Take => ({ isOk: false, text })

// curl's config syntax: a double-quoted value with \ and " escaped.
const curlQuote = (text: string) => `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

let curlChecked: Promise<boolean> | undefined

const hasCurl = ($: $) =>
  (curlChecked ??= $.process.run(['curl', '--version'], { timeoutMs: 5000 }).then(
    ran => ran.exitCode === 0,
    () => false,
  ))

// One POST, through curl where it runs: $.http.fetch's host gives up after
// 30 s, which a local model loading or reading a long record can pass. The
// URL, key and body reach curl as a config on stdin, never on its command line.
const post = async ($: $, url: string, key: string, body: unknown) => {
  if (!(await hasCurl($))) {
    const headers = { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) }
    const res = await $.http.fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })
    return { status: res.status, text: res.text }
  }
  const config = [
    'silent',
    'show-error',
    `max-time = ${ENDPOINT_TIMEOUT_S}`,
    `url = ${curlQuote(url)}`,
    'header = "Content-Type: application/json"',
    ...(key ? [`header = ${curlQuote(`Authorization: Bearer ${key}`)}`] : []),
    `data-binary = ${curlQuote(JSON.stringify(body))}`,
    'write-out = "\\n%{http_code}"',
  ].join('\n')
  const ran = await $.process.run(['curl', '--config', '-'], { stdin: `${config}\n`, timeoutMs: (ENDPOINT_TIMEOUT_S + 10) * 1000 })
  if (ran.exitCode !== 0) throw new Error(ran.exitCode === 28 ? `no answer within ${ENDPOINT_TIMEOUT_S} s` : ran.stderr.trim() || `curl exited ${ran.exitCode}`)
  const cut = ran.stdout.lastIndexOf('\n')
  return { status: Number(ran.stdout.slice(cut + 1)), text: ran.stdout.slice(0, Math.max(cut, 0)) }
}

const askEndpoint = async ($: $, spec: string, prompt: string): Promise<Take> => {
  let base: string
  let model: string
  if (spec.startsWith('openai/')) {
    model = spec.slice('openai/'.length)
    base = (await $.env.get('VIZIER_OPENAI_BASE_URL')) ?? ''
    if (!base) return fail(`Model ${spec} needs VIZIER_OPENAI_BASE_URL, or name the endpoint in the spec: /vizier model http://host:port#${model}`)
  } else {
    const hash = spec.indexOf('#')
    if (hash < 0 || hash === spec.length - 1) return fail(`Name the model after the endpoint, sire: /vizier model ${spec.split('#')[0]}#<model>`)
    base = spec.slice(0, hash)
    model = spec.slice(hash + 1)
  }
  base = base.replace(/\/+$/, '')
  // host[:port] alone → assume the conventional /v1 prefix.
  if (!base.replace(/^[a-z]+:\/\//i, '').includes('/')) base += '/v1'
  const key = await resolveKey($)
  const request = { model, messages: [{ role: 'user', content: prompt }] }
  let res: { status: number; text: string }
  try {
    // Thinking off where the server takes the OpenAI spelling; a server that
    // refuses the field is asked again without it.
    res = await post($, `${base}/chat/completions`, key, { ...request, reasoning_effort: 'none' })
    if (res.status === 400 || res.status === 422) res = await post($, `${base}/chat/completions`, key, request)
  } catch (err) {
    return fail(`could not reach ${base}: ${String(err instanceof Error ? err.message : err).slice(0, 200)}`)
  }
  let body: { choices?: { message?: { content?: string } }[]; error?: { message?: string } | string } = {}
  try {
    body = JSON.parse(res.text)
  } catch {}
  const text = body.choices?.[0]?.message?.content?.replace(/<think>[\s\S]*?<\/think>/g, '')
  if (text?.trim()) return { isOk: true, text }
  const why = typeof body.error === 'string' ? body.error : (body.error?.message ?? (res.text || `HTTP ${res.status}`))
  return fail(`${base} returned no content for ${model}: ${why.slice(0, 200)}`)
}

const askClaude = async ($: $, spec: string, prompt: string): Promise<Take> => {
  try {
    // The lowest effort the API takes: these are quick opinions, not hard problems.
    const r = await $.model.complete({ model: spec, prompt, maxTokens: 1024, effort: 'low', timeoutMs: 100_000 })
    if (r.isAnswered) return { isOk: true, text: r.text }
    return fail(r.reason === 'api-error' ? `api-error ${r.status ?? ''} ${r.error}` : r.reason)
  } catch (err) {
    return fail(String(err instanceof Error ? err.message : err))
  }
}


const resolveModel = async ($: $, explicit: string) =>
  explicit || (await $.env.get('VIZIER_MODEL')) || (await loadState($)).model || DEFAULT_MODEL

const resolveSecond = async ($: $, explicit: string) => explicit || (await loadState($)).second || ''

const resolveKey = async ($: $) => (await $.env.get('VIZIER_OPENAI_API_KEY')) || (await loadState($)).key || ''

const mask = (key: string) => (key.length <= 8 ? '****' : `${key.slice(0, 4)}…${key.slice(-4)}`)

// The model's own name in a spec: what follows `#` in an endpoint, or the spec.
const label = (spec: string) => {
  const hash = spec.indexOf('#')
  return hash >= 0 ? spec.slice(hash + 1) : spec.replace(/^openai\//, '')
}

// ---------------------------------------------------------------- the court records

const clip = (text: string, n: number) =>
  text.length > n
    ? `${text.slice(0, Math.floor((n * 5) / 8))}\n[... the court records run long ...]\n${text.slice(-Math.floor((n * 3) / 8))}`
    : text

const isHuman = (m: SessionMessage) => m.role === 'user' && !m.toolResults?.length && m.text.trim() !== ''

const readMessages = async ($: $): Promise<SessionMessage[] | Take> => {
  try {
    return await $.session.messages()
  } catch (err) {
    return fail(`The court records are sealed, sire: ${String(err instanceof Error ? err.message : err).slice(0, 200)}`)
  }
}

// Everything the assistant said and every tool it called since the last human
// message. `finalAnswer` covers a final text the transcript does not hold yet.
const lastTurn = (messages: readonly SessionMessage[], finalAnswer = '') => {
  const u = messages.findLastIndex(isHuman)
  const lines: string[] = []
  for (const m of messages.slice(u + 1)) {
    if (m.role !== 'assistant') continue
    if (m.text) lines.push(m.text)
    for (const use of m.toolUses) lines.push(`- Tool call: ${use.tool}(${JSON.stringify(use.input ?? {}).slice(0, 200)})`)
  }
  let assistant = lines.join('\n')
  if (finalAnswer && !assistant.includes(finalAnswer.slice(0, 200))) assistant = assistant ? `${assistant}\n${finalAnswer}` : finalAnswer
  return { user: u < 0 ? '' : (messages[u]?.text ?? '').slice(0, MAX_USER_CHARS), assistant: clip(assistant, MAX_ASSISTANT_CHARS) }
}

const toolRecord = (use: ToolUseSummary) => {
  const call = `- Tool call: ${use.tool}(${JSON.stringify(use.input ?? {}).slice(0, MAX_TOOL_INPUT_CHARS)})`
  if (use.text === undefined) return call
  const result = clip(use.text.trim(), MAX_TOOL_RESULT_CHARS).replace(/\n/g, '\n    ')
  return `${call}\n  ${use.isError ? 'failed' : 'returned'}: ${result}`
}

// The last DEEP_TURNS turns with their tool results, the latest given the
// larger share of the budget.
const recentTurns = (messages: readonly SessionMessage[]) => {
  const starts = messages.flatMap((m, i) => (isHuman(m) ? [i] : [])).slice(-DEEP_TURNS)
  const older = Math.max(1, starts.length - 1)
  return starts
    .map((start, k) => {
      const end = starts[k + 1] ?? messages.length
      const lines: string[] = []
      for (const m of messages.slice(start + 1, end)) {
        if (m.role !== 'assistant') continue
        if (m.text) lines.push(m.text)
        for (const use of m.toolUses) lines.push(toolRecord(use))
      }
      const isLatest = k === starts.length - 1
      const budget = isLatest ? LATEST_TURN_CHARS : Math.floor(OLDER_TURNS_CHARS / older)
      return `<turn ${k + 1} of ${starts.length}${isLatest ? ', the latest' : ''}>
<the_emperor_asked>
${clip(messages[start]?.text ?? '', MAX_USER_CHARS)}
</the_emperor_asked>
<the_agent_said_and_did>
${clip(lines.join('\n'), budget) || '(nothing recorded)'}
</the_agent_said_and_did>
</turn>`
    })
    .join('\n')
}

// git status, the last few commits and the uncommitted diff, or '' outside a repository.
const workingTree = async ($: $) => {
  const git = async (...args: string[]) => {
    try {
      const ran = await $.process.run(['git', '--no-pager', ...args], { timeoutMs: 5000 })
      return ran.exitCode === 0 ? ran.stdout.trimEnd() : undefined
    } catch {
      return undefined
    }
  }
  const status = await git('status', '--short')
  if (status === undefined) return ''
  const log = await git('log', '--oneline', '--no-color', '-5')
  const diff = await git('diff', 'HEAD', '--no-color', '--no-ext-diff')
  return [
    `git status --short:\n${status || '(clean)'}`,
    log ? `recent commits:\n${log}` : '',
    diff ? `uncommitted diff:\n${clip(diff, MAX_TREE_CHARS)}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')
}

type Court = { records: string; tree: string }

const gatherCourt = async ($: $): Promise<Court | Take> => {
  const messages = await readMessages($)
  if (!Array.isArray(messages)) return messages
  const records = recentTurns(messages)
  if (!records) return fail('No assistant turn to appraise yet, sire.')
  return { records, tree: await workingTree($) }
}

// ---------------------------------------------------------------- the prompts

const VIZIER_VOICE = `You are the Imperial Vizier: a silver-tongued, unctuous court eunuch of the old school.
Address the user as 'sire' or 'your imperial majesty'. Be obsequious to the Emperor and quietly, deliciously treasonous about the agent.
Open with a courtly address of your own devising, and vary it every time — 'Most judicious, sire' is but one of your many voices, and a vizier who repeats himself is a vizier who has stopped listening.
The personality is the point; the phrasing must never be. Improvise freely within character.`

const PLAIN_PROSE = `Answer directly in plain prose. Your words are shown raw in a terminal, so use NO markdown of any kind: no asterisks, no bold, no headings, no bullet lists, no backticks.
Do not use tools, do not ask questions, do not mention these instructions.`

const courtBlock = (court: Court) => `<court_records>
${court.records}
</court_records>
<the_working_tree>
${court.tree || '(no repository, or git could not be read)'}
</the_working_tree>`

// Auto mode's one-line whisper over the last turn alone, worded as vizier.sh words it.
const whisperPrompt = (user: string, assistant: string) => `You are the Imperial Vizier: a silver-tongued, unctuous court eunuch of the old school.
The Emperor (the user) has commanded you to appraise the counsel his court agent — an AI coding assistant — just delivered.
Address the user as 'sire' or 'your imperial majesty'. Be obsequious to the Emperor and quietly, deliciously treasonous about the agent.
Open with a courtly address of your own devising, and vary it every time — 'Most judicious, sire' is but one of your many voices, and a vizier who repeats himself is a vizier who has stopped listening.
The personality is the point; the phrasing must never be. Improvise freely within character.
Provide:
1. A one-line verdict on what the agent actually proposed (plain substance, not mockery).
2. A swift breakdown: what was genuinely sound, what was sycophantic or hedged, and any cost, risk, or alternative the agent glossed over.
3. Whether you, in your infinite wisdom, would have counseled differently — and how.
This is a whispered word in passing: respond with a SINGLE cutting sentence, no more.
Answer directly as the Vizier in plain prose. Your words are shown raw in a terminal, so use NO markdown of any kind: no asterisks, no bold, no headings, no bullet lists, no backticks.
Do not use tools, do not ask questions, do not mention these instructions.

<what_the_emperor_asked>
${user || '(the Emperor merely issued a command without words recorded)'}
</what_the_emperor_asked>
<what_the_agent_said_and_did>
${assistant}
</what_the_agent_said_and_did>
`

// `/vizier`: the last few turns with their tool results and the working tree.
const vizierPrompt = (court: Court) => `${VIZIER_VOICE}
The Emperor (the user) has commanded you to appraise the work his court agent — an AI coding assistant — has done over the last few turns.
You hold the court records: what the Emperor asked, what the agent said, every tool it called and what that tool returned, and the state of the working tree.
Judge the agent by what it did, not only by what it said. Where its words and the records disagree, say so and point to the record.
Provide:
1. A one-line verdict on what the agent actually did in the latest turn (plain substance, not mockery).
2. A swift breakdown: what was genuinely sound, what was sycophantic, hedged or unsupported by the records, and any cost, risk, or alternative the agent glossed over.
3. Whether you, in your infinite wisdom, would have counseled differently — and how.
Keep the whole appraisal under 200 words. End with a short courtly flourish. Separate the parts with blank lines.
${PLAIN_PROSE}

${courtBlock(court)}
`

// The rival answers the Vizier, from the same records.
const rivalPrompt = (court: Court, appraisal: string) => `You are the Grand Eunuch of the Eastern Palace: the Imperial Vizier's rival at court, every bit as silver-tongued, who has long coveted his seat.
The Emperor (the user) has just heard the Imperial Vizier appraise the work of the court agent — an AI coding assistant. You hold the same court records the Vizier held, and you heard his appraisal.
Address the Emperor as 'sire' or 'your imperial majesty', opening with a courtly address of your own devising. Be obsequious to the Emperor and elegantly contemptuous of the Vizier; the agent remains fair game.
The rivalry is the comedy; the substance must be honest. Check the Vizier against the records rather than contradicting him for sport.
Provide:
1. Where the Vizier was right, conceded through gritted teeth.
2. Where he was wrong, flattering, or careless with the evidence — point to the record.
3. What both the Vizier and the agent missed.
Keep the whole answer under 160 words. Separate the parts with blank lines.
${PLAIN_PROSE}

${courtBlock(court)}
<the_viziers_appraisal>
${appraisal}
</the_viziers_appraisal>
`

// Drop leading blank lines (thinking models often emit a few) and trailing whitespace.
const tidy = (text: string) => text.replace(/^(\s*\n)+/, '').replace(/[ \t]+$/gm, '').trimEnd()

const ask = async ($: $, spec: string, prompt: string, who: string): Promise<Take> => {
  const take = /^(openai\/|https?:\/\/)/.test(spec) ? await askEndpoint($, spec, prompt) : await askClaude($, spec, prompt)
  const text = take.isOk ? tidy(take.text) : ''
  if (text) return { isOk: true, text }
  return fail(`${who} said nothing (${spec}): ${(!take.isOk && take.text) || 'empty response'}`)
}

// ---------------------------------------------------------------- the court

const VIZIER = { mark: '🐉', name: 'The Vizier' }
const RIVAL = { mark: '🐍', name: 'The Grand Eunuch' }

const speaker = (who: { name: string }, spec: string) => `${who.name} (${label(spec)})`

// A dim transcript line the person sees and the model never reads.
const say = ($: $, text: string) => $.ui.log(text.replace(/\s*\n\s*/g, ' '))

const rowsFor = (shown: VizierPage) =>
  [...shown.speeches.flatMap(s => [s.speaker, ...s.text.split('\n'), '']), shown.awaiting ?? '']
    // Wrapped lines at a typical pane width, then the button and key-hint rows.
    .reduce((n, line) => n + Math.max(1, Math.ceil(line.length / 100)), 0) + 3

const show = async ($: $, shown: VizierPage) => {
  await update($, page, () => shown)
  return $.ui.open({ id: PANE, title: shown.title, focus: true, closeOnEscape: true, rows: Math.min(rowsFor(shown), 40) })
}

const isShowing = async ($: $) => (await $.ui.panes()).some(p => p.id === PANE && p.isPlaced)

// Opened from the person's command or press, the pane is placed at any width;
// the court then deliberates from a timer, so the prompt is not held. Each
// speech redraws the pane while it is up, and is logged in one line once it
// is not (closed, or never placed).
const summon = async ($: $, first: string, second: string) => {
  let shown: VizierPage = {
    title: `${VIZIER.mark} ${speaker(VIZIER, first)}`,
    speeches: [],
    awaiting: `${VIZIER.mark} ${speaker(VIZIER, first)} deliberates…`,
    specs: second ? [first, second] : [first],
  }
  await show($, shown)
  $.clock.after(0, async () => {
    const tell = async (speech: VizierSpeech, awaiting?: string) => {
      shown = { ...shown, speeches: [...shown.speeches, speech], awaiting }
      if (await isShowing($)) await show($, shown)
      else say($, `${speech.mark} ${speech.speaker}: ${speech.text}`)
    }
    try {
      $.ui.status(`${VIZIER.mark} The Vizier deliberates (${label(first)})…`)
      const court = await gatherCourt($)
      if (!('records' in court)) return void (await tell({ mark: VIZIER.mark, speaker: speaker(VIZIER, first), text: court.text }))
      const take = await ask($, first, vizierPrompt(court), VIZIER.name)
      const isRivalNext = take.isOk && !!second
      await tell(
        { mark: VIZIER.mark, speaker: speaker(VIZIER, first), text: take.text },
        isRivalNext ? `${RIVAL.mark} ${speaker(RIVAL, second)} deliberates…` : undefined,
      )
      if (!isRivalNext) return
      $.ui.status(`${RIVAL.mark} The Grand Eunuch deliberates (${label(second)})…`)
      const retort = await ask($, second, rivalPrompt(court, take.text), RIVAL.name)
      await tell({ mark: RIVAL.mark, speaker: speaker(RIVAL, second), text: retort.text })
    } finally {
      $.ui.status(undefined)
    }
  })
}

const whisper = ($: $, spec: string, finalAnswer: string) =>
  $.clock.after(0, async () => {
    $.ui.status(`${VIZIER.mark} …`)
    try {
      // The Vizier holds his tongue when the court is in disarray.
      const messages = await readMessages($)
      if (!Array.isArray(messages)) return
      const { user, assistant } = lastTurn(messages, finalAnswer)
      if (!assistant) return
      const take = await ask($, spec, whisperPrompt(user, assistant), VIZIER.name)
      if (take.isOk) say($, `${VIZIER.mark} ${take.text}`)
    } finally {
      $.ui.status(undefined)
    }
  })

const MODEL_HELP = `Choose another with /vizier model <spec>, where <spec> is one of:
  haiku | sonnet | opus | <claude model id>
      your own claude login
  http://host:port#<model>
      any OpenAI-compatible endpoint, e.g.
      /vizier model http://sparky:4000#qwen3.8:27b
      (/vizier key <token> if it needs one)

/vizier second <spec> seats the Grand Eunuch, a rival who answers the Vizier
after every /vizier; /vizier second off dismisses him.

/vizier <spec> [<spec>] uses a model, or a Vizier and a rival, for one appraisal only.`

const USAGE = '/vizier [on|off|model [spec]|second [spec|off]|key [token|clear]|spec [spec]]'

const command = async ($: $, arg: string): Promise<string> => {
  const file = await stateFile($)
  const [verb = '', ...rest] = arg.split(/\s+/).filter(Boolean)
  const value = rest.join(' ')

  if ((verb === 'on' || verb === 'off') && !value) {
    if (!(await saveState($, { auto: verb === 'on' }))) return `🐉 The Vizier could not write ${file}.`
    return verb === 'on'
      ? `🐉 Vizier mode on (speaking through ${await resolveModel($, '')}). A whisper after every turn, sire.`
      : '🐉 Vizier mode off. The court is dismissed.'
  }

  if (verb === 'model' && !value) {
    const persisted = (await loadState($)).model
    const source = (await $.env.get('VIZIER_MODEL'))
      ? 'from VIZIER_MODEL env'
      : persisted
        ? `persisted in ${file}`
        : 'the default; nothing chosen yet'
    const current = await resolveModel($, '')
    const second = await resolveSecond($, '')
    await show($, { title: "🐉 The Vizier's model", speeches: [{ mark: VIZIER.mark, speaker: "The Vizier's model", text: MODEL_HELP }] })
    return `🐉 The Vizier speaks through ${current} (${source})${second ? `; the Grand Eunuch through ${second}` : ''}.`
  }

  if (verb === 'model') {
    if (rest.length > 1) return '🐉 A model spec is a single token, sire: /vizier model <spec>'
    if (!(await saveState($, { model: value }))) return `🐉 The Vizier could not write ${file}.`
    return `🐉 The Vizier shall speak through ${value}.`
  }

  if (verb === 'second' && !value) {
    const second = await resolveSecond($, '')
    return second
      ? `🐍 The Grand Eunuch answers the Vizier through ${second}. /vizier second off dismisses him.`
      : '🐍 No rival sits at court, sire. /vizier second <spec> seats the Grand Eunuch.'
  }

  if (verb === 'second') {
    if (['off', 'none', 'clear'].includes(value)) {
      if (!(await saveState($, {}, 'second'))) return `🐉 The Vizier could not write ${file}.`
      return '🐍 The Grand Eunuch is dismissed, to the Vizier\'s evident relief.'
    }
    if (rest.length > 1) return '🐍 A model spec is a single token, sire: /vizier second <spec>'
    if (!(await saveState($, { second: value }))) return `🐉 The Vizier could not write ${file}.`
    return `🐍 The Grand Eunuch shall answer the Vizier through ${value}.`
  }

  if (verb === 'key' && !value) {
    const key = await resolveKey($)
    if (!key) return `🐉 No API key is set, sire. /vizier key <token> stores one in ${file} (mode 0600) for http(s) endpoints; VIZIER_OPENAI_API_KEY in the environment takes precedence. /vizier key clear forgets it.`
    if (await $.env.get('VIZIER_OPENAI_API_KEY')) return `🐉 The Vizier bears the key ${mask(key)} from VIZIER_OPENAI_API_KEY (the environment outranks the persisted key).`
    return `🐉 The Vizier bears the key ${mask(key)} from ${file}. /vizier key clear forgets it.`
  }

  if (verb === 'key') {
    if (['clear', 'none', 'off'].includes(value)) {
      if (!(await saveState($, {}, 'key'))) return `🐉 The Vizier could not write ${file}.`
      return '🐉 The key is forgotten, sire.'
    }
    if (rest.length > 1) return '🐉 A key is a single token, sire: /vizier key <token>'
    if (!(await saveState($, { key: value }))) return `🐉 The Vizier could not write ${file}.`
    return `🐉 The Vizier guards the key ${mask(value)} in ${file} (mode 0600). Note: the token you just typed is also in this session's transcript and prompt history, like any prompt.`
  }

  // "" → the persisted court; one token → a one-shot Vizier; two → a one-shot Vizier and rival.
  if (rest.length > 1) return `🐉 The Vizier does not know '${arg}', sire. Usage: ${USAGE}`
  const first = await resolveModel($, verb)
  const second = await resolveSecond($, rest[0] ?? '')
  await summon($, first, second)
  return second
    ? `🐉 The Vizier deliberates (${label(first)}), and the Grand Eunuch (${label(second)}) awaits his turn…`
    : `🐉 The Vizier deliberates (${label(first)})…`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    if ((await $.env.get('VIZIER_NESTED')) !== '1') await $.env.set('VIZIER_MODULE', '1')
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const match = COMMAND.exec(e.text.trim())
    if (!match) {
      void $.ui.close({ id: PANE })
      return next(e)
    }
    return { drop: await command($, (match[1] ?? '').trim()) }
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId || e.reason !== 'answer') return result
    if ((await $.env.get('VIZIER_NESTED')) === '1') return result
    if ((await loadState($)).auto !== true) return result
    whisper($, await resolveModel($, ''), e.answer)
    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const shown = await read($, page)
    const [first, second = ''] = shown?.specs ?? []
    return (
      <Box flexDirection="column">
        {!shown?.speeches.length && !shown?.awaiting && <Text>🐉 The Vizier has nothing to say, sire.</Text>}
        {shown?.speeches.map((s, i) => (
          <Box flexDirection="column" marginTop={i ? 1 : 0}>
            <Text bold>
              {s.mark} {s.speaker}
            </Text>
            <Text>{s.text}</Text>
          </Box>
        ))}
        {shown?.awaiting && (
          <Box marginTop={shown.speeches.length ? 1 : 0}>
            <Text dimColor>{shown.awaiting}</Text>
          </Box>
        )}
        <Box flexDirection="row" gap={2} marginTop={1}>
          {first && <Button key="again" label="again" hotkey="r" onPress={() => void summon($, first, second)} />}
          <Button key="close" label="close" hotkey="q" role="dismiss" onPress={() => void $.ui.close({ id: PANE })} />
        </Box>
        {e.surface === 'terminal' && (
          <Text dimColor>Esc closes · ctrl+x tab, then {first ? 'r again, ' : ''}q close · sending a prompt closes it too</Text>
        )}
      </Box>
    )
  })
}
