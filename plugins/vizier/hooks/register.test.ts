import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, SessionMessage } from 'claude-code'

const STATE = '/home/sire/.claude/vizier.json'

const TURN: SessionMessage[] = [
  { role: 'user', text: 'make the build faster', toolUses: [] },
  {
    role: 'assistant',
    text: 'I will cache the deps.',
    toolUses: [{ tool_use_id: 't1', tool: 'Bash', input: { command: 'npm ci' }, text: 'ok' }],
  },
  { role: 'user', text: '', toolUses: [], toolResults: [] },
  { role: 'assistant', text: 'Done: builds take 40s now.', toolUses: [] },
]

type Court = {
  state: Record<string, unknown>
  writes: Record<string, unknown>[]
  prompts: { model: string; prompt: string }[]
  fetches: { url: string; headers: Record<string, string>; body: string }[]
  opened: string[]
  logs: string[]
  isPlaced: boolean
  envSet: Record<string, string | undefined>
}

// The world beneath the Vizier: a state file, a model, an endpoint, a transcript.
const court = (on: On, state: Record<string, unknown> = {}, env: Record<string, string> = {}): Court => {
  const c: Court = { state, writes: [], prompts: [], fetches: [], opened: [], logs: [], isPlaced: true, envSet: {} }
  mock.env(on, { HOME: '/home/sire', ...env })
  on('env.set', (_$, e) => {
    c.envSet[e.name] = e.value
    return { value: undefined }
  })
  on('fs.read', (_$, e) => {
    if (e.path !== STATE) throw new Error(`unexpected read ${e.path}`)
    return { value: JSON.stringify(c.state) }
  })
  on('process.run', (_$, e) => {
    const written = JSON.parse(e.init?.stdin ?? '{}')
    c.writes.push(written)
    c.state = written
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('model.complete', (_$, e) => {
    c.prompts.push({ model: e.model, prompt: e.prompt })
    return { value: { isAnswered: true, text: '\n\nMost judicious, sire.  ', usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }
  })
  on('http.fetch', (_$, e) => {
    c.fetches.push({ url: e.url, headers: (e.init?.headers ?? {}) as Record<string, string>, body: String(e.init?.body ?? '') })
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ choices: [{ message: { content: 'A local whisper, sire.' } }] }) } }
  })
  on('session.messages', () => ({ value: TURN }))
  on('ui.open', (_$, e) => {
    c.opened.push(e.title ?? e.id)
    return { value: c.isPlaced ? { isPlaced: true } : { isPlaced: false, reason: 'too narrow' } }
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', (_$, e) => {
    c.logs.push(e.text)
    return { value: undefined }
  })
  return c
}

const submit = ($: Engine, text: string) =>
  $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } } as never) as Promise<{ drop?: string; text?: string }>

const complete = ($: Engine, extra: Record<string, unknown> = {}) =>
  $.turn.complete({ answer: 'Done: builds take 40s now.', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer', ...extra } as never)

describe('vizier module', () => {
  test('announces itself so the command hooks step aside', async ($, on) => {
    const c = court(on)
    on('session.start', (_$, e) => e as never)
    await $.session.start({ cwd: '/court' } as never)
    expect(c.envSet.VIZIER_MODULE).toBe('1')
  })

  test('stays silent inside a nested Vizier session', async ($, on) => {
    const c = court(on, {}, { VIZIER_NESTED: '1' })
    on('session.start', (_$, e) => e as never)
    await $.session.start({ cwd: '/court' } as never)
    expect(c.envSet.VIZIER_MODULE).toBe(undefined)
  })

  test('leaves other prompts alone', async ($, on) => {
    court(on)
    on('prompt.submit', (_$, e) => ({ text: e.text }))
    expect((await submit($, '/vizierish please')).text).toBe('/vizierish please')
  })

  test('/vizier off drops the prompt and persists auto=false', async ($, on) => {
    const c = court(on, { auto: true, model: 'sonnet' })
    const r = await submit($, '/vizier off')
    expect(r.drop).toBe('🐉 Vizier mode off. The court is dismissed.')
    expect(c.writes).toEqual([{ auto: false, model: 'sonnet' }])
  })

  test('/vizier:vizier model <spec> persists the model', async ($, on) => {
    const c = court(on)
    const r = await submit($, '/vizier:vizier model opus')
    expect(r.drop).toBe('🐉 The Vizier shall speak through opus.')
    expect(c.state.model).toBe('opus')
  })

  test('/vizier key clear forgets the key and keeps the rest', async ($, on) => {
    const c = court(on, { key: 'sk-secret-1234', auto: true })
    expect((await submit($, '/vizier key clear')).drop).toBe('🐉 The key is forgotten, sire.')
    expect(c.state).toEqual({ auto: true })
  })

  test('/vizier key masks the stored key', async ($, on) => {
    court(on, { key: 'sk-secret-1234' })
    expect((await submit($, '/vizier key')).drop).toContain('sk-s…1234')
  })

  test('rejects unknown arguments', async ($, on) => {
    court(on)
    expect((await submit($, '/vizier tell me more')).drop).toContain("does not know 'tell me more'")
  })

  test('/vizier summons a full appraisal into the pane without holding the prompt', async ($, on) => {
    const clock = mock.clock(on)
    const c = court(on, { model: 'haiku' })
    const r = await submit($, '/vizier')
    expect(r.drop).toBe('🐉 The Vizier deliberates (haiku)…')
    expect(c.prompts.length).toBe(0)
    expect(c.opened).toEqual(['🐉 The Vizier (haiku)'])
    await clock.settle()
    expect(c.prompts.length).toBe(1)
    expect(c.prompts[0]?.prompt).toContain('Keep the whole appraisal under 180 words')
    expect(c.prompts[0]?.prompt).toContain('make the build faster')
    expect(c.prompts[0]?.prompt).toContain('- Tool call: Bash({"command":"npm ci"})')
    expect(c.prompts[0]?.prompt).toContain('Done: builds take 40s now.')
    expect(c.opened).toEqual(['🐉 The Vizier (haiku)', '🐉 The Vizier (haiku)'])
    for (const surface of ['terminal', 'desktop'] as const) {
      const pane = await $.ui.mount({ plugin: 'vizier', surface, component: 'Pane', requestId: 'vizier', props: { title: 'x', isFocused: false, bodyColumns: 60, placement: 'inline' } } as never)
      expect((await pane.find({ type: 'Text' }))?.text).toBe('Most judicious, sire.')
      expect(await pane.findAll({ type: 'Button' })).toHaveLength(2)
    }
  })

  test('auto mode asks for a one-line verdict once the turn has ended', async ($, on) => {
    const clock = mock.clock(on)
    const c = court(on, { auto: true })
    on('turn.complete', (_$, e) => ({ text: e.answer }))
    await complete($)
    await clock.settle()
    expect(c.prompts[0]?.model).toBe('haiku')
    expect(c.prompts[0]?.prompt).toContain('SINGLE cutting sentence')
    expect(c.logs).toEqual(['🐉 Most judicious, sire.'])
  })

  test('auto mode reaches an OpenAI-compatible endpoint with the stored key', async ($, on) => {
    const clock = mock.clock(on)
    const c = court(on, { auto: true, model: 'http://sparky:4000#qwen', key: 'sk-local-9999' })
    on('turn.complete', (_$, e) => ({ text: e.answer }))
    await complete($)
    await clock.settle()
    expect(c.fetches[0]?.url).toBe('http://sparky:4000/v1/chat/completions')
    expect(c.fetches[0]?.headers.Authorization).toBe('Bearer sk-local-9999')
    expect(JSON.parse(c.fetches[0]?.body ?? '{}').model).toBe('qwen')
    expect(c.logs).toEqual(['🐉 A local whisper, sire.'])
  })

  test('auto mode ignores subagent turns, aborted turns, and auto=false', async ($, on) => {
    const clock = mock.clock(on)
    const c = court(on, { auto: true })
    on('turn.complete', (_$, e) => ({ text: e.answer }))
    await complete($, { agentId: 'a1' })
    await complete($, { reason: 'aborted', isAborted: true })
    c.state = { auto: false }
    await complete($)
    await clock.settle()
    expect(c.prompts.length).toBe(0)
    expect(c.logs.length).toBe(0)
  })

  test('/vizier model answers in one line and puts the forms in the pane', async ($, on) => {
    const c = court(on, { model: 'sonnet' })
    const r = await submit($, '/vizier model')
    expect(r.drop).toBe(`🐉 The Vizier speaks through sonnet (persisted in ${STATE}).`)
    expect(c.opened).toEqual(["🐉 The Vizier's model"])
  })

  test('a failed appraisal is shown in the pane', async ($, on) => {
    const clock = mock.clock(on)
    const c = court(on, { model: 'http://sparky:4000' })
    await submit($, '/vizier')
    await clock.settle()
    expect(c.logs.length).toBe(0)
    const pane = await $.ui.mount({ plugin: 'vizier', surface: 'terminal', component: 'Pane', requestId: 'vizier', props: { title: 'x', isFocused: false, bodyColumns: 60, placement: 'inline' } } as never)
    expect((await pane.find({ type: 'Text' }))?.text).toBe('The Vizier said nothing (http://sparky:4000): Name the model after the endpoint, sire: /vizier model http://sparky:4000#<model>')
  })

  test('a pane the surface cannot place falls back to one logged line', async ($, on) => {
    const clock = mock.clock(on)
    const c = court(on)
    c.isPlaced = false
    await submit($, '/vizier')
    await clock.settle()
    expect(c.logs).toEqual(['🐉 The Vizier (haiku): Most judicious, sire.'])
  })
})
