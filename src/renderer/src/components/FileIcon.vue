<script lang="ts">
import { ref } from 'vue'
import manifest from 'material-icon-theme/dist/material-icons.json'
import { currentTheme } from '../theme'

/**
 * Ícones do Material Icon Theme (o tema de ícones mais usado no VS Code, licença MIT).
 * O mapa oficial do tema escolhe o ícone por nome de arquivo, extensão (a mais longa primeiro:
 * "d.ts" antes de "ts") e nome de pasta; no tema claro valem as variantes claras.
 * Cada SVG é um arquivo à parte, carregado só quando aparece na tela.
 */
type Map = Record<string, string>
interface Manifest {
  iconDefinitions: Record<string, { iconPath: string }>
  file: string
  folder: string
  folderExpanded: string
  fileExtensions: Map
  fileNames: Map
  folderNames: Map
  folderNamesExpanded: Map
  light: { fileExtensions?: Map; fileNames?: Map; folderNames?: Map; folderNamesExpanded?: Map }
}
const m = manifest as unknown as Manifest

const urls = import.meta.glob<string>('../../../../node_modules/material-icon-theme/icons/*.svg', { query: '?no-inline', import: 'default', eager: true })
const byName = new Map(Object.entries(urls).map(([k, v]) => [k.slice(k.lastIndexOf('/') + 1, -4), v]))

/** O tema do app é escuro? (acompanha a troca de tema e o claro/escuro do sistema) */
const dark = ref(true)
const media = window.matchMedia('(prefers-color-scheme: dark)')
const syncDark = () => {
  const t = currentTheme()
  dark.value = t.colors ? t.dark : media.matches
}
syncDark()
media.addEventListener('change', syncDark)
window.addEventListener('ovseer-theme', syncDark)

const lookup = (key: string, maps: (Map | undefined)[]) => {
  for (const mp of maps) if (mp?.[key]) return mp[key]
  return undefined
}

function iconId(path: string, dir: boolean, open: boolean, isDark: boolean): string {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
  const light = isDark ? undefined : m.light
  if (dir) {
    const id = open
      ? lookup(name, [light?.folderNamesExpanded, m.folderNamesExpanded])
      : lookup(name, [light?.folderNames, m.folderNames])
    return id ?? (open ? m.folderExpanded : m.folder)
  }
  const byFile = lookup(name, [light?.fileNames, m.fileNames])
  if (byFile) return byFile
  // extensões compostas primeiro ("test.ts", "d.ts"), depois a simples
  const parts = name.split('.')
  for (let i = 1; i < parts.length; i++) {
    const id = lookup(parts.slice(i).join('.'), [light?.fileExtensions, m.fileExtensions])
    if (id) return id
  }
  return m.file
}

/** Endereço do SVG do ícone (com fallback para o ícone genérico) */
export function fileIconUrl(path: string, dir = false, open = false): string {
  const id = iconId(path, dir, open, dark.value)
  const file = m.iconDefinitions[id]?.iconPath
  const key = file ? file.slice(file.lastIndexOf('/') + 1, -4) : id
  return byName.get(key) ?? byName.get(dir ? (open ? 'folder-open' : 'folder') : 'file') ?? ''
}
</script>

<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{ path: string; dir?: boolean; open?: boolean; size?: number }>()
const src = computed(() => fileIconUrl(props.path, props.dir, props.open))
const px = computed(() => props.size ?? 16)
</script>

<template>
  <img class="fi" :src="src" :width="px" :height="px" alt="" draggable="false" />
</template>

<style scoped>
.fi { flex: none; display: block; object-fit: contain; }
</style>
