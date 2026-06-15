import InternalsIndex from "@/views/InternalsPage/InternalsIndex";

/**
 * Hidden internals build log — a static `/docs/internals` segment. It sits beside
 * the dynamic `[section]/[slug]` docs route (which needs two segments), so it
 * resolves here and is not enumerated by the docs nav. Lists the build-log notes
 * (src/views/InternalsPage/internalsNav.tsx); each links to /docs/internals/:slug.
 */
export default function Page() {
  return <InternalsIndex />;
}
