import { useState } from "react";
import { useSearchParams, useNavigate, Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { PasswordInput } from "@/components/ui/password-input";
import { resetPassword } from "../api/auth.api";
import { useErrorMessage } from "../hooks/useErrorMessage";

export default function ResetPasswordPage() {
  const [t] = useTranslation();
  const errorMessage = useErrorMessage();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token") || "";

  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (newPassword.length < 8) {
      setError(t("validation.passwordMinChars", "Password must be at least 8 characters"));
      return;
    }

    if (newPassword !== confirmPassword) {
      setError(t("validation.passwordsDoNotMatch", "Passwords do not match"));
      return;
    }

    setLoading(true);
    try {
      await resetPassword(token, newPassword);
      navigate("/login", { replace: true });
    } catch (err: any) {
      setError(errorMessage(err.message));
    } finally {
      setLoading(false);
    }
  };

  if (!token) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-4">
        <div className="w-full max-w-sm space-y-6 text-center">
          <h1 className="text-2xl font-semibold text-foreground">{t("editor.link.invalidLink", "Invalid link")}</h1>
          <p className="text-sm text-muted-foreground">
            {t("error.passwordResetLinkInvalid", "This password reset link is invalid.")}
          </p>
          <Link to="/forgot-password" className="text-primary hover:underline text-sm">
            {t("auth.reset.requestNewLink", "Request a new link")}
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center space-y-2">
          <h1 className="text-2xl font-semibold text-foreground">{t("auth.reset.resetYourPassword", "Reset your password")}</h1>
          <p className="text-sm text-muted-foreground">
            {t("auth.reset.enterNewPassword", "Enter your new password below.")}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              {error}
            </div>
          )}

          <div className="space-y-2">
            <label htmlFor="new-password" className="text-sm font-medium text-foreground">
              {t("auth.reset.newPassword", "New password")}
            </label>
            <PasswordInput
              id="new-password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder={t("validation.atLeast8Chars", "At least 8 characters")}
              required
              autoComplete="new-password"
              autoFocus
            />
          </div>

          <div className="space-y-2">
            <label htmlFor="confirm-password" className="text-sm font-medium text-foreground">
              {t("auth.reset.confirmNewPassword", "Confirm new password")}
            </label>
            <PasswordInput
              id="confirm-password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder={t("auth.reset.repeatNewPassword", "Repeat your new password")}
              required
              autoComplete="new-password"
            />
          </div>

          <Button
            type="submit"
            loading={loading}
            disabled={!newPassword || !confirmPassword}
            className="w-full"
          >
            {t("auth.reset.resetPassword", "Reset password")}
          </Button>
        </form>

        <p className="text-center text-sm text-muted-foreground">
          <Link to="/login" className="text-primary hover:underline">
            {t("auth.backToSignIn", "Back to sign in")}
          </Link>
        </p>
      </div>
    </div>
  );
}
