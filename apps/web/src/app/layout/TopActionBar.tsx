import VisuallyHidden from "../components/uiKit/VisuallyHidden/VisuallyHidden";
import React from "react";
import style from "./Layout.module.css";
import { clsx } from "clsx";
import { ListIcon, CaretRightIcon } from "@phosphor-icons/react";
import useResponsive from "../hooks/useResponsive";
import { SavingIndicator } from "../components/SavingIndicator";
import { PageSettings } from "../components/PageSettings";
import { usePageSettings } from "../contexts/PageSettingsContext";
import { useGetPage } from "../api/pages.api";
import { useParams, Link } from "react-router-dom";
import { ActiveUsersAvatars } from "../components/ActiveUsersAvatars";

export function TopActionBar({
  open,
  setOpen,
}: {
  open: boolean;
  setOpen: React.Dispatch<React.SetStateAction<boolean>>;
}) {
  const { id } = useParams<{ id: string }>();
  const isMobile = useResponsive("(max-width: 768px)");

  return (
    <div className={style.appHeader}>
      {(!open || isMobile) && (
        <button
          className={clsx(style.iconButton, style.appHeaderOpenSidebar, {
            [style.visible]: isMobile || !open,
          })}
          onClick={() => setOpen(true)}
        >
          <ListIcon size={20} />
          <VisuallyHidden>Open sidebar</VisuallyHidden>
        </button>
      )}

      {id && <PageActionBar id={id} />}
    </div>
  );
}

function PageActionBar({ id }: { id: string }) {
  const { data: page, isLoading, isError } = useGetPage(id);
  const { isSaving, activeUsers, permission } = usePageSettings();

  return (
    <>
      <div className={style.appHeaderTitles}>
        {page?.parents && page.parents.length > 0 ? (
          page.parents.map((parent, index) => (
            <React.Fragment key={parent.id}>
              {index !== 0 && (
                <span className={style.appHeaderTitleSeparator}>
                  <CaretRightIcon size={16} />
                </span>
              )}
              <Link to={`/page/${parent.id}`} className={style.appHeaderTitle}>
                {parent.title || "Untitled"}
              </Link>
            </React.Fragment>
          ))
        ) : (
          <span className={style.appHeaderTitle}>
            {page?.title || "Untitled"}
          </span>
        )}
      </div>

      <div className="ml-auto flex items-center gap-2">
        <ActiveUsersAvatars users={activeUsers} />
        {permission !== "view" && <SavingIndicator isSaving={isSaving} />}
        {!isLoading && !isError && <PageSettings />}
      </div>
    </>
  );
}
