// Workaround: @ubjs/node@0.31.0-6 ships index.d.ts declaring only UniffiNativeModule, but
// lib.js (the package `main`) also exports FfiType and resolveLibPath. Loose augmentation so
// tsc can get past the runtime plumbing and check the generated API surface itself.
import '@ubjs/node';
declare module '@ubjs/node' {
  export const FfiType: any;
  export const resolveLibPath: any;
}
