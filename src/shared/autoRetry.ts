/**
 * Retomada automática: quando a resposta do agente cai por um erro passageiro (conexão, sobrecarga, o CLI que saiu
 * no meio), a janela pede sozinha para continuar. Depois de algumas tentativas seguidas sem sucesso, para e avisa
 * o usuário, que decide o que fazer.
 */

/** Tentativas seguidas antes de parar e avisar o usuário */
export const AUTO_RETRY_MAX = 3
/** Espera, em segundos, antes de cada tentativa (cresce para dar tempo de o serviço voltar) */
export const AUTO_RETRY_DELAYS = [3, 10, 30]

/** Erros em que tentar de novo não adianta: dependem de uma ação do usuário */
const NEEDS_USER = [
  /^Interrompido\.?$/i,
  /interrompida antes de terminar/i,
  /sem login|\bentrar\b|auth|login|oauth|credential|unauthorized|\b401\b|\b403\b/i,
  /não encontrad[oa]|not found|ENOENT/i,
  /antigo demais|does not support this model|escolha outro/i,
  /usage limit|limit reached|hit your .*limit|limite de uso|quota|billing|credit balance|payment/i,
  /ainda está respondendo|outro provedor|grande demais/i
]

/** A falha pode ser retomada sozinha? (interrupção do usuário, login, limite da assinatura e afins não) */
export function canAutoRetry(error: string | undefined): boolean {
  const e = error?.trim()
  if (!e) return false
  return !NEEDS_USER.some((re) => re.test(e))
}
