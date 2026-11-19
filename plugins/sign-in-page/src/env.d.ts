// import.meta.env is a Vite build-time transform; declare the slice the
// UI kit's client components read so the package typechecks without a
// vite dependency (same pattern as plugins/dev-capture-test/src/env.d.ts
// and @ktb/app-host/env.d.ts). The index signature keeps ImportMetaEnv
// assignable to Record<string, unknown>.
interface ImportMetaEnv {
	readonly PROD: boolean;
	readonly DEV: boolean;
	readonly [key: string]: unknown;
}
interface ImportMeta {
	readonly env: ImportMetaEnv;
}
