/** Public surface of the map feature. */

export { CoverageIsland } from './components/coverage-island';
export { FriendsIsland } from './components/friends-island';
export type { MapRosterFriend } from './components/friends-island';
export { IslandTabs } from './components/island-tabs';
export type { IslandTab } from './components/island-tabs';
export { LocateMeControl } from './components/locate-me-control';
export { MapIsland } from './components/map-island';
export {
  MapLayersControl,
  type MapLayerId,
  type MapLayerToggles,
} from './components/map-layers-control';
export { SettingsControl } from './components/settings-control';
export { MapView } from './render/map-view';
export type { MapFriendLocation, MapTrailLocation } from './render/map-view';
export { sampleTrailForMap } from './core/trail-sampling';
export { hexToRgb, rgbToHex } from './core/color';
export { useMapTheme } from './hooks/use-map-theme';
export type { MapReadout, Rgb } from './core/types';
