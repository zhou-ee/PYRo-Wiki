# VitePress theme component structure

Theme code is split into three layers: component registration, component UI, and domain data adapters.

```text
.vitepress/
?? data/
?  ?? member-types.ts       # Member profile types
?  ?? members.ts            # Typed member-data adapter and registry
?? theme/
   ?? components/
      ?? index.ts           # Global Markdown component registration
      ?? RecentUpdates.vue
      ?? author-card/
         ?? AuthorCard.vue  # Author-card UI
         ?? registry.ts     # Author resolution and display helpers
```

## Adding a component

1. Create a component directory or `.vue` file under `components/`.
2. Import it in `components/index.ts` and add it to `themeComponents`.
3. Put component-specific types and data adapters under `.vitepress/data/`.
4. Keep UI components dependent on data adapters instead of reading Markdown or `public` files directly.
5. Run `npm run docs:build` to verify the documentation build.

## Legacy Markdown compatibility

Existing documents can continue to use:

```ts
import { mem1 } from '../public/member_list/members'
```

`public/member_list/members.ts` remains the source used by legacy documents and the VS Code preview parser. `.vitepress/data/members.ts` provides the typed adapter used by theme components, so documents can be migrated gradually without changing their rendered appearance.
# VitePress theme component structure

Theme code is split into three layers: component registration, component UI, and domain data adapters.

```text
.vitepress/
?? data/
?  ?? member-types.ts       # Member profile types
?  ?? members.ts            # Typed member-data adapter and registry
?? theme/
   ?? components/
      ?? index.ts           # Global Markdown component registration
      ?? RecentUpdates.vue
      ?? author-card/
         ?? AuthorCard.vue  # Author-card UI
         ?? registry.ts     # Author resolution and display helpers
```

## Adding a component

1. Create a component directory or `.vue` file under `components/`.
2. Import it in `components/index.ts` and add it to `themeComponents`.
3. Put component-specific types and data adapters under `.vitepress/data/`.
4. Keep UI components dependent on data adapters instead of reading Markdown or `public` files directly.
5. Run `npm run docs:build` to verify the documentation build.

## Legacy Markdown compatibility

Existing documents can continue to use:

```ts
import { mem1 } from '../public/member_list/members'
```

`public/member_list/members.ts` remains the source used by legacy documents and the VS Code preview parser. `.vitepress/data/members.ts` provides the typed adapter used by theme components, so documents can be migrated gradually without changing their rendered appearance.
