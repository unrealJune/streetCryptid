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

One accent per role. **Your chosen profile signal = you. A chosen profile signal = that
friend. Amber = the frontier rim. Teal ramp = the city.** You and your friends are the
same kind of thing on this map, so you are colored the same way they are: by the signal
color you picked in Settings, which is also the one they already see for your dot.
Contact-green remains the default friend signal and the nearby-pairing system color; the
app never assigns decorative colors.

Amber is the _canvas accent_, not a person. It survives in exactly two places: the
frontier rim on acquired territory, and as the fallback for YOU before a profile exists.

### Daybreak (default, light)

| Role                                                 | Value                                          |
| ---------------------------------------------------- | ---------------------------------------------- |
| bg / void                                            | `#EEF2F5` / `#C9D3DA`                          |
| panel (islands)                                      | `#FFFFFF` (translucent)                        |
| ink (headings/body)                                  | `#152633`                                      |
| steel / steel-dark (muted, AA-tuned)                 | `#4D6675` / `#5B7480`                          |
| hairline                                             | `#D6DEE4`                                      |
| **amber (frontier rim)** / amber-dark for small text | `#C6791A` / `#9A5C10`                          |
| **default self + friend signal**                     | `#2F9E6A` (canvas `[38,150,100]`)              |
| street ramp (unexplored→explored)                    | light `[176,190,200]` → dark navy `[20,44,64]` |
| water (shallow→deep)                                 | `[150,192,224]` → `[30,104,170]`               |
| park (faded→lush)                                    | `[158,200,168]` → `[34,128,80]`                |

On the pale bg, **explored streets render dark** ("blueprint console"); unexplored
drains toward the paper.

### Deep sea (dark alt)

void `#060C14` · navy `#0A1420` · ink `#DCEBF0` · steel `#8AA6B2` · **amber `#EDA23C`**
(small `#B9761E`) · **default friend green `#6FD08A`** (`[111,208,138]`) · street ramp
`#22424A`→`#D4ECEA` · water `#1A4A80`→`#56A8E8`.

### Nocturne (dark alt)

Indigo/cyan field · **coral accent `#F0657F`** · **default friend green `#63D0B0`**.

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
- **No personal path trace.** The low ping rate cannot support granular walked centerlines;
  your own movement remains sector reveal. Selecting a friend may connect their retained
  48-hour sharing fixes as a temporary, low-resolution breadcrumb in that friend's signal
  color. Amber remains reserved for the frontier rim; the **YOU** locator wears your own
  signal color, exactly like every other person on the map.
- **Zoom-aware (`?zoom=street|hood|city|region`).** Coverage _decreases_ outward
  (58 → 34 → 12 → 3 %). street = magnified neighborhood; hood = neighborhood; city =
  arterials + water + coastline; region = state silhouette + city nodes.
- **Names arrive with the zoom, not with the geometry.** A road can be drawn long before it
  is worth naming: motorways label from far out, residential streets and service alleys stay
  anonymous until you are actually in the neighbourhood. A name also has to _fit_ inside its
  way's on-screen length, so short stubs suppress themselves. One label per name (a road
  crossing four tiles is still one road), rotated to the road's heading, colliding labels
  dropped rather than stacked. Park names sit on the polygon centroid, gated on on-screen
  area. Mono, uppercase, letter-spaced — the map's text is data, not chrome.

## Chrome & layout — Apple-Maps "islands"

- **Full-bleed map. There is no tab bar and no header.** The map is the whole app. The
  only chrome is floating: attribution and a Settings gear across the top, a right-side
  control stack of **map affordances only** (layers · locate [amber]), and one bottom
  island. Everything else is either that island or a sheet pulled over it.
- **Settings is one gear, top-right,** in neutral steel — never an accent, because it is
  not a signal. It opens as a modal over the map with its own close affordance, so leaving
  it always returns you to exactly the view you left.
- **One island, with its own segmented bar** (ME · FRIENDS) along its bottom edge — the
  app's only navigation. Find My's model: the sheet owns the switch, so the map's corners
  stay about the map and nothing floats that isn't a map affordance. Selection is carried
  by **contrast, not colour** (ink on a `seg` pill vs steel) — with one exception: the ME
  glyph wears **your** signal color while ME is open, so the tab and your dot on the map
  read as the same thing. The bar carries **no badge**: presence is already stated by the
  roster header ("N NEARBY", in words) and by the live dots on the map, and a pip would be
  a third voice saying it.
- **The island floats clear of the system gesture bar** — `insets.bottom` plus a real
  margin, on both platforms. (It once special-cased Android to skip the inset, which was
  true only while a native tab bar was consuming it.)
- **ME is zoom-aware "where you are":** hero place name (Rajdhani) + one mono
  uppercase sub + **one** flip-dot coverage bar **in your signal color** (it counts ground
  _you_ covered) + **one** % — retitled per tier (BLOCKS / SECTORS / HOODS / CITIES).
  **No legend** (removed). Declutter law: one live dot, one coverage number, one accent —
  never duplicate badges or status text.
- **A selected trace is a drill-down, not a third tab.** It replaces the island's body while
  the bar stays lit on the tab you came from, so closing it returns you where you were and
  either tab is always a way out.
- **Surfaces:** flat translucent panel + 1px hairline border, generous radius (island
  ≈ 26px). No gradients, no glow, no glass-as-default, no vignette.

## Social layer

- Friends are the **same kind of signal you are**, not a lesser one. Each friend's chosen
  profile color drives their screen-stable presence ring, core dot, `@handle` chip, ASCII
  form, and selected breadcrumb; contact-green is the fallback for legacy profiles. Your
  own color works identically — the map has no privileged color for "me".
- **Identity = an ASCII "cryptid" sigil** per friend (mothman / jackalope / black shuck…),
  mono and rendered in their chosen signal — terminal-native, not a mascot.
- **Roster sheet:** cryptid avatar + `@handle` + location + a **"shared ground"** bar
  (% of streets you've _both_ walked). Hairline dividers, **not** cards; offline rows
  dimmed. The roster is the island's FRIENDS tab — it swaps the bottom island from "where
  you are" to "who is out there" without leaving the map, and tapping a row flies there and
  opens that friend's trace. It leads with `N NEARBY` rather than a "FRIENDS" title,
  because the lit tab below already names the view. _Shipped without the shared-ground bar:_
  the app has no overlap metric yet, and the declutter law says a fabricated number is worse
  than no number.
- **Friend profile is also friend _management_:** big cryptid hero, sharing state, retained
  48-hour location timeline, a **"View trail on map"** CTA, and **Remove friend** behind an
  inline confirm. It is reached from a **filled `seg` circle with a "more" glyph** at the end
  of a roster row — the row asks "where are they", that target asks "who are they, and what
  do I want to do about it". It is deliberately _not_ a hairline chevron: as a chevron it read
  as decoration and people concluded the app had no way to remove anyone. Removal is the one
  destructive act in the product, so the door to it has to look like a door.
- **Pairing lives in the FRIENDS tab, not on a screen.** Arming is one deliberate tap on
  ARM BUMP; after that, two phones touching is the whole gesture. Opening the tab used to
  arm the radio implicitly, which was wrong twice over: it fired an OS Bluetooth prompt
  from a view transition, and when that prompt was declined the strip had nothing left to
  offer. Idle is therefore always a **recoverable** state with a button in it, never a
  spinner. Leaving the tab or backgrounding the app disarms, so the radio never runs behind
  an island that isn't the roster. The island shows a single honest status line, and only
  offers a tap-to-pair button when motion detection cannot close the deal. The blocking
  ASCII verification and the discovery celebration are full overlays — that is the one
  moment a mistake hands a stranger your location, so it earns the whole screen.
- Social metric is **shared ground (overlap)**, never a leaderboard. Friend colors are
  chosen identity signals, never an app-assigned rainbow.

## Motion (for the RN build)

Gentle live **YOU** pulse; sector acquisition can animate a single hex "flip." Ease-out
(quart / expo), no bounce, no elastic. **Every** animation needs a
`prefers-reduced-motion` fallback (crossfade / instant). Motion is intentional per
element — never one uniform entrance on everything.

## Do / Don't (earned through iteration)

- **Do:** flip-dot dots, hex sectors, single accents, real OSM geometry, calm restraint,
  light-first.
- **Don't:** gradients / glow / glass, permanent personal path traces, map legends,
  mascots, hero-metric cards, duplicate status text, app-assigned rainbow colors,
  military jargon.

## Reference implementation

See [`docs/design/`](docs/design/README.md): `mock_social.html` (map + 4 zoom tiers + 3
themes + social layer) and `mock_real.html` (base map, no friends). Renders in
`docs/design/renders/` — the `-light` set is primary.
