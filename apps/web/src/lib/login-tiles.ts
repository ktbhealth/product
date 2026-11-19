// Login-tile collection moved to @ktb/app-host/client so plugin-owned
// sign-in pages can resolve the same offer set without importing the
// composition root. This shim keeps the app-bound import path stable.
export { loginTileTargets, visibleLoginTiles } from "#/lib/registry.ts";
