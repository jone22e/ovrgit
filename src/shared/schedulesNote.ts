import type { AgentChatOpen } from './types'

export function schedulesNote(api: { port: number; token: string } | null, agent: AgentChatOpen): string {
  if (!api) return ''
  const base = `http://127.0.0.1:${api.port}/schedules`
  const example = JSON.stringify({ name: 'Resumo diário', prompt: 'INSTRUÇÃO EXATA DO USUÁRIO', cwd: agent.cwd,
    provider: agent.provider, model: agent.model, effort: agent.effort, mode: agent.mode === 'plan' ? 'plan' : 'full', enabled: true,
    timing: { kind: 'daily', time: '08:00', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone } })
  return [
    '<scheduled_tasks>',
    'O Ovseer permite agendar tarefas periódicas neste computador pela API local autenticada. Crie ou altere agendamentos somente quando o usuário pedir. Use a instrução, o projeto, a recorrência e o fuso solicitados; esclareça o que faltar. Nunca use o agendamento para contornar pedidos de autorização, como deploy ou alterações de dados.',
    `Base: ${base}. Cabeçalho em todas as chamadas: Authorization: Bearer ${api.token}. Em JSON, Content-Type: application/json.`,
    `GET ${base}: listar tarefas, ids, próximos horários e últimas 50 execuções com resultados.`,
    `POST ${base}: criar com um objeto como ${example}. O exemplo é só o formato; não o execute sem adaptar ao pedido.`,
    'timing aceita {"kind":"interval","minutes":60}, {"kind":"daily","time":"08:00","timezone":"America/Sao_Paulo"} ou {"kind":"weekly","time":"08:00","timezone":"America/Sao_Paulo","days":[1,2,3,4,5]}. Dias: 0 domingo até 6 sábado. mode: full para executar, plan para análise em modo Plano.',
    `PUT ${base}/{id}: editar usando o objeto completo. POST ${base}/{id}/pause ou /resume: pausar ou retomar. POST ${base}/{id}/run: executar agora. DELETE ${base}/{id}: excluir (não durante execução). Use ids retornados pela listagem.`,
    'Cada execução abre uma conversa nova e usa as instruções atuais do Ovseer e do projeto. Consulte o histórico pelo GET e pela tela Agendamentos no menu do usuário. Requer Ovseer aberto e computador acordado; ao retornar, executa uma vez o horário atrasado, sem acumular repetições. Uma tarefa não executa duas vezes ao mesmo tempo. Pausar não interrompe uma execução em andamento; para isso, use a conversa.',
    '</scheduled_tasks>'
  ].join('\n')
}
