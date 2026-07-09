// Native (and default) resolution: render the screen body directly. Web is
// handled by the sibling `map-screen.web.tsx`, which first loads CanvasKit.
// Keeping the Skia-web import out of `src/app/` is deliberate — expo-router's
// require.context enumerates every file there (including .web.tsx) into the
// native bundle, and canvaskit-wasm imports Node's `fs`, which breaks Android.
export { default } from './map-screen-body';
