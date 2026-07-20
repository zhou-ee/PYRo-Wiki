<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { withBase } from 'vitepress'

interface RecentUpdateEntry {
  title: string
  url: string
  file: string
  section: string
  lastModified: number
}

const recentData = ref<RecentUpdateEntry[]>([])

onMounted(async () => {
  try {
    const res = await fetch(withBase('/recent-updates.json'))
    if (res.ok) {
      recentData.value = await res.json()
    }
  } catch {
    // JSON file may not exist yet (e.g., first dev startup)
  }
})

function formatDate(ts: number): string {
  const d = new Date(ts)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}
</script>

<template>
  <div v-if="recentData.length" class="recent-section">
    <div class="recent-container">
      <h2 class="recent-heading">最近更新</h2>
      <p class="recent-subtitle">以下是近期修改或新增的文档</p>

      <div class="recent-list">
        <a
          v-for="item in recentData"
          :key="item.file"
          :href="withBase(item.url)"
          class="recent-row"
        >
          <svg class="recent-row-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
            <line x1="16" y1="13" x2="8" y2="13"/>
            <line x1="16" y1="17" x2="8" y2="17"/>
            <polyline points="10 9 9 9 8 9"/>
          </svg>

          <div class="recent-row-main">
            <span class="recent-row-title">{{ item.title }}</span>
            <span v-if="item.section" class="recent-row-path">{{ item.section }}</span>
          </div>

          <span class="recent-row-date">{{ formatDate(item.lastModified) }}</span>
        </a>
      </div>
    </div>
  </div>
</template>
