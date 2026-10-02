<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import type { AgentSnapshot } from '@shared/types'

/**
 * O mascote: uma bolinha com dois olhos que seguem o cursor, no topo da tela ao lado do recorte da câmera,
 * sobre um pedaço preto que se emenda ao recorte. Mostra, pela cara e por um balãozinho, como os agentes estão
 * (trabalhando, esperando você, erro, concluído).
 *
 * A janelinha se abre como uma "ilha" abaixo do recorte: ao passar o mouse, ao clicar (aí com o foco, para o
 * ⌘V chegar) ou quando algo é arrastado por cima. Aberta, mostra o painel dos agentes (quantos em cada
 * situação e as conversas mais urgentes) e a dica do que ele come: arquivos arrastados e o que for colado
 * viram um agente novo, depois de ele engolir. Tudo é proporcional ao raio do corpo, então as caras e as
 * animações são as mesmas fechada e aberta.
 *
 * Leveza: a janela é transparente e cada repintura custa; por isso nada anima o tempo todo (só o piscar, de vez
 * em quando, e as animações passageiras), e o único movimento contínuo (os pontinhos do balão de
 * "trabalhando") anda em poucos quadros por segundo. O cursor chega do processo principal já filtrado, e o
 * painel é HTML parado, sem relógio: redesenha só quando os agentes mudam.
 */
const api = window.ovseer

// ---------- geometria (reage ao tamanho da janela: a ilha cresce e encolhe) ----------
const params = new URLSearchParams(location.search)
/** Altura da barra de menus (= do recorte) */
const BAR = Number(params.get('bar')) || 37
/** Largura do recorte da câmera que o pedaço preto cobre (0: sem recorte, só a cápsula) */
const NOTCH = Number(params.get('notch')) || 0
const size = ref({ w: window.innerWidth, h: window.innerHeight })
/** A ilha está aberta (a janela cresceu para baixo do recorte) */
const expanded = computed(() => size.value.h > BAR + 20)

const geo = computed(() => {
  const W = size.value.w
  const H = size.value.h
  let R: number
  let BR: number
  let CX: number
  let CY: number
  if (expanded.value) {
    // aberta: o corpo grande à esquerda, abaixo do recorte; à direita fica o painel dos agentes
    R = Math.min(36, (H - BAR - 36) / 2)
    BR = Math.round(R * 0.4)
    CX = 16 + 8 + R
    CY = BAR + (H - BAR) / 2 - 4
  } else {
    // fechada: logo à direita do recorte (o balão fica do lado de fora, onde o recorte não o corta)
    R = Number(params.get('r')) || 13
    BR = Number(params.get('br')) || 7
    CX = W / 2 + NOTCH / 2 + 6 + R
    CY = H / 2
  }
  return {
    W,
    H,
    R,
    BR,
    CX,
    CY,
    /** Olhos: distância do centro e tamanho da pílula, em proporção ao corpo */
    EYE_DX: R * 0.35,
    EYE_W: R * 0.28,
    EYE_H: R * 0.56,
    STROKE: Math.max(1.2, R * 0.09),
    /** Balão: fechada, à direita do corpo, longe do recorte; aberta, no alto à esquerda do corpo */
    BX: expanded.value ? CX - R + 6 : CX + R + BR + 2,
    BY: expanded.value ? CY - R + 6 : CY - R * 0.3,
    /** Proporção para as animações que andam em px (pulinho) */
    K: R / 54,
    /** Cantos de baixo do pedaço preto */
    CORNER: expanded.value ? 24 : 10
  }
})

/** Algo está sendo arrastado por cima dele */
const over = ref(false)

// ---------- cursor: olhar e inclinação ----------
const cursor = ref({ x: 0, y: -1000 })
const look = computed(() => {
  const { CX, CY, R } = geo.value
  const dx = cursor.value.x - CX
  const dy = cursor.value.y - CY
  const d = Math.hypot(dx, dy) || 1
  // o olhar satura perto; longe, aponta na direção. Com algo arrastado por cima, ele acompanha o objeto com
  // mais vontade (olhos e inclinação maiores), como quem espera a hora de soltar
  const k = Math.min(1, d / (2.6 * R)) * (over.value ? 1.5 : 1)
  const ux = dx / d
  const uy = dy / d
  return { x: ux * 0.167 * R * k, y: uy * 0.13 * R * k, tilt: ux * 4 * k, dx: ux * 0.056 * R * k, dy: uy * 0.037 * R * k }
})

// ---------- humor, pelos agentes ----------
type Mood = 'idle' | 'working' | 'waiting' | 'error' | 'done'
const snaps = ref<AgentSnapshot[]>([])
const happy = ref(false)
let happyTimer: ReturnType<typeof setTimeout> | null = null
function beHappy(ms: number) {
  happy.value = true
  if (happyTimer) clearTimeout(happyTimer)
  happyTimer = setTimeout(() => (happy.value = false), ms)
}
const mood = computed<Mood>(() => {
  const s = snaps.value
  if (s.some((a) => a.status === 'error')) return 'error'
  if (s.some((a) => a.status === 'waiting')) return 'waiting'
  if (happy.value) return 'done'
  if (s.some((a) => a.status === 'live')) return 'working'
  return 'idle'
})
let doneBefore = new Set<string>()
function onSnaps(list: AgentSnapshot[]) {
  // alguém acabou de concluir: cara feliz por uns segundos
  const doneNow = new Set(list.filter((a) => a.status === 'done').map((a) => a.uid))
  if ([...doneNow].some((u) => !doneBefore.has(u)) && snaps.value.length) beHappy(4000)
  doneBefore = doneNow
  snaps.value = list
}

// ---------- painel da ilha: quantos agentes em cada situação e as conversas mais urgentes ----------
const counts = computed(() => {
  const c = { live: 0, waiting: 0, error: 0, done: 0 }
  for (const a of snaps.value) if (a.status in c) c[a.status as keyof typeof c]++
  return c
})
const ORDER: Record<string, number> = { waiting: 0, error: 1, live: 2, done: 3, idle: 4 }
const urgent = computed(() => [...snaps.value].sort((a, b) => (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9) || a.since - b.since).slice(0, 3))
const STATUS_LABEL: Record<string, string> = { live: 'trabalhando', waiting: 'esperando você', error: 'erro', done: 'concluído', idle: 'sem conversa' }
function ago(ms: number): string {
  const sec = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (sec < 60) return 'agora'
  const m = Math.round(sec / 60)
  if (m < 60) return `${m} min`
  return `${Math.floor(m / 60)} h`
}
function openAgent(uid: string) {
  api.agentShow(uid).catch(() => undefined)
  api.buddyExpand(false)
}

// ---------- abrir e fechar a ilha ----------
/**
 * Passar o mouse abre a ilha (como no NotchNook), sem tomar o foco; sair fecha. Um clique prende a ilha aberta
 * e dá o foco (para o ⌘V); aí só Esc, outro clique ou perder o foco fecham.
 */
const pinned = ref(false)
watch(expanded, (on) => !on && (pinned.value = false))
let hoverTimer: ReturnType<typeof setTimeout> | null = null
function onEnter() {
  if (expanded.value) return
  if (hoverTimer) clearTimeout(hoverTimer)
  hoverTimer = setTimeout(() => api.buddyExpand(true), 350)
}
function onLeave() {
  if (hoverTimer) clearTimeout(hoverTimer)
  hoverTimer = null
  if (!expanded.value || over.value || pinned.value) return
  hoverTimer = setTimeout(() => {
    if (expanded.value && !over.value && !anim.value && !pinned.value) api.buddyExpand(false)
  }, 300)
}

// ---------- movimentos contínuos, em poucos quadros por segundo ----------
// Uma animação CSS infinita em SVG repinta a janela transparente a cada quadro (60 por segundo, mesmo com
// `steps()`), e isso pesava. Em vez disso, um relógio lento troca o quadro: os pontinhos de "trabalhando"
// acendem um de cada vez, e com algo arrastado por cima ele dá pulinhos de expectativa. Só roda enquanto há
// algo para mostrar; o balão de "esperando" fica parado.
const phase = ref(0)
let phaseTimer: ReturnType<typeof setInterval> | null = null
watch(
  () => mood.value === 'working' || over.value,
  (on) => {
    if (phaseTimer) clearInterval(phaseTimer)
    phaseTimer = on ? setInterval(() => (phase.value = (phase.value + 1) % 3), 400) : null
  },
  { immediate: true }
)

// ---------- animações passageiras ----------
type Anim = '' | 'slap' | 'eat' | 'gulp'
const anim = ref<Anim>('')
const blink = ref(false)
let blinkTimer: ReturnType<typeof setTimeout> | null = null
function scheduleBlink() {
  blinkTimer = setTimeout(() => {
    blink.value = true
    setTimeout(() => (blink.value = false), 140)
    scheduleBlink()
  }, 2500 + Math.random() * 4000)
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** O objeto que ele come: onde está (coordenadas da página = do SVG) e o tamanho; some quando entra no corpo */
const bite = ref<{ x: number; y: number; s: number } | null>(null)

/**
 * Engolir, sem boca (o personagem é só os olhos): os olhos arregalam e o objeto voa até o corpo e entra nele,
 * encolhendo (260 ms); com os olhos fechados o corpo engole (achata, estufa e assenta, 420 ms); depois ele fica
 * feliz um instante e a ilha encolhe. `from` é de onde o objeto vem (onde foi solto); sem isso, de cima da
 * cabeça (o que foi colado).
 */
async function eat(run: () => Promise<unknown>, from?: { x: number; y: number }) {
  if (anim.value === 'eat' || anim.value === 'gulp') return
  const g = geo.value
  anim.value = 'eat'
  bite.value = { x: from?.x ?? g.CX, y: from?.y ?? g.CY - g.R * 1.7, s: 1 }
  // no quadro seguinte o objeto parte para o corpo (a transição faz o voo)
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  bite.value = { x: g.CX, y: g.CY + g.R * 0.3, s: 0 }
  await wait(260)
  bite.value = null
  anim.value = 'gulp'
  await wait(420)
  anim.value = ''
  beHappy(1800)
  await wait(300)
  api.buddyExpand(false)
  try {
    await run()
  } catch (e) {
    console.error('Mascote:', e)
  }
}
function slap() {
  if (anim.value) return
  anim.value = 'slap'
  setTimeout(() => (anim.value = ''), 600)
}

// ---------- olhos: forma conforme o humor ----------
const eyeShape = computed(() => {
  if (anim.value === 'gulp' || blink.value) return 'closed'
  if (over.value || anim.value === 'eat') return 'wide'
  if (mood.value === 'done') return 'happy'
  if (mood.value === 'error') return 'cross'
  return 'pill'
})

// ---------- clicar (abre e prende a ilha; outro clique fecha), clique duplo (abre o app), menu ----------
let press = false
function onDown(e: MouseEvent) {
  if (e.button === 0) press = true
}
function onUp() {
  if (!press) return
  press = false
  if (pinned.value) api.buddyExpand(false)
  else {
    pinned.value = true
    api.buddyFocus()
  }
}

// ---------- comer: arquivos arrastados e o que for colado ----------
/**
 * Enquanto algo é arrastado por cima, os `dragover` chegam de tempos em tempos (não a cada quadro), e abrir a
 * ilha redimensiona a janela debaixo do arrasto, o que faz o sistema mandar um "saiu" e logo um "entrou".
 * Por isso o "saiu" tem uma carência: só vale se nada chegar por um bom tempo; senão a ilha abria e fechava
 * sem parar. E, se os eventos pararem de vez (o arrasto terminou fora), um vigia encerra.
 */
let leaveTimer: ReturnType<typeof setTimeout> | null = null
let overTimer: ReturnType<typeof setTimeout> | null = null
const LEAVE_GRACE_MS = 700
const OVER_SILENCE_MS = 2000
function arrive() {
  if (leaveTimer) clearTimeout(leaveTimer)
  leaveTimer = null
  if (!over.value) {
    over.value = true
    if (!expanded.value) api.buddyExpand(true)
  }
  if (overTimer) clearTimeout(overTimer)
  overTimer = setTimeout(left, OVER_SILENCE_MS)
}
function onDragOver(e: DragEvent) {
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
  arrive()
}
function onDragLeave(e: DragEvent) {
  // entre elementos da própria página não é sair
  if (e.relatedTarget instanceof Node && (e.currentTarget as Node).contains(e.relatedTarget)) return
  if (leaveTimer) clearTimeout(leaveTimer)
  leaveTimer = setTimeout(left, LEAVE_GRACE_MS)
}
function left() {
  if (overTimer) clearTimeout(overTimer)
  if (leaveTimer) clearTimeout(leaveTimer)
  overTimer = null
  leaveTimer = null
  if (!over.value) return
  over.value = false
  // nada foi solto: encolhe (a não ser que esteja engolindo ou presa por clique)
  if (expanded.value && !anim.value && !pinned.value) api.buddyExpand(false)
}
function onDrop(e: DragEvent) {
  e.preventDefault()
  if (overTimer) clearTimeout(overTimer)
  if (leaveTimer) clearTimeout(leaveTimer)
  overTimer = null
  leaveTimer = null
  over.value = false
  const paths = [...(e.dataTransfer?.files ?? [])].map((f) => api.filePath(f)).filter(Boolean)
  if (!paths.length) {
    if (!pinned.value) api.buddyExpand(false)
    return
  }
  eat(() => api.buddyFiles(paths), { x: e.clientX, y: e.clientY })
}
function onKey(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'v') {
    e.preventDefault()
    eat(async () => {
      const r = await api.buddyPaste()
      if (!r.ate) slap()
    })
  } else if (e.key === 'Escape' && expanded.value) api.buddyExpand(false)
}

const offs: (() => void)[] = []
const onResize = () => (size.value = { w: window.innerWidth, h: window.innerHeight })
onMounted(() => {
  offs.push(api.onBuddyCursor((p) => (cursor.value = p)))
  offs.push(api.onAgentSnapshots(onSnaps))
  api.agentSnapshots().then(onSnaps).catch(() => undefined)
  scheduleBlink()
  window.addEventListener('keydown', onKey)
  window.addEventListener('mouseup', onUp)
  window.addEventListener('resize', onResize)
})
onUnmounted(() => {
  offs.forEach((f) => f())
  if (blinkTimer) clearTimeout(blinkTimer)
  if (happyTimer) clearTimeout(happyTimer)
  if (phaseTimer) clearInterval(phaseTimer)
  if (overTimer) clearTimeout(overTimer)
  if (leaveTimer) clearTimeout(leaveTimer)
  if (hoverTimer) clearTimeout(hoverTimer)
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('mouseup', onUp)
  window.removeEventListener('resize', onResize)
})
</script>

<template>
  <div
    class="stage"
    :class="[mood, anim, { over, expanded }]"
    :style="{ width: `${geo.W}px`, height: `${geo.H}px`, '--k': geo.K }"
    @dragenter.prevent="arrive"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
    @mouseenter="onEnter"
    @mouseleave="onLeave"
    @contextmenu.prevent="api.buddyMenu()"
  >
    <svg :width="geo.W" :height="geo.H" :viewBox="`0 0 ${geo.W} ${geo.H}`" @mousedown="onDown" @dblclick="api.buddyOpenMain()">
      <defs>
        <linearGradient id="skin" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#e9e9ea" />
          <stop offset="0.55" stop-color="#c9ced6" />
          <stop offset="1" stop-color="#7fa6cf" />
        </linearGradient>
        <radialGradient id="shine" cx="0.35" cy="0.25" r="0.6">
          <stop offset="0" stop-color="#fff" stop-opacity="0.55" />
          <stop offset="1" stop-color="#fff" stop-opacity="0" />
        </radialGradient>
      </defs>
      <!-- o pedaço preto que se emenda ao recorte da câmera, com os cantos de baixo arredondados -->
      <path class="plate" :d="`M0 0 H${geo.W} V${geo.H - geo.CORNER} Q${geo.W} ${geo.H} ${geo.W - geo.CORNER} ${geo.H} H${geo.CORNER} Q0 ${geo.H} 0 ${geo.H - geo.CORNER} Z`" />
      <!-- corpo: inclina e se desloca um pouco na direção do cursor -->
      <g class="body" :style="{ transform: `translate(${look.dx}px, ${look.dy - (over && phase % 2 ? 5 * geo.K : 0)}px) rotate(${look.tilt}deg)`, transformOrigin: `${geo.CX}px ${geo.CY}px` }">
        <circle :cx="geo.CX" :cy="geo.CY" :r="geo.R" fill="url(#skin)" />
        <circle :cx="geo.CX" :cy="geo.CY" :r="geo.R" fill="url(#shine)" />
        <!-- olhos -->
        <g class="eyes" :style="{ transform: `translate(${look.x}px, ${look.y}px)` }">
          <g v-for="side in [-1, 1]" :key="side" class="eye" :class="eyeShape" :style="{ transformOrigin: `${geo.CX + side * geo.EYE_DX}px ${geo.CY}px` }">
            <template v-if="eyeShape === 'happy'">
              <path
                :d="`M ${geo.CX + side * geo.EYE_DX - geo.R * 0.17} ${geo.CY + geo.R * 0.07} q ${geo.R * 0.17} ${-geo.R * 0.26} ${geo.R * 0.33} 0`"
                fill="none"
                stroke="#1b1d22"
                :stroke-width="geo.STROKE"
                stroke-linecap="round"
              />
            </template>
            <template v-else-if="eyeShape === 'cross'">
              <path
                :d="`M ${geo.CX + side * geo.EYE_DX - geo.R * 0.13} ${geo.CY - geo.R * 0.13} l ${geo.R * 0.26} ${geo.R * 0.26} M ${geo.CX + side * geo.EYE_DX + geo.R * 0.13} ${geo.CY - geo.R * 0.13} l ${-geo.R * 0.26} ${geo.R * 0.26}`"
                fill="none"
                stroke="#1b1d22"
                :stroke-width="geo.STROKE"
                stroke-linecap="round"
              />
            </template>
            <template v-else-if="eyeShape === 'wide'">
              <circle :cx="geo.CX + side * geo.EYE_DX" :cy="geo.CY" :r="geo.R * 0.22" fill="#1b1d22" />
              <circle :cx="geo.CX + side * geo.EYE_DX - geo.R * 0.074" :cy="geo.CY - geo.R * 0.074" :r="geo.R * 0.065" fill="#fff" />
            </template>
            <rect v-else :x="geo.CX + side * geo.EYE_DX - geo.EYE_W / 2" :y="geo.CY - geo.EYE_H / 2" :width="geo.EYE_W" :height="geo.EYE_H" :rx="geo.EYE_W / 2" fill="#1b1d22" />
          </g>
        </g>
      </g>
      <!-- o objeto que ele come: um arquivo, que voa até o corpo e some dentro dele -->
      <g v-if="bite" class="bite" :style="{ transform: `translate(${bite.x}px, ${bite.y}px) scale(${bite.s})` }">
        <path :d="`M ${-geo.R * 0.22} ${-geo.R * 0.3} h ${geo.R * 0.3} l ${geo.R * 0.14} ${geo.R * 0.14} v ${geo.R * 0.46} h ${-geo.R * 0.44} z`" fill="#f4f5f7" stroke="#9aa3b2" :stroke-width="Math.max(1, geo.R * 0.03)" stroke-linejoin="round" />
        <path :d="`M ${-geo.R * 0.12} ${geo.R * 0.0} h ${geo.R * 0.24} M ${-geo.R * 0.12} ${geo.R * 0.1} h ${geo.R * 0.24} M ${-geo.R * 0.12} ${geo.R * 0.2} h ${geo.R * 0.16}`" stroke="#9aa3b2" :stroke-width="Math.max(1, geo.R * 0.035)" stroke-linecap="round" />
      </g>
      <!-- balão: o que os agentes estão fazendo -->
      <g v-if="mood === 'working'" class="bubble working" :style="{ transformOrigin: `${geo.BX}px ${geo.BY}px` }">
        <circle :cx="geo.BX" :cy="geo.BY" :r="geo.BR" fill="#2f7cf6" />
        <circle v-for="i in 3" :key="i" :cx="geo.BX + (i - 2) * geo.BR * 0.47" :cy="geo.BY" :r="geo.BR * 0.18" fill="#fff" :opacity="phase % 3 === i - 1 ? 1 : 0.35" />
      </g>
      <g v-else-if="mood === 'waiting'" class="bubble waiting" :style="{ transformOrigin: `${geo.BX}px ${geo.BY}px` }">
        <circle :cx="geo.BX" :cy="geo.BY" :r="geo.BR" fill="#f08a2d" />
        <text :x="geo.BX" :y="geo.BY + geo.BR * 0.42" text-anchor="middle" :font-size="geo.BR * 1.3" font-weight="700" fill="#fff" font-family="system-ui, sans-serif">?</text>
      </g>
      <g v-else-if="mood === 'error'" class="bubble error" :style="{ transformOrigin: `${geo.BX}px ${geo.BY}px` }">
        <circle :cx="geo.BX" :cy="geo.BY" :r="geo.BR" fill="#e0443e" />
        <text :x="geo.BX" :y="geo.BY + geo.BR * 0.42" text-anchor="middle" :font-size="geo.BR * 1.3" font-weight="700" fill="#fff" font-family="system-ui, sans-serif">!</text>
      </g>
    </svg>
    <!-- ilha aberta: o painel dos agentes, à direita do mascote -->
    <div v-if="expanded" class="panel" :style="{ left: `${geo.CX + geo.R + 18}px`, top: `${BAR + 8}px`, bottom: '8px' }">
      <div v-if="!snaps.length" class="none">
        <strong>Nenhum agente aberto</strong>
        <small>Solte um arquivo aqui, ou cole com ⌘V, para abrir um.</small>
      </div>
      <template v-else>
        <div class="counts">
          <span v-if="counts.live" class="c live"><i />{{ counts.live }} trabalhando</span>
          <span v-if="counts.waiting" class="c waiting"><i />{{ counts.waiting }} esperando você</span>
          <span v-if="counts.error" class="c error"><i />{{ counts.error }} com erro</span>
          <span v-if="counts.done" class="c done"><i />{{ counts.done }} {{ counts.done === 1 ? 'concluído' : 'concluídos' }}</span>
          <span v-if="!counts.live && !counts.waiting && !counts.error && !counts.done" class="c idle"><i />{{ snaps.length }} sem conversa</span>
        </div>
        <button v-for="a in urgent" :key="a.uid" type="button" class="row" :title="a.title" @click="openAgent(a.uid)">
          <i :class="a.status" />
          <span class="t">{{ a.title }}</span>
          <span class="s">{{ a.status === 'waiting' && a.ask ? 'esperando resposta' : a.status === 'live' && a.activity ? a.activity : STATUS_LABEL[a.status] }}</span>
          <span class="w">{{ ago(a.since) }}</span>
        </button>
        <small v-if="snaps.length > urgent.length" class="more">+{{ snaps.length - urgent.length }} no Ovseer</small>
      </template>
      <small class="foot" :class="{ on: over }">{{ over ? 'Solte aqui' : 'Solte um arquivo, ou cole com ⌘V, para abrir um agente' }}</small>
    </div>
  </div>
</template>

<style scoped>
.stage { position: relative; cursor: default; }
svg { display: block; overflow: visible; }
.plate { fill: #000; }

/* painel da ilha */
.panel { position: absolute; right: 16px; display: flex; flex-direction: column; gap: 3px; min-width: 0; font: 12px system-ui, -apple-system, sans-serif; color: rgba(255, 255, 255, 0.9); }
.panel .none { display: flex; flex-direction: column; gap: 4px; margin: auto 0; }
.panel .none strong { font-size: 13px; }
.panel .none small, .panel .foot, .panel .more { font-size: 11px; color: rgba(255, 255, 255, 0.5); }
.counts { display: flex; flex-wrap: wrap; gap: 4px 10px; margin-bottom: 3px; font-size: 11.5px; color: rgba(255, 255, 255, 0.75); }
.c { display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; }
.c i, .row i { width: 7px; height: 7px; border-radius: 50%; background: rgba(255, 255, 255, 0.35); flex: none; }
.c.live i, .row i.live { background: #2f7cf6; }
.c.waiting i, .row i.waiting { background: #f08a2d; }
.c.error i, .row i.error { background: #e0443e; }
.c.done i, .row i.done { background: #3ac36b; }
.row { display: flex; align-items: center; gap: 7px; height: 24px; padding: 0 6px; margin: 0 -6px; border: 0; border-radius: 7px; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; min-width: 0; }
.row:hover { background: rgba(255, 255, 255, 0.1); }
.row .t { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; font-size: 12px; }
.row .s { max-width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: rgba(255, 255, 255, 0.55); font-size: 11px; }
.row .w { flex: none; color: rgba(255, 255, 255, 0.4); font-size: 11px; font-variant-numeric: tabular-nums; }
.panel .foot { margin-top: auto; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.panel .foot.on { color: #fff; }

/* o mascote */
.body { transition: transform 0.12s ease-out; }
.eyes { transition: transform 0.1s ease-out; }
.eye { transition: transform 0.12s ease-in-out; }
.eye.closed { transform: scaleY(0.08); }
.working .eye.pill { transform: scaleY(0.78); }
.waiting .eye.pill { transform: scaleY(1.12) scaleX(1.1); }

/* alguém arrastando algo por cima: cresce um pouco, como quem abre a boca */
.over .body { scale: 1.08; }

/* o objeto voa até o corpo e entra nele, encolhendo */
.bite { transition: transform 0.26s ease-in; }

/* engolir: o corpo achata na mordida, estufa quando desce e assenta */
.gulp .body { animation: gulp 0.42s ease-in-out; }
@keyframes gulp {
  0% { scale: 1 1; }
  25% { scale: 1.12 0.88; }
  55% { scale: 0.94 1.1; }
  80% { scale: 1.03 0.97; }
  100% { scale: 1 1; }
}

/* tapa: balança */
.slap .body { animation: wobble 0.6s ease-in-out; }
@keyframes wobble {
  0%, 100% { rotate: 0deg; }
  20% { rotate: -12deg; }
  45% { rotate: 9deg; }
  70% { rotate: -5deg; }
  85% { rotate: 2deg; }
}

/* concluído: pulinho */
.done .body { animation: hop 0.7s ease-out; }
@keyframes hop { 0%, 100% { translate: 0 0; } 35% { translate: 0 calc(-14px * var(--k)); } 60% { translate: 0 0; } 80% { translate: 0 calc(-5px * var(--k)); } }

/* balões: aparecem com um pulo (o resto é pelo relógio lento) */
.bubble { animation: pop 0.25s ease-out; }
@keyframes pop { from { scale: 0.4; opacity: 0; } to { scale: 1; opacity: 1; } }
</style>
