/**
 * Locale-aware redirect for legacy unprefixed URLs. Static export has no
 * request-time headers, so the browser performs the redirect after hydration.
 */
export default function RootRedirect({ pathname }: { pathname: string }) {
  const targetPath = JSON.stringify(pathname);
  const script = `(function(){window.location.replace('/en'+${targetPath});})();`;
  return <script dangerouslySetInnerHTML={{ __html: script }} />;
}
