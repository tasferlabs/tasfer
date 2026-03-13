export const Errors = {
  // Common
  INTERNAL_ERROR: "internal_error",
  USER_NOT_FOUND: "user_not_found",

  // Auth
  EMAIL_PASSWORD_REQUIRED: "email_password_required",
  PASSWORD_MIN_LENGTH: "password_min_length",
  EMAIL_ALREADY_IN_USE: "email_already_in_use",
  EMAIL_CODE_REQUIRED: "email_code_required",
  INVALID_VERIFICATION_CODE: "invalid_verification_code",
  EMAIL_ALREADY_VERIFIED: "email_already_verified",
  NO_VERIFICATION_PENDING: "no_verification_pending",
  VERIFICATION_CODE_EXPIRED: "verification_code_expired",
  EMAIL_REQUIRED: "email_required",
  INVALID_CREDENTIALS: "invalid_credentials",
  AUTH_REQUIRED: "auth_required",
  SESSION_EXPIRED: "session_expired",
  SESSION_ID_REQUIRED: "session_id_required",

  // Profile
  NAME_INVALID_LENGTH: "name_invalid_length",
  PROFILE_UPDATE_FAILED: "profile_update_failed",

  // Password reset
  TOKEN_PASSWORD_REQUIRED: "token_password_required",
  INVALID_OR_EXPIRED_LINK: "invalid_or_expired_link",
  LINK_EXPIRED: "link_expired",

  // Email change
  NEW_EMAIL_REQUIRED: "new_email_required",
  EMAIL_SAME_AS_CURRENT: "email_same_as_current",
  TOKEN_REQUIRED: "token_required",
  EMAIL_CHANGE_LINK_EXPIRED: "email_change_link_expired",

  // Password change
  PASSWORDS_REQUIRED: "passwords_required",
  NEW_PASSWORD_MIN_LENGTH: "new_password_min_length",
  CURRENT_PASSWORD_INCORRECT: "current_password_incorrect",
} as const;

export type ErrorCode = (typeof Errors)[keyof typeof Errors];
