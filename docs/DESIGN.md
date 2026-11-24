# Vibe design system

> Quiet chrome. The artwork supplies the colour.

This is the design system of the Vibe web app (and the TV app, which is the same app in TV mode, `?tv=1`). It is the
reference for anyone building or restyling a page: tokens, type, layout, components and their APIs, and the rules
that keep the product coherent. Brand assets (the Lens mark, wordmark, gradient, icons) are documented in
[`branding/vibe/README.md`](../branding/vibe/README.md).

## Principles

1. **Library first.** Home is built from the viewer's own library; discovery, requests and Live TV rows are opt-in.
   Nothing promotional sits above Continue Watching.
2. **Continue Watching is the first content row**, resumable in one click. A quiet, static hero may sit above it.
3. **Few clicks.** Libraries are pinned in the sidebar in the viewer's order. Common tasks take at most two clicks.
4. **Fast.** Instant navigation, server-side paging, render what is visible, skeletons only for loads over ~1 s.
5. **The viewer controls Home**: hide, reorder and restore rows per profile (Customize Home).
6. **Never remove features.** Every route and action stays reachable. A redesign is a reskin and a re-layout.
7. **Density that respects big screens**: comfortable by default, Compact as an option; useful metadata on tiles.
8. **No autoplay by default.** Trailer previews follow the viewer's preference; reduced motion is honoured.
9. **The right artwork in the right place**: posters in grids, stills in Continue Watching, backdrops in heroes,
   title logos on title pages.
10. **Bold, never-hidden focus**: a 2 px ring with ≥ 3:1 contrast, `:focus-visible`, never covered by sticky bars.
11. **Accessible**: WCAG 2.2 AA contrast, keyboard everything, landmarks, reduced motion and higher contrast.

## Where things live

| Piece | File |
| --- | --- |
| Tokens (colour, radius, spacing, type, motion, density) | `web/src/styles/tokens.css` (imported by `base.css`) |
| Fonts (Outfit + Figtree, self-hosted) | `web/src/styles/fonts.css` |
| Document, typography, focus, scrollbars, buttons, inputs, chips, segmented, switches, utilities | `web/src/styles/base.css` |
| Components: cards, rows, grids, hero, badges, modal / sheet, menu, popover, tabs, toast, headers, empty state | `web/src/styles/components.css` |
| App shell: sidebar, top bar, tab bar, mini player, page frame | `web/src/styles/layout.css` |
| TV mode overrides | `web/src/styles/tv.css` |
| Artwork light, palette, peek cards, title page, sign-in, player chrome (feature surfaces) | `web/src/styles/lumen.css` |
| React components | `web/src/components/ui.tsx`, `Cards.tsx`, `Row.tsx`, `Hero.tsx`, `CustomizeHome.tsx` |
| Shell | `web/src/components/Layout.tsx`, `shell/Sidebar.tsx`, `shell/TopBar.tsx`, `shell/shellPrefs.ts` |
| Theme application, density | `web/src/theme/applyTheme.ts`, `web/src/theme/defaults.ts` |
| Built-in server themes | `server/src/services/themes.ts` |

## Colour and themes

Colours always come from the active **server theme** (Branding Studio, starter looks, seasonal schedules or the
viewer's own theme choice). `applyTheme.ts` writes the theme into the `--c-*` variables on `<html>`; `tokens.css`
derives the Vibe tokens from them. So any server theme, custom brand colour or custom CSS keeps working, and page
CSS written against the old `--c-*` names keeps working too.

| Theme field | Input variable | Vibe tokens derived from it |
| --- | --- | --- |
| background | `--c-bg` | `--bg`, `--surface-glass`, the bottom of every scrim |
| surface | `--c-surface` | `--surface-1`, `--surface-overlay` |
| surfaceAlt | `--c-surface-alt` | `--surface-2`, `--surface-3` (alt + 7 % text) |
| text | `--c-text` | `--text`, `--line` (8 %), `--line-strong` (16 %), `--hover*`, `--focus` |
| textMuted | `--c-text-muted` | `--text-2`, `--text-3` (muted mixed 80 % toward bg) |
| primary / primaryText | `--c-primary`, `--c-primary-text` | `--accent`, `--on-accent`, `--accent-soft`, `--accent-ink`, `--focus-halo` |
| accent | `--c-accent` | `--accent-2`, `--accent-2-soft` |
| success / warning / danger | `--c-success` … | `--ok`, `--warn`, `--err` |
| radius | `--radius` | `--r-xs` (×0.43), `--r-sm` (×0.72), `--r`, `--r-lg` (×1.43); posters `--poster-radius` |
| font | `--font` | `--font-display` = Outfit when the theme uses Figtree / Inter / Plus Jakarta Sans |
| mode | `data-mode` on `<html>` | light-mode overrides (deeper `--accent-ink`, softer shadows and lines) |
| card size | `--card-w-theme` | `--card-w` (× 0.85 in Compact) |

The derived tokens are declared on `:root` **and** on any element carrying an inline theme
(`[style*='--c-bg']`, e.g. Branding Studio previews from `themeStyle()`), so previews render with their own colours.

### The Vibe themes

`Vibe` (id `mediamax`, dark, the default for new installs) and `Vibe Light` (id `mediamax-light`). The ids are the
old ones, so saved settings and viewer preferences carry over. Both use the static hero.

| Token | Dark | Light |
| --- | --- | --- |
| `--bg` | `#0C0C10` | `#F7F6FA` |
| `--surface-1` | `#15151B` | `#FFFFFF` |
| `--surface-2` | `#1D1D25` | `#F0EEF5` |
| `--surface-3` | ≈ `#26262F` | ≈ `#E6E3EE` |
| `--text` | `#F2F1F6` | `#15131C` |
| `--text-2` (≥ 7:1) | `#B4B2C2` | `#4E4B5C` |
| `--text-3` (≥ 4.5:1) | ≈ `#93919F` | ≈ `#6F6C7C` |
| `--accent` (fills; white label ≥ 4.5:1) | `#D23A72` | `#C8336A` |
| `--accent-ink` (accent as text on the page) | ≈ `#F0588C` | deeper rose |
| `--accent-2` (violet) | `#8C6BFF` | `#6A4BF0` |
| `--ok` · `--warn` · `--err` · `--live` | `#3DD68C` · `#F5B53D` · `#FF5D6C` · `#FF4757` | AA-safe darker shades |

The spec's bright rose `#F0588C` fails AA under a white label (3.2:1), so the theme's fill is the AA-safe
`#D23A72` and `#F0588C` appears as `--accent-ink`, the colour for accent **text and thin strokes** on dark surfaces.

**Rules.** Surfaces get lighter as they rise (`--bg` → `--surface-1` → `--surface-2` → `--surface-3`); shadows are
light and reserved for overlays. Use `--accent` sparingly: the primary action on a page, selection, progress, the
active nav marker. Use `--accent-ink`, never `--accent`, for accent-coloured text. Text over artwork is white
(`--on-media`) on a scrim, never on raw art.

The **brand gradient** (`#FF8A5C → #E2498A → #7C5CFF`, 135°) belongs to the Lens mark, the splash and tiny accents
only. Never fill large UI areas with it.

## Typography

- **Outfit** (display, variable 100–900): page titles, section and row titles 22 px and up, hero and title-page
  titles, modal titles, the wordmark. Weights 600–650; tight tracking (−0.015 to −0.03 em).
- **Figtree** (UI and body, variable 300–900, upright + italic): everything else. Body 14 px / 1.45.

Never set body copy, labels or anything under 18 px in Outfit. Both faces are self-hosted from
`@fontsource-variable/*` (Latin + Latin Extended, `font-display: swap`, no runtime CDN).

| Token | Size | Face | Use |
| --- | --- | --- | --- |
| `--t-xs` | 12 | Figtree | captions, badges, eyebrows (`.t-eyebrow`) |
| `--t-sm` | 13 | Figtree | secondary lines, card subtitles |
| `--t-base` | 14 | Figtree | body, controls, card titles |
| `--t-md` | 16 | Figtree | emphasised body, overview text |
| `--t-lg` | 18 | Figtree | `h3`, small section headers |
| `--t-xl` | 22 | Outfit | `h2`, row titles, modal titles (`.t-section`) |
| `--t-2xl` | 28 | Outfit | page titles (`.t-title`) |
| `--t-3xl` | 36 | Outfit | large page titles (`h1`, `.t-display`) |
| `--t-hero` | 52 | Outfit | hero and title page (`.t-hero`) |

Times, durations, counts and tables use tabular figures (`.tabular`, `time`, tables do it automatically).

## Spacing, radius, motion, density

- **Spacing**: 4-pt scale `--s-1` (4) … `--s-12` (48). Page gutter `--gutter` = `clamp(16px, 3vw, 48px)`.
  Content max width `--content-max` 1680 px (heroes, backdrops and the guide run full-bleed).
- **Radius**: `--r-xs` 6 · `--r-sm` 10 · `--r` 14 · `--r-lg` 20 · `--r-pill`. Posters use `--poster-radius`
  (= `--r-sm` for the default rounded shape). Buttons, chips, search and segmented controls are pills.
- **Motion**: `--dur-hover` 120 ms, `--dur-enter` 200 ms, `--dur-panel` 280 ms, ease `--ease`
  `cubic-bezier(.2,.8,.2,1)`. Animate `transform` and `opacity`. No Ken Burns, parallax or drifting light.
  Under `prefers-reduced-motion` all durations collapse; spinners keep turning slowly; skeletons stop shimmering.
- **Density**: `html[data-density=compact]` shrinks cards (`--card-w` × 0.85), row gaps and section gaps.
  `setDensity('compact' | 'comfortable')` / `getDensity()` in `theme/applyTheme.ts` (stored per device,
  `vibe.density`; applied by the shell). A Settings page can offer it as a Segmented control.
- **Higher contrast**: under `prefers-contrast: more`, lines and secondary text get stronger and glass turns solid.

## Focus

One ring everywhere: a 2 px outline in the text colour with a 2–3 px accent halo, on `:focus-visible` only
(`--focus-ring` gives the same ring as a box-shadow for clipped elements). Cards draw the ring inside the artwork.
`html` has `scroll-padding` and focusable elements have `scroll-margin` for the top bar, the mini player and the tab
bar, so sticky chrome never hides focus. TV mode uses a 4 px ring and scales the focused card.

## Layout

```
┌──────────────┬───────────────────────────────────────────────────────┐
│ Sidebar      │ Top bar (sticky, translucent): [search ⌘K]   🔔  (S)  │
│ 248 px       ├───────────────────────────────────────────────────────┤
│ (72 px rail) │ main#main  .page (gutter, max 1680)                   │
│              │   full-bleed .hero / .detail-backdrop slide under the │
│              │   top bar (margin-top: calc(var(--topbar-h) * -1))    │
│              ├───────────────────────────────────────────────────────┤
│              │ Mini player (docked, 72 px) when audio is playing     │
└──────────────┴───────────────────────────────────────────────────────┘
```

- **Sidebar** (`shell/Sidebar.tsx`): Home · Search · My List; **Libraries** in the viewer's order (Edit → up/down,
  Reset; saved per user in `localStorage` `vibe.sidebar.libraryOrder.<userId>`); **Live** (Live TV, Guide,
  Recordings, IPTV libraries, per feature flags and user permissions); **Listen & discover** (DJ, Podcasts,
  Requests with the pending count, Discover when requests are on) and a collapsible **More** group (Calendar,
  Playlists, Collections, Roulette, Movie Match, Issues); then Settings, Admin (admins), Help, the connection status
  and the collapse toggle. Collapsed it is a 72 px icon rail (labels become tooltips, counts ride on the icons),
  remembered per device (`vibe.sidebar.collapsed`), toggled with **[**. Under 900 px it is an off-canvas drawer
  opened from the top bar's menu button or the tab bar's More. In TV mode it is always the rail and widens while it
  has D-pad focus.
- **Top bar** (`shell/TopBar.tsx`): the search field opens the command palette (also ⌘K / Ctrl K / "/"), whose
  "Search everything" goes to `/search`; the notification bell; the profile avatar menu (switch profile, account &
  settings, Your year, pair a phone / remote control, link a device, keyboard shortcuts, admin, switch user, sign
  out). It is transparent over a hero (white controls) and turns into frosted `--surface-glass` once the page
  scrolls. On phones: menu, back, brand, search icon, bell, avatar.
- **Phones (≤ 900 px)**: bottom tab bar (Home, Search, Live, My List, More); the mini player floats above it.
- **Mini player** (`player/MiniPlayer.tsx`, logic unchanged): art + title, transport centre, tools right, seek bar
  along its top edge. Sets `--mini-h` so pages, toasts and focus scrolling leave room for it.
- Shell variables page CSS may use: `--topbar-h`, `--sidebar-w`, `--mini-h`, `--tabbar-h`, `--gutter`.
- Global hosts stay in `App.tsx`: keyboard shortcuts (`?`), What's new, server messages, the phone-remote host.

## Components

All in `web/src/components/ui.tsx` unless noted. Plain class names work too (`className="btn btn-primary"`); the
components are the preferred API for new code.

### Buttons

```tsx
<Button variant="primary" icon="play">Play</Button>            // primary | secondary (default) | ghost | glass | danger | play
<Button size="sm" to="/settings">Settings</Button>               // xs | sm | md | lg; `to` renders a router Link
<Button loading block>Saving…</Button>
<IconButton icon="more" label="More options" />                  // label → aria-label + tooltip; size sm|md|lg; filled; active
```

| Class | Use |
| --- | --- |
| `.btn` | secondary (surface-2, hairline) |
| `.btn-primary` | the page's main action (accent) — one per view |
| `.btn-play` | the media "Play" over artwork (white, dark label) |
| `.btn-glass` | secondary action over artwork (add `.on-media` to keep it white in light mode) |
| `.btn-ghost` | tertiary / toolbar |
| `.btn-danger` | destructive confirmation |
| `.btn-sm` / `.btn-lg` / `.btn-xs` / `.btn-block` | sizes (32 / 48 / 26 px; default 40) |
| `.btn-icon` (`-sm`, `-lg`, `.filled`, `.active`) | round icon button |
| `.btn-round` | round action over artwork (My List, watched on the title page) |

### Inputs and choices

```tsx
<Field label="Display name" hint="Shown to other profiles"><input className="input" /></Field>
<Input icon="search" placeholder="Filter" />                      // .input with a leading icon (inputSize sm|md|lg)
<select className="select">…</select>   <textarea className="textarea" />
<Switch checked={on} onChange={setOn} label="Autoplay next episode" hint="…" />
<Chip active={f} onClick={toggle}>Unwatched</Chip>              // onRemove adds an ×
<Segmented label="View" value={v} onChange={setV} options={[{ value: 'grid', label: 'Posters', icon: 'grid' }, …]} />
```

### Overlays

```tsx
<Modal open title="Edit" onClose={close} footer={<Button variant="primary">Save</Button>} size="sm|md|lg|xl" />
<Modal variant="sheet" …/>                                       // docked right; a bottom sheet on phones
<Dropdown trigger={({ onClick, open }) => <IconButton icon="more" label="More" onClick={onClick} />} items={[{ label, icon, onClick, danger, checked, divider }]} />
<Popover label="Filters" trigger={…}>{(close) => …}</Popover>    // anchored panel, closes on outside click / Esc
const confirm = useConfirm(); await confirm({ title, message, confirmLabel, danger });
const toast = useToast(); toast.show('Saved'); toast.error(err);  // state/toast.tsx
```

Dialogs are bottom sheets on phones automatically.

### Status

```tsx
<Badge tone="primary|accent|success|warning|danger|muted|outline|quality|new|live">4K</Badge>
<QualityBadges media={item.media} />    // 4K / HDR / DV / ATMOS from MediaSource (detail responses carry media)
<LiveBadge />  <ProgressBar value={42} size="lg" label="Watched" />
<Skeleton w={200} h={20} />  <CardSkeleton shape="poster|landscape|square" />  <Spinner />  <PageLoader />
<EmptyState icon="film" title="Nothing here yet" message="…" action={<Button>…</Button>} compact />
<ErrorState message={err} onRetry={reload} />
```

### Headers and tabs

```tsx
<PageHeader title="Movies" subtitle="1,204 titles" eyebrow="Library" icon="film" actions={<Button icon="shuffle">Shuffle</Button>} />
<SectionHeader title="Cast" link="/…" linkLabel="See all" actions={…} flush />   // flush = no gutter (inside .page)
<Tabs value={tab} onChange={setTab} tabs={[…]} variant="underline|pills" />
```

### Media (`Cards.tsx`, `Row.tsx`, `Hero.tsx`)

```tsx
<PosterCard item={item} />                  // 2:3 poster; square for music/photos, landscape for episodes (or shape=…)
<LandscapeCard item={item} />               // Continue Watching / Next Up: 16:9 still, progress, "S2 · E3 · Title", "23 min left"
<ChannelCard channel={c} />  <RankedCard item={i} rank={1} />  <UpcomingCard entry={e} />
<WatchlistButton item={item} variant="detail|hero|card|peek" />  <WatchedButton item={item} played={p} onChange={setP} />
<Row title="Recently Added" link="/library/x" subtitle="…" id={row.id} actions={…}>{cards}</Row>
<div className="grid">{cards}</div>          // .grid-square, .grid-landscape variants; responsive auto-fill
<Hero items={items} style="static|carousel" collapsible eyebrow="Featured" />
<CustomizeHome open rows={rows.map(({ id, title }) => ({ id, title }))} onClose={…} onSaved={reload} />
```

- **Cards** always show watched (✓), the unwatched count, favourite and progress. Hover / focus reveals a shade with
  badges (NEW for titles added in the last 14 days and not started, quality tags when the item carries media) and
  quick actions: Play, My List, Watched. Quick actions are `tabIndex=-1` (one tab stop per card); keyboard users get
  the same actions in the peek card and on the title page. Cards lift 3 px on hover with a hairline ring; no tilt.
- **Rows**: title (a link when `link` is set), ‹ › page buttons and "See all" in the header; the scroller snaps,
  supports native momentum and mouse drag, and ←/→ move focus between cards (TV mode uses spatial navigation).
- **Hero**: quiet and static. Backdrop + logo (or the title in Outfit) + one meta line (year · rating · runtime ·
  genres + rating badge) + overview + Play (`.btn-play`), More info (glass), My List. `carousel` (a theme choice)
  adds dots and slow auto-advance that pauses on hover / focus and never runs under reduced motion. Trailers only
  when the viewer enabled previews. `collapsible` adds a hide button (remembered per device, `vibe.hero.collapsed`).
- **Customize Home** (`CustomizeHome.tsx`): show / hide and reorder rows, Reset to default. Saves
  `preferences.homeLayout = { hidden, order }` with `PATCH /auth/me`; the server applies it in `buildHome()`
  (`server/src/services/items.ts`): hidden rows are dropped, ordered rows come first, the rest keep the server order.
  An id without `:suffix` covers its expansions (`lib-recent` → every `lib-recent:<libraryId>` row). The Home page
  places the entry point (a pencil in its header).

## Do / don't

- **Do** use tokens (`--surface-2`, `--text-2`, `--accent-ink`) in new CSS; keep `--c-*` only where you haven't
  restyled yet.
- **Do** put one primary action per view; everything else is secondary, ghost or an icon button.
- **Do** use scrims (gradients to `--bg` or to black) under any text on artwork.
- **Do** use `PageHeader` / `SectionHeader` / `Row` / `.grid` so pages share rhythm (28 px under page headers,
  `--section-gap` between sections).
- **Don't** use the brand gradient, glows or coloured shadows in the interface.
- **Don't** set body or small text in Outfit, or use `--accent` (the fill) as text.
- **Don't** autoplay sound or video, animate backgrounds, or add tilt / parallax / Ken Burns.
- **Don't** add `backdrop-filter` to elements that repeat (every card): it costs a blur per card per frame. Glass
  is for the top bar, menus, the mini player and dialogs.
- **Don't** hide focus (`outline: none` without a replacement) or remove a route or action.

## TV mode and lite mode

`?tv=1` (or a TV user agent) turns on `html.tv`: 20 px root size, 3 % overscan safe area, the sidebar as a rail
that widens on focus, 4 px focus rings, bigger targets; spatial navigation is unchanged (`[data-nav]`).
`html.lite` (`theme/fx.ts`, automatic on TVs and low-end devices) removes every `backdrop-filter` and turns glass
solid.

## Artwork light (kept, toned down)

The ambient light (`theme/ambient.ts`, `AmbientLight.tsx`) still samples the featured title's artwork, but it is a
faint, static wash (about a third of its former strength, no drift). Title pages may still read `--art-tint` but
should prefer the neutral buttons above.
