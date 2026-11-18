import type { SimulatorDevice } from './simulator'

export function simulatorAgentNote(api: { port: number; token: string }, connected: SimulatorDevice[]): string {
  const base = `http://127.0.0.1:${api.port}/simulators`
  return [
    '<simulator_access>',
    'O Ovseer tem um painel lateral de simuladores iOS e Android. Você pode descobrir, iniciar, controlar, instalar e abrir o app pela API local autenticada. Use quando isso fizer parte da tarefa autorizada; respeite o Modo Plano e as instruções do usuário.',
    connected.length ? `Conectados agora: ${connected.map((d) => `${d.name} (${d.runtime}), id=${d.id}`).join('; ')}.` : 'Nenhuma captura conectada agora. Consulte a lista; os aparelhos podem estar ligados mesmo sem captura.',
    `Base: ${base}. Em todas as chamadas use o cabeçalho Authorization: Bearer ${api.token}. Em POST JSON, use Content-Type: application/json. Codifique o id na URL; nunca deduza nome, UDID, serial ou appId.`,
    `1. Descobrir aparelhos reais, estado e capturas conectadas: GET ${base}. Escolha explicitamente um id retornado (ios:<UDID> ou android:<AVD>). Reaproveite o aparelho da tarefa; não pare aparelhos de outras tarefas.`,
    '2. Iniciar e preparar: POST /{id}/start. Aguarde a resposta. A API aproveita a captura existente ou cria uma conexão temporária. Não requer abrir navegador.',
    '3. Capturar a tela nativa: GET /{id}/screenshot retorna PNG sem a moldura. Salve em tmp/ do projeto e leia a imagem antes de decidir onde tocar. Exemplo: curl -sS -f -H "Authorization: Bearer <token>" "<base>/<id>/screenshot" -o "<projeto>/tmp/simulador.png". Não exiba o token.',
    '4. Controlar: POST /{id}/action. Coordenadas de 0 a 1 relativas à tela do aparelho, não à janela do Mac. Exemplos JSON: {"type":"tap","x":0.5,"y":0.5}; {"type":"swipe","x":0.5,"y":0.8,"toX":0.5,"toY":0.2,"durationMs":400}; {"type":"text","text":"teste@exemplo.com"} (ASCII, teclado US); {"type":"key","key":"Enter","code":36}; {"type":"home"}; {"type":"back"} (Android). Capture novamente para verificar o resultado.',
    '5. Instalar: primeiro leia os scripts/configuração do projeto e gere o artefato correto. iOS exige um diretório .app compilado para iOS Simulator, não um .ipa ou build de iPhone físico. Android exige .apk. POST /{id}/install com {"path":"/caminho/absoluto/App.app"} ou {"path":"/caminho/absoluto/app.apk"}. A API instala o artefato; não compila nem escolhe o projeto.',
    '6. Abrir o app: POST /{id}/launch com {"appId":"com.exemplo.app"}; use o identificador retornado pela instalação ou confirmado na configuração do projeto. Para Expo e deep links: POST /{id}/open-url com {"url":"exp://host:porta"} (use o endereço real do servidor do projeto). Reaproveite os serviços já rodando no Ovseer.',
    '7. Desligar, somente quando fizer parte da tarefa: POST /{id}/stop. Não apague dados, desinstale apps ou encerre outros aparelhos sem autorização. Fechar a captura não apaga nem reinstala o app.',
    '</simulator_access>'
  ].join('\n')
}
