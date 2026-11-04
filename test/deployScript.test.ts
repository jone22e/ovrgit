import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { parseDeployManifest, type DeployScriptManifest } from '../src/shared/deploy'

const userData = mkdtempSync(path.join(tmpdir(), 'ovseer-deploy-script-'))
vi.mock('electron', () => ({ app: { getPath: () => userData } }))
vi.mock('../src/main/ptyRegistry', () => ({ trackPty: () => undefined }))

interface FakePty { pid: number; file: string; args: string[]; cwd: string; data?: (d: string) => void; exit?: (e: { exitCode: number }) => void; killed: string[]; kill: (s: string) => void; onData: (cb: (d: string) => void) => void; onExit: (cb: (e: { exitCode: number }) => void) => void }
let pty: FakePty
vi.mock('@lydell/node-pty', () => ({
  spawn: (file: string, args: string[], opts: { cwd: string }) => {
    pty = { pid: 4242, file, args, cwd: opts.cwd, killed: [], kill: (s) => pty.killed.push(s), onData: (cb) => (pty.data = cb), onExit: (cb) => (pty.exit = cb) }
    return pty
  }
}))

const script = await import('../src/main/deployScript')

const repo = mkdtempSync(path.join(tmpdir(), 'ovseer-deploy-repo-'))
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' }).toString().trim()
git('init', '-q', '-b', 'main')
git('config', 'user.email', 't@t')
git('config', 'user.name', 't')
writeFileSync(path.join(repo, 'a.txt'), 'a\n')
git('add', '.')
git('commit', '-qm', 'inicio')
const head = git('rev-parse', 'HEAD')

const manifest = parseDeployManifest(JSON.stringify({ ovseer: 'deploy', version: 1, kind: 'script', command: 'make deploy', steps: [{ id: 'prep', title: 'Preparação' }, { id: 'envio', title: 'Envio' }, { id: 'fim', title: 'Conclusão' }] })) as DeployScriptManifest

afterAll(() => {
  rmSync(userData, { recursive: true, force: true })
  rmSync(repo, { recursive: true, force: true })
})

describe('deploy por script', () => {
  it('plano, execução com marcadores partidos, falha pelo código de saída e histórico', async () => {
    const plan = await script.plan(repo, manifest)
    expect(plan.plan.tag).toMatch(/^deploy-\d{4}\.\d{2}\.\d{2}-\d{4}$/)
    expect(plan.plan.commit).toBe(head)
    expect(plan.plan.order).toBe('make deploy')
    expect(plan.plan.plan?.reasons?.[0]).toBe('branch main')
    expect(plan.plan.plan?.warnings).toEqual([])

    const op = await script.run(repo, manifest, plan.plan_id)
    expect(op.release_tag).toBe(plan.plan.tag)
    expect(pty.args.at(-1)).toBe('make deploy')
    expect(pty.cwd).toBe(repo)
    let snap = script.snapshot(repo)
    expect(snap.operation?.operation_id).toBe(plan.plan.tag)
    expect(snap.lockSupported).toBe(false)
    expect(snap.current?.phases.prep.status).toBe('running')

    pty.data!('Código local: abc\r\n\x1b[32m[ovseer] eta')
    pty.data!('pa envio\x1b[0m\r\nenviando…\r\n')
    snap = script.snapshot(repo)
    expect(snap.current?.phases.prep.status).toBe('completed')
    expect(snap.current?.phases.envio.status).toBe('running')
    expect(script.log(repo, plan.plan.tag, 'prep')).toContain('Código local: abc')
    expect(script.log(repo, plan.plan.tag, 'envio')).toContain('enviando…')

    pty.data!('rsync: connection refused\r\n')
    pty.exit!({ exitCode: 12 })
    snap = script.snapshot(repo)
    expect(snap.operation).toBeNull()
    expect(snap.current?.status).toBe('failed')
    expect(snap.current?.phases.envio.status).toBe('failed')
    expect(snap.current?.phases.envio.error).toBe('rsync: connection refused (código 12)')
    expect(snap.current?.failure_phase).toBe('envio')
    expect(snap.current?.phases.fim).toBeUndefined()
    expect(existsSync(path.join(userData, 'deploy-runs'))).toBe(true)

    // segunda execução, com sucesso; o plano antigo não serve mais
    await expect(script.run(repo, manifest, plan.plan_id)).rejects.toThrow(/Plano ausente/)
    const plan2 = await script.plan(repo, manifest)
    expect(plan2.plan.tag).not.toBe(plan.plan.tag)
    await script.run(repo, manifest, plan2.plan_id)
    await expect(script.plan(repo, manifest)).rejects.toThrow(/em andamento/)
    pty.data!('[ovseer] etapa envio\n[ovseer] etapa fim\npublicado\n')
    pty.exit!({ exitCode: 0 })
    snap = script.snapshot(repo)
    expect(snap.current?.status).toBe('completed')
    expect(Object.values(snap.current!.phases).map((p) => p.status)).toEqual(['completed', 'completed', 'completed'])
    expect(snap.releases.map((r) => r.status)).toEqual(['completed', 'failed'])
  })

  it('cancelar manda SIGTERM e marca a etapa como cancelada', async () => {
    const plan = await script.plan(repo, manifest)
    await script.run(repo, manifest, plan.plan_id)
    expect(() => script.cancel(repo, 'outra')).toThrow(/mudou/)
    script.cancel(repo, plan.plan.tag)
    expect(pty.killed).toEqual(['SIGTERM'])
    expect(script.snapshot(repo).operation?.cancel_requested_at).toBeTruthy()
    pty.exit!({ exitCode: 143 })
    const snap = script.snapshot(repo)
    expect(snap.current?.status).toBe('failed')
    expect(snap.current?.phases.prep.error).toBe('Deploy cancelado pelo usuário.')
  })
})
