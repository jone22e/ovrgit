<script setup lang="ts">
import { computed } from 'vue'
import { repoIconChoices } from '../repoIconChoices'
import Icon from './Icon.vue'

const props = withDefaults(defineProps<{ icon?: string | null; favicon?: string | null; group?: boolean; size?: number }>(), { size: 16 })
const choice = computed(() => repoIconChoices.find((c) => c.id === props.icon))
</script>

<template>
  <span class="repo-icon" :class="{ chosen: !!choice, compact: size < 20 }" :style="{ width: `${size}px`, height: `${size}px`, '--icon-color': choice?.color }">
    <Icon v-if="choice" :name="choice.id" :size="Math.round(size * 0.7)" />
    <img v-else-if="favicon && !group" :src="favicon" alt="" />
    <Icon v-else :name="group ? 'layers' : 'folder'" :size="Math.round(size * 0.82)" />
  </span>
</template>

<style scoped>
.repo-icon { display: inline-grid; place-items: center; flex: none; border-radius: 7px; line-height: 0; color: var(--faint); }
.repo-icon.chosen { color: #fff; background: var(--icon-color); box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.22), 0 1px 2px rgba(0, 0, 0, 0.2); }
.repo-icon.chosen :deep(svg) { stroke-width: 2.3; }
.repo-icon.compact { border-radius: 4px; }
.repo-icon.compact.chosen { box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.18); }
.repo-icon img { display: block; width: 100%; height: 100%; object-fit: contain; border-radius: 4px; }
</style>
