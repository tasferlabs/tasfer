import { useState, useRef, useEffect } from "react";
import { useNavigate, useSearchParams, Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuth } from "../contexts/AuthContext";
import { resendVerification } from "../api/auth.api";
import { useErrorMessage } from "../hooks/useErrorMessage";

export default function VerifyEmailPage() {
  const [t] = useTranslation();
  const errorMessage = useErrorMessage();
  const { verifyEmail } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const email = searchParams.get("email") || "";

  const [digits, setDigits] = useState<string[]>(Array(6).fill(""));
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [resending, setResending] = useState(false);
  const [resent, setResent] = useState(false);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

  useEffect(() => {
    if (!email) {
      navigate("/register", { replace: true });
    }
  }, [email, navigate]);

  useEffect(() => {
    inputRefs.current[0]?.focus();
  }, []);

  const code = digits.join("");

  const handleDigitChange = (index: number, value: string) => {
    // Handle paste of full code
    if (value.length > 1) {
      const pasted = value.replace(/\D/g, "").slice(0, 6);
      if (pasted.length > 0) {
        const newDigits = Array(6).fill("");
        for (let i = 0; i < pasted.length; i++) {
          newDigits[i] = pasted[i];
        }
        setDigits(newDigits);
        const focusIndex = Math.min(pasted.length, 5);
        inputRefs.current[focusIndex]?.focus();
        return;
      }
    }

    const digit = value.replace(/\D/g, "").slice(-1);
    const newDigits = [...digits];
    newDigits[index] = digit;
    setDigits(newDigits);

    if (digit && index < 5) {
      inputRefs.current[index + 1]?.focus();
    }
  };

  const handleKeyDown = (index: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Backspace" && !digits[index] && index > 0) {
      const newDigits = [...digits];
      newDigits[index - 1] = "";
      setDigits(newDigits);
      inputRefs.current[index - 1]?.focus();
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (code.length !== 6) {
      setError(t("auth.verify.enterCode", "Please enter the 6-digit code"));
      return;
    }

    setLoading(true);
    try {
      await verifyEmail(email, code);
      navigate("/", { replace: true });
    } catch (err: any) {
      setError(errorMessage(err.message));
    } finally {
      setLoading(false);
    }
  };

  const handleResend = async () => {
    setResending(true);
    setResent(false);
    setError("");
    try {
      await resendVerification(email);
      setResent(true);
    } catch (err: any) {
      setError(errorMessage(err.message));
    } finally {
      setResending(false);
    }
  };

  if (!email) return null;

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center space-y-2">
          <h1 className="text-2xl font-semibold text-foreground">{t("auth.verify.checkEmail", "Check your email")}</h1>
          <p className="text-sm text-muted-foreground">
            {t("auth.verify.sentCodeTo", "We sent a 6-digit code to")} <span className="font-medium text-foreground">{email}</span>
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              {error}
            </div>
          )}

          {resent && (
            <div className="rounded-md bg-green-500/10 p-3 text-sm ">
              {t("auth.verify.newCodeSent", "A new code has been sent to your email.")}
            </div>
          )}

          <div className="space-y-3">
            <label className="text-sm font-medium text-foreground text-center block">
              {t("auth.verify.verificationCode", "Verification code")}
            </label>
            <div className="flex gap-3 justify-center">
              {digits.map((digit, i) => (
                <Input
                  key={i}
                  ref={(el) => { inputRefs.current[i] = el; }}
                  type="text"
                  inputMode="numeric"
                  maxLength={6}
                  value={digit}
                  onChange={(e) => handleDigitChange(i, e.target.value)}
                  onKeyDown={(e) => handleKeyDown(i, e)}
                  autoComplete={i === 0 ? "one-time-code" : "off"}
                  className="!w-12 h-12 text-center text-xl font-mono px-0 flex-shrink-0"
                />
              ))}
            </div>
          </div>

          <Button type="submit" loading={loading} className="w-full">
            {t("auth.verify.verifyEmail", "Verify email")}
          </Button>
        </form>

        <div className="text-center space-y-2">
          <p className="text-sm text-muted-foreground">
            {t("auth.verify.didntGetCode", "Didn't get the code?")}{" "}
            <button
              onClick={handleResend}
              disabled={resending}
              className="text-primary hover:underline disabled:opacity-50"
            >
              {resending ? t("common.sending", "Sending...") : t("auth.verify.resendCode", "Resend code")}
            </button>
          </p>
          <p className="text-sm text-muted-foreground">
            <Link to="/register" className="text-primary hover:underline">
              {t("settings.security.useDifferentEmail", "Use a different email")}
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
