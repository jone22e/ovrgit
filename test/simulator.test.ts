import { describe, expect, it } from 'vitest'
import { macSimulatorKeyCode, parseAvds, parseIosDevices, simulatorImageSize, simulatorPanelWidth, simulatorPoint, validSimulatorInput } from '../src/shared/simulator'

describe('catálogo dos simuladores', () => {
  it('lista apenas aparelhos iOS disponíveis e preserva a identidade e o runtime', () => {
    expect(parseIosDevices({ runtimes: [{ identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-5', name: 'iOS 26.5' }], devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [
        { udid: 'A', name: 'iPhone 17 Pro', state: 'Booted', isAvailable: true },
        { udid: 'B', name: 'iPhone 17 Pro', state: 'Shutdown', isAvailable: true },
        { udid: 'C', name: 'Antigo', state: 'Shutdown', isAvailable: false }
      ],
      'com.apple.CoreSimulator.SimRuntime.watchOS-26-5': [{ udid: 'W', name: 'Watch', state: 'Booted', isAvailable: true }]
    } })).toEqual([
      { id: 'ios:A', platform: 'ios', name: 'iPhone 17 Pro', runtime: 'iOS 26.5', running: true },
      { id: 'ios:B', platform: 'ios', name: 'iPhone 17 Pro', runtime: 'iOS 26.5', running: false }
    ])
  })
  it('não interpreta mensagens de diagnóstico como nomes de AVD', () => {
    expect(parseAvds('INFO | Android emulator version 36\r\nMedium_Phone\r\nPixel_9\r\nMedium_Phone\r\n')).toEqual([
      { id: 'android:Medium_Phone', platform: 'android', name: 'Medium_Phone', runtime: 'Android', running: false },
      { id: 'android:Pixel_9', platform: 'android', name: 'Pixel_9', runtime: 'Android', running: false }
    ])
  })
})
describe('redimensionamento da coluna do simulador', () => {
  it('limita a largura pelo contêiner, inclusive quando ele é menor que a janela', () => {
    expect(simulatorPanelWidth(900, 600)).toBe(360)
    expect(simulatorPanelWidth(100, 600)).toBe(220)
    expect(simulatorPanelWidth(400, 320)).toBe(192)
    expect(simulatorPanelWidth(360 - 20, 600)).toBe(340)
    expect(simulatorPanelWidth(400, 0)).toBe(0)
  })
  it('encaixa o aparelho inteiro sem mudar a proporção ao estreitar ou alargar a coluna', () => {
    for (const image of [{ width: 409, height: 826 }, { width: 1080, height: 2400 }]) {
      for (const viewport of [{ width: 188, height: 660 }, { width: 368, height: 660 }, { width: 688, height: 360 }]) {
        const size = simulatorImageSize(image, viewport)
        expect(size.width).toBeLessThanOrEqual(viewport.width)
        expect(size.height).toBeLessThanOrEqual(viewport.height)
        expect(size.width / size.height).toBeCloseTo(image.width / image.height)
        const zoomed = simulatorImageSize(image, viewport, 1.25)
        expect(zoomed.width).toBeCloseTo(size.width * 1.25)
        expect(zoomed.height).toBeCloseTo(size.height * 1.25)
      }
    }
  })
})
describe('entrada no painel dos simuladores', () => {
  it('converte o clique na imagem para a posição proporcional do aparelho', () => {
    expect(simulatorPoint(250, 500, { left: 100, top: 200, width: 300, height: 600 })).toEqual({ x: 0.5, y: 0.5 })
    expect(simulatorPoint(500, 0, { left: 100, top: 200, width: 300, height: 600 })).toEqual({ x: 1, y: 0 })
    expect(simulatorPoint(0, 0, { left: 0, top: 0, width: 0, height: 100 })).toBeNull()
  })
  it('mapeia toques para a tela dentro da moldura original do aparelho', () => {
    const rect = { left: 100, top: 200, width: 400, height: 800 }
    const touchArea = { x: 0.1, y: 0.05, width: 0.8, height: 0.9 }
    const middle = simulatorPoint(300, 600, rect, touchArea)!
    expect(middle.x).toBeCloseTo(0.5)
    expect(middle.y).toBeCloseTo(0.5)
    expect(simulatorPoint(110, 210, rect, touchArea)).toBeNull()
    expect(simulatorPoint(110, 210, rect, touchArea, true)).toEqual({ x: 0, y: 0 })
    expect(simulatorPoint(600, 1100, rect, touchArea, true)).toEqual({ x: 1, y: 1 })
    expect(simulatorPoint(300, 600, rect, { ...touchArea, width: 0 })).toBeNull()
  })
  it('rejeita coordenadas inválidas e formatos inesperados na fronteira IPC', () => {
    for (const value of [null, {}, { type: 'touch', phase: 'down', x: NaN, y: 0 }, { type: 'touch', phase: 'up', x: Infinity, y: 0 }, { type: 'touch', phase: 'move', x: -1, y: 0 }, { type: 'touch', phase: 'drag', x: 0, y: 0 }, { type: 'key', key: 'a', code: 128 }, { type: 'key', key: 'a', code: 1.5 }, { type: 'key', key: 'a', shift: 'yes' }]) expect(validSimulatorInput(value)).toBe(false)
    expect(validSimulatorInput({ type: 'touch', phase: 'up', x: 1, y: 0 })).toBe(true)
    expect(validSimulatorInput({ type: 'home' })).toBe(true)
    expect(validSimulatorInput({ type: 'key', key: 'A', code: 0, shift: true })).toBe(true)
  })
  it('traduz teclas físicas sem tratar todas as letras como A', () => {
    expect(macSimulatorKeyCode('KeyA')).toBe(0)
    expect(macSimulatorKeyCode('KeyB')).toBe(11)
    expect(macSimulatorKeyCode('Backspace')).toBe(51)
    expect(macSimulatorKeyCode('Unidentified')).toBeUndefined()
  })
})
