import { useTranslation } from "react-i18next";
import { Errors } from "@shared/errors";
import type { ErrorCode } from "@shared/errors";

export function useErrorMessage() {
  const { t } = useTranslation("errors");

  const messages: Record<ErrorCode, string> = {
    [Errors.INTERNAL_ERROR]: t`Something went wrong. Please try again.`,
    [Errors.USER_NOT_FOUND]: t`User not found.`,
    [Errors.EMAIL_PASSWORD_REQUIRED]: t`Email and password are required.`,
    [Errors.PASSWORD_MIN_LENGTH]: t`Password must be at least 8 characters.`,
    [Errors.EMAIL_ALREADY_IN_USE]: t`Email already in use.`,
    [Errors.EMAIL_CODE_REQUIRED]: t`Email and code are required.`,
    [Errors.INVALID_VERIFICATION_CODE]: t`Invalid verification code.`,
    [Errors.EMAIL_ALREADY_VERIFIED]: t`Email already verified.`,
    [Errors.NO_VERIFICATION_PENDING]: t`No verification code pending. Please request a new one.`,
    [Errors.VERIFICATION_CODE_EXPIRED]: t`Verification code expired. Please request a new one.`,
    [Errors.EMAIL_REQUIRED]: t`Email is required.`,
    [Errors.INVALID_CREDENTIALS]: t`Invalid email or password.`,
    [Errors.AUTH_REQUIRED]: t`Authentication required.`,
    [Errors.SESSION_EXPIRED]: t`Session expired.`,
    [Errors.SESSION_ID_REQUIRED]: t`Session ID is required.`,
    [Errors.NAME_INVALID_LENGTH]: t`Name must be between 1 and 255 characters.`,
    [Errors.PROFILE_UPDATE_FAILED]: t`Failed to update profile.`,
    [Errors.TOKEN_PASSWORD_REQUIRED]: t`Token and new password are required.`,
    [Errors.INVALID_OR_EXPIRED_LINK]: t`Invalid or expired link.`,
    [Errors.LINK_EXPIRED]: t`This link has expired. Please request a new one.`,
    [Errors.NEW_EMAIL_REQUIRED]: t`New email is required.`,
    [Errors.EMAIL_SAME_AS_CURRENT]: t`New email must be different from current email.`,
    [Errors.TOKEN_REQUIRED]: t`Token is required.`,
    [Errors.EMAIL_CHANGE_LINK_EXPIRED]: t`This link has expired. Please request a new email change.`,
    [Errors.PASSWORDS_REQUIRED]: t`Current password and new password are required.`,
    [Errors.NEW_PASSWORD_MIN_LENGTH]: t`New password must be at least 6 characters.`,
    [Errors.CURRENT_PASSWORD_INCORRECT]: t`Current password is incorrect.`,
  };

  return function errorMessage(code: string): string {
    return messages[code as ErrorCode] ?? code;
  };
}
