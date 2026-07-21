/**
 * Locale-aware redirect for legacy unprefixed URLs. Static export has no
 * request-time headers, so the browser chooses from the saved locale or its
 * language preference before React hydrates.
 */
export default function RootRedirect({ pathname }: { pathname: string }) {
  const targetPath = JSON.stringify(pathname);
  const script = `(function(){try{var m=document.cookie.match(/(?:^|;\\s*)locale=(en|ar)(?:;|$)/);var l=m?m[1]:(/^ar(?:-|$)/i.test(navigator.language||'')?'ar':'en');window.location.replace('/'+l+${targetPath});}catch(e){window.location.replace('/en'+${targetPath});}})();`;
  return <script dangerouslySetInnerHTML={{ __html: script }} />;
}
