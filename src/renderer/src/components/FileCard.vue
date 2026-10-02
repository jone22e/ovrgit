<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import type { FileInfo } from '@shared/types'
import { artifactKind, formatSize, splitPath } from '@shared/artifacts'
import Icon from './Icon.vue'

/** Cartão de um arquivo gerado pelo agente (planilha, PDF…): tipo, nome, pasta, tamanho, abrir e mostrar na pasta. */
const props = defineProps<{ path: string; cwd?: string }>()
const api = window.ovseer
const info = ref<FileInfo | null>(null)
const parts = computed(() => splitPath(props.path))
const kind = computed(() => artifactKind(parts.value.name))
const KIND_LABEL: Record<string, string> = { sheet: 'Planilha', doc: 'Documento', pdf: 'PDF', image: 'Imagem', archive: 'Arquivo compactado', media: 'Mídia', data: 'Dados', file: 'Arquivo' }
const ext = computed(() => parts.value.name.replace(/^.*\./, '').toUpperCase())
/** Está dentro do projeto mas fora de tmp/: o agente ignorou a regra; vale avisar */
const inProject = computed(() => {
  const root = props.cwd?.replace(/[\\/]+$/, '').replace(/\\/g, '/')
  const p = props.path.replace(/\\/g, '/')
  return !!root && p.startsWith(`${root}/`) && !p.startsWith(`${root}/tmp/`)
})
/** Pasta encurtada: ~ no lugar da home */
const dir = computed(() => parts.value.dir.replace(/^\/Users\/[^/]+|^\/home\/[^/]+|^[A-Za-z]:\\Users\\[^\\]+/, '~'))
const when = computed(() => {
  if (!info.value?.exists) return ''
  const d = new Date(info.value.mtime)
  const today = new Date().toDateString() === d.toDateString()
  const hm = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  return today ? `hoje às ${hm}` : `${d.toLocaleDateString('pt-BR')} ${hm}`
})
async function load() {
  try {
    info.value = (await api.filesInfo([props.path]))[0] ?? null
  } catch {
    info.value = null
  }
}
onMounted(load)
watch(() => props.path, load)
</script>

<template>
  <div class="file-card" :class="[kind, { missing: info && !info.exists }]">
    <!-- "folha" com a extensão, na cor do tipo -->
    <span class="paper" aria-hidden="true"><i class="fold" /><b>{{ ext.slice(0, 4) }}</b></span>
    <span class="text">
      <strong class="ellipsis" :title="path">{{ parts.name }}</strong>
      <span class="meta ellipsis" :title="path">
        <span class="type">{{ KIND_LABEL[kind] }}</span>
        <template v-if="info?.exists"><span class="sep" />{{ formatSize(info.size) }}<span class="sep" />{{ when }}</template>
        <template v-else-if="info"><span class="sep" /><span class="bad">arquivo não encontrado</span></template>
        <span class="sep" /><span class="where"><Icon name="folder" :size="11" /> {{ dir }}</span>
        <template v-if="inProject"><span class="sep" /><span class="warn"><Icon name="alert" :size="11" /> fora de tmp/: cuidado para não versionar</span></template>
      </span>
    </span>
    <span class="acts">
      <button type="button" class="ghost reveal" :disabled="info ? !info.exists : false" title="Mostrar na pasta" @click="api.fileReveal(path)"><Icon name="folder" :size="13" /> Mostrar na pasta</button>
      <button type="button" class="primary open" :disabled="info ? !info.exists : false" title="Abrir no aplicativo padrão" @click="api.fileOpen(path)"><Icon name="external" :size="13" /> Abrir</button>
    </span>
  </div>
</template>

<style scoped>
.file-card {
  --tone: var(--accent);
  display: flex; align-items: center; gap: 14px; margin: 10px 0; padding: 10px 12px; width: 100%; box-sizing: border-box;
  border-radius: 12px; border: 1px solid var(--border);
  background: var(--panel);
  transition: border-color 0.15s, box-shadow 0.15s;
}
.file-card:hover { border-color: color-mix(in srgb, var(--tone) 40%, var(--border)); box-shadow: 0 6px 20px rgba(0, 0, 0, 0.18); }
.file-card.sheet { --tone: var(--add); }
.file-card.pdf { --tone: var(--del); }
.file-card.image { --tone: var(--mod); }
.file-card.doc { --tone: var(--accent); }
/* folha de papel com o canto dobrado e a extensão em baixo */
.paper {
  position: relative; display: grid; place-items: end center; width: 34px; height: 40px; flex: none;
  border-radius: 5px 10px 5px 5px; background: color-mix(in srgb, var(--tone) 16%, var(--panel-2));
  border: 1px solid color-mix(in srgb, var(--tone) 35%, var(--border)); padding-bottom: 5px;
}
.fold { position: absolute; top: -1px; right: -1px; width: 11px; height: 11px; border-radius: 0 10px 0 4px; background: color-mix(in srgb, var(--tone) 45%, var(--panel)); border-left: 1px solid color-mix(in srgb, var(--tone) 35%, var(--border)); border-bottom: 1px solid color-mix(in srgb, var(--tone) 35%, var(--border)); }
.paper b { font-family: var(--mono); font-size: 9.5px; font-weight: 800; letter-spacing: 0.02em; color: var(--tone); }
.file-card.missing .paper { opacity: 0.55; }
.text { display: flex; flex-direction: column; gap: 3px; min-width: 0; flex: 1; }
.text strong { font-size: 13.5px; font-weight: 600; }
.meta { display: flex; align-items: center; gap: 7px; font-size: 11.5px; color: var(--muted); white-space: nowrap; min-width: 0; }
.type { color: var(--tone); font-weight: 600; }
.sep { width: 3px; height: 3px; border-radius: 50%; background: var(--faint); flex: none; }
.bad { color: var(--del); }
.where { display: inline-flex; align-items: center; gap: 4px; font-family: var(--mono); font-size: 11px; color: var(--faint); min-width: 0; }
.warn { display: inline-flex; align-items: center; gap: 4px; color: var(--mod); }
.acts { display: inline-flex; align-items: center; gap: 6px; flex: none; }
.reveal { height: 30px; padding: 0 10px; gap: 6px; font-size: 12.5px; color: var(--muted); }
.reveal:hover { color: var(--text); }
.open { height: 30px; padding: 0 14px; gap: 6px; font-size: 12.5px; }
</style>
