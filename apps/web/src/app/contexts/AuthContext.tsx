import React from "react";
import { invariant } from "@shared/invariant";
import { type AuthUser, getMe } from "../api/auth.api";

interface AuthState {
  user: AuthUser | null;
  isLoading: boolean;
}

interface AuthContextValue extends AuthState {
  updateUser: (user: AuthUser) => void;
}

const AuthContext = React.createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = React.useState<AuthState>({
    user: null,
    isLoading: true,
  });

  React.useEffect(() => {
    let cancelled = false;

    async function restore() {
      try {
        const user = await getMe();
        if (!cancelled) setState({ user, isLoading: false });
      } catch {
        if (!cancelled) setState({ user: null, isLoading: false });
      }
    }

    restore();
    return () => { cancelled = true; };
  }, []);

  const updateUser = React.useCallback((user: AuthUser) => {
    setState((prev) => ({ ...prev, user }));
  }, []);

  const value = React.useMemo(
    () => ({
      ...state,
      updateUser,
    }),
    [state, updateUser]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = React.useContext(AuthContext);
  invariant(ctx, "useAuth must be used within AuthProvider");
  return ctx;
}
