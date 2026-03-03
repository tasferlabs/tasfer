import React from "react";
import {
  type AuthUser,
  login as apiLogin,
  register as apiRegister,
  logout as apiLogout,
  refreshToken as apiRefreshToken,
  getMe,
} from "../api/auth.api";
import { setAuthHandlers } from "../api/client";

interface AuthState {
  user: AuthUser | null;
  accessToken: string | null;
  isLoading: boolean;
}

interface AuthContextValue extends AuthState {
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, name: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = React.createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = React.useState<AuthState>({
    user: null,
    accessToken: null,
    isLoading: true,
  });

  const accessTokenRef = React.useRef<string | null>(null);
  const refreshTimerRef = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Keep ref in sync
  accessTokenRef.current = state.accessToken;

  const scheduleRefresh = React.useCallback((_token: string) => {
    // Refresh 1 minute before expiry (tokens last 15min)
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = setTimeout(async () => {
      const newToken = await apiRefreshToken();
      if (newToken) {
        setState((prev) => ({ ...prev, accessToken: newToken }));
        accessTokenRef.current = newToken;
        scheduleRefresh(newToken);
      } else {
        // Refresh failed — log out
        setState({ user: null, accessToken: null, isLoading: false });
        accessTokenRef.current = null;
      }
    }, 13 * 60 * 1000); // 13 minutes
  }, []);

  // Wire up auth handlers for the shared fetch client
  React.useEffect(() => {
    setAuthHandlers(
      () => accessTokenRef.current,
      async () => {
        const newToken = await apiRefreshToken();
        if (newToken) {
          setState((prev) => ({ ...prev, accessToken: newToken }));
          accessTokenRef.current = newToken;
          scheduleRefresh(newToken);
          return newToken;
        }
        // Refresh failed
        setState({ user: null, accessToken: null, isLoading: false });
        accessTokenRef.current = null;
        return null;
      }
    );
  }, [scheduleRefresh]);

  // Try to restore session on mount
  React.useEffect(() => {
    let cancelled = false;

    async function restore() {
      const token = await apiRefreshToken();
      if (cancelled) return;

      if (token) {
        try {
          const user = await getMe(token);
          if (cancelled) return;
          setState({ user, accessToken: token, isLoading: false });
          accessTokenRef.current = token;
          scheduleRefresh(token);
        } catch {
          if (!cancelled) {
            setState({ user: null, accessToken: null, isLoading: false });
          }
        }
      } else {
        setState({ user: null, accessToken: null, isLoading: false });
      }
    }

    restore();
    return () => { cancelled = true; };
  }, [scheduleRefresh]);

  const login = React.useCallback(
    async (email: string, password: string) => {
      const { user, accessToken } = await apiLogin({ email, password });
      setState({ user, accessToken, isLoading: false });
      accessTokenRef.current = accessToken;
      scheduleRefresh(accessToken);
    },
    [scheduleRefresh]
  );

  const register = React.useCallback(
    async (email: string, name: string, password: string) => {
      const { user, accessToken } = await apiRegister({ email, name, password });
      setState({ user, accessToken, isLoading: false });
      accessTokenRef.current = accessToken;
      scheduleRefresh(accessToken);
    },
    [scheduleRefresh]
  );

  const logoutFn = React.useCallback(async () => {
    await apiLogout();
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    setState({ user: null, accessToken: null, isLoading: false });
    accessTokenRef.current = null;
  }, []);

  const value = React.useMemo(
    () => ({
      ...state,
      login,
      register,
      logout: logoutFn,
    }),
    [state, login, register, logoutFn]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = React.useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
