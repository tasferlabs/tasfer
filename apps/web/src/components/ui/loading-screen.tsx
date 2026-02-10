import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";

export default function LoadingScreen() {
  const { t } = useTranslation();
  return (
    <div
      className={cn(
        "flex items-center justify-center h-screen-dvh w-screen-dvw"
      )}
    >
      <img
        className="animate-spin"
        src="/spinner.png"
        alt={t`Loading...`}
        width={32}
        height={32}
      />
    </div>
  );
}
