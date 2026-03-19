import { useTranslation } from "react-i18next";
import { Errors } from "@shared/errors";
import type { ErrorCode } from "@shared/errors";

export function useErrorMessage() {
  const { t } = useTranslation();

  const messages: Record<ErrorCode, string> = {
    [Errors.INTERNAL_ERROR]: t("error.somethingWentWrong", "Something went wrong. Please try again."),
    [Errors.USER_NOT_FOUND]: t("error.userNotFound", "User not found."),
    [Errors.EMAIL_PASSWORD_REQUIRED]: t("error.emailAndPasswordRequired", "Email and password are required."),
    [Errors.PASSWORD_MIN_LENGTH]: t("error.passwordMinChars", "Password must be at least 8 characters."),
    [Errors.EMAIL_ALREADY_IN_USE]: t("error.emailAlreadyInUse", "Email already in use."),
    [Errors.EMAIL_CODE_REQUIRED]: t("error.emailAndCodeRequired", "Email and code are required."),
    [Errors.INVALID_VERIFICATION_CODE]: t("error.invalidVerificationCode", "Invalid verification code."),
    [Errors.EMAIL_ALREADY_VERIFIED]: t("error.emailAlreadyVerified", "Email already verified."),
    [Errors.NO_VERIFICATION_PENDING]: t("error.noVerificationCodePending", "No verification code pending. Please request a new one."),
    [Errors.VERIFICATION_CODE_EXPIRED]: t("error.verificationCodeExpired", "Verification code expired. Please request a new one."),
    [Errors.EMAIL_REQUIRED]: t("error.emailIsRequired", "Email is required."),
    [Errors.INVALID_CREDENTIALS]: t("error.invalidEmailOrPassword", "Invalid email or password."),
    [Errors.AUTH_REQUIRED]: t("error.authRequired", "Authentication required."),
    [Errors.SESSION_EXPIRED]: t("error.sessionExpired", "Session expired."),
    [Errors.SESSION_ID_REQUIRED]: t("error.sessionIdRequired", "Session ID is required."),
    [Errors.NAME_INVALID_LENGTH]: t("error.nameLength", "Name must be between 1 and 255 characters."),
    [Errors.PROFILE_UPDATE_FAILED]: t("error.failedToUpdateProfile", "Failed to update profile."),
    [Errors.TOKEN_PASSWORD_REQUIRED]: t("error.tokenAndPasswordRequired", "Token and new password are required."),
    [Errors.INVALID_OR_EXPIRED_LINK]: t("error.invalidOrExpiredLink", "Invalid or expired link."),
    [Errors.LINK_EXPIRED]: t("error.linkExpiredGeneral", "This link has expired. Please request a new one."),
    [Errors.NEW_EMAIL_REQUIRED]: t("error.newEmailRequired", "New email is required."),
    [Errors.EMAIL_SAME_AS_CURRENT]: t("error.newEmailMustDiffer", "New email must be different from current email."),
    [Errors.TOKEN_REQUIRED]: t("error.tokenRequired", "Token is required."),
    [Errors.EMAIL_CHANGE_LINK_EXPIRED]: t("error.linkExpiredEmailChange", "This link has expired. Please request a new email change."),
    [Errors.PASSWORDS_REQUIRED]: t("error.currentAndNewRequired", "Current password and new password are required."),
    [Errors.NEW_PASSWORD_MIN_LENGTH]: t("error.newPasswordMin6Chars", "New password must be at least 6 characters."),
    [Errors.CURRENT_PASSWORD_INCORRECT]: t("error.currentPasswordIncorrect", "Current password is incorrect."),
  };

  return function errorMessage(code: string): string {
    return messages[code as ErrorCode] ?? code;
  };
}
