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

const STORAGE_KEY = 'sc.map.color-scheme.v1';
const kv = createPersistentKV();

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
let customJson = CUSTOM_MAP_COLOR_SCHEME_TEMPLATE;
let selectedId = DEFAULT_MAP_COLOR_SCHEME_ID;
let loaded = false;
let loadPromise: Promise<void> | null = null;
let snapshot = makeSnapshot();
const listeners = new Set<() => void>();

function makeSnapshot(): MapColorSchemeSnapshot {
  return {
    selectedId,
    selected: findMapColorScheme(selectedId, custom),
    custom,
    customJson,
    schemes: custom ? [...BUILT_IN_MAP_COLOR_SCHEMES, custom] : BUILT_IN_MAP_COLOR_SCHEMES,
  };
}

function emit(): void {
  snapshot = makeSnapshot();
  listeners.forEach((listener) => listener());
}

function persistedCustom(input: CustomMapColorSchemeInput): string {
  return JSON.stringify(input, null, 2);
}

async function persist(preference: PersistedPreference): Promise<void> {
  await kv.set(STORAGE_KEY, JSON.stringify(preference));
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
    const raw = await kv.get(STORAGE_KEY);
    if (raw) {
      try {
        const value = JSON.parse(raw) as PersistedPreference;
        if (value.custom) {
          const parsed = parseCustomMapColorScheme(JSON.stringify(value.custom));
          custom = parsed.scheme;
          customJson = persistedCustom(parsed.input);
        }
        selectedId = findMapColorScheme(value.selectedId, custom).id;
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
  selectedId = findMapColorScheme(id, custom).id;
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
