/**
 * Router state carried on a `/page/:id` navigation.
 *
 * The route itself says which page to show; this says how the user got there,
 * for the cases where arriving by hand and arriving by command should differ.
 */
export interface PageNavState {
  /**
   * The opened page should take the caret on arrival, even if another typing
   * surface still holds DOM focus — the command surface that sent the user
   * here, which is on its way out.
   */
  focusEditor?: boolean;
}

/** State for an "open this page" navigation driven from the action center. */
export const OPEN_PAGE_NAV_STATE: PageNavState = { focusEditor: true };

export function wantsEditorFocus(state: unknown): boolean {
  return (state as PageNavState | null)?.focusEditor === true;
}
