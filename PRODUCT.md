# Product

## Register

product

## Users

People who want a passive, ambient record of the city they actually move through —
"where have I really been?" The app runs in the **background at a low ping rate**
(battery-friendly), so the user is not actively operating it most of the time; they
open it to _browse_ the territory they've accumulated. The mental context is a
walker / commuter / urban explorer glancing at their phone between things, **not**
someone navigating a trip in real time.

## Product Purpose

streetCryptid is a **"walk every street" fog-of-war map** of the city you live in. As
you move through the world, the map reveals where you've been in discrete **hex
sectors**; everywhere you haven't been stays a desaturated "ghost city." It is a
passive **where-you've-been-vs-haven't atlas — not** a route tracker, trip logger, or
fitness app. Success looks like the quiet satisfaction of watching your city fill in
over months, plus a light social layer for comparing territory with friends.

## Brand Personality

Calm, precise, instrument-like. Three words: **calm · instrument · atlas.** The UX
borrows the _structure_ of an Evangelion "MAGI / control-plane" readout — technical,
legible, unhurried — married to the owner's own **flip-dot / dot-matrix** design
language (the city rendered as a field of tiny dots). It should feel like a beautiful
living instrument you glance at, not a game that nags you. Warmth is carried by the
social layer (friends, ASCII "cryptid" sigils) and the light **"daybreak"** default —
never by mascots or hype.

## Anti-references

- **Pokémon GO / gamified AR monster-hunting** — no creatures to catch, no XP, no
  battles. The "cryptid" is a personal ASCII sigil, not a collectible.
- **Fitness / route trackers (Strava, Nike Run, Fog of World's trip mode)** — no
  per-trip timers, pace, "resume walk," or GPS breadcrumb trails. Reveal is
  sector-chunked, never a traced path.
- **Military / tactical cosplay** — no hazard tape, targeting reticles, or
  OPERATOR / SWEEP / TERRITORY jargon. Borrow the MAGI instrument's calm, not its
  war-room.
- **SaaS dashboard clichés** — no hero-metric template (big number + supporting stats
  - gradient), no identical card grids, no tiny uppercase tracked eyebrows.
- **"Vibe-code" gradient slop** — no decorative gradients, glow halos,
  glassmorphism-as-default, or vignette drama. Flat translucent panels + hairline
  borders only.

## Design Principles

1. **Passive, not performative.** The app observes; it never asks the user to "start"
   or "resume" anything. Every screen answers "where have I been?" at a glance.
2. **The map is the product.** The full-bleed dot-field map is the hero; chrome is a
   few minimal floating "islands." Hide analytics; show territory.
3. **One honest signal per color.** Amber = you. Contact-green = friends. Teal ramp =
   the city. No redundant badges, no duplicate status text, no rainbow.
4. **Reveal in chunks, not traces.** A low-battery background ping acquires a whole
   hex sector. Discovered = crisp and saturated; unexplored = desaturated ghost +
   amber frontier rim.
5. **Themeable from one source of truth.** A single THEME object drives both the chrome
   and the canvas palette. Light ("daybreak") is the default; dark ("deep sea",
   "nocturne") are alternates.

## Accessibility & Inclusion

- Target **WCAG AA**: body text ≥ 4.5:1, large / UI text ≥ 3:1. Muted "steel" inks were
  tuned to clear 4.5:1 on every theme background (deepsea 5.07, nocturne 5.15,
  daybreak 4.94).
- The map is a `<canvas>`; the real app **must** ship an accessible text model beside it
  (named current location, coverage %, nearby friends) for screen readers — the dot
  field alone is not accessible. _(Open P0 for the RN build.)_
- **Reduced motion:** the live "you" pulse and any sector-reveal animation need a
  `prefers-reduced-motion` alternative (crossfade or instant).
- **Never color alone:** friends carry a handle + ASCII sigil and sectors carry an
  outline, so hue is never the only differentiator.
