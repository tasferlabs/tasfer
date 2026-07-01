import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Check, CircleAlert, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import clsx from "clsx";
import { invariant } from "@shared/invariant";

/**
 * Platform-wide toasts. Call `useToast()` from anywhere under the provider to
 * surface transient status: `toast.error(msg)`, `toast.success(msg)`, or
 * `toast.loading(msg)` for work in progress. A `loading` toast persists until
 * its handle is dismissed or updated (e.g. into a success/error), so callers can
 * flip one toast through the lifecycle of an async action.
 */

type ToastVariant = "default" | "loading" | "success" | "error";

interface ToastOptions {
  message: string;
  variant?: ToastVariant;
  /**
   * Milliseconds before auto-dismiss, or null to persist until dismissed.
   * Defaults: `loading` persists (null); everything else clears after 4s.
   */
  duration?: number | null;
}

/** A live toast the caller can update or remove after showing it. */
export interface ToastHandle {
  id: string;
  dismiss: () => void;
  update: (opts: Partial<ToastOptions>) => void;
}

interface ToastFn {
  (opts: ToastOptions): ToastHandle;
  error: (message: string) => ToastHandle;
  success: (message: string) => ToastHandle;
  loading: (message: string) => ToastHandle;
}

interface ToastContextValue {
  toast: ToastFn;
  dismiss: (id: string) => void;
}

interface ToastItem {
  id: string;
  message: string;
  variant: ToastVariant;
  open: boolean;
}

const ToastContext = createContext<ToastContextValue | undefined>(undefined);

/** Grace period between starting the exit animation and unmounting the toast. */
const EXIT_MS = 180;

function defaultDuration(variant: ToastVariant): number | null {
  return variant === "loading" ? null : 4000;
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const idSeq = useRef(0);

  const clearTimer = useCallback((id: string) => {
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const remove = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  // Play the exit animation, then unmount. Timeout-based rather than tied to
  // animationend so removal stays deterministic when reduced motion disables it.
  const dismiss = useCallback(
    (id: string) => {
      clearTimer(id);
      setToasts((prev) =>
        prev.map((t) => (t.id === id ? { ...t, open: false } : t)),
      );
      timers.current.set(
        id,
        setTimeout(() => remove(id), EXIT_MS),
      );
    },
    [clearTimer, remove],
  );

  const arm = useCallback(
    (id: string, duration: number | null) => {
      clearTimer(id);
      if (duration != null) {
        timers.current.set(
          id,
          setTimeout(() => dismiss(id), duration),
        );
      }
    },
    [clearTimer, dismiss],
  );

  const update = useCallback(
    (id: string, opts: Partial<ToastOptions>) => {
      setToasts((prev) => {
        const existing = prev.find((t) => t.id === id);
        if (!existing) return prev;
        const variant = opts.variant ?? existing.variant;
        const duration =
          opts.duration !== undefined
            ? opts.duration
            : defaultDuration(variant);
        arm(id, duration);
        return prev.map((t) =>
          t.id === id
            ? {
                ...t,
                variant,
                message: opts.message ?? t.message,
                open: true,
              }
            : t,
        );
      });
    },
    [arm],
  );

  const show = useCallback(
    (opts: ToastOptions): ToastHandle => {
      const id = `toast-${idSeq.current++}`;
      const variant = opts.variant ?? "default";
      const duration =
        opts.duration !== undefined ? opts.duration : defaultDuration(variant);
      setToasts((prev) => [
        ...prev,
        { id, message: opts.message, variant, open: true },
      ]);
      arm(id, duration);
      return {
        id,
        dismiss: () => dismiss(id),
        update: (next) => update(id, next),
      };
    },
    [arm, dismiss, update],
  );

  const toast = useMemo<ToastFn>(() => {
    const fn = ((opts: ToastOptions) => show(opts)) as ToastFn;
    fn.error = (message) => show({ message, variant: "error" });
    fn.success = (message) => show({ message, variant: "success" });
    fn.loading = (message) => show({ message, variant: "loading" });
    return fn;
  }, [show]);

  const value = useMemo<ToastContextValue>(
    () => ({ toast, dismiss }),
    [toast, dismiss],
  );

  // Snapshot the timer map for the unmount cleanup below.
  const pendingTimers = timers.current;
  useEffect(
    () => () => {
      pendingTimers.forEach(clearTimeout);
      pendingTimers.clear();
    },
    [pendingTimers],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

function ToastViewport({
  toasts,
  onDismiss,
}: {
  toasts: ToastItem[];
  onDismiss: (id: string) => void;
}) {
  if (toasts.length === 0) return null;
  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom,0px)+1.25rem)] z-[70] flex flex-col items-center gap-2 px-4"
      role="region"
      aria-live="polite"
    >
      {toasts.map((toast) => (
        <ToastRow
          key={toast.id}
          toast={toast}
          onDismiss={() => onDismiss(toast.id)}
        />
      ))}
    </div>
  );
}

function ToastRow({
  toast,
  onDismiss,
}: {
  toast: ToastItem;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  const isError = toast.variant === "error";
  return (
    <div
      data-state={toast.open ? "open" : "closed"}
      className={clsx(
        // Match the app's floating-surface language: popover fill, a hairline
        // foreground ring rather than a solid border, and soft elevation.
        "pointer-events-auto flex max-w-[min(92vw,26rem)] items-center gap-2.5 rounded-lg px-4 py-2.5 text-sm shadow-lg ring-1 duration-150",
        "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-bottom-2",
        "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-bottom-2",
        "motion-reduce:animate-none",
        isError
          ? "bg-card text-destructive ring-destructive/25"
          : "bg-popover text-popover-foreground ring-foreground/10",
      )}
    >
      {toast.variant === "loading" && (
        <span className="size-4 shrink-0 animate-spin rounded-full border-2 border-primary border-t-transparent motion-reduce:animate-none" />
      )}
      {toast.variant === "success" && (
        <Check className="size-4 shrink-0 text-primary" />
      )}
      {isError && <CircleAlert className="size-4 shrink-0 text-current" />}
      <span className="min-w-0 flex-1 leading-snug">{toast.message}</span>
      {toast.variant !== "loading" && (
        <button
          type="button"
          onClick={onDismiss}
          className={clsx(
            "-mr-1.5 grid size-6 shrink-0 place-items-center rounded-md transition-colors",
            "focus-visible:ring-ring/50 outline-hidden focus-visible:ring-2",
            isError
              ? "text-destructive/70 hover:bg-destructive/10 hover:text-destructive"
              : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
          )}
          aria-label={t("common.dismiss", "Dismiss")}
        >
          <X className="size-4" />
        </button>
      )}
    </div>
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  invariant(context, "useToast must be used within a ToastProvider");
  return context;
}
