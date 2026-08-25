/// <reference types="vite/client" />
interface ImportMetaEnv {
  /** 构建期开关：置 "1" 时把 MSW 打进包里（仅用于 E2E 预览构建） */
  readonly VITE_USE_MOCKS?: string;
}
interface ImportMeta { readonly env: ImportMetaEnv; }
