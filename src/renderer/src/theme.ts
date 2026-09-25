import { DEFAULT_THEME, findTheme, themeVars, type Theme } from '@shared/themes'

let applied: string[] = []
let current: Theme = findTheme(DEFAULT_THEME)

export const currentTheme = () => current

/** Aplica o tema: sobrescreve as variáveis CSS (o padrão volta ao styles.css, que segue o sistema). */
export function applyTheme(id: string | undefined) {
  const theme = findTheme(id)
  current = theme
  const root = document.documentElement
  applied.forEach((k) => root.style.removeProperty(k))
  const vars = themeVars(theme)
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v)
  applied = Object.keys(vars)
  root.dataset.theme = theme.id
  root.style.colorScheme = theme.colors ? (theme.dark ? 'dark' : 'light') : ''
  window.dispatchEvent(new CustomEvent('ovrgit-theme'))
  // barra de título do Windows e cor de fundo da janela acompanham o tema
  const css = getComputedStyle(root)
  window.ovrgit.setWindowTheme(css.getPropertyValue('--bg').trim(), css.getPropertyValue('--muted').trim())
}

// o tema padrão segue o sistema: avisa quem depende das cores (terminal, janela) quando o sistema troca
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (!current.colors) applyTheme(current.id)
})
