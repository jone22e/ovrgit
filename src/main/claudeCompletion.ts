import type { AgentChatEvent } from '../shared/types'

type Done = Extract<AgentChatEvent, { type: 'done' }>

/** O Claude pode juntar várias mensagens enviadas durante uma resposta em um único `result`. */
export class ClaudeCompletion {
  private steered = false
  private pending: Done | null = null
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly finish: (event: Done) => void, private readonly settleMs = 1000) {}

  get waiting(): boolean {
    return this.pending !== null
  }

  steer() {
    this.clear()
    this.steered = true
  }

  /** Uma nova resposta começou após o resultado anterior; aquele resultado não encerra a vez exibida. */
  activity(): boolean {
    if (!this.pending) return false
    this.clear()
    return true
  }

  result(event: Done) {
    if (!this.steered) return this.finish(event)
    this.clear()
    this.pending = event
    this.timer = setTimeout(() => this.flush(), this.settleMs)
  }

  /** Se o processo sair após o resultado, não espere o prazo para encerrar o card. */
  flush() {
    const event = this.pending
    this.clear()
    if (event) {
      this.steered = false
      this.finish(event)
    }
  }

  dispose() {
    this.clear()
  }

  private clear() {
    clearTimeout(this.timer)
    this.timer = undefined
    this.pending = null
  }
}
