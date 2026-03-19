import { useState } from "react";
import { useTranslation } from "react-i18next";
import styles from "./Data.module.css";
import { ExportAllDialog } from "@/app/components/ExportAllDialog";
import { ImportAllDialog } from "@/app/components/ImportAllDialog";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

export function Data() {
  const { t } = useTranslation();
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [showImportDialog, setShowImportDialog] = useState(false);

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
