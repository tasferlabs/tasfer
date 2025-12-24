import React from "react";

export default function useResponsive(query: string): boolean {
  if (typeof window === 'undefined') return false;
  
  const [match, setMatch] = React.useState<boolean>(window.matchMedia(query).matches ?? false);

  React.useEffect(() => {
    if (!window.matchMedia) {
      return;
    }

    const queryList = window.matchMedia(query);
    const updateMatch = () => {
      setMatch(queryList.matches);
    };
    updateMatch();

    queryList.addEventListener("change", updateMatch);
    return () => {
      queryList.removeEventListener("change", updateMatch);
    };
  }, [query]);

  return match;
}

