import type { Metadata } from "next";
import DownloadPage from "@/views/DownloadPage/DownloadPage";

export const metadata: Metadata = {
  title: "Download",
  description:
    "Get Tasfer — the local-first, end-to-end encrypted markdown editor. Run it in your browser today; native desktop and mobile builds are on the way.",
  alternates: { canonical: "/download" },
};

export default function Page() {
  return <DownloadPage />;
}
