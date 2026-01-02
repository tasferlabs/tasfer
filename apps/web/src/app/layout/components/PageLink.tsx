import { CircleNotch, X } from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { useEffect, useRef, useState } from "react";
import { useDrag, useDrop } from "react-dnd";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  type IListPage,
  useCreatePage,
  useDeletePage,
  useMovePage,
  useUpdatePage,
} from "../../api/pages.api";
import Icons from "../../components/uiKit/Icons/Icons";
import VisuallyHidden from "../../components/uiKit/VisuallyHidden/VisuallyHidden";
import PagesLinks, { type IParentsStack } from "./PagesLinks";
import style from "./PagesLinks.module.css";
import { useConfirmation } from "../../components/ConfirmationDialog";

// Mock t function
const t = (s: string | TemplateStringsArray) => s.toString();

// Mock hooks
const useOutsideClick = ({ element, action, condition }: any) => {
  useEffect(() => {
    if (!condition) return;

    const handleClick = (e: MouseEvent) => {
      if (element.current && !element.current.contains(e.target)) {
        action(e);
      }
    };

    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [condition, element, action]);
};

const mergeRefs = (refs: any[]) => {
  return (node: any) => {
    refs.forEach((ref) => {
      if (typeof ref === "function") {
        ref(node);
      } else if (ref) {
        ref.current = node;
      }
    });
  };
};

export function PageLink({
  data,
  parentsStack = [],
}: {
  data: IListPage;
  parentsStack?: IParentsStack;
}) {
  const queryClient = useQueryClient();
  const { getConfirmation } = useConfirmation();
  const navigate = useNavigate();
  const { id: currentPageId } = useParams<{ id: string }>();
  const inputRef = useRef<HTMLInputElement>(null);
  const [editingPageId, setEditingPageId] = useState<string | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const [localTitle, setLocalTitle] = useState(data.title);

  const { mutate: updatePage } = useUpdatePage({
    onSuccess: (_, variables) => {
      queryClient.setQueryData<IListPage[]>(
        ["pages", { parentId: data.parentId }],
        (old) => {
          return old?.map((page) => {
            if (page.id === variables.id) {
              return { ...page, title: variables.title || page.title };
            }
            return page;
          });
        }
      );
      queryClient.invalidateQueries({
        queryKey: ["pages", { parentId: data.parentId }],
      });
    },
  });

  const { mutate: movePage } = useMovePage({
    onSuccess: (_, variables) => {
      // Invalidate both the old and new parent queries
      queryClient.invalidateQueries({
        queryKey: ["pages", { parentId: data.parentId }],
      });
      queryClient.invalidateQueries({
        queryKey: ["pages", { parentId: variables.parentId }],
      });
    },
  });

  const { mutate: deletePage, isPending: isDeleting } = useDeletePage({
    onSuccess: (_, variables) => {
      queryClient.setQueryData<IListPage[]>(
        ["pages", { parentId: data.parentId }],
        (old) => {
          return old?.filter((page) => page.id !== variables.id);
        }
      );
      queryClient.invalidateQueries({
        queryKey: ["pages", { parentId: data.parentId }],
      });
    },
  });

  const { mutate: createPage, isPending: isCreating } = useCreatePage({
    onSuccess: (newPage) => {
      queryClient.invalidateQueries({
        queryKey: ["pages", { parentId: data.id }],
      });
      queryClient.setQueryData<IListPage[]>(
        ["pages", { parentId: data.parentId }],
        (old) => {
          return old?.map((page) => {
            if (page.id === data.id) {
              return { ...page, hasChildren: true };
            }
            return page;
          });
        }
      );
      setIsExpanded(true);
      // Navigate to the newly created page
      navigate(`/page/${newPage.id}`);
    },
  });

  const [collected, drag] = useDrag(
    () => ({
      type: "pageLink",
      item: { ...data, parentsStack },
      collect: (monitor) => ({
        isDragging: monitor.isDragging(),
      }),
    }),
    [data, parentsStack]
  );

  const [{ isOver }, drop] = useDrop(
    () => ({
      accept: "pageLink",
      drop: (item: IListPage, monitor) => {
        if (item.id === data.id) return;
        const didDrop = monitor.didDrop();
        if (didDrop) return;

        movePage({
          id: item.id,
          parentId: data.id,
        });

        setIsExpanded(true);
      },
      collect: (monitor) => ({
        isOver: monitor.isOver({ shallow: true }),
      }),
    }),
    [data.id]
  );

  useOutsideClick({
    element: inputRef,
    action: (ev: Event) => {
      ev.stopImmediatePropagation();
      handleStopEditing();
    },
    condition: editingPageId === data.id,
  });

  function handleOnChange(title: string): void {
    setLocalTitle(title);
  }

  function handleStopEditing(): void {
    if (localTitle !== data.title) {
      updatePage({ id: data.id, title: localTitle });
    }
    setEditingPageId(null);
  }

  function handleStartEditing() {
    setEditingPageId(data.id);
  }

  async function handleDelete() {
    const confirmed = await getConfirmation({
      title: "Delete Page",
      description: t`Are you sure you want to delete this page?`,
      cancelText: "Cancel",
      confirmText: "Delete",
    });

    if (confirmed) {
      // If we're deleting the currently open page, navigate away first
      if (currentPageId === data.id) {
        navigate("/page");
      }
      deletePage({ id: data.id });
    }
  }

  function handleAdd() {
    createPage({
      title: "",
      content: "# ", // Empty heading 1
      parentId: data.id,
    });
  }

  const isEditing = editingPageId === data.id;

  useEffect(() => {
    function handleWindowFocus() {
      if (isEditing) {
        handleStopEditing();
      }
    }
    window.addEventListener("focusout", handleWindowFocus);
    return () => {
      window.removeEventListener("focusout", handleWindowFocus);
    };
  }, [isEditing]);

  useEffect(() => {
    setLocalTitle(data.title);
  }, [data.title]);

  return (
    <div ref={mergeRefs([drag, drop])}>
      <div
        className={clsx(style.link, { [style.isOver]: isOver })}
        style={{ opacity: collected.isDragging ? 0.5 : 1 }}
      >
        {data.hasChildren && (
          <button
            onClick={() => setIsExpanded((old) => !old)}
            className={style.action}
          >
            {!isExpanded ? (
              <Icons.ChevronRight width={20} height={20} />
            ) : (
              <Icons.ChevronRight
                width={20}
                height={20}
                style={{ transform: "rotate(90deg)" }}
              />
            )}
            <VisuallyHidden>{t`Open sub pages`}</VisuallyHidden>
          </button>
        )}
        <div className={style.linkTitle}>
          {isEditing ? (
            <input
              value={localTitle}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") handleStopEditing();
                if (e.key === "Escape") handleStopEditing();
              }}
              onChange={(e) => handleOnChange(e.target.value)}
              onBlur={() => handleStopEditing()}
              placeholder={t`Untitled`}
              ref={inputRef}
            />
          ) : (
            <Link to={`/page/${data.id}`} onClick={() => setIsExpanded(true)}>
              {data.title || t`Untitled`}
            </Link>
          )}
        </div>
        <div className={style.actions}>
          <button
            onClick={() => {
              if (isEditing) handleStopEditing();
              else handleStartEditing();
            }}
            className={style.action}
          >
            {isEditing ? (
              <X size={20} />
            ) : (
              <Icons.Edit width={20} height={20} />
            )}
            <VisuallyHidden>{t`Edit page`}</VisuallyHidden>
          </button>
          <button
            onClick={() => handleDelete()}
            className={style.action}
            disabled={isDeleting}
          >
            {isDeleting ? (
              <CircleNotch className="spin" size={12} />
            ) : (
              <Icons.Trash width={20} height={20} />
            )}
            <VisuallyHidden>{t`Delete page`}</VisuallyHidden>
          </button>
          <button
            onClick={() => handleAdd()}
            className={style.action}
            disabled={isCreating}
          >
            {isCreating ? (
              <CircleNotch className="spin" size={12} />
            ) : (
              <Icons.Plus width={20} height={20} />
            )}
            <VisuallyHidden>{t`Add page`}</VisuallyHidden>
          </button>
        </div>
      </div>
      {isExpanded && data.hasChildren ? (
        <div className={style.accordion}>
          <PagesLinks parentId={data.id} parentsStack={parentsStack} />
        </div>
      ) : null}
    </div>
  );
}
