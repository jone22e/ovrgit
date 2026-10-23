<script setup lang="ts">
import { computed } from 'vue'
import { repoIconChoices } from '../repoIconChoices'
import Icon from './Icon.vue'

const props = withDefaults(defineProps<{ icon?: string | null; favicon?: string | null; group?: boolean; size?: number }>(), { size: 16 })
const choice = computed(() => repoIconChoices.find((c) => c.id === props.icon))
</script>

<template>
  <span class="repo-icon" :class="{ chosen: !!choice }" :style="{ width: `${size}px`, height: `${size}px`, color: choice?.color, backgroundColor: choice ? `color-mix(in srgb, ${choice.color} 18%, transparent)` : undefined }">
    <Icon v-if="choice" :name="choice.id" :size="Math.round(size * 0.68)" />
    <img v-else-if="favicon && !group" :src="favicon" alt="" />
    <Icon v-else :name="group ? 'layers' : 'folder'" :size="Math.round(size * 0.82)" />
  </span>
</template>

<style scoped>
.repo-icon { display: inline-grid; place-items: center; flex: none; border-radius: 5px; line-height: 0; color: var(--faint); }
.repo-icon.chosen { border: 1px solid color-mix(in srgb, currentColor 30%, transparent); box-sizing: border-box; }
.repo-icon img { display: block; width: 100%; height: 100%; object-fit: contain; border-radius: 4px; }
</style>
