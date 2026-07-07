# Design

> Visual system of record for streetCryptid. The working reference implementation is
> the HTML/canvas mockup in [`docs/design/`](docs/design/README.md) — open
> `mock_social.html` in a browser to see everything below live. Renders are in
> `docs/design/renders/`.

## Theme

A passive fog-of-war city atlas rendered as a **flip-dot / dot-matrix field** under
calm **MAGI-instrument** chrome. One `THEME` object drives **both** the CSS chrome vars
and the `<canvas>` palette, selected with `?theme=`:

| Theme        | Mode                | Feel                                                                                                                                   |
| ------------ | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **daybreak** | light **(default)** | Cool off-white paper; dark ink dots that go crisp teal→navy when explored; amber accent; white islands. Blueprint-console-in-daylight. |
| **deep sea** | dark (alt)          | Navy void, teal ramp, single bold amber. The original flip-dot subway feel.                                                            |
| **nocturne** | dark (alt)          | Indigo/cyan field with a coral accent + mint contact-green.                                                                            |

**Light (daybreak) is the default from now on.** Dark themes are alternates and should
auto-switch with the OS color scheme.

## Color

One accent per role. **Amber = you. Contact-green = friends. Teal ramp = the city.**
Nothing else competes.

### Daybreak (default, light)

| Role                                        | Value                                          |
| ------------------------------------------- | ---------------------------------------------- |
| bg / void                                   | `#EEF2F5` / `#C9D3DA`                          |
| panel (islands)                             | `#FFFFFF` (translucent)                        |
| ink (headings/body)                         | `#152633`                                      |
| steel / steel-dark (muted, AA-tuned)        | `#4D6675` / `#5B7480`                          |
| hairline                                    | `#D6DEE4`                                      |
| **amber (you)** / amber-dark for small text | `#C6791A` / `#9A5C10`                          |
| **contact-green (friends)**                 | `#2F9E6A` (canvas `[38,150,100]`)              |
| street ramp (unexplored→explored)           | light `[176,190,200]` → dark navy `[20,44,64]` |
| water (shallow→deep)                        | `[150,192,224]` → `[30,104,170]`               |
| park (faded→lush)                           | `[158,200,168]` → `[34,128,80]`                |

On the pale bg, **explored streets render dark** ("blueprint console"); unexplored
drains toward the paper.

### Deep sea (dark alt)

void `#060C14` · navy `#0A1420` · ink `#DCEBF0` · steel `#8AA6B2` · **amber `#EDA23C`**
(small `#B9761E`) · **contact-green `#6FD08A`** (`[111,208,138]`) · street ramp
`#22424A`→`#D4ECEA` · water `#1A4A80`→`#56A8E8`.

### Nocturne (dark alt)

Indigo/cyan field · **coral accent `#F0657F`** · **contact-green `#63D0B0`**.

## Typography

- **Display / UI — Rajdhani** (500 / 600 / 700): condensed and technical. Hero place
  names, coverage numbers, the YOU / @handle labels.
- **Data / mono — IBM Plex Mono** (400 / 500 / 600): small labels, stats, street names,
  and the ASCII cryptid sigils.
- **Pairing rationale:** condensed-geometric sans + monospace = a clear _contrast_ axis
  (not two similar sans). Small mono labels are uppercase + letter-spaced; hero names are
  large Rajdhani. Display letter-spacing floor ≥ −0.04em; hero clamp max ≤ 6rem.

## The map (core component)

- **Flip-dot halftone on `<canvas>`:** a fine dot field (step `S≈2.0`). Each dot is
  colored by feature (teal ramp = street, blue = water, green = park) and sized /
  brightened by road class. **The dot field _is_ the city.**
- **Real geometry:** OpenStreetMap (Overpass) streets / parks / water, multi-geography
  and multi-zoom, baked into `docs/design/mapdata.js` + `zoomdata.js`.
- **Fog = hex-sector reveal (default).** A background ping "acquires" the whole hex you're
  in. Discovered sectors show true saturated color; undiscovered ones **desaturate toward
  a gray ghost city** (desat ≈ .74, dim toward bg ≈ .24) under a faint honeycomb lattice,
  with an **amber frontier rim** on the boundary of acquired territory. Water and parkland
  are capped so basins always read even when unexplored. Alt reveal modes exist for
  experimentation only (`?fog=soft|grid`).
- **No path trace.** The low ping rate can't track granular routes, so there are no walked
  centerlines. Amber is reserved for the frontier rim and the single **YOU** locator.
- **Zoom-aware (`?zoom=street|hood|city|region`).** Coverage _decreases_ outward
  (58 → 34 → 12 → 3 %). street = magnified neighborhood; hood = neighborhood; city =
  arterials + water + coastline; region = state silhouette + city nodes.

## Chrome & layout — Apple-Maps "islands"

- **Full-bleed map.** Floating only: a right-side control stack (layers · friends toggle
  [green] · locate [amber]) and one bottom island.
- **Bottom island is zoom-aware "where you are":** hero place name (Rajdhani) + one mono
  uppercase sub + **one** flip-dot coverage bar + **one** % — retitled per tier
  (BLOCKS / SECTORS / HOODS / CITIES). **No legend** (removed). Declutter law: one live
  dot, one coverage number, one accent — never duplicate badges or status text.
- **Surfaces:** flat translucent panel + 1px hairline border, generous radius (island
  ≈ 26px). No gradients, no glow, no glass-as-default, no vignette.

## Social layer

- Friends are a **second signal** in contact-green, distinct from amber YOU. On the map:
  presence ring + core dot + `@handle` chip (online friends only; drawn beneath YOU).
- **Identity = an ASCII "cryptid" sigil** per friend (mothman / jackalope / black shuck…),
  mono and contact-green — terminal-native, not a mascot.
- **Roster sheet:** cryptid avatar + `@handle` + location + a **"shared ground"** bar
  (% of streets you've _both_ walked). Hairline dividers, **not** cards; offline rows
  dimmed.
- **Friend profile:** big cryptid hero, shared-ground %, "N shared streets · M sectors
  they've explored that you haven't," and a **"View their map"** CTA.
- Social metric is **shared ground (overlap)**, never a leaderboard, never per-friend
  rainbow colors.

## Motion (for the RN build)

Gentle live **YOU** pulse; sector acquisition can animate a single hex "flip." Ease-out
(quart / expo), no bounce, no elastic. **Every** animation needs a
`prefers-reduced-motion` fallback (crossfade / instant). Motion is intentional per
element — never one uniform entrance on everything.

## Do / Don't (earned through iteration)

- **Do:** flip-dot dots, hex sectors, single accents, real OSM geometry, calm restraint,
  light-first.
- **Don't:** gradients / glow / glass, path traces, map legends, mascots, hero-metric
  cards, duplicate status text, per-friend rainbow colors, military jargon.

## Reference implementation

See [`docs/design/`](docs/design/README.md): `mock_social.html` (map + 4 zoom tiers + 3
themes + social layer) and `mock_real.html` (base map, no friends). Renders in
`docs/design/renders/` — the `-light` set is primary.
