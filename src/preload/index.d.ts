import type { OvrGitApi } from '../shared/types'

declare global {
  interface Window {
    ovrgit: OvrGitApi
  }
}
