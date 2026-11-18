export type SimulatorPlatform = 'ios' | 'android'
export interface SimulatorDevice {
  id: string
  platform: SimulatorPlatform
  name: string
  runtime: string
  running: boolean
}
export interface SimulatorCatalog { devices: SimulatorDevice[]; issues: Partial<Record<SimulatorPlatform, string>> }
export interface SimulatorFrame { deviceId: string; image: string; width: number; height: number }
export type SimulatorInput =
  | { type: 'touch'; phase: 'down' | 'move' | 'up'; x: number; y: number }
  | { type: 'key'; key: string; code?: number; shift?: boolean }
  | { type: 'home' }
  | { type: 'back' }

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
/** Coordenadas no elemento da imagem, que preserva a proporção e não contém barras vazias. */
export function simulatorPoint(x: number, y: number, rect: { left: number; top: number; width: number; height: number }) {
  if (rect.width <= 0 || rect.height <= 0) return null
  return { x: Math.max(0, Math.min(1, (x - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (y - rect.top) / rect.height)) }
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
