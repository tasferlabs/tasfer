import { InternalsEnglishProvider } from "@/views/InternalsPage/InternalsEnglishProvider";

export default function InternalsLayout({ children }: { children: React.ReactNode }) {
  return <InternalsEnglishProvider>{children}</InternalsEnglishProvider>;
}
