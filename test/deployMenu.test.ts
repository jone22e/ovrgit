import { readFileSync } from 'node:fs'
import { compile, computed, createSSRApp, ref } from 'vue'
import { parse } from '@vue/compiler-sfc'
import { renderToString } from 'vue/server-renderer'
import { describe, expect, it } from 'vitest'
import {
  buildDeploySteps, isLiveRelease, isSuccessfulRelease, parseDeployManifest, preserveDeployHistory, releaseStatusLabel,
  type DeploySnapshot
} from '../src/shared/deploy'

// Renderiza o template real do dropdown, sem abrir navegador nem consultar um console de deploy.
const source = readFileSync(new URL('../src/renderer/src/components/DeployMenu.vue', import.meta.url), 'utf8')
const render = compile(parse(source).descriptor.template!.content)
const manifest = parseDeployManifest(JSON.stringify({ ovseer: 'deploy', version: 1, kind: 'console', start: 'make deploy-console', port: 3098 }))
const empty = (console: DeploySnapshot['console']): DeploySnapshot => ({
  console, origin: '', operation: null, releases: [], current: null, expectedTests: 0, lockSupported: true
})

function menu() {
  const snap = ref<DeploySnapshot | null>(null)
  const current = computed(() => snap.value?.current ?? null)
  const bindings = {
    snap, current, manifest, consoleState: computed(() => snap.value?.console ?? 'loading'),
    steps: computed(() => buildDeploySteps(manifest, current.value)),
    operation: computed(() => snap.value?.operation ?? null),
    open: true, manifestError: '', activeDeploy: null, executing: false, lockedWithoutOperation: false,
    remoteResult: '', remoteSucceeded: false, dot: '', lockSupported: true, lockError: '', lock: null,
    planning: false, historyOpen: false, isScript: false, busy: '', expanded: null, confirmCancel: false,
    attemptRejected: false, failure: null, elapsed: '', isLiveRelease, isSuccessfulRelease, releaseStatusLabel,
    time: () => '', stepTime: () => '', targetTitle: (id: string) => id,
    toggle: () => {}, startConsole: () => {}, startPlanning: () => {}
  }
  const html = async () => {
    const app = createSSRApp({ setup: () => bindings, render })
    const stub = { render: () => null }
    app.component('Icon', stub)
    app.component('DeployActivity', stub)
    app.config.warnHandler = (message) => { throw new Error(message) }
    return renderToString(app)
  }
  return { snap, html }
}

describe('etapas no dropdown de deploy', () => {
  it.each([null, 'starting', 'stopped', 'error'] as const)('mostra as etapas mesmo ao abrir com console %s', async (console) => {
    const { snap, html } = menu()
    snap.value = console ? empty(console) : null
    const result = await html()
    const list = result.match(/<ol class="steps">([\s\S]*?)<\/ol>/)?.[1]
    expect(list).toBeDefined()
    for (const step of manifest.steps) expect(list).toContain(step.title)
    expect(result).not.toContain('Novo deploy</button>')
    expect(result).not.toContain('Nenhuma release registrada')
  })

  it('mantém as etapas durante a troca de fase, indisponibilidade e recuperação', async () => {
    const { snap, html } = menu()
    snap.value = { ...empty('ready'), current: { tag: 'v1', status: 'running', phases: { plan: { status: 'running' } } } }
    expect(await html()).toMatch(/class="running"[\s\S]*?class="title ellipsis">Plano/)
    snap.value = preserveDeployHistory(snap.value, empty('starting'))
    const waiting = await html()
    expect(waiting).toContain('Último estado recebido')
    expect(waiting).toContain('<ol class="steps">')
    snap.value = { ...empty('ready'), current: { tag: 'v1', status: 'running', phases: { plan: { status: 'completed' }, tests: { status: 'running' } } } }
    const updated = await html()
    expect(updated).toMatch(/class="completed"[\s\S]*?class="title ellipsis">Plano/)
    expect(updated).toMatch(/class="running"[\s\S]*?class="title ellipsis">Testes/)
    expect(updated).not.toContain('Último estado recebido')
  })
})
