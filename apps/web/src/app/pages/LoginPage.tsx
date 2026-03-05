import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuth } from "../contexts/AuthContext";

export default function LoginPage() {
  const [t] = useTranslation("LoginPage");
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const result = await login(email, password);
      if (result?.needsVerification) {
        navigate(`/verify-email?email=${encodeURIComponent(result.email)}`, { replace: true });
        return;
      }
      navigate("/", { replace: true });
    } catch (err: any) {
      setError(err.message || "Login failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center space-y-2">
          <h1 className="text-2xl font-semibold text-foreground">{t`Welcome back`}</h1>
          <p className="text-sm text-muted-foreground">{t`Sign in to your account`}</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              {error}
            </div>
          )}

          <div className="space-y-2">
            <label htmlFor="email" className="text-sm font-medium text-foreground">
              {t`Email`}
            </label>
            <Input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              required
              autoComplete="email"
              autoFocus
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label htmlFor="password" className="text-sm font-medium text-foreground">
                {t`Password`}
              </label>
              <Link to="/forgot-password" className="text-sm text-primary hover:underline">
                {t`Forgot password?`}
              </Link>
            </div>
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t`Your password`}
              required
              autoComplete="current-password"
            />
          </div>

          <Button type="submit" loading={loading} className="w-full">
            {t`Sign in`}
          </Button>
        </form>

        <p className="text-center text-sm text-muted-foreground">
          {t`Don't have an account?`}{" "}
          <Link to="/register" className="text-primary hover:underline">
            {t`Sign up`}
          </Link>
        </p>
      </div>
    </div>
  );
}
