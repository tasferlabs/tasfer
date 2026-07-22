import React from "react";
import { invariant } from "@shared/invariant";
import { useGetSpaces, type ISpace } from "../api/spaces.api";

interface SpaceContextValue {
  spaces: ISpace[];
  activeSpaceId: string | null;
  setActiveSpaceId: (id: string) => void;
  isLoading: boolean;
}

const SpaceContext = React.createContext<SpaceContextValue | null>(null);

export function SpaceProvider({ children }: { children: React.ReactNode }) {
  const { data: spaces = [], isLoading } = useGetSpaces();
  const [activeSpaceId, setActiveSpaceId] = React.useState<string | null>(null);

  // Default to first space
  React.useEffect(() => {
    if (!activeSpaceId && spaces.length > 0) {
      setActiveSpaceId(spaces[0].id);
    }
  }, [spaces, activeSpaceId]);

  const value = React.useMemo(
    () => ({
      spaces,
      activeSpaceId: activeSpaceId || spaces[0]?.id || null,
      setActiveSpaceId,
      isLoading,
    }),
    [spaces, activeSpaceId, isLoading]
  );

  return <SpaceContext.Provider value={value}>{children}</SpaceContext.Provider>;
}

export function useSpaces(): SpaceContextValue {
  const ctx = React.useContext(SpaceContext);
  invariant(ctx, "useSpaces must be used within SpaceProvider");
  return ctx;
}
