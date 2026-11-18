import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), on: vi.fn(), showMessageBox: vi.fn() }))
vi.mock('electron', () => ({
  app: { isPackaged: true }, ipcMain: { on: mocks.on },
  dialog: { showMessageBox: mocks.showMessageBox },
  BrowserWindow: vi.fn(), nativeImage: {}, screen: {}, shell: {}
}))
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }))
vi.mock('../src/main/computerUse', () => ({ computerUseBinary: () => '/native/ovseer-computer' }))

import { setScreenCaptureShortcut, startScreenCapture, stopScreenCapture } from '../src/main/screenCapture'

function child() {
  return Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn()
  })
}

describe.skipIf(process.platform !== 'darwin')('tecla do atalho de captura', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.spawn.mockImplementation(child)
    mocks.showMessageBox.mockResolvedValue({ response: 1 })
  })
  afterEach(stopScreenCapture)

  it('mantém Shift como padrão e inicia com a tecla salva', () => {
    startScreenCapture()
    expect(mocks.spawn.mock.calls[0][1]).toEqual(['--watch-capture-key', 'shift'])
    stopScreenCapture()
    startScreenCapture('control')
    expect(mocks.spawn.mock.calls[1][1]).toEqual(['--watch-capture-key', 'control'])
  })

  it('troca o monitor na hora e ignora eventos atrasados do anterior', () => {
    startScreenCapture()
    const previous = mocks.spawn.mock.results[0].value as ReturnType<typeof child>
    setScreenCaptureShortcut('option')
    const current = mocks.spawn.mock.results[1].value as ReturnType<typeof child>
    expect(previous.kill).toHaveBeenCalledOnce()
    expect(mocks.spawn.mock.calls[1][1]).toEqual(['--watch-capture-key', 'option'])

    previous.emit('exit', 2)
    previous.stdout.emit('data', Buffer.from('capture\n'))
    setScreenCaptureShortcut('option')
    expect(mocks.spawn).toHaveBeenCalledTimes(2)
    expect(mocks.showMessageBox).not.toHaveBeenCalled()

    setScreenCaptureShortcut('command')
    expect(current.kill).toHaveBeenCalledOnce()
    expect(mocks.spawn.mock.calls[2][1]).toEqual(['--watch-capture-key', 'command'])
    expect(mocks.on).toHaveBeenCalledTimes(1)
  })

  it('informa a tecla atual quando falta permissão do macOS', () => {
    startScreenCapture('command')
    const current = mocks.spawn.mock.results[0].value as ReturnType<typeof child>
    current.emit('exit', 2)
    expect(mocks.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({
      message: 'O macOS ainda não permite detectar os três toques em Command.'
    }))
  })
})
