import { Archive, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import EmptyStateIllustration from "./illustrations/empty-state";

/**
 * Content-area state for someone who archived every space.
 *
 * The setup flow deliberately does not run again here: this person already has
 * an identity and a profile, and archiving is reversible, so what they need is
 * the two ways back in — not the keypair explainer a first-run user gets.
 * Layout renders this in place of the routed page, so the editor never mounts
 * without a space and never flashes a skeleton it cannot resolve.
 */
export function NoSpacesScreen({
  onCreateSpace,
}: {
  onCreateSpace: () => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();

  return (
    <div className="mx-auto flex h-full w-full max-w-[600px] flex-col items-center justify-center gap-4 p-4 text-center">
      <EmptyStateIllustration className="w-full max-w-[250px] text-muted-foreground/50" />
      <h2 className="text-2xl leading-tight font-bold">
        {t("space.noSpacesOpen", "No spaces open")}
      </h2>
      <p className="text-muted-foreground text-base">
        {t(
          "space.noSpacesOpenHint",
          "Everything you archived is still there. Restoring a space brings its pages back with it.",
        )}
      </p>
      <div className="mt-2 flex flex-wrap items-center justify-center gap-3">
        <Button onClick={onCreateSpace}>
          <Plus className="size-4" />
          {t("space.createSpace", "Create space")}
        </Button>
        <Button variant="outline" onClick={() => navigate("/archive")}>
          <Archive className="size-4" />
          {t("archive.open", "Open Archive")}
        </Button>
      </div>
    </div>
  );
}
