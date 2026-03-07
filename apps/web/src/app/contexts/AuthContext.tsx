import React from "react";
import {
  type AuthUser,
  login as apiLogin,
  register as apiRegister,
  logout as apiLogout,
  verifyEmail as apiVerifyEmail,
  getMe,
} from "../api/auth.api";

interface AuthState {
  user: AuthUser | null;
  isLoading: boolean;
}

interface NeedsVerification {
  needsVerification: true;
  email: string;
}

interface AuthContextValue extends AuthState {
  login: (email: string, password: string) => Promise<NeedsVerification | void>;
  register: (email: string, password: string) => Promise<NeedsVerification | void>;
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

  // Try to restore session on mount
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

  const login = React.useCallback(
    async (email: string, password: string): Promise<NeedsVerification | void> => {
      const data = await apiLogin({ email, password });
      if (data.needsVerification) {
        return { needsVerification: true, email: data.email! };
      }
      setState({ user: data.user!, isLoading: false });
    },
    []
  );

  const register = React.useCallback(
    async (email: string, password: string): Promise<NeedsVerification | void> => {
      const data = await apiRegister({ email, password });
      if (data.needsVerification) {
        return { needsVerification: true, email: data.email! };
      }
      setState({ user: data.user!, isLoading: false });
    },
    []
  );

  const verifyEmail = React.useCallback(
    async (email: string, code: string) => {
      const { user } = await apiVerifyEmail({ email, code });
      setState({ user, isLoading: false });
    },
    []
  );

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
