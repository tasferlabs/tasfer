import { useEffect } from "react";
import { useAuth } from "../contexts/AuthContext";
import LoadingScreen from "@/components/ui/loading-screen";
import { SITE_URL } from "./siteUrl";

/** Hard-navigates the browser to an external URL (e.g. the separate site app). */
function ExternalRedirect({ to }: { to: string }) {
  useEffect(() => {
    window.location.assign(to);
  }, [to]);
  return <LoadingScreen />;
}

export function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, isLoading } = useAuth();

  if (isLoading) {
    return <LoadingScreen />;
  }

  if (!user) {
    // The marketing home now lives in the separate site app (apps/site).
    return <ExternalRedirect to={`${SITE_URL}/home`} />;
  }

  return <>{children}</>;
}
