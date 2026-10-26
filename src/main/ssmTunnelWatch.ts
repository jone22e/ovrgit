export interface ProcessInfo {
  pid: number
  ppid: number
  command: string
}

interface SsmTunnel {
  target: string
  document: string
  host: string
  port: string
}

function argument(command: string, name: string): string | null {
  const value = new RegExp(`(?:^|\\s)--${name}(?:=|\\s+)([^\\s]+)`).exec(command)?.[1]
  return value?.replace(/^['"]|['"]$/g, '') ?? null
}

/** Identifica apenas túneis SSM cujos parâmetros JSON podem ser conferidos por completo. */
export function ssmTunnelKey(command: string): string | null {
  const normalized = command.replace(/\\\s*\r?\n/g, ' ').trim()
  if (!/(?:^|\s)(?:\S*\/)?aws\s+ssm\s+start-session(?:\s|$)/.test(normalized)) return null
  const target = argument(normalized, 'target')
  const document = argument(normalized, 'document-name')
  const parametersAt = normalized.indexOf('--parameters')
  const jsonStart = normalized.indexOf('{', parametersAt)
  const jsonEnd = normalized.indexOf('}', jsonStart)
  if (!target || !document || parametersAt < 0 || jsonStart < 0 || jsonEnd < 0) return null
  if (document !== 'AWS-StartPortForwardingSession' && document !== 'AWS-StartPortForwardingSessionToRemoteHost') return null
  try {
    const parameters = JSON.parse(normalized.slice(jsonStart, jsonEnd + 1)) as Record<string, unknown>
    const port = Array.isArray(parameters.portNumber) ? parameters.portNumber[0] : null
    const host = document === 'AWS-StartPortForwardingSessionToRemoteHost' && Array.isArray(parameters.host)
      ? parameters.host[0] : ''
    if (!port || (document === 'AWS-StartPortForwardingSessionToRemoteHost' && !host)) return null
    const tunnel: SsmTunnel = { target, document, host: String(host), port: String(port) }
    return JSON.stringify(tunnel)
  } catch {
    return null
  }
}

export function parseProcessTable(output: string): ProcessInfo[] {
  return output.split(/\r?\n/).flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line)
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }] : []
  })
}

/** Um processo pertence ao serviço se sua cadeia de pais chega ao PTY desse serviço. */
export function externalTunnelProcesses(
  processes: ProcessInfo[],
  managed: { id: string; name: string; command: string; pid?: number }[]
): { id: string; name: string; pid: number }[] {
  const byPid = new Map(processes.map((process) => [process.pid, process]))
  const tunnels = managed.flatMap((service) => {
    const key = ssmTunnelKey(service.command)
    return key ? [{ ...service, key }] : []
  })
  const ownedBy = (pid: number, root: number): boolean => {
    const visited = new Set<number>()
    while (pid > 1 && !visited.has(pid)) {
      if (pid === root) return true
      visited.add(pid)
      pid = byPid.get(pid)?.ppid ?? 0
    }
    return false
  }
  return processes.flatMap((process) => {
    if (!/^(?:\S*\/)?aws\s+ssm\s+start-session(?:\s|$)/.test(process.command)) return []
    const key = ssmTunnelKey(process.command)
    if (tunnels.some((item) => item.key === key && item.pid && ownedBy(process.pid, item.pid))) return []
    const service = tunnels.find((item) => item.key === key)
    return service ? [{ id: service.id, name: service.name, pid: process.pid }] : []
  })
}
