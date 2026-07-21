import type { Metadata } from "next";
import DownloadPage from "@/views/DownloadPage/DownloadPage";

export const metadata: Metadata = {
  title: "Download",
  description:
    "Download Tasfer for macOS, Windows, or Linux — or open it in your browser. No account, no telemetry; your notes stay on your own disk.",
  alternates: { canonical: "/download" },
};

export default function Page() {
  return <DownloadPage />;
}
