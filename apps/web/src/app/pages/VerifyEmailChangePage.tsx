import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams, useNavigate } from "react-router-dom";
import { verifyEmailChange } from "../api/auth.api";
import { useAuth } from "../contexts/AuthContext";

export default function VerifyEmailChangePage() {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { user, updateUser } = useAuth();
  const token = searchParams.get("token") || "";

  const [error, setError] = useState("");

  useEffect(() => {
    if (!token) {
      navigate("/settings?tab=security", { replace: true });
      return;
    }

    let cancelled = false;

    async function verify() {
      try {
        const updatedUser = await verifyEmailChange(token);
        if (cancelled) return;
        if (user) {
          updateUser(updatedUser);
        }
        navigate("/settings?tab=security", { replace: true });
      } catch (err: any) {
        if (cancelled) return;
        setError(err.message || t`Verification failed`);
      }
    }

    verify();

    return () => { cancelled = true; };
  }, [token]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="w-full max-w-sm space-y-6 text-center">
        {!error ? (
          <p className="text-sm text-muted-foreground">{t`Verifying...`}</p>
        ) : (
          <>
            <h1 className="text-2xl font-semibold text-foreground">{t`Verification failed`}</h1>
            <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              {error}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
