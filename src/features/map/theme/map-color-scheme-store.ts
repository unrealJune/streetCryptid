import { createPersistentKV } from '@/features/social/net/persistence';

import {
  BUILT_IN_MAP_COLOR_SCHEMES,
  CUSTOM_MAP_COLOR_SCHEME_TEMPLATE,
  DEFAULT_MAP_COLOR_SCHEME_ID,
  findMapColorScheme,
  parseCustomMapColorScheme,
  type CustomMapColorSchemeInput,
  type MapColorScheme,
} from './map-color-schemes';
import { readMaterialYouScheme } from './material-you';

const STORAGE_KEY = 'sc.map.color-scheme.v2';

/**
 * Built on first use, never at import.
 *
 * The selected palette now supplies the app's CHROME as well as the map canvas (see
 * `derive-chrome.ts`), so this store is read by `use-theme` — which `themed-text` imports, which
 * means every screen in the app imports it. `createPersistentKV()` probes expo-sqlite eagerly, so
 * building it here opened a database on the import path of the first frame. Same reasoning, and
 * the same shape, as the thunk in `settings/core/display-preferences.ts`.
 */
let kvInstance: ReturnType<typeof createPersistentKV> | null = null;
const kv = () => (kvInstance ??= createPersistentKV());

interface PersistedPreference {
  readonly selectedId: string;
  readonly custom?: CustomMapColorSchemeInput;
}

export interface MapColorSchemeSnapshot {
  readonly selectedId: string;
  readonly selected: MapColorScheme;
  readonly custom: MapColorScheme | null;
  readonly customJson: string;
  readonly schemes: readonly MapColorScheme[];
}

let custom: MapColorScheme | null = null;
/**
 * The phone's wallpaper palette, or `null` where there is none.
 *
 * Read at import rather than inside {@link loadMapColorSchemePreference} because it is
 * synchronous and involves no storage, and because the very first frame paints from
 * {@link getMapColorSchemeSnapshot} — a phone whose saved choice is `material-you` would
 * otherwise flash Seattle's chrome before settling. Re-read by {@link refreshMaterialYouScheme}.
 */
let materialYou: MapColorScheme | null = readMaterialYouScheme();
let customJson = CUSTOM_MAP_COLOR_SCHEME_TEMPLATE;
let selectedId = DEFAULT_MAP_COLOR_SCHEME_ID;
let loaded = false;
let loadPromise: Promise<void> | null = null;
let snapshot = makeSnapshot();
const listeners = new Set<() => void>();

function makeSnapshot(): MapColorSchemeSnapshot {
  return {
    selectedId,
    selected: findMapColorScheme(selectedId, custom, materialYou),
    custom,
    customJson,
    // System first among the runtime schemes: it is the one the phone already looks like.
    schemes: [
      ...BUILT_IN_MAP_COLOR_SCHEMES,
      ...(materialYou ? [materialYou] : []),
      ...(custom ? [custom] : []),
    ],
  };
}

/**
 * Re-read the wallpaper palette and publish it if it moved.
 *
 * Changing wallpaper or flipping the system theme does not necessarily restart the JS context, so
 * the colours this store handed out can go stale under a running app. Compared by value: the OS
 * returns fresh strings every call, so an identity check would repaint the whole tree on every
 * foreground resume.
 */
export function refreshMaterialYouScheme(): void {
  const next = readMaterialYouScheme();
  if (JSON.stringify(next) === JSON.stringify(materialYou)) return;
  materialYou = next;
  // A phone that lost dynamic colours while `material-you` was selected falls back through
  // `findMapColorScheme` on the next snapshot; nothing here needs to rewrite the saved id, and
  // rewriting it would lose the choice the moment the wallpaper came back.
  emit();
}

function emit(): void {
  snapshot = makeSnapshot();
  listeners.forEach((listener) => listener());
}

function persistedCustom(input: CustomMapColorSchemeInput): string {
  return JSON.stringify(input, null, 2);
}

async function persist(preference: PersistedPreference): Promise<void> {
  await kv().set(STORAGE_KEY, JSON.stringify(preference));
}

export function getMapColorSchemeSnapshot(): MapColorSchemeSnapshot {
  return snapshot;
}

export function subscribeToMapColorScheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function loadMapColorSchemePreference(): Promise<void> {
  if (loaded) return Promise.resolve();
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    const raw = await kv().get(STORAGE_KEY);
    if (raw) {
      try {
        const value = JSON.parse(raw) as PersistedPreference;
        if (value.custom) {
          const parsed = parseCustomMapColorScheme(JSON.stringify(value.custom));
          custom = parsed.scheme;
          customJson = persistedCustom(parsed.input);
        }
        selectedId = findMapColorScheme(value.selectedId, custom, materialYou).id;
      } catch {
        selectedId = DEFAULT_MAP_COLOR_SCHEME_ID;
        custom = null;
      }
    }
    loaded = true;
    emit();
  })();
  return loadPromise;
}

export async function selectMapColorScheme(id: string): Promise<void> {
  await loadMapColorSchemePreference();
  selectedId = findMapColorScheme(id, custom, materialYou).id;
  emit();
  await persist({
    selectedId,
    ...(custom ? { custom: parseCustomMapColorScheme(customJson).input } : {}),
  });
}

export async function saveCustomMapColorScheme(json: string): Promise<void> {
  const parsed = parseCustomMapColorScheme(json);
  await loadMapColorSchemePreference();
  custom = parsed.scheme;
  customJson = persistedCustom(parsed.input);
  selectedId = custom.id;
  emit();
  await persist({ selectedId, custom: parsed.input });
}
