<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { loadSourceFiles, openSource, state, toast } from '../store'
import FileIcon from './FileIcon.vue'
import Icon from './Icon.vue'

/**
 * Menu do botão direito na árvore de arquivos: cria, na pasta clicada, os arquivos que costumam faltar
 * (.env, .env.prod, .env.example…) e só mostra os que ainda não existem nela. "Novo arquivo…" pede o nome.
 * Os .env nascem do .env.example da pasta, quando há um; o .env.example nasce do .env, sem os valores.
 */
const props = defineProps<{ x: number; y: number; dir: string; target?: string }>()
const emit = defineEmits<{ close: [] }>()
const api = window.ovseer

const join = (name: string) => (props.dir ? `${props.dir}/${name}` : name)
/** Já existe na pasta? (sem diferenciar maiúsculas: "readme.md" conta como README.md) */
const exists = (name: string) => {
  const want = join(name).toLowerCase()
  return state.sourceList.some((p) => p.toLowerCase() === want)
}
const example = computed(() => ['.env.example', '.env.sample', '.env.dist'].find(exists) ?? null)

/** Só as chaves, sem os valores (para o .env.example, que vai para o git) */
const stripValues = (text: string) =>
  text
    .split(/\r?\n/)
    .map((l) => l.replace(/^(\s*(?:export\s+)?[A-Za-z_][\w.-]*\s*=).*$/, '$1'))
    .join('\n')

interface Template {
  name: string
  hint: string
  content: () => Promise<string>
}
const fromExample = async () => (example.value ? ((await api.readSource(join(example.value))).content ?? '') : '')
const folder = computed(() => (props.dir || state.repo?.root || '').split(/[\\/]/).pop() ?? '')
const TEMPLATES = computed<Template[]>(() => [
  { name: '.env', hint: example.value ? `a partir do ${example.value}` : 'variáveis de ambiente', content: fromExample },
  { name: '.env.local', hint: example.value ? `a partir do ${example.value}` : 'só nesta máquina', content: fromExample },
  { name: '.env.dev', hint: example.value ? `a partir do ${example.value}` : 'desenvolvimento', content: fromExample },
  { name: '.env.prod', hint: example.value ? `a partir do ${example.value}` : 'produção', content: fromExample },
  {
    name: '.env.example',
    hint: exists('.env') ? 'chaves do .env, sem os valores' : 'modelo que vai para o git',
    content: async () => (exists('.env') ? stripValues((await api.readSource(join('.env'))).content ?? '') : '')
  },
  { name: '.gitignore', hint: 'o que o git não deve levar', content: async () => 'node_modules/\ndist/\n.DS_Store\n\n.env\n.env.*\n!.env.example\n' },
  { name: 'README.md', hint: 'apresentação do projeto', content: async () => `# ${folder.value}\n\n` },
  {
    name: '.editorconfig',
    hint: 'padrão de indentação',
    content: async () => 'root = true\n\n[*]\ncharset = utf-8\nend_of_line = lf\nindent_style = space\nindent_size = 2\ninsert_final_newline = true\ntrim_trailing_whitespace = true\n'
  }
])
const available = computed(() => TEMPLATES.value.filter((t) => !exists(t.name)))

async function create(name: string, content: string) {
  const rel = join(name.trim().replace(/^\/+/, ''))
  try {
    const r = await api.createSource(rel, content)
    emit('close')
    await loadSourceFiles()
    openSource(r.path, true)
    // .env com senhas indo para o repositório: avisa (o .env.example é para ir mesmo)
    const base = rel.slice(rel.lastIndexOf('/') + 1)
    if (/^\.env/.test(base) && !/\.(example|sample|dist)$/.test(base) && !r.ignored)
      state.error = `${rel} não está no .gitignore: se tiver senhas, elas podem acabar indo para o repositório. Adicione ".env*" ao .gitignore.`
    else toast(`${rel} criado.`)
  } catch (e) {
    state.error = String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
  }
}
async function pick(t: Template) {
  create(t.name, await t.content())
}

// ---------- "Novo arquivo…": vira um campo para o nome ----------
const asking = ref(false)
const fileName = ref('')
const input = ref<HTMLInputElement>()
async function ask() {
  asking.value = true
  await nextTick()
  input.value?.focus()
}
function submit() {
  const n = fileName.value.trim()
  if (!n) return
  if (exists(n)) return void (state.error = `${join(n)} já existe.`)
  create(n, '')
}

function copyPath() {
  if (props.target) navigator.clipboard.writeText(props.target)
  toast('Caminho copiado.')
  emit('close')
}

// ---------- posição e fechamento ----------
const el = ref<HTMLElement>()
const pos = ref({ left: props.x, top: props.y })
onMounted(() => {
  // não deixa o menu sair da janela
  const r = el.value!.getBoundingClientRect()
  pos.value = { left: Math.min(props.x, window.innerWidth - r.width - 8), top: Math.min(props.y, window.innerHeight - r.height - 8) }
  document.addEventListener('mousedown', onDoc, true)
  document.addEventListener('keydown', onEsc, true)
})
onUnmounted(() => {
  document.removeEventListener('mousedown', onDoc, true)
  document.removeEventListener('keydown', onEsc, true)
})
const onDoc = (e: MouseEvent) => {
  if (!el.value?.contains(e.target as Node)) emit('close')
}
const onEsc = (e: KeyboardEvent) => {
  if (e.key === 'Escape') emit('close')
}
</script>

<template>
  <div ref="el" class="ctx" :style="{ left: `${pos.left}px`, top: `${pos.top}px` }" @contextmenu.prevent>
    <p class="where faint"><Icon name="folder" :size="12" /> {{ dir || 'raiz do projeto' }}</p>
    <form v-if="asking" class="ask" @submit.prevent="submit">
      <input ref="input" v-model="fileName" type="text" placeholder="nome.ext (ou pasta/nome.ext)" spellcheck="false" />
      <button class="small primary" :disabled="!fileName.trim()">Criar</button>
    </form>
    <template v-else>
      <button v-for="t in available" :key="t.name" class="item" @click="pick(t)">
        <FileIcon :path="t.name" :size="15" />
        <span class="nm">Criar {{ t.name }}</span>
        <small class="faint">{{ t.hint }}</small>
      </button>
      <div v-if="available.length" class="sep" />
      <button class="item" @click="ask"><Icon name="plus" :size="14" /> <span class="nm">Novo arquivo…</span></button>
      <button v-if="target" class="item" @click="copyPath"><Icon name="clipboard" :size="14" /> <span class="nm">Copiar caminho</span></button>
    </template>
  </div>
</template>

<style scoped>
.ctx {
  position: fixed; z-index: 60; min-width: 260px; max-width: 360px; padding: 4px;
  background: var(--panel); border: 1px solid var(--border); border-radius: 9px; box-shadow: 0 12px 40px rgba(0, 0, 0, 0.3);
}
.where { display: flex; align-items: center; gap: 6px; margin: 0; padding: 5px 8px 6px; font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.item {
  display: flex; align-items: center; gap: 8px; width: 100%; height: 28px; padding: 0 8px; border: 0; border-radius: 6px;
  background: transparent; color: var(--text); font-size: 12.5px; text-align: left; justify-content: flex-start;
}
.item:hover { background: var(--accent-soft); }
.nm { white-space: nowrap; }
.item small { margin-left: auto; padding-left: 12px; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sep { height: 1px; margin: 4px 6px; background: var(--border); }
.ask { display: flex; gap: 6px; padding: 2px 4px 4px; }
.ask input { flex: 1; min-width: 0; height: 28px; font-size: 12.5px; }
.ask button { height: 28px; padding: 0 10px; }
</style>
