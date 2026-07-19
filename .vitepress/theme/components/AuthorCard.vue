<script setup lang="ts">
import { computed } from 'vue'
import * as memberRegistry from '../../../public/member_list/members'

type Member = {
  id?: string
  name: string
  avatar?: string
  title?: string
  desc?: string
  description?: string
  links?: Array<{ icon?: string; link: string }>
}

const props = defineProps<{ author: string }>()
const members = memberRegistry as unknown as Record<string, Member>
const member = computed(() => Object.values(members).find((candidate) => candidate.name === props.author || candidate.id === props.author))
</script>

<template>
  <article v-if="member" class="pyro-author-card">
    <img v-if="member.avatar" class="pyro-author-avatar" :src="member.avatar" :alt="member.name" />
    <div v-else class="pyro-author-avatar pyro-author-avatar-placeholder" />
    <div class="pyro-author-body">
      <strong>{{ member.name }}</strong>
      <div v-if="member.title" class="pyro-author-title">{{ member.title }}</div>
      <p v-if="member.desc || member.description">{{ member.desc || member.description }}</p>
      <div v-if="member.links?.length" class="pyro-author-links">
        <a v-for="link in member.links" :key="link.link" :href="link.link" target="_blank" rel="noreferrer">{{ link.icon || 'link' }}</a>
      </div>
    </div>
  </article>
  <div v-else class="pyro-author-error">Unknown author: {{ author }}</div>
</template>

<style scoped>
.pyro-author-card {
  display: flex;
  gap: 14px;
  align-items: flex-start;
  margin: 20px 0;
  padding: 16px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  background: var(--vp-c-bg-soft);
}

.pyro-author-avatar {
  width: 56px;
  height: 56px;
  flex: 0 0 auto;
  border-radius: 50%;
  object-fit: cover;
  background: var(--vp-c-bg-mute);
}

.pyro-author-avatar-placeholder {
  background: linear-gradient(135deg, #42d392, #647eff);
}

.pyro-author-body strong {
  display: block;
  color: var(--vp-c-text-1);
}

.pyro-author-title,
.pyro-author-body p {
  margin: 2px 0;
  color: var(--vp-c-text-2);
  font-size: 0.9em;
}

.pyro-author-links {
  display: flex;
  gap: 10px;
  margin-top: 6px;
  font-size: 0.85em;
}

.pyro-author-error {
  margin: 16px 0;
  padding: 10px 12px;
  border: 1px solid var(--vp-c-danger-1);
  border-radius: 8px;
  color: var(--vp-c-danger-1);
  background: var(--vp-c-danger-soft);
}
</style>
