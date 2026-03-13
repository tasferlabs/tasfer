import { useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { forgotPassword } from "../api/auth.api";
import { useErrorMessage } from "../hooks/useErrorMessage";

export default function ForgotPasswordPage() {
  const [t] = useTranslation("ForgotPasswordPage");
  const errorMessage = useErrorMessage();

  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (!email.trim()) {
      setError(t`Please enter your email address`);
      return;
    }

    setLoading(true);
    try {
      await forgotPassword(email.trim());
      setSent(true);
    } catch (err: any) {
      setError(errorMessage(err.message));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="w-full max-w-sm space-y-6">
        {!sent ? (
          <>
            <div className="text-center space-y-2">
              <h1 className="text-2xl font-semibold text-foreground">{t`Forgot password?`}</h1>
              <p className="text-sm text-muted-foreground">
                {t`Enter your email and we'll send you a link to reset your password.`}
              </p>
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

              <Button type="submit" loading={loading} className="w-full">
                {t`Send reset link`}
              </Button>
            </form>

            <p className="text-center text-sm text-muted-foreground">
              <Link to="/login" className="text-primary hover:underline">
                {t`Back to sign in`}
              </Link>
            </p>
          </>
        ) : (
          <>
            <div className="text-center space-y-2">
              <h1 className="text-2xl font-semibold text-foreground">{t`Check your email`}</h1>
              <p className="text-sm text-muted-foreground">
                {t`We sent a password reset link to`}{" "}
                <span className="font-medium text-foreground">{email}</span>
              </p>
            </div>

            <div className="rounded-md bg-green-500/10 p-3 text-sm text-center">
              {t`Click the link in the email to reset your password.`}
            </div>

            <p className="text-center text-sm text-muted-foreground">
              <Link to="/login" className="text-primary hover:underline">
                {t`Back to sign in`}
              </Link>
            </p>
          </>
        )}
      </div>
    </div>
  );
}
