<script setup lang="ts">
import logo from '../assets/logo.png'
import { onMounted } from 'vue'
import { loadProject, loadProjectIcon, openProject, projectIcons, state } from '../store'
import Icon from './Icon.vue'

onMounted(() => state.settings?.recentProjects.forEach(loadProjectIcon))
</script>

<template>
  <div class="welcome">
    <img :src="logo" alt="" class="hero" />
    <h1>OvrGit</h1>
    <p class="muted">Git que entende o que você fez. Commit, Criar Feature, Baixar e Enviar.</p>
    <button class="primary big" :disabled="state.busy === 'load'" @click="openProject">
      <span v-if="state.busy === 'load'" class="spinner" />
      <Icon v-else name="folder" />
      Abrir projeto
    </button>
    <button class="big ghost-lite" @click="state.showClone = true">
      <Icon name="down" />
      Clonar repositório
    </button>

    <section v-if="state.settings?.recentProjects.length" class="recent">
      <h2>Recentes</h2>
      <button
        v-for="p in state.settings.recentProjects"
        :key="p"
        class="ghost recent-item"
        :title="p"
        @click="loadProject(p)"
      >
        <img v-if="projectIcons.get(p)" :src="projectIcons.get(p)!" class="favicon" alt="" />
        <Icon v-else name="folder" />
        <span class="name">{{ p.split(/[\\/]/).pop() }}</span>
        <span class="path faint ellipsis">{{ p }}</span>
      </button>
    </section>
  </div>
</template>

<style scoped>
.welcome {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 32px;
  overflow: auto;
}
.hero { width: 120px; height: 120px; margin-bottom: -8px; }
h1 { margin: 0; font-size: 26px; letter-spacing: -0.02em; }
p { margin: 0 0 12px; }
.big { height: 40px; padding: 0 22px; font-size: 14px; }
.ghost-lite { margin-top: -2px; }
.recent { width: min(520px, 100%); margin-top: 28px; display: flex; flex-direction: column; gap: 2px; }
h2 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--faint); margin: 0 0 6px 10px; }
.recent-item { justify-content: flex-start; height: 38px; gap: 10px; }
.name { font-weight: 600; }
.favicon { width: 16px; height: 16px; object-fit: contain; border-radius: 3px; }
.path { font-size: 12px; font-weight: 400; min-width: 0; }
</style>
