/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CRYSTALSKETCH_VERSION: string;
  readonly VITE_CRYSTALSKETCH_STATIC_SCENE?: string;
  readonly VITE_CRYSTALSKETCH_STATIC_SCENE_NAME?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
