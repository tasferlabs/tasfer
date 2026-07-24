# iOS App Store metadata

This directory is the version-controlled source for the iOS App Store listing.
`bundle exec fastlane ios release` stages only the locales enabled by
`IOS_LANGS` in the Fastfile, then uploads that generated copy with the build.
Localized release notes come from `fastlane/release_notes/<lang>.txt`.

Arabic files under `ar-SA/` are intentionally retained but are not currently
uploaded to App Store Connect or TestFlight. Android Arabic remains enabled.

## Before the first release

Fastlane metadata does not replace every App Store Connect setup step. Complete
these once in App Store Connect before dispatching the release workflow:

- Create the iOS app record for bundle ID `app.tasfer`.
- Complete App Privacy answers using Tasfer's actual data practices.
- Complete the age-rating questionnaire, pricing, and availability.
- Review the checked-in English iPhone screenshots under
  `fastlane/screenshots/en-US/` before dispatching the release.
- Confirm the privacy, support, and marketing URLs are publicly reachable.
- Add the four `APP_REVIEW_*` GitHub Actions secrets documented in
  `fastlane/.env.example`.
- Generate an Admin **team key** under App Store Connect **Users and Access →
  Integrations → Team Keys** for the first cloud-signed build. Add its Key ID as
  `ASC_KEY_ID`, the Team Keys page's Issuer ID as `ASC_ISSUER_ID`, and the
  base64-encoded downloaded `.p8` as `ASC_KEY_CONTENT` GitHub Actions secrets.
  All three values must belong to the same active key.
- Add the 10-character Team ID from Apple Developer **Membership details** as
  the `APPLE_TEAM_ID` GitHub Actions secret. It must be the team that owns the
  `app.tasfer` bundle ID.

The release lane uploads the checked-in 6.9-inch iPhone screenshots from
`fastlane/screenshots/en-US/`. No Arabic screenshot directory is sent. Do not
put App Store Connect API keys, review phone numbers, email addresses, or future
demo credentials in this directory.
