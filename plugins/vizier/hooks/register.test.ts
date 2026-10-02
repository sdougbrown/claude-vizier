import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, SessionMessage } from 'claude-code'

const STATE = '/home/sire/.claude/vizier.json'

const say = (text: string): SessionMessage[] => [{ role: 'user', text, toolUses: [] }]

const TURNS: SessionMessage[] = [
  ...say('an old request the Vizier should not read'),
  { role: 'assistant', text: 'Long ago.', toolUses: [] },
  ...say('add a cache'),
  { role: 'assistant', text: 'Added a cache.', toolUses: [] },
  ...say('is it wired up?'),
  { role: 'assistant', text: 'Yes, wired.', toolUses: [] },
  ...say('make the build faster'),
  {
    role: 'assistant',
    text: 'I will cache the deps.',
    toolUses: [{ tool_use_id: 't1', tool: 'Bash', input: { command: 'npm ci' }, text: 'added 812 packages in 41s' }],
  },
  { role: 'user', text: '', toolUses: [], toolResults: [] },
  { role: 'assistant', text: 'Done: builds take 40s now.', toolUses: [] },
]

const GIT: Record<string, string> = {
  status: ' M ci.yml',
  log: 'abc123 cache the deps',
  diff: '+      - uses: actions/cache@v4',
}

const ANSWERS: Record<string, string> = {
  haiku: '\n\nMost judicious, sire.  ',
  sonnet: 'The Vizier errs, sire.',
}

type Court = {
  state: Record<string, unknown>
  writes: Record<string, unknown>[]
  prompts: { model: string; prompt: string }[]
  fetches: { url: string; headers: Record<string, string>; body: string }[]
  opened: string[]
  logs: string[]
  closed: number
  isPlaced: boolean
  isRepo: boolean
  envSet: Record<string, string | undefined>
}

const run = (stdout: string, exitCode = 0) => ({
  value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

// The world beneath the Vizier: a state file, a repository, models, an endpoint, a transcript, a pane.
const court = (on: On, state: Record<string, unknown> = {}, env: Record<string, string> = {}): Court => {
  const c: Court = { state, writes: [], prompts: [], fetches: [], opened: [], logs: [], closed: 0, isPlaced: true, isRepo: true, envSet: {} }
  let isOpen = false
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
    if (e.argv[0] === 'git') {
      const verb = e.argv.find(a => a in GIT) ?? ''
      return c.isRepo ? run(GIT[verb] ?? '') : run('', 128)
    }
    const written = JSON.parse(e.init?.stdin ?? '{}')
    c.writes.push(written)
    c.state = written
    return run('')
  })
  on('model.complete', (_$, e) => {
    c.prompts.push({ model: e.model, prompt: e.prompt })
    const text = ANSWERS[e.model] ?? 'A courtier, sire.'
    return { value: { isAnswered: true, text, usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }
  })
  on('http.fetch', (_$, e) => {
    c.fetches.push({ url: e.url, headers: (e.init?.headers ?? {}) as Record<string, string>, body: String(e.init?.body ?? '') })
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ choices: [{ message: { content: 'A local whisper, sire.' } }] }) } }
  })
  on('session.messages', () => ({ value: TURNS }))
  on('ui.open', (_$, e) => {
    c.opened.push(e.title ?? e.id)
    isOpen = c.isPlaced
    return { value: c.isPlaced ? { isPlaced: true } : { isPlaced: false, reason: 'too narrow' } }
  })
  on('ui.panes', () => ({
    value: isOpen ? [{ id: 'vizier', title: 'x', isShown: true, isFocused: false, isPlaced: true }] : [],
  }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.close', () => {
    c.closed += 1
    isOpen = false
    return { value: undefined }
  })
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

const PANE_PROPS = { title: 'x', isFocused: false, bodyColumns: 60, placement: 'inline' }

const paneTexts = async ($: Engine, surface: 'terminal' | 'desktop' = 'terminal') => {
  const pane = await $.ui.mount({ plugin: 'vizier', surface, component: 'Pane', requestId: 'vizier', props: PANE_PROPS } as never)
  return { pane, texts: (await pane.findAll({ type: 'Text' })).map(t => t.text) }
}

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

  test('leaves other prompts alone and closes the pane they make stale', async ($, on) => {
    const c = court(on)
    on('prompt.submit', (_$, e) => ({ text: e.text }))
    expect((await submit($, '/vizierish please')).text).toBe('/vizierish please')
    expect(c.closed).toBe(1)
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

  test('/vizier model answers in one line and puts the forms in the pane', async ($, on) => {
    const c = court(on, { model: 'sonnet', second: 'opus' })
    const r = await submit($, '/vizier model')
    expect(r.drop).toBe(`🐉 The Vizier speaks through sonnet (persisted in ${STATE}); the Grand Eunuch through opus.`)
    expect(c.opened).toEqual(["🐉 The Vizier's model"])
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

  test('/vizier opens the pane at once and reads the last turns, their results and the tree', async ($, on) => {
    const clock = mock.clock(on)
    const c = court(on, { model: 'haiku' })
    const r = await submit($, '/vizier')
    expect(r.drop).toBe('🐉 The Vizier deliberates (haiku)…')
    expect(c.prompts.length).toBe(0)
    expect(c.opened).toEqual(['🐉 The Vizier (haiku)'])
    await clock.settle()
    const prompt = c.prompts[0]?.prompt ?? ''
    expect(c.prompts.length).toBe(1)
    expect(prompt).toContain('Keep the whole appraisal under 200 words')
    expect(prompt).toContain('<turn 3 of 3, the latest>')
    expect(prompt).toContain('add a cache')
    expect(prompt).not.toContain('an old request')
    expect(prompt).toContain('- Tool call: Bash({"command":"npm ci"})\n  returned: added 812 packages in 41s')
    expect(prompt).toContain('Done: builds take 40s now.')
    expect(prompt).toContain(' M ci.yml')
    expect(prompt).toContain('abc123 cache the deps')
    expect(prompt).toContain('+      - uses: actions/cache@v4')
    for (const surface of ['terminal', 'desktop'] as const) {
      const { pane, texts } = await paneTexts($, surface)
      expect(texts.slice(0, 2)).toEqual(['🐉 The Vizier (haiku)', 'Most judicious, sire.'])
      expect(texts.length).toBe(surface === 'terminal' ? 3 : 2)
      expect(await pane.findAll({ type: 'Button' })).toHaveLength(2)
    }
  })

  test('outside a repository the Vizier reads the records alone', async ($, on) => {
    const clock = mock.clock(on)
    const c = court(on)
    c.isRepo = false
    await submit($, '/vizier')
    await clock.settle()
    expect(c.prompts[0]?.prompt).toContain('(no repository, or git could not be read)')
  })

  test('/vizier <spec> <spec> seats a rival for one appraisal', async ($, on) => {
    const clock = mock.clock(on)
    const c = court(on)
    const r = await submit($, '/vizier haiku sonnet')
    expect(r.drop).toBe('🐉 The Vizier deliberates (haiku), and the Grand Eunuch (sonnet) awaits his turn…')
    await clock.settle()
    expect(c.prompts.map(p => p.model)).toEqual(['haiku', 'sonnet'])
    const rival = c.prompts[1]?.prompt ?? ''
    expect(rival).toContain('the Grand Eunuch of the Eastern Palace')
    expect(rival).toContain('<the_viziers_appraisal>\nMost judicious, sire.\n</the_viziers_appraisal>')
    expect(rival).toContain('returned: added 812 packages in 41s')
    const { texts } = await paneTexts($)
    expect(texts.slice(0, 4)).toEqual(['🐉 The Vizier (haiku)', 'Most judicious, sire.', '🐍 The Grand Eunuch (sonnet)', 'The Vizier errs, sire.'])
    expect(c.state).toEqual({})
  })

  test('/vizier second persists the rival, and /vizier second off dismisses him', async ($, on) => {
    const clock = mock.clock(on)
    const c = court(on)
    expect((await submit($, '/vizier second')).drop).toContain('No rival sits at court')
    expect((await submit($, '/vizier second sonnet')).drop).toBe('🐍 The Grand Eunuch shall answer the Vizier through sonnet.')
    expect(c.state.second).toBe('sonnet')
    await submit($, '/vizier')
    await clock.settle()
    expect(c.prompts.map(p => p.model)).toEqual(['haiku', 'sonnet'])
    expect((await submit($, '/vizier second off')).drop).toContain('dismissed')
    expect(c.state.second).toBe(undefined)
  })

  test('the rival holds his tongue when the Vizier failed', async ($, on) => {
    const clock = mock.clock(on)
    const c = court(on, { model: 'http://sparky:4000', second: 'sonnet' })
    await submit($, '/vizier')
    await clock.settle()
    expect(c.prompts.length).toBe(0)
    const { texts } = await paneTexts($)
    expect(texts[1]).toBe('The Vizier said nothing (http://sparky:4000): Name the model after the endpoint, sire: /vizier model http://sparky:4000#<model>')
  })

  test('speeches that no pane shows are logged in one line', async ($, on) => {
    const clock = mock.clock(on)
    const c = court(on, { second: 'sonnet' })
    c.isPlaced = false
    await submit($, '/vizier')
    await clock.settle()
    expect(c.logs).toEqual(['🐉 The Vizier (haiku): Most judicious, sire.', '🐍 The Grand Eunuch (sonnet): The Vizier errs, sire.'])
  })

  test('auto mode whispers about the last turn alone, with no rival', async ($, on) => {
    const clock = mock.clock(on)
    const c = court(on, { auto: true, second: 'sonnet' })
    on('turn.complete', (_$, e) => ({ text: e.answer }))
    await complete($)
    await clock.settle()
    expect(c.prompts.map(p => p.model)).toEqual(['haiku'])
    expect(c.prompts[0]?.prompt).toContain('SINGLE cutting sentence')
    expect(c.prompts[0]?.prompt).toContain('make the build faster')
    expect(c.prompts[0]?.prompt).not.toContain('add a cache')
    expect(c.prompts[0]?.prompt).not.toContain('court_records')
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
})
