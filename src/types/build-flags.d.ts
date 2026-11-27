// Replaced at build time through Bun's `define` (electrobun.config.ts build.bun.define,
// scripts/build-daemon-bundle.ts, scripts/build-cli.ts). Undefined when the source runs unbuilt
// (`bun test`, `bun run dev`, `bun src/bun/headless.ts`), which src/shared/build-flags.ts treats as a dev build.
declare const __AGETOR_RELEASE_BUILD__: boolean | undefined;
declare const __AGETOR_COMPANION__: boolean | undefined;
