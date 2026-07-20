import type { App, Component } from 'vue'
import AuthorCard from './author-card/AuthorCard.vue'
import RecentUpdates from './RecentUpdates.vue'

export const themeComponents: Record<string, Component> = {
  RecentUpdates,
  AuthorCard
}

export function registerThemeComponents(app: App): void {
  for (const [name, component] of Object.entries(themeComponents)) app.component(name, component)
}

export { AuthorCard, RecentUpdates }
