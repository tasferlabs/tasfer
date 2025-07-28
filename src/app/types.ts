import type { Editor } from "../editor";
import type { Page } from "../deserializer/loadPage";

export interface AppState {
  editor: Editor | null;
  page: Page | null;
  isLoading: boolean;
  error: string | null;
}

export interface EditorHookState {
  editor: Editor | null;
  isInitialized: boolean;
  isError: boolean;
}
