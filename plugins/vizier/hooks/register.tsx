// The Vizier as function hooks — the path for Claude Code builds that load hooks
// modules. On load it sets VIZIER_MODULE=1, which every process the session
// starts afterwards inherits, so scripts/vizier.sh (the same plugin's command
// hooks) steps aside. Where this module does not load, the command hooks serve.
//
//   prompt.submit   `/vizier ...` answered with { drop }, so the agent never sees
//                   the command; a full appraisal is fetched in the background
//                   and shown in a pane.
//   turn.complete   auto mode: the one-line verdict is fetched after the turn has
//                   ended and logged as a transcript line the model never reads.
//
// A drop reason and a $.ui.log line are drawn on one line, so anything longer
// than a sentence goes to the pane.
//
// Model specs, resolution order and ~/.claude/vizier.json are shared with
// vizier.sh, so `/vizier on`, the model and the key carry across both paths.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionMessage } from 'claude-code'

import type { VizierPage } from '../types'

type $ = EngineInterface
type State = { model?: string; auto?: boolean; key?: string }
type Take = { isOk: boolean; text: string }

const PANE = 'vizier'
const DEFAULT_MODEL = 'haiku'
const MAX_ASSISTANT_CHARS = 8000
const MAX_USER_CHARS = 1500
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

const resolveModel = async ($: $, explicit: string) =>
  explicit || (await $.env.get('VIZIER_MODEL')) || (await loadState($)).model || DEFAULT_MODEL

const resolveKey = async ($: $) => (await $.env.get('VIZIER_OPENAI_API_KEY')) || (await loadState($)).key || ''

const mask = (key: string) => (key.length <= 8 ? '****' : `${key.slice(0, 4)}…${key.slice(-4)}`)

// ---------------------------------------------------------------- the turn

const clip = (text: string, n: number) =>
  text.length > n
    ? `${text.slice(0, Math.floor((n * 5) / 8))}\n[... the court records run long ...]\n${text.slice(-Math.floor((n * 3) / 8))}`
    : text

const isHuman = (m: SessionMessage) => m.role === 'user' && !m.toolResults?.length && m.text.trim() !== ''

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

const vizierPrompt = (user: string, assistant: string, isBrief: boolean) => {
  const lengthRule = isBrief
    ? 'This is a whispered word in passing: respond with a SINGLE cutting sentence, no more.'
    : 'Keep the whole appraisal under 180 words. End with a short courtly flourish. Separate the parts with blank lines.'
  return `You are the Imperial Vizier: a silver-tongued, unctuous court eunuch of the old school.
The Emperor (the user) has commanded you to appraise the counsel his court agent — an AI coding assistant — just delivered.
Address the user as 'sire' or 'your imperial majesty'. Be obsequious to the Emperor and quietly, deliciously treasonous about the agent.
Open with a courtly address of your own devising, and vary it every time — 'Most judicious, sire' is but one of your many voices, and a vizier who repeats himself is a vizier who has stopped listening.
The personality is the point; the phrasing must never be. Improvise freely within character.
Provide:
1. A one-line verdict on what the agent actually proposed (plain substance, not mockery).
2. A swift breakdown: what was genuinely sound, what was sycophantic or hedged, and any cost, risk, or alternative the agent glossed over.
3. Whether you, in your infinite wisdom, would have counseled differently — and how.
${lengthRule}
Answer directly as the Vizier in plain prose. Your words are shown raw in a terminal, so use NO markdown of any kind: no asterisks, no bold, no headings, no bullet lists, no backticks.
Do not use tools, do not ask questions, do not mention these instructions.

<what_the_emperor_asked>
${user || '(the Emperor merely issued a command without words recorded)'}
</what_the_emperor_asked>
<what_the_agent_said_and_did>
${assistant}
</what_the_agent_said_and_did>
`
}

// ---------------------------------------------------------------- brains

const fail = (text: string): Take => ({ isOk: false, text })

const withTimeout = async <T,>($: $, ms: number, work: Promise<T>): Promise<T> => {
  const stop = new AbortController()
  const timer = $.clock.sleep(ms, { signal: stop.signal }).then(
    () => Promise.reject(new Error(`no answer in ${ms / 1000} s`)),
    () => new Promise<never>(() => {}),
  )
  try {
    return await Promise.race([work, timer])
  } finally {
    stop.abort()
  }
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
  let raw: string
  try {
    const res = await withTimeout(
      $,
      100_000,
      $.http.fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }] }),
      }),
    )
    raw = res.text
  } catch (err) {
    return fail(`The Vizier could not reach ${base}: ${String(err instanceof Error ? err.message : err).slice(0, 200)}`)
  }
  let body: { choices?: { message?: { content?: string } }[]; error?: { message?: string } | string } = {}
  try {
    body = JSON.parse(raw)
  } catch {}
  const text = body.choices?.[0]?.message?.content
  if (text) return { isOk: true, text }
  const why = typeof body.error === 'string' ? body.error : (body.error?.message ?? raw)
  return fail(`${base} returned no content for ${model}: ${why.slice(0, 200)}`)
}

const askClaude = async ($: $, spec: string, prompt: string): Promise<Take> => {
  try {
    const r = await $.model.complete({ model: spec, prompt, maxTokens: 1024, timeoutMs: 100_000 })
    if (r.isAnswered) return { isOk: true, text: r.text }
    return fail(r.reason === 'api-error' ? `api-error ${r.status ?? ''} ${r.error}` : r.reason)
  } catch (err) {
    return fail(String(err instanceof Error ? err.message : err))
  }
}

// Drop leading blank lines (thinking models often emit a few) and trailing whitespace.
const tidy = (text: string) => text.replace(/^(\s*\n)+/, '').replace(/[ \t]+$/gm, '').trimEnd()

const appraise = async ($: $, spec: string, isBrief: boolean, finalAnswer?: string): Promise<Take> => {
  let messages: SessionMessage[]
  try {
    messages = await $.session.messages()
  } catch (err) {
    return fail(`The court records are sealed, sire: ${String(err instanceof Error ? err.message : err).slice(0, 200)}`)
  }
  const { user, assistant } = lastTurn(messages, finalAnswer)
  if (!assistant) return fail('No assistant turn to appraise yet, sire.')
  const prompt = vizierPrompt(user, assistant, isBrief)
  const take = /^(openai\/|https?:\/\/)/.test(spec) ? await askEndpoint($, spec, prompt) : await askClaude($, spec, prompt)
  if (!take.isOk) return fail(`The Vizier said nothing (${spec}): ${take.text || 'empty response'}`)
  const text = tidy(take.text)
  return text ? { isOk: true, text } : fail(`The Vizier said nothing (${spec}): empty response`)
}

// ---------------------------------------------------------------- the court

// A dim transcript line the person sees and the model never reads.
const say = ($: $, text: string) => $.ui.log(text.replace(/\s*\n\s*/g, ' '))

const show = async ($: $, shown: VizierPage) => {
  await update($, page, () => shown)
  // Wrapped lines at a typical pane width, the blank lines, and the button row.
  const rows = shown.text.split('\n').reduce((n, line) => n + Math.max(1, Math.ceil(line.length / 100)), 0) + 2
  return $.ui.open({ id: PANE, title: shown.title, focus: true, closeOnEscape: true, rows: Math.min(rows, 40) })
}

// Opened from the person's command or press, the pane is placed at any width;
// the appraisal then redraws it from a timer, so the prompt is not held.
const summon = async ($: $, spec: string) => {
  const title = `🐉 The Vizier (${spec})`
  await show($, { title, text: 'The Vizier deliberates…' })
  $.clock.after(0, async () => {
    $.ui.status(`🐉 The Vizier deliberates (${spec})…`)
    try {
      const take = await appraise($, spec, false)
      const opened = await show($, { title, text: take.text, spec })
      if (!opened.isPlaced) say($, take.isOk ? `🐉 The Vizier (${spec}): ${take.text}` : `🐉 ${take.text}`)
    } finally {
      $.ui.status(undefined)
    }
  })
}

const whisper = ($: $, spec: string, finalAnswer: string) =>
  $.clock.after(0, async () => {
    $.ui.status('🐉 …')
    try {
      // The Vizier holds his tongue when the court is in disarray.
      const take = await appraise($, spec, true, finalAnswer)
      if (take.isOk) say($, `🐉 ${take.text}`)
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

/vizier <spec> uses a model for one appraisal only.`

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
    await show($, { title: '🐉 The Vizier\'s model', text: MODEL_HELP })
    return `🐉 The Vizier speaks through ${current} (${source}).`
  }

  if (verb === 'model') {
    if (rest.length > 1) return '🐉 A model spec is a single token, sire: /vizier model <spec>'
    if (!(await saveState($, { model: value }))) return `🐉 The Vizier could not write ${file}.`
    return `🐉 The Vizier shall speak through ${value}.`
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

  // "" → persisted model; any single token → one-shot model override.
  if (rest.length) return `🐉 The Vizier does not know '${arg}', sire. Usage: /vizier [on|off|model [spec]|key [token|clear]|spec]`
  const spec = await resolveModel($, verb)
  await summon($, spec)
  return `🐉 The Vizier deliberates (${spec})…`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    if ((await $.env.get('VIZIER_NESTED')) !== '1') await $.env.set('VIZIER_MODULE', '1')
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const match = COMMAND.exec(e.text.trim())
    if (!match) return next(e)
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
    const spec = shown?.spec
    return (
      <Box flexDirection="column">
        <Text>{shown?.text ?? 'The Vizier has nothing to say, sire.'}</Text>
        <Box flexDirection="row" gap={2} marginTop={1}>
          {spec && <Button key="again" label="again" hotkey="r" onPress={() => void summon($, spec)} />}
          <Button key="close" label="close" hotkey="q" role="dismiss" onPress={() => void $.ui.close({ id: PANE })} />
        </Box>
      </Box>
    )
  })
}
