import React from "react";
import {
  type AuthUser,
  getMe,
  logout as apiLogout,
} from "../api/auth.api";

interface AuthState {
  user: AuthUser | null;
  isLoading: boolean;
}

interface AuthContextValue extends AuthState {
  /** @deprecated No login in decentralized mode — identity is local */
  login: (email: string, password: string) => Promise<void>;
  /** @deprecated No registration in decentralized mode — identity is local */
  register: (email: string, password: string) => Promise<void>;
  /** @deprecated No email verification in decentralized mode */
  verifyEmail: (email: string, code: string) => Promise<void>;
  logout: () => Promise<void>;
  updateUser: (user: AuthUser) => void;
}

const AuthContext = React.createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = React.useState<AuthState>({
    user: null,
    isLoading: true,
  });

  // Load local identity on mount (replaces "restore session from server")
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

  const login = React.useCallback(async () => {
    throw new Error("login is not available in decentralized mode");
  }, []);

  const register = React.useCallback(async () => {
    throw new Error("register is not available in decentralized mode");
  }, []);

  const verifyEmail = React.useCallback(async () => {
    throw new Error("verifyEmail is not available in decentralized mode");
  }, []);

  const updateUser = React.useCallback((user: AuthUser) => {
    setState((prev) => ({ ...prev, user }));
  }, []);

  const logoutFn = React.useCallback(async () => {
    await apiLogout();
    setState({ user: null, isLoading: false });
  }, []);

  const value = React.useMemo(
    () => ({
      ...state,
      login,
      register,
      verifyEmail,
      logout: logoutFn,
      updateUser,
    }),
    [state, login, register, verifyEmail, logoutFn, updateUser]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = React.useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
