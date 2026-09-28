import type { OvseerApi } from '../shared/types'

declare global {
  interface Window {
    ovseer: OvseerApi
  }
}
