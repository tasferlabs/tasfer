import { isCollapsedSelection, isForwardSelection } from "./selection";
import type { EditorState, PartialSelectionState } from "./state-types";

export function updateSelection(
  state: EditorState,
  updates: PartialSelectionState | null,
): EditorState {
  return {
    ...state,
    document: {
      ...state.document,
      selection: !!updates
        ? {
            anchor: updates.anchor,
            focus: updates.focus,
            isForward: isForwardSelection(updates),
            isCollapsed: isCollapsedSelection(updates),
            lastUpdate: Date.now(),
            // Only preserve initialBoundary if explicitly provided in updates
            // This prevents unintentional preservation of gesture boundaries in programmatic selections
            ...("initialBoundary" in updates && updates.initialBoundary !== null
              ? { initialBoundary: updates.initialBoundary }
              : {}),
          }
        : null,
    },
  };
}
