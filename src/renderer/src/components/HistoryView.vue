<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue'
import type { SavedChanges } from '@shared/types'
import { api, dropSaved, editLastMessage, loadHistory, restoreSaved, state, undoLastCommit } from '../store'
import Icon from './Icon.vue'

onMounted(loadHistory)

const rtf = new Intl.RelativeTimeFormat('pt-BR', { numeric: 'auto' })
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60], ['second', 1]
]
function relative(iso: string): string {
  const diff = (new Date(iso).getTime() - Date.now()) / 1000
  const [unit, secs] = UNITS.find(([, s]) => Math.abs(diff) >= s) ?? ['second', 1]
  return rtf.format(Math.round(diff / secs), unit)
}

// guardadas: abre/fecha a lista de arquivos
const openSaved = ref(new Set<string>())
function toggleSaved(item: SavedChanges) {
  const s = new Set(openSaved.value)
  if (s.has(item.ref)) s.delete(item.ref)
  else s.add(item.ref)
  openSaved.value = s
}

/** Versões de junção (merge) ganham um nome que qualquer pessoa entende. */
function friendly(c: { subject: string; merge?: boolean }) {
  if (!c.merge) return c.subject
  const m = /^Merge (?:remote-tracking )?branch '([^']+)'(?: of .*)?(?: into (.+))?$/.exec(c.subject)
  if (!m) return c.subject
  return m[1] === state.repo?.branch || /^origin\//.test(m[1]) || / of /.test(c.subject)
    ? 'Juntou as atualizações do servidor'
    : `Juntou a linha "${m[1]}"`
}

// explicar uma versão com a IA
const explained = ref<Record<string, { loading: boolean; text?: string; error?: string }>>({})
async function explain(hash: string) {
  if (explained.value[hash]?.text) {
    delete explained.value[hash]
    return
  }
  explained.value[hash] = { loading: true }
  try {
    explained.value[hash] = { loading: false, text: await api.explainCommit(hash) }
  } catch (e) {
    const msg = String((e as Error).message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
    explained.value[hash] = { loading: false, error: /CANCELADO/.test(msg) ? 'Cancelado.' : msg }
  }
}

// editar a mensagem da última versão
const editing = ref(false)
const draft = ref('')
const editInput = ref<HTMLInputElement>()
async function startEdit(subject: string) {
  draft.value = subject
  editing.value = true
  await nextTick()
  editInput.value?.select()
}
async function saveEdit() {
  if (!draft.value.trim()) return
  editing.value = false
  await editLastMessage(draft.value.trim())
}
</script>

<template>
  <div class="history">
    <div class="inner">
      <section v-if="state.saved.length" class="saved">
        <h3><Icon name="archive" :size="15" /> Guardadas</h3>
        <p class="muted hint">Alterações que saíram da lista mas não foram perdidas. Recupere quando quiser.</p>
        <article v-for="s in state.saved" :key="s.ref" class="saved-item" :class="s.kind">
          <div class="s-head" @click="toggleSaved(s)">
            <Icon :name="s.kind === 'trash' ? 'trash' : 'archive'" :size="15" class="s-ic" />
            <div class="s-text">
              <strong class="ellipsis">{{ s.label }}</strong>
              <small class="faint">{{ relative(s.date) }} · {{ s.files.length }} arquivo(s)</small>
            </div>
            <button class="small" :disabled="!!state.busy" title="Traz as alterações de volta para a lista" @click.stop="restoreSaved(s)">
              <Icon name="undo" :size="13" /> Recuperar
            </button>
            <button class="ghost icon small danger" :disabled="!!state.busy" title="Apagar de vez (não dá para desfazer)" @click.stop="dropSaved(s)">
              <Icon name="trash" :size="13" />
            </button>
          </div>
          <ul v-if="openSaved.has(s.ref)" class="s-files mono">
            <li v-for="f in s.files" :key="f">{{ f }}</li>
          </ul>
        </article>
      </section>

      <section>
        <h3><Icon name="history" :size="15" /> Versões</h3>
        <p class="muted hint">Cada versão é um ponto salvo do projeto. As mais novas ficam em cima.</p>
        <div v-if="!state.history.length" class="empty faint">Nenhuma versão salva ainda.</div>
        <ol v-else>
          <li v-for="(c, i) in state.history" :key="c.hash" :class="{ local: c.local }">
            <span class="dot" />
            <div class="main">
              <template v-if="i === 0 && editing">
                <form class="edit" @submit.prevent="saveEdit">
                  <input ref="editInput" v-model="draft" type="text" class="mono" @keydown.esc="editing = false" />
                  <button type="submit" class="small primary">Salvar</button>
                  <button type="button" class="small" @click="editing = false">Cancelar</button>
                </form>
              </template>
              <div v-else class="subject ellipsis" :title="c.subject">
                <Icon v-if="c.merge" name="merge" :size="13" class="merge-ic" />{{ friendly(c) }}
              </div>
              <div class="meta faint">
                <span
                  class="where"
                  :class="{ local: c.local }"
                  :title="c.local ? 'Esta versão ainda não foi enviada: só existe no seu computador' : 'Esta versão já está no servidor'"
                >
                  <Icon :name="c.local ? 'monitor' : 'cloud'" :size="11" />
                  {{ c.local ? 'Só no seu computador' : 'No servidor' }}
                </span>
                <span>{{ c.author }}</span>
                <span :title="new Date(c.date).toLocaleString('pt-BR')">{{ relative(c.date) }}</span>
                <span class="mono">{{ c.short }}</span>
              </div>
            </div>
            <div v-if="explained[c.hash]" class="explain">
              <p v-if="explained[c.hash].loading" class="faint"><span class="spinner" /> A IA está lendo esta versão…</p>
              <p v-else-if="explained[c.hash].error" class="bad">{{ explained[c.hash].error }}</p>
              <p v-else class="expl-text"><Icon name="sparkles" :size="13" /> <span>{{ explained[c.hash].text }}</span></p>
            </div>
            <button
              v-if="state.settings?.provider !== 'none'"
              class="small ghost explain-btn"
              :title="explained[c.hash]?.text ? 'Esconder a explicação' : 'A IA explica, em palavras simples, o que esta versão mudou'"
              @click="explain(c.hash)"
            >
              <Icon name="sparkles" :size="13" /> {{ explained[c.hash]?.text ? 'Esconder' : 'Explicar' }}
            </button>
            <div v-if="i === 0 && c.local && !c.merge && !editing && !state.repo?.operation" class="acts">
              <button class="small ghost" :disabled="!!state.busy" title="Trocar a descrição desta versão" @click="startEdit(c.subject)">
                <Icon name="pencil" :size="13" /> Editar
              </button>
              <button
                class="small ghost"
                :disabled="!!state.busy"
                title="Desfazer esta versão: as alterações voltam para a lista (nada é apagado)"
                @click="undoLastCommit(c.subject)"
              >
                <Icon name="undo" :size="13" /> Desfazer
              </button>
            </div>
          </li>
        </ol>
      </section>
    </div>
  </div>
</template>

<style scoped>
.history { flex: 1; overflow: auto; background: var(--panel); }
.inner { max-width: 900px; margin: 0 auto; padding: 18px 24px 30px; display: flex; flex-direction: column; gap: 24px; }
h3 { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 13px; }
h3 svg { color: var(--accent); }
.hint { margin: 2px 0 10px; font-size: 12px; }
.empty { padding: 24px 0; }

.saved-item { border: 1px solid var(--border); border-radius: 10px; background: var(--panel-2); margin-bottom: 8px; overflow: hidden; }
.s-head { display: flex; align-items: center; gap: 10px; padding: 10px 12px; cursor: pointer; }
.s-ic { color: var(--muted); flex: none; }
.saved-item.trash .s-ic { color: var(--del); }
.s-text { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.s-text strong { font-size: 13px; font-weight: 600; }
.s-text small { font-size: 11.5px; }
.danger:hover { color: var(--del); background: var(--del-bg) !important; }
.s-files { list-style: none; margin: 0; padding: 8px 12px 10px 37px; border-top: 1px solid var(--border); font-size: 11.5px; color: var(--muted); user-select: text; }
.s-files li { padding: 1px 0; word-break: break-all; }

ol { list-style: none; margin: 0; padding: 0; }
li { display: flex; gap: 14px; padding: 9px 0; position: relative; align-items: flex-start; user-select: text; }
li::before { content: ''; position: absolute; left: 5px; top: 0; bottom: 0; width: 2px; background: var(--border); }
li:first-child::before { top: 18px; }
li:last-child::before { bottom: calc(100% - 18px); }
.dot { width: 12px; height: 12px; border-radius: 50%; background: var(--panel); border: 2px solid var(--faint); margin-top: 4px; flex: none; z-index: 1; }
li.local .dot { border-color: var(--accent); }
.main { min-width: 0; flex: 1; }
.subject { font-weight: 500; }
.merge-ic { color: var(--hunk); vertical-align: -2px; margin-right: 6px; }
.meta { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; font-size: 12px; margin-top: 3px; }
.where { display: inline-flex; align-items: center; gap: 4px; padding: 1px 7px; border-radius: 999px; background: var(--panel-2); font-size: 11px; }
.where.local { color: var(--accent); background: var(--accent-soft); }
.acts { display: flex; gap: 4px; flex: none; }
li { flex-wrap: wrap; }
.explain { flex-basis: 100%; margin: 4px 0 0 26px; }
.explain p { margin: 0; font-size: 12.5px; display: flex; gap: 8px; align-items: flex-start; line-height: 1.55; }
.expl-text { background: var(--accent-soft); padding: 8px 10px; border-radius: 8px; white-space: pre-wrap; }
.expl-text svg { color: var(--accent); flex: none; margin-top: 3px; }
.bad { color: var(--del); }
.explain-btn { opacity: 0; flex: none; color: var(--accent); }
li:hover .explain-btn { opacity: 1; }
.edit { display: flex; gap: 6px; }
.edit input { flex: 1; height: 30px; font-size: 12.5px; }
</style>
