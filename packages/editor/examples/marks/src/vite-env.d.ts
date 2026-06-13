/// <reference types="vite/client" />

// The editor can optionally talk to a native iOS/Android shell through a global
// `window.CypherBridge` that it never creates itself — a native host injects it
// at runtime (see apps/web/src/platform/bridge.ts for the full contract). This
// example runs in a plain browser with no native shell, so the bridge is always
// undefined here; we only declare the shape so the editor source typechecks.
//
// (Triple-slash references don't make this a module, and there are no
// imports/exports, so `interface Window` merges into the global Window type.)
interface Window {
  CypherBridge?: {
    clipboard: {
      copy(text: string): Promise<void>;
      cut(text: string): Promise<void>;
      paste(): Promise<string>;
    };
    haptic: {
      trigger(style: "light" | "medium" | "heavy"): Promise<void>;
    };
    navigation: {
      openUrl(url: string): Promise<void>;
    };
  };
}
