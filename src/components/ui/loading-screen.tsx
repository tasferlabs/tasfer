import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

export default function LoadingScreen() {
  const { t } = useTranslation("LoadingScreen");
  return (
    <div className={cn("flex items-center justify-center h-screen w-screen")}>
      <img
        className={" animate-spin  "}
        src={"/spinner.png"}
        alt={t`Loading...`}
        width={32}
      />
    </div>
  );
}
