/** "1 arquivo" / "3 arquivos": o número com o texto no singular ou no plural (nada de "arquivo(s)") */
export const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
