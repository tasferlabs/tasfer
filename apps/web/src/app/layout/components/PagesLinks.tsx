import { LoaderCircle } from "lucide-react";
import { useGetPages } from "../../api/pages.api";
import { PageLink } from "./PageLink";
import style from "./PagesLinks.module.css";
import Icons from "@/app/components/uiKit/Icons/Icons";
import { clsx } from "clsx";
import { useTranslation } from "react-i18next";

export type IParentsStack = { id: string | null; order: number }[];

export default function PagesLinks({
  parentId = null,
  spaceId,
  parentsStack = [],
  handleAdd = () => {},
  isCreating = false,
  color,
}: {
  parentId?: string | null;
  spaceId?: string;
  parentsStack?: IParentsStack;
  handleAdd?: () => void;
  isCreating?: boolean;
  color?: string | null;
}) {
  const { t } = useTranslation();
  const { data: pages, isLoading } = useGetPages(spaceId ?? null, parentId);

  if (isLoading) return null;

  return (
    <>
      {pages?.map((link) => (
        <PageLink
          key={link.id}
          data={link}
          spaceId={spaceId}
          parentsStack={[...parentsStack, { id: parentId, order: link.order }]}
          color={color}
        />
      ))}

      {/* Empty space for breath room for dragging if it is nested*/}
      {parentsStack.length > 0 && <div className={style.emptySpace} />}

      {pages?.length === 0 && !!parentId && (
        <>
          <div className={style.empty}>
            <p>{t("page.noPagesHere", "No pages here")}</p>
          </div>
          <button
            onClick={() => handleAdd()}
            className={style.accordionAddButton}
            disabled={isCreating}
          >
            {isCreating ? (
              <LoaderCircle className="spin" size={16} />
            ) : (
              <Icons.Plus width={16} height={16} />
            )}
            <span>{t("page.addPage", "Add page")}</span>
          </button>
        </>
      )}

      {pages?.length === 0 && !parentId && (
        <div className={clsx(style.allEmpty, "ps-2")} >
          <p>{t("page.noPagesYet", "No pages here yet!")}</p>
        </div>
      )}
    </>
  );
}
