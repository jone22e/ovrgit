/** `a` é uma versão mais nova que `b`? Compara os números separados por ponto ("0.1.33" > "0.1.9"); um "v" na frente e sufixos ("-beta.1") são ignorados */
export function isNewerVersion(a: string, b: string): boolean {
  const parts = (v: string) => v.replace(/^v/i, '').split('-')[0].split('.').map((n) => parseInt(n, 10) || 0)
  const pa = parts(a)
  const pb = parts(b)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x !== y) return x > y
  }
  return false
}
