/**
 * Temas do app. "ovrgit" é o padrão e segue o claro/escuro do sistema (definido em styles.css);
 * os demais sobrescrevem as variáveis CSS e trazem a paleta ANSI do terminal.
 */

export interface AnsiPalette {
  black: string
  red: string
  green: string
  yellow: string
  blue: string
  magenta: string
  cyan: string
  white: string
  brightBlack: string
  brightRed: string
  brightGreen: string
  brightYellow: string
  brightBlue: string
  brightMagenta: string
  brightCyan: string
  brightWhite: string
}

export interface ThemeColors {
  accent: string
  accentStrong: string
  onAccent: string
  bg: string
  panel: string
  panel2: string
  hover: string
  border: string
  text: string
  muted: string
  faint: string
  add: string
  del: string
  mod: string
  hunk: string
}

export interface Theme {
  id: string
  name: string
  dark: boolean
  colors?: ThemeColors
  ansi?: AnsiPalette
}

export const DEFAULT_THEME = 'ovrgit'

export const THEMES: Theme[] = [
  { id: 'ovrgit', name: 'OvrGit (padrão)', dark: true },
  {
    id: 'dracula',
    name: 'Dracula',
    dark: true,
    colors: {
      accent: '#bd93f9', accentStrong: '#a87bf0', onAccent: '#282a36',
      bg: '#21222c', panel: '#282a36', panel2: '#313341', hover: '#3a3c4e', border: '#44475a',
      text: '#f8f8f2', muted: '#bfc2d9', faint: '#7b86b8',
      add: '#50fa7b', del: '#ff5555', mod: '#f1fa8c', hunk: '#8be9fd'
    },
    ansi: {
      black: '#21222c', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c', blue: '#bd93f9', magenta: '#ff79c6',
      cyan: '#8be9fd', white: '#f8f8f2', brightBlack: '#6272a4', brightRed: '#ff6e6e', brightGreen: '#69ff94',
      brightYellow: '#ffffa5', brightBlue: '#d6acff', brightMagenta: '#ff92df', brightCyan: '#a4ffff',
      brightWhite: '#ffffff'
    }
  },
  {
    id: 'one-dark',
    name: 'One Dark Pro',
    dark: true,
    colors: {
      accent: '#61afef', accentStrong: '#4d9de0', onAccent: '#1b1d23',
      bg: '#21252b', panel: '#282c34', panel2: '#2c313a', hover: '#333842', border: '#3e4451',
      text: '#abb2bf', muted: '#8b93a1', faint: '#5c6370',
      add: '#98c379', del: '#e06c75', mod: '#e5c07b', hunk: '#c678dd'
    },
    ansi: {
      black: '#3f4451', red: '#e05561', green: '#8cc265', yellow: '#d18f52', blue: '#4aa5f0', magenta: '#c162de',
      cyan: '#42b3c2', white: '#d7dae0', brightBlack: '#4f5666', brightRed: '#ff616e', brightGreen: '#a5e075',
      brightYellow: '#f0a45d', brightBlue: '#4dc4ff', brightMagenta: '#de73ff', brightCyan: '#4cd1e0',
      brightWhite: '#e6e6e6'
    }
  },
  {
    id: 'tokyo-night',
    name: 'Tokyo Night',
    dark: true,
    colors: {
      accent: '#7aa2f7', accentStrong: '#5a86e8', onAccent: '#16161e',
      bg: '#16161e', panel: '#1a1b26', panel2: '#1f2335', hover: '#292e42', border: '#2a2f45',
      text: '#c0caf5', muted: '#a9b1d6', faint: '#737aa2',
      add: '#9ece6a', del: '#f7768e', mod: '#e0af68', hunk: '#bb9af7'
    },
    ansi: {
      black: '#15161e', red: '#f7768e', green: '#9ece6a', yellow: '#e0af68', blue: '#7aa2f7', magenta: '#bb9af7',
      cyan: '#7dcfff', white: '#a9b1d6', brightBlack: '#414868', brightRed: '#f7768e', brightGreen: '#9ece6a',
      brightYellow: '#e0af68', brightBlue: '#7aa2f7', brightMagenta: '#bb9af7', brightCyan: '#7dcfff',
      brightWhite: '#c0caf5'
    }
  },
  {
    id: 'monokai',
    name: 'Monokai',
    dark: true,
    colors: {
      accent: '#f92672', accentStrong: '#e0135e', onAccent: '#ffffff',
      bg: '#1e1f1c', panel: '#272822', panel2: '#2f302a', hover: '#3e3d32', border: '#46473d',
      text: '#f8f8f2', muted: '#bebdb0', faint: '#8a8672',
      add: '#a6e22e', del: '#ff6188', mod: '#e6db74', hunk: '#66d9ef'
    },
    ansi: {
      black: '#272822', red: '#f92672', green: '#a6e22e', yellow: '#f4bf75', blue: '#66d9ef', magenta: '#ae81ff',
      cyan: '#a1efe4', white: '#f8f8f2', brightBlack: '#75715e', brightRed: '#f92672', brightGreen: '#a6e22e',
      brightYellow: '#f4bf75', brightBlue: '#66d9ef', brightMagenta: '#ae81ff', brightCyan: '#a1efe4',
      brightWhite: '#f9f8f5'
    }
  },
  {
    id: 'nord',
    name: 'Nord',
    dark: true,
    colors: {
      accent: '#88c0d0', accentStrong: '#81a1c1', onAccent: '#2e3440',
      bg: '#272c36', panel: '#2e3440', panel2: '#353c4a', hover: '#3b4252', border: '#434c5e',
      text: '#eceff4', muted: '#b4bccb', faint: '#7b88a1',
      add: '#a3be8c', del: '#bf616a', mod: '#ebcb8b', hunk: '#b48ead'
    },
    ansi: {
      black: '#3b4252', red: '#bf616a', green: '#a3be8c', yellow: '#ebcb8b', blue: '#81a1c1', magenta: '#b48ead',
      cyan: '#88c0d0', white: '#e5e9f0', brightBlack: '#4c566a', brightRed: '#bf616a', brightGreen: '#a3be8c',
      brightYellow: '#ebcb8b', brightBlue: '#81a1c1', brightMagenta: '#b48ead', brightCyan: '#8fbcbb',
      brightWhite: '#eceff4'
    }
  },
  {
    id: 'github-dark',
    name: 'GitHub Dark',
    dark: true,
    colors: {
      accent: '#4493f8', accentStrong: '#1f6feb', onAccent: '#ffffff',
      bg: '#010409', panel: '#0d1117', panel2: '#161b22', hover: '#1f252d', border: '#30363d',
      text: '#e6edf3', muted: '#9198a1', faint: '#6e7681',
      add: '#3fb950', del: '#f85149', mod: '#d29922', hunk: '#a371f7'
    },
    ansi: {
      black: '#484f58', red: '#ff7b72', green: '#3fb950', yellow: '#d29922', blue: '#58a6ff', magenta: '#bc8cff',
      cyan: '#39c5cf', white: '#b1bac4', brightBlack: '#6e7681', brightRed: '#ffa198', brightGreen: '#56d364',
      brightYellow: '#e3b341', brightBlue: '#79c0ff', brightMagenta: '#d2a8ff', brightCyan: '#56d4dd',
      brightWhite: '#ffffff'
    }
  },
  {
    id: 'github-light',
    name: 'GitHub Light',
    dark: false,
    colors: {
      accent: '#0969da', accentStrong: '#0550ae', onAccent: '#ffffff',
      bg: '#f6f8fa', panel: '#ffffff', panel2: '#f6f8fa', hover: '#eaeef2', border: '#d0d7de',
      text: '#1f2328', muted: '#59636e', faint: '#818b98',
      add: '#1a7f37', del: '#cf222e', mod: '#9a6700', hunk: '#8250df'
    },
    ansi: {
      black: '#24292f', red: '#cf222e', green: '#116329', yellow: '#4d2d00', blue: '#0969da', magenta: '#8250df',
      cyan: '#1b7c83', white: '#6e7781', brightBlack: '#57606a', brightRed: '#a40e26', brightGreen: '#1a7f37',
      brightYellow: '#633c01', brightBlue: '#218bff', brightMagenta: '#a475f9', brightCyan: '#3192aa',
      brightWhite: '#8c959f'
    }
  }
]

export const findTheme = (id: string | undefined) => THEMES.find((t) => t.id === id) ?? THEMES[0]

/** Converte "#rrggbb" em "rgba(r, g, b, a)". */
export function alpha(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`
}

/** Variáveis CSS do tema (vazio para o padrão, que usa styles.css). */
export function themeVars(theme: Theme): Record<string, string> {
  const c = theme.colors
  if (!c) return {}
  return {
    '--accent': c.accent,
    '--accent-strong': c.accentStrong,
    '--accent-soft': alpha(c.accent, theme.dark ? 0.18 : 0.12),
    '--on-accent': c.onAccent,
    '--bg': c.bg,
    '--panel': c.panel,
    '--panel-2': c.panel2,
    '--hover': c.hover,
    '--border': c.border,
    '--text': c.text,
    '--muted': c.muted,
    '--faint': c.faint,
    '--add': c.add,
    '--add-bg': alpha(c.add, theme.dark ? 0.14 : 0.12),
    '--del': c.del,
    '--del-bg': alpha(c.del, theme.dark ? 0.14 : 0.1),
    '--mod': c.mod,
    '--hunk': c.hunk,
    '--hunk-bg': alpha(c.hunk, theme.dark ? 0.1 : 0.08)
  }
}
