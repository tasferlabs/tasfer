import { RESUME_INTO_APP_FN } from "@/lib/appResume";
import { DEFAULT_LNG } from "@/lib/i18n/locales";

/**
 * Locale-aware redirect for legacy unprefixed URLs. Static export has no
 * request-time headers, so the browser performs the redirect after hydration.
 *
 * `pathname` is the unprefixed path, leading and trailing slash included
 * (`trailingSlash` is on, so redirecting to the slashed form avoids a second
 * hop). The `<meta refresh>` covers clients that never run the script.
 *
 * `resumeIntoApp` belongs to the bare root only: it is the app's front door, so
 * it takes the same shortcut the localized landing page does — a browser with a
 * workspace goes straight to the editor rather than through the locale hop
 * first. Every other unprefixed path is a page in its own right, so it just
 * gains the locale prefix.
 */
export default function RootRedirect({
  pathname,
  resumeIntoApp = false,
}: {
  pathname: string;
  resumeIntoApp?: boolean;
}) {
  const target = JSON.stringify(`/${DEFAULT_LNG}${pathname}`);
  const replace = `window.location.replace(${target});`;
  const script = resumeIntoApp
    ? `(function(){if((${RESUME_INTO_APP_FN})())return;${replace}})();`
    : replace;

  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: script }} />
      {!resumeIntoApp && (
        <meta httpEquiv="refresh" content={`0; url=/${DEFAULT_LNG}${pathname}`} />
      )}
    </>
  );
}
