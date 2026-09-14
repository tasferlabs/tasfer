import React from "react";
import { invariant } from "@shared/invariant";
import { useGetSpaces, type ISpace } from "../api/spaces.api";

interface SpaceContextValue {
  spaces: ISpace[];
  /**
   * The first listed space. There is no "current" space: the sidebar and the
   * calendar show every space at once. Anything tied to a page or event uses
   * that page's own space; this is only for actions with nothing to go by,
   * such as creating the very first page from an empty screen.
   */
  firstSpaceId: string | null;
  isLoading: boolean;
  loadError: Error | null;
}

const SpaceContext = React.createContext<SpaceContextValue | null>(null);

export function SpaceProvider({ children }: { children: React.ReactNode }) {
  const spacesQuery = useGetSpaces();
  const spaces = spacesQuery.data ?? [];
  const loadError =
    spacesQuery.isError && spacesQuery.data === undefined
      ? spacesQuery.error
      : null;

  const value = React.useMemo(
    () => ({
      spaces,
      firstSpaceId: spaces[0]?.id ?? null,
      isLoading: spacesQuery.isLoading,
      loadError,
    }),
    [spaces, spacesQuery.isLoading, loadError],
  );

  return <SpaceContext.Provider value={value}>{children}</SpaceContext.Provider>;
}

export function useSpaces(): SpaceContextValue {
  const ctx = React.useContext(SpaceContext);
  invariant(ctx, "useSpaces must be used within SpaceProvider");
  return ctx;
}
