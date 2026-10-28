import { AppState, type AppStateStatus } from 'react-native';

/**
 * `AppState.currentState` as an `AppStateStatus`.
 *
 * React Native 0.88 types `currentState` as `string | null | undefined`: it is `null` until
 * RCTAppState reports, which a genuine background launch can observe. Callers that store or compare
 * a status get `'unknown'` for that window instead of a value outside the union.
 */
export function currentAppState(): AppStateStatus {
  const state = AppState.currentState;
  switch (state) {
    case 'active':
    case 'background':
    case 'inactive':
    case 'extension':
      return state;
    default:
      return 'unknown';
  }
}
