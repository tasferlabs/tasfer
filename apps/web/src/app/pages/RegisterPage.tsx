import { useState } from "react";
import { useForm } from "react-hook-form";
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { useAuth } from "../contexts/AuthContext";
import { useErrorMessage } from "../hooks/useErrorMessage";

interface RegisterForm {
  email: string;
  password: string;
  confirmPassword: string;
}

export default function RegisterPage() {
  const [t] = useTranslation();
  const errorMessage = useErrorMessage();
  const { register: registerUser } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState("");

  const {
    register,
    handleSubmit,
    watch,
    formState: { isSubmitting, errors },
  } = useForm<RegisterForm>();

  const onSubmit = async (data: RegisterForm) => {
    setError("");

    try {
      const result = await registerUser(data.email, data.password);
      if (result?.needsVerification) {
        navigate(
          `/verify-email?email=${encodeURIComponent(result.email)}`,
          { replace: true },
        );
        return;
      }
      navigate("/", { replace: true });
    } catch (err: any) {
      setError(errorMessage(err.message));
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center space-y-2">
          <h1 className="text-2xl font-semibold text-foreground">{t("auth.createAccount", "Create account")}</h1>
          <p className="text-sm text-muted-foreground">{t("profile.getStarted", "Get started with Cypher")}</p>
        </div>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          {error && (
            <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              {error}
            </div>
          )}

          <div className="space-y-2">
            <label htmlFor="email" className="text-sm font-medium text-foreground">
              {t("common.email", "Email")}
            </label>
            <Input
              id="email"
              type="email"
              placeholder="you@example.com"
              autoComplete="email"
              autoFocus
              {...register("email", { required: true })}
            />
          </div>

          <div className="space-y-2">
            <label htmlFor="password" className="text-sm font-medium text-foreground">
              {t("common.password", "Password")}
            </label>
            <PasswordInput
              id="password"
              placeholder={t("auth.yourPassword", "Your password")}
              autoComplete="new-password"
              {...register("password", {
                required: true,
                minLength: {
                  value: 8,
                  message: t("validation.passwordMinChars", "Password must be at least 8 characters"),
                },
              })}
            />
            {errors.password?.message && (
              <p className="text-xs text-destructive">{errors.password.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <label htmlFor="confirmPassword" className="text-sm font-medium text-foreground">
              {t("auth.confirmPassword", "Confirm password")}
            </label>
            <PasswordInput
              id="confirmPassword"
              placeholder={t("auth.repeatPassword", "Repeat your password")}
              autoComplete="new-password"
              {...register("confirmPassword", {
                required: true,
                validate: (value) =>
                  value === watch("password") || t("validation.passwordsDoNotMatch", "Passwords do not match"),
              })}
            />
            {errors.confirmPassword?.message && (
              <p className="text-xs text-destructive">{errors.confirmPassword.message}</p>
            )}
          </div>

          <Button type="submit" loading={isSubmitting} className="w-full">
            {t("auth.createAccount", "Create account")}
          </Button>
        </form>

        <p className="text-center text-sm text-muted-foreground">
          {t("auth.alreadyHaveAccount", "Already have an account?")}{" "}
          <Link to="/login" className="text-primary hover:underline">
            {t("auth.signIn", "Sign in")}
          </Link>
        </p>
      </div>
    </div>
  );
}
