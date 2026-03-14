import React from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/app/contexts/AuthContext";
import { changeEmail, changePassword } from "@/app/api/auth.api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { cn } from "@/lib/utils";
import { useErrorMessage } from "@/app/hooks/useErrorMessage";
import styles from "./Security.module.css";

export function Security() {
  const { t } = useTranslation();
  const errorMessage = useErrorMessage();
  const { user } = useAuth();

  // Email change state
  const [newEmail, setNewEmail] = React.useState("");
  const [emailSent, setEmailSent] = React.useState(false);
  const [emailLoading, setEmailLoading] = React.useState(false);
  const [emailError, setEmailError] = React.useState("");

  // Password change state
  const [currentPassword, setCurrentPassword] = React.useState("");
  const [newPassword, setNewPassword] = React.useState("");
  const [confirmPassword, setConfirmPassword] = React.useState("");
  const [passwordLoading, setPasswordLoading] = React.useState(false);
  const [passwordError, setPasswordError] = React.useState("");
  const [passwordSuccess, setPasswordSuccess] = React.useState("");

  async function handleChangeEmail(e: React.FormEvent) {
    e.preventDefault();
    setEmailError("");

    if (!newEmail.trim()) {
      setEmailError(t`Please enter a new email address`);
      return;
    }

    setEmailLoading(true);
    try {
      await changeEmail(newEmail.trim());
      setEmailSent(true);
    } catch (err: any) {
      setEmailError(errorMessage(err.message));
    } finally {
      setEmailLoading(false);
    }
  }

  async function handleChangePassword(e: React.FormEvent) {
    e.preventDefault();
    setPasswordError("");
    setPasswordSuccess("");

    if (!currentPassword) {
      setPasswordError(t`Please enter your current password`);
      return;
    }

    if (newPassword.length < 8) {
      setPasswordError(t`New password must be at least 8 characters`);
      return;
    }

    if (newPassword !== confirmPassword) {
      setPasswordError(t`Passwords do not match`);
      return;
    }

    setPasswordLoading(true);
    try {
      await changePassword(currentPassword, newPassword);
      setPasswordSuccess(t`Password updated successfully`);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (err: any) {
      setPasswordError(errorMessage(err.message));
    } finally {
      setPasswordLoading(false);
    }
  }

  return (
    <div className={styles.container}>
      {/* Email Change Section */}
      <div className={styles.section}>
        <div className={styles.row}>
          <div className={styles.column}>
            <p className={cn("text-sm", styles.title)}>{t`Email`}</p>
            <p className="text-sm opacity-75">{user?.email}</p>
          </div>
        </div>

        {emailError && (
          <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive mb-3">
            {emailError}
          </div>
        )}

        {!emailSent ? (
          <form onSubmit={handleChangeEmail}>
            <div className={styles.row}>
              <div className={styles.column}>
                <p className="text-sm opacity-75">{t`Enter a new email address`}</p>
              </div>
              <Input
                className={styles.input}
                type="email"
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
                placeholder={t`New email address`}
              />
            </div>
            <div className={styles.actions}>
              <Button
                type="submit"
                disabled={!newEmail.trim() || emailLoading}
                loading={emailLoading}
              >
                {t`Change Email`}
              </Button>
            </div>
          </form>
        ) : (
          <div>
            <div className="rounded-md bg-green-500/10 p-3 text-sm mb-3">
              {t`We sent a verification link to`}{" "}
              <span className="font-medium">{newEmail}</span>.{" "}
              {t`Please check your inbox and click the link to confirm the change.`}
            </div>
            <Button
              variant="ghost"
              onClick={() => {
                setEmailSent(false);
                setNewEmail("");
              }}
            >
              {t`Cancel`}
            </Button>
          </div>
        )}
      </div>

      <hr className="border-border mb-6" />

      {/* Password Change Section */}
      <div className={styles.section}>
        <div className={styles.row}>
          <div className={styles.column}>
            <p className={cn("text-sm", styles.title)}>{t`Password`}</p>
            <p className="text-sm opacity-75">{t`Change your account password`}</p>
          </div>
        </div>

        {passwordError && (
          <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive mb-3">
            {passwordError}
          </div>
        )}

        {passwordSuccess && (
          <div className="rounded-md bg-green-500/10 p-3 text-sm mb-3">
            {passwordSuccess}
          </div>
        )}

        <form onSubmit={handleChangePassword}>
          <div className={styles.row}>
            <div className={styles.column}>
              <p className="text-sm opacity-75">{t`Current password`}</p>
            </div>
            <PasswordInput
              className={styles.input}
              value={currentPassword}
              onChange={(e) => {
                setCurrentPassword(e.target.value);
                setPasswordSuccess("");
              }}
              placeholder={t`Current password`}
            />
          </div>
          <div className={styles.row}>
            <div className={styles.column}>
              <p className="text-sm opacity-75">{t`New password`}</p>
            </div>
            <PasswordInput
              className={styles.input}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder={t`New password`}
            />
          </div>
          <div className={styles.row}>
            <div className={styles.column}>
              <p className="text-sm opacity-75">{t`Confirm new password`}</p>
            </div>
            <PasswordInput
              className={styles.input}
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder={t`Confirm new password`}
            />
          </div>
          <div className={styles.actions}>
            <Button
              type="submit"
              disabled={
                !currentPassword ||
                !newPassword ||
                !confirmPassword ||
                passwordLoading
              }
              loading={passwordLoading}
            >
              {t`Change Password`}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
