export type SimulatorPlatform = 'ios' | 'android'
export interface SimulatorDevice {
  id: string
  platform: SimulatorPlatform
  name: string
  runtime: string
  running: boolean
}
export interface SimulatorCatalog { devices: SimulatorDevice[]; issues: Partial<Record<SimulatorPlatform, string>> }
export interface SimulatorDebugProject { root: string; name: string; kind: 'react-native' | 'expo'; platforms: SimulatorPlatform[] }
export interface SimulatorDebugProgress { root: string; deviceId: string; message: string; serviceId?: string }
/** Área da tela sensível ao toque, em proporções da imagem que também pode incluir a carcaça. */
export interface SimulatorTouchArea { x: number; y: number; width: number; height: number }
export interface SimulatorFrame { deviceId: string; image: string; width: number; height: number; touchArea?: SimulatorTouchArea }
export type SimulatorInput =
  | { type: 'touch'; phase: 'down' | 'move' | 'up'; x: number; y: number }
  | { type: 'key'; key: string; code?: number; shift?: boolean }
  | { type: 'home' }
  | { type: 'back' }

export type SimulatorAction =
  | { type: 'tap'; x: number; y: number }
  | { type: 'swipe'; x: number; y: number; toX: number; toY: number; durationMs?: number }
  | { type: 'text'; text: string }
  | Extract<SimulatorInput, { type: 'key' | 'home' | 'back' }>

export function validSimulatorAction(value: unknown): value is SimulatorAction {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  const point = (x: unknown) => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 1
  if (v.type === 'tap') return point(v.x) && point(v.y)
  if (v.type === 'swipe') return point(v.x) && point(v.y) && point(v.toX) && point(v.toY) && (v.durationMs === undefined || typeof v.durationMs === 'number' && Number.isFinite(v.durationMs) && v.durationMs >= 80 && v.durationMs <= 2000)
  if (v.type === 'text') return typeof v.text === 'string' && v.text.length > 0 && v.text.length <= 1000 && /^[\x20-\x7e\n\t]+$/.test(v.text)
  return validSimulatorInput(v) && v.type !== 'touch'
}

export function parseIosDevices(value: unknown): SimulatorDevice[] {
  const data = value as { devices?: Record<string, { udid: string; name: string; state: string; isAvailable?: boolean }[]>; runtimes?: { identifier: string; name: string }[] }
  const runtimes = new Map(data.runtimes?.map((r) => [r.identifier, r.name]) ?? [])
  return Object.entries(data.devices ?? {}).flatMap(([runtime, devices]) => !runtime.includes('.iOS-') ? [] : devices.filter((d) => d.isAvailable === true && typeof d.udid === 'string' && typeof d.name === 'string').map((d) => ({
    id: `ios:${d.udid}`, platform: 'ios' as const, name: d.name,
    runtime: runtimes.get(runtime) ?? runtime.replace('com.apple.CoreSimulator.SimRuntime.', '').replace(/-(\d)/g, '.$1').replace('iOS.', 'iOS '),
    running: d.state === 'Booted'
  })))
}
export function parseAvds(output: string): SimulatorDevice[] {
  return [...new Set(output.split(/\r?\n/).map((s) => s.trim()).filter((s) => /^[\w.-]+$/.test(s)))].map((name) => ({ id: `android:${name}`, platform: 'android', name, runtime: 'Android', running: false }))
}
export function validSimulatorInput(value: unknown): value is SimulatorInput {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  if (v.type === 'touch') return ['down', 'move', 'up'].includes(String(v.phase)) && typeof v.x === 'number' && Number.isFinite(v.x) && v.x >= 0 && v.x <= 1 && typeof v.y === 'number' && Number.isFinite(v.y) && v.y >= 0 && v.y <= 1
  if (v.type === 'key') return typeof v.key === 'string' && v.key.length > 0 && v.key.length <= 32 && (v.code === undefined || typeof v.code === 'number' && Number.isInteger(v.code) && v.code >= 0 && v.code < 128) && (v.shift === undefined || typeof v.shift === 'boolean')
  return v.type === 'home' || v.type === 'back'
}
/** A carcaça não recebe toques; arrastos iniciados na tela podem terminar fora dela. */
export function simulatorPoint(x: number, y: number, rect: { left: number; top: number; width: number; height: number }, touchArea?: SimulatorTouchArea, clampToScreen = false) {
  if (rect.width <= 0 || rect.height <= 0) return null
  let px = (x - rect.left) / rect.width, py = (y - rect.top) / rect.height
  if (touchArea) {
    if (![touchArea.x, touchArea.y, touchArea.width, touchArea.height].every(Number.isFinite) || touchArea.width <= 0 || touchArea.height <= 0) return null
    px = (px - touchArea.x) / touchArea.width
    py = (py - touchArea.y) / touchArea.height
    if (!clampToScreen && (px < 0 || px > 1 || py < 0 || py > 1)) return null
  }
  return { x: Math.max(0, Math.min(1, px)), y: Math.max(0, Math.min(1, py)) }
}
const macCodes: Record<string, number> = {
  KeyA: 0, KeyS: 1, KeyD: 2, KeyF: 3, KeyH: 4, KeyG: 5, KeyZ: 6, KeyX: 7, KeyC: 8, KeyV: 9, KeyB: 11,
  KeyQ: 12, KeyW: 13, KeyE: 14, KeyR: 15, KeyY: 16, KeyT: 17, Digit1: 18, Digit2: 19, Digit3: 20, Digit4: 21,
  Digit6: 22, Digit5: 23, Equal: 24, Digit9: 25, Digit7: 26, Minus: 27, Digit8: 28, Digit0: 29, BracketRight: 30,
  KeyO: 31, KeyU: 32, BracketLeft: 33, KeyI: 34, KeyP: 35, Enter: 36, KeyL: 37, KeyJ: 38, Quote: 39,
  KeyK: 40, Semicolon: 41, Backslash: 42, Comma: 43, Slash: 44, KeyN: 45, KeyM: 46, Period: 47,
  Tab: 48, Space: 49, Backquote: 50, Backspace: 51, Escape: 53, ArrowLeft: 123, ArrowRight: 124, ArrowDown: 125, ArrowUp: 126
}
export const macSimulatorKeyCode = (code: string) => macCodes[code]

/** Digitação básica com o mapeamento físico US do teclado do Simulator. */
export function simulatorTextKeys(text: string): Extract<SimulatorInput, { type: 'key' }>[] {
  const punctuation: Record<string, [string, boolean]> = {}
  for (const [code, normal, shifted] of [
    ['Minus', '-', '_'], ['Equal', '=', '+'], ['BracketLeft', '[', '{'], ['BracketRight', ']', '}'],
    ['Semicolon', ';', ':'], ['Quote', "'", '"'], ['Backslash', '\\', '|'], ['Comma', ',', '<'],
    ['Period', '.', '>'], ['Slash', '/', '?'], ['Backquote', '`', '~']
  ]) { punctuation[normal] = [code, false]; punctuation[shifted] = [code, true] }
  for (let n = 0; n < 10; n++) { punctuation[String(n)] = [`Digit${n}`, false]; punctuation[')!@#$%^&*('[n]] = [`Digit${n}`, true] }
  return [...text].map((key) => {
    const mapped: [string, boolean] | undefined = /^[a-z]$/i.test(key) ? [`Key${key.toUpperCase()}`, key !== key.toLowerCase()]
      : key === ' ' ? ['Space', false] : key === '\n' ? ['Enter', false] : key === '\t' ? ['Tab', false] : punctuation[key]
    if (!mapped) throw new Error('A digitação direta aceita ASCII, tabulação e quebra de linha. Para Unicode, use as ferramentas nativas do projeto.')
    return { type: 'key', key: key === '\n' ? 'Enter' : key === '\t' ? 'Tab' : key, code: macSimulatorKeyCode(mapped[0]), shift: mapped[1] }
  })
}

/** Mesmo limite na largura exibida, no arrasto e no teclado, relativo ao contêiner real. */
export function simulatorPanelWidth(wanted: number, available: number) {
  const max = Math.max(0, available * 0.6)
  return Math.min(max, Math.max(Math.min(220, max), wanted))
}

/** Dimensões do elemento da imagem: sem barras vazias dentro da área que recebe os toques. */
export function simulatorImageSize(image: { width: number; height: number }, viewport: { width: number; height: number }, zoom = 1) {
  if (image.width <= 0 || image.height <= 0 || viewport.width <= 0 || viewport.height <= 0) return { width: 0, height: 0 }
  const scale = Math.min(viewport.width / image.width, viewport.height / image.height) * zoom
  return { width: image.width * scale, height: image.height * scale }
}
