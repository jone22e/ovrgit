<script setup lang="ts">
import { computed } from 'vue'
import { setShowDiff, state } from '../store'
import Icon from './Icon.vue'

interface Line { kind: 'add' | 'del' | 'ctx' | 'hunk' | 'meta'; text: string; old?: number; new?: number }

const lines = computed<Line[]>(() => {
  const out: Line[] = []
  let o = 0
  let n = 0
  let inHunk = false
  for (const raw of state.diff.split('\n')) {
    if (raw.startsWith('diff --git') || raw.startsWith('index ')) { inHunk = false; continue }
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)/.exec(raw)
    if (m) {
      o = Number(m[1]); n = Number(m[2]); inHunk = true
      out.push({ kind: 'hunk', text: raw })
    } else if (!inHunk) {
      if (/^(---|\+\+\+) /.test(raw)) continue
      if (raw.trim()) out.push({ kind: 'meta', text: raw })
    } else if (raw.startsWith('+')) out.push({ kind: 'add', text: raw.slice(1), new: n++ })
    else if (raw.startsWith('-')) out.push({ kind: 'del', text: raw.slice(1), old: o++ })
    else if (raw.startsWith('\\')) out.push({ kind: 'meta', text: raw })
    else if (raw !== '' || o || n) out.push({ kind: 'ctx', text: raw.slice(1), old: o++, new: n++ })
  }
  while (out.length && out[out.length - 1].kind === 'ctx' && out[out.length - 1].text === '') out.pop()
  return out
})

const stats = computed(() => ({
  add: lines.value.filter((l) => l.kind === 'add').length,
  del: lines.value.filter((l) => l.kind === 'del').length
}))
</script>

<template>
  <div class="diff">
    <div v-if="!state.activeFile" class="placeholder faint">
      Selecione um arquivo para ver o diff.
      <button class="ghost icon small close-empty" title="Fechar o diff" @click="setShowDiff(false)"><Icon name="x" :size="14" /></button>
    </div>
    <template v-else>
      <header>
        <span class="mono ellipsis path">
          <template v-if="state.activeFile.origPath">
            <span class="faint">{{ state.activeFile.origPath }} → </span>
          </template>{{ state.activeFile.path }}
        </span>
        <span class="add">+{{ stats.add }}</span>
        <span class="del">−{{ stats.del }}</span>
        <button class="ghost icon small" title="Fechar o diff" @click="setShowDiff(false)"><Icon name="x" :size="14" /></button>
      </header>
      <div v-if="state.diffLoading" class="placeholder"><span class="spinner" /></div>
      <div v-else-if="!lines.length" class="placeholder faint">
        {{ state.activeFile.kind === 'deleted' ? 'Arquivo removido.' : 'Sem diferenças de texto (arquivo binário ou só permissão).' }}
      </div>
      <div v-else class="code">
        <table>
          <tbody>
            <tr v-for="(l, i) in lines" :key="i" :class="l.kind">
              <template v-if="l.kind === 'hunk' || l.kind === 'meta'">
                <td colspan="3" class="hunk-text">{{ l.text }}</td>
              </template>
              <template v-else>
                <td class="ln">{{ l.old ?? '' }}</td>
                <td class="ln">{{ l.new ?? '' }}</td>
                <td class="txt"><span class="sign">{{ l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' ' }}</span>{{ l.text }}</td>
              </template>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </div>
</template>

<style scoped>
.diff { display: flex; flex-direction: column; height: 100%; min-width: 0; background: var(--panel); }
header {
  display: flex; align-items: center; gap: 10px;
  height: var(--pane-header); padding: 0 14px; border-bottom: 1px solid var(--border); flex: none; box-sizing: border-box;
}
.path { flex: 1; font-size: 12px; min-width: 0; }
.add { color: var(--add); font-family: var(--mono); font-size: 12px; }
.del { color: var(--del); font-family: var(--mono); font-size: 12px; }
.diff { position: relative; }
.close-empty { position: absolute; top: 8px; right: 8px; }
.icon.small { width: 26px; }
.placeholder { flex: 1; display: flex; align-items: center; justify-content: center; padding: 24px; text-align: center; }
.code { flex: 1; overflow: auto; user-select: text; }
table { border-collapse: collapse; font-family: var(--mono); font-size: 12px; line-height: 20px; min-width: 100%; }
td { padding: 0; vertical-align: top; }
.ln {
  width: 1%; min-width: 44px; padding: 0 8px; text-align: right; color: var(--faint);
  user-select: none; white-space: nowrap; background: var(--panel);
}
.txt { white-space: pre; padding-right: 24px; }
.sign { display: inline-block; width: 18px; text-align: center; color: var(--faint); user-select: none; }
tr.add .txt, tr.add .ln { background: var(--add-bg); }
tr.add .sign { color: var(--add); }
tr.del .txt, tr.del .ln { background: var(--del-bg); }
tr.del .sign { color: var(--del); }
tr.hunk td { background: var(--hunk-bg); color: var(--hunk); padding: 2px 12px; }
tr.meta td { color: var(--faint); padding: 2px 12px; font-style: italic; }
.hunk-text { white-space: pre; }
</style>
