import { cn } from "@/lib/utils";
import { publicAssetUrl } from "@/lib/publicAssetUrl";
import { useTranslation } from "react-i18next";

export default function LoadingScreen() {
  const { t } = useTranslation();
  return (
    <div
      className={cn(
        "flex items-center justify-center h-dvh w-full overflow-hidden"
      )}
    >
      <img
        className="animate-spin"
        src={publicAssetUrl("spinner.png")}
        alt={t("common.loading", "Loading...")}
        width={32}
        height={32}
      />
    </div>
  );
}
