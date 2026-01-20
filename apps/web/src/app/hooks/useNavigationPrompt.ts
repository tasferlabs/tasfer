import { useEffect } from "react";
import { useBlocker } from "react-router-dom";
import { useUnsavedChangesDialog } from "../components/UnsavedChangesDialog";

/**
 * Hook to prompt user before navigation when there are unsaved changes.
 * Uses React Router's useBlocker which handles ALL navigation types:
 * - In-app link clicks
 * - Browser back/forward buttons
 * - Programmatic navigation (navigate())
 *
 * Note: Page refresh/close is handled separately via beforeunload in EditorPage.
 *
 * @param when - Condition to check before allowing navigation
 */
export function useNavigationPrompt(when: boolean) {
  const { showUnsavedChangesDialog } = useUnsavedChangesDialog();

  const blocker = useBlocker(when);

  useEffect(() => {
    if (blocker.state === "blocked") {
      showUnsavedChangesDialog().then((confirmed) => {
        if (confirmed) {
          blocker.proceed();
        } else {
          blocker.reset();
        }
      });
    }
  }, [blocker, showUnsavedChangesDialog]);
}
