import React from "react";
import { useGetSpaces, type ISpace } from "../api/spaces.api";

interface SpaceContextValue {
  personalSpace: ISpace | null;
  groupSpaces: ISpace[];
  activeSpaceId: string | null;
  setActiveSpaceId: (id: string) => void;
  isLoading: boolean;
}

const SpaceContext = React.createContext<SpaceContextValue | null>(null);

export function SpaceProvider({ children }: { children: React.ReactNode }) {
  const { data, isLoading } = useGetSpaces();
  const [activeSpaceId, setActiveSpaceId] = React.useState<string | null>(null);

  const personalSpace = React.useMemo(
    () => data?.owned.find((s) => s.type === "personal") ?? null,
    [data]
  );

  const groupSpaces = React.useMemo(() => {
    const ownedGroups = data?.owned.filter((s) => s.type === "group") ?? [];
    const memberGroups = data?.member ?? [];
    return [...ownedGroups, ...memberGroups];
  }, [data]);

  // Default to personal space
  React.useEffect(() => {
    if (!activeSpaceId && personalSpace) {
      setActiveSpaceId(personalSpace.id);
    }
  }, [personalSpace, activeSpaceId]);

  const value = React.useMemo(
    () => ({
      personalSpace,
      groupSpaces,
      activeSpaceId: activeSpaceId || personalSpace?.id || null,
      setActiveSpaceId,
      isLoading,
    }),
    [personalSpace, groupSpaces, activeSpaceId, isLoading]
  );

  return <SpaceContext.Provider value={value}>{children}</SpaceContext.Provider>;
}

export function useSpaces(): SpaceContextValue {
  const ctx = React.useContext(SpaceContext);
  if (!ctx) throw new Error("useSpaces must be used within SpaceProvider");
  return ctx;
}
