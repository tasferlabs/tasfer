import { RESUME_INTO_APP_FN } from "@/lib/appResume";

/**
 * Locale-aware redirect for legacy unprefixed URLs. Static export has no
 * request-time headers, so the browser performs the redirect after hydration.
 *
 * The bare root is also the app's front door, so it takes the same shortcut
 * the localized landing page does — a browser with a workspace goes straight
 * to the editor rather than through the locale hop first.
 */
export default function RootRedirect({ pathname }: { pathname: string }) {
  const targetPath = JSON.stringify(pathname);
  const script = `(function(){if((${RESUME_INTO_APP_FN})())return;window.location.replace('/en'+${targetPath});})();`;
  return <script dangerouslySetInnerHTML={{ __html: script }} />;
}
