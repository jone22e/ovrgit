<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  commitPlan, outsidePlan, ovseerReady, planGroups, state, togglePlanGroup, updateGroupCommit, useSingleCommit
} from '../store'
import TaskPicker from './TaskPicker.vue'
import Icon from './Icon.vue'
import Modal from './Modal.vue'

const open = ref(new Set<string>())
const toggleFiles = (id: string) => {
  const s = new Set(open.value)
  if (s.has(id)) s.delete(id)
  else s.add(id)
  open.value = s
}
const n = computed(() => planGroups.value.length)
const close = () => (state.planOpen = false)

const vAutosize = {
  mounted: (el: HTMLTextAreaElement) => fit(el),
  updated: (el: HTMLTextAreaElement) => fit(el)
}
function fit(el: HTMLTextAreaElement) {
  el.style.height = 'auto'
  el.style.height = `${el.scrollHeight + 2}px`
}
</script>

<template>
  <Modal
    v-if="state.planOpen"
    :title="`${state.analysis?.provider ?? 'A IA'} sugeriu ${state.groups.length} commit${state.groups.length === 1 ? '' : 's'}`"
    :width="640"
    @close="close"
  >
    <p v-if="state.planStale" class="stale">
      <Icon name="alert" :size="14" /> Os arquivos mudaram desde esta análise. Reanalise para um plano atualizado.
    </p>

    <ol class="plan">
      <li v-for="(g, i) in state.groups" :key="g.id" :class="{ off: state.planExcluded.has(g.id) }">
        <div class="head">
          <input
            type="checkbox"
            :checked="!state.planExcluded.has(g.id)"
            :title="state.planExcluded.has(g.id) ? 'Incluir este commit' : 'Deixar este commit para depois'"
            @change="togglePlanGroup(g.id)"
          />
          <span class="num">{{ i + 1 }}</span>
          <strong class="title ellipsis">{{ g.title }}</strong>
          <span class="type">{{ g.type }}</span>
          <span class="spacer" />
          <TaskPicker
            v-if="ovseerReady"
            :model-value="state.planTasks[g.id] ?? null"
            compact
            @update:model-value="state.planTasks[g.id] = $event"
          />
          <button class="ghost small files-btn" @click="toggleFiles(g.id)">
            {{ g.files.length }} arquivo{{ g.files.length === 1 ? '' : 's' }}
            <Icon name="chevron" :size="12" class="chev" :class="{ open: open.has(g.id) }" />
          </button>
        </div>
        <textarea
          v-autosize
          rows="1"
          class="msg mono"
          :value="g.commit"
          spellcheck="false"
          :disabled="state.planExcluded.has(g.id)"
          @input="updateGroupCommit(g.id, ($event.target as HTMLTextAreaElement).value)"
        />
        <ul v-if="g.bullets.length" class="bullets muted">
          <li v-for="b in g.bullets" :key="b">{{ b }}</li>
        </ul>
        <ul v-if="open.has(g.id)" class="files mono">
          <li v-for="f in g.files" :key="f">{{ f }}</li>
        </ul>
      </li>
    </ol>

    <p v-if="outsidePlan.length" class="faint note">
      {{ outsidePlan.length }} arquivo(s) alterado(s) depois da análise não estão aqui e ficam para depois.
    </p>

    <template #footer>
      <button class="ghost single" title="Ignorar a divisão e usar a mensagem geral da IA num commit só" @click="useSingleCommit">
        Usar 1 commit só
      </button>
      <span class="grow" />
      <button @click="close">Cancelar</button>
      <button class="primary" :disabled="!n || !!state.busy" @click="commitPlan">
        <Icon name="check" :size="14" /> Criar {{ n }} commit{{ n === 1 ? '' : 's' }}
      </button>
    </template>
  </Modal>
</template>

<style scoped>
.stale {
  display: flex; align-items: center; gap: 8px; margin: -4px 0 0; padding: 8px 10px; border-radius: 8px;
  background: color-mix(in srgb, var(--mod) 14%, transparent); color: var(--mod); font-size: 12.5px;
}
.plan { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; max-height: 58vh; overflow: auto; }
.plan > li {
  border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; background: var(--panel);
  display: flex; flex-direction: column; gap: 6px;
}
.plan > li.off { opacity: 0.5; }
.head { display: flex; align-items: center; gap: 8px; min-width: 0; }
.num {
  width: 20px; height: 20px; border-radius: 50%; background: var(--accent-soft); color: var(--accent);
  font-size: 11px; font-weight: 700; display: inline-flex; align-items: center; justify-content: center; flex: none;
}
.title { min-width: 0; }
.type { font-family: var(--mono); font-size: 10.5px; color: var(--accent); background: var(--accent-soft); padding: 1px 6px; border-radius: 4px; }
.spacer { flex: 1; }
.files-btn { height: 24px; padding: 0 8px; font-size: 12px; color: var(--muted); font-weight: 400; }
.chev { transition: transform 0.12s; }
.chev.open { transform: rotate(90deg); }
.msg { font-size: 12.5px; line-height: 1.5; padding: 5px 8px; background: var(--panel-2); border-color: transparent; overflow: hidden; }
.msg:focus { border-color: var(--accent); background: var(--panel); }
.bullets { margin: 0; padding-left: 18px; font-size: 12.5px; }
.files { margin: 0; padding: 6px 10px; list-style: none; font-size: 11.5px; color: var(--muted); background: var(--panel-2); border-radius: 6px; user-select: text; }
.files li { padding: 1px 0; word-break: break-all; }
.note { margin: 0; font-size: 12px; }
.grow { flex: 1; }
.single { margin-right: auto; }
</style>
