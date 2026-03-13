import { useState } from "react";
import { useForm } from "react-hook-form";
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { useAuth } from "../contexts/AuthContext";

interface LoginForm {
  email: string;
  password: string;
}

export default function LoginPage() {
  const [t] = useTranslation("LoginPage");
  const { login } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState("");

  const {
    register,
    handleSubmit,
    formState: { isSubmitting },
  } = useForm<LoginForm>();

  const onSubmit = async (data: LoginForm) => {
    setError("");

    try {
      const result = await login(data.email, data.password);
      if (result?.needsVerification) {
        navigate(
          `/verify-email?email=${encodeURIComponent(result.email)}`,
          { replace: true },
        );
        return;
      }
      navigate("/", { replace: true });
    } catch (err: any) {
      setError(err.message || t`Login failed`);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center space-y-2">
          <h1 className="text-2xl font-semibold text-foreground">{t`Welcome back`}</h1>
          <p className="text-sm text-muted-foreground">{t`Sign in to your account`}</p>
        </div>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
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
              placeholder="you@example.com"
              autoComplete="email"
              autoFocus
              {...register("email", { required: true })}
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
            <PasswordInput
              id="password"
              placeholder={t`Your password`}
              autoComplete="current-password"
              {...register("password", { required: true })}
            />
          </div>

          <Button type="submit" loading={isSubmitting} className="w-full">
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
