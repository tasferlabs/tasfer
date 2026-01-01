import { useGetPages } from "../../api/pages.api";
import { PageLink } from "./PageLink";
import style from "./PagesLinks.module.css";

// Mock t function
const t = (s: string | TemplateStringsArray) => s.toString();

export type IParentsStack = { id: string | null; order: number }[];

export default function PagesLinks({
  parentId = null,
  parentsStack = [],
}: {
  parentId?: string | null;
  parentsStack?: IParentsStack;
}) {
  const { data: pages, isLoading } = useGetPages(parentId);

  if (isLoading) return null;

  return (
    <>
      {pages?.map((link) => (
        <div key={link.id} className={style.linkWrapper}>
          <PageLink
            data={link}
            parentsStack={[
              ...parentsStack,
              { id: parentId, order: link.order },
            ]}
          />
        </div>
      ))}

      {pages?.length === 0 && !!parentId && (
        <div className={style.empty}>
          <p>{t`No pages here`}</p>
        </div>
      )}

      {pages?.length === 0 && !parentId && (
        <div className={style.allEmpty}>
          <p>{t`No pages here yet!`}</p>
        </div>
      )}
    </>
  );
}
