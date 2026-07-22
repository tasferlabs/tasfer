import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import styles from "./Data.module.css";
import { ExportAllDialog } from "@/app/components/ExportAllDialog";
import { ImportAllDialog } from "@/app/components/ImportAllDialog";
import { useToast } from "@/app/components/Toast";
import {
  getPersistentStorageStatus,
  requestPersistentStorage,
  type PersistentStorageStatus,
} from "@/lib/persistentStorage";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

export function Data() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [storageStatus, setStorageStatus] =
    useState<PersistentStorageStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    getPersistentStorageStatus().then((status) => {
      if (!cancelled) setStorageStatus(status);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleProtectStorage = async () => {
    const status = await requestPersistentStorage();
    setStorageStatus(status);
    if (status === "protected") {
      toast.success(
        t(
          "storage.protectionEnabled",
          "Your local data is now protected from automatic cleanup.",
        ),
      );
    } else {
      toast({
        message: t(
          "storage.protectionDeclined",
          "Your browser declined the request. Installing Tasfer as an app usually helps — then try again.",
        ),
      });
    }
  };

  return (
    <div className={styles.container}>
      <div className={styles.row}>
        <div className={styles.column}>
          <p className={cn("text-sm", styles.title)}>{t("export.title", "Export")}</p>
          <p className="text-sm opacity-75">{t("export.allAsZip", "Export all pages as a ZIP file")}</p>
        </div>
        <Button variant="outline" onClick={() => setShowExportDialog(true)}>
          {t("export.all", "Export all")}
        </Button>
      </div>

      <div className={styles.row}>
        <div className={styles.column}>
          <p className={cn("text-sm", styles.title)}>{t("import.title", "Import")}</p>
          <p className="text-sm opacity-75">{t("import.fromZipOrMarkdown", "Import pages from a ZIP file or markdown files")}</p>
        </div>
        <Button variant="outline" onClick={() => setShowImportDialog(true)}>
          {t("import.title", "Import")}
        </Button>
      </div>

      {/* Only meaningful in the browser build — native platforms ("native")
          store data in real files outside the browser quota system. */}
      {storageStatus !== null && storageStatus !== "native" && (
        <div className={styles.row}>
          <div className={styles.column}>
            <p className={cn("text-sm", styles.title)}>
              {t("storage.protectionTitle", "Storage protection")}
            </p>
            <p className="text-sm opacity-75">
              {storageStatus === "protected"
                ? t(
                    "storage.protectionOnDesc",
                    "Your browser will keep Tasfer's local data safe from automatic cleanup.",
                  )
                : storageStatus === "unprotected"
                  ? t(
                      "storage.protectionOffDesc",
                      "Your browser may delete Tasfer's local data when disk space runs low. Protect it, or export backups regularly.",
                    )
                  : t(
                      "storage.protectionUnsupportedDesc",
                      "This browser can't guarantee local data won't be cleaned up automatically. Export backups regularly.",
                    )}
            </p>
          </div>
          {storageStatus === "unprotected" && (
            <Button variant="outline" onClick={handleProtectStorage}>
              {t("storage.protect", "Protect data")}
            </Button>
          )}
        </div>
      )}

      <ExportAllDialog
        open={showExportDialog}
        onOpenChange={setShowExportDialog}
      />

      <ImportAllDialog
        open={showImportDialog}
        onOpenChange={setShowImportDialog}
      />
    </div>
  );
}
