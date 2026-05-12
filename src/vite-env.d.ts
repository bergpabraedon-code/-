/// <reference types="vite/client" />

declare const __FRONTEND_BUILD_VERSION__: string;

interface ImportMetaEnv {
  readonly VITE_ALLOWED_API_ENDPOINTS?: string;
}
