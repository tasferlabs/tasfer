import { CircleNotch } from "@phosphor-icons/react";
import { useGetPages } from "../../api/pages.api";
import { PageLink } from "./PageLink";
import style from "./PagesLinks.module.css";
import Icons from "@/app/components/uiKit/Icons/Icons";

// Mock t function
const t = (s: string | TemplateStringsArray) => s.toString();

export type IParentsStack = { id: string | null; order: number }[];

export default function PagesLinks({
  parentId = null,
  parentsStack = [],
  handleAdd = () => {},
  isCreating = false,
}: {
  parentId?: string | null;
  parentsStack?: IParentsStack;
  handleAdd?: () => void;
  isCreating?: boolean;
}) {
  const { data: pages, isLoading } = useGetPages(parentId);

  if (isLoading) return null;

  return (
    <>
      {pages?.map((link) => (
        <PageLink
          key={link.id}
          data={link}
          parentsStack={[...parentsStack, { id: parentId, order: link.order }]}
        />
      ))}

      {/* Empty space for breath room for dragging if it is nested*/}
      {parentsStack.length > 0 && <div className={style.emptySpace} />}

      {pages?.length === 0 && !!parentId && (
        <>
          <div className={style.empty}>
            <p>{t`No pages here`}</p>
          </div>
          <button
            onClick={() => handleAdd()}
            className={style.accordionAddButton}
            disabled={isCreating}
          >
            {isCreating ? (
              <CircleNotch className="spin" size={16} />
            ) : (
              <Icons.Plus width={16} height={16} />
            )}
            <span>{t`Add page`}</span>
          </button>
        </>
      )}

      {pages?.length === 0 && !parentId && (
        <div className={style.allEmpty}>
          <p>{t`No pages here yet!`}</p>
        </div>
      )}
    </>
  );
}
