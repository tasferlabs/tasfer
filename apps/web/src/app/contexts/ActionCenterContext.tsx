import { createContext, useContext, useMemo, useState } from "react";

interface ActionCenterContextValue {
  /** Whether the command palette is currently showing */
  open: boolean;
  setOpen: React.Dispatch<React.SetStateAction<boolean>>;
}

const ActionCenterContext = createContext<ActionCenterContextValue>({
  open: false,
  setOpen: () => {},
});

export function ActionCenterProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const value = useMemo(() => ({ open, setOpen }), [open]);

  return (
    <ActionCenterContext.Provider value={value}>
      {children}
    </ActionCenterContext.Provider>
  );
}

export function useActionCenter() {
  return useContext(ActionCenterContext);
}
