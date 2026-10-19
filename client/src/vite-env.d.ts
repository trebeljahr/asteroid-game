/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Error reporting endpoint; "" turns reporting off. Defined in vite.config.mts. */
  readonly VITE_SENTRY_DSN: string;
  /** `asteroid-game@<version>+<commit>`. Defined in vite.config.mts. */
  readonly VITE_SENTRY_RELEASE: string;
}
