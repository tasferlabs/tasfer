import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { AnimatePresence, motion } from "framer-motion";
import { Check, Lock, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";

const STORAGE_KEY = "cypher:p2p-tutorial-seen";

/** Check whether the user has already completed the P2P tutorial. */
export function hasSeenP2PTutorial(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

/** Mark the tutorial as completed so it won't show again. */
export function markP2PTutorialSeen(): void {
  try {
    localStorage.setItem(STORAGE_KEY, "1");
  } catch {
    // localStorage unavailable
  }
}

const STEP_COUNT = 3;

const slideVariants = {
  enter: (direction: number) => ({ x: direction > 0 ? 60 : -60, opacity: 0 }),
  center: { x: 0, opacity: 1 },
  exit: (direction: number) => ({ x: direction > 0 ? -60 : 60, opacity: 0 }),
};

// -----------------------------------------------------------------------------
// Illustration primitives
// -----------------------------------------------------------------------------

/** A miniature document card used in the step illustrations. */
function MiniDoc({
  width,
  height,
  accent,
  showTitle = true,
}: {
  width: number;
  height: number;
  accent: "primary" | "neutral";
  showTitle?: boolean;
}) {
  const border = accent === "primary" ? "border-primary/40" : "border-border";
  const titleBar = accent === "primary" ? "bg-primary" : "bg-foreground/30";
  const line = accent === "primary" ? "bg-primary/50" : "bg-foreground/15";
  return (
    <div
      className={`flex flex-col gap-1 rounded-lg border bg-background ${border}`}
      style={{ width, height, padding: "8px 8px 0" }}
    >
      {showTitle && (
        <div className={`h-1.5 rounded-full ${titleBar}`} style={{ width: "72%" }} />
      )}
      <div className={`h-1 rounded-full ${line}`} style={{ width: "100%" }} />
      <div className={`h-1 rounded-full ${line}`} style={{ width: "86%" }} />
      <div className={`h-1 rounded-full ${line}`} style={{ width: "94%" }} />
    </div>
  );
}

/** Panel that frames each step's illustration. */
function IllustrationPanel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-4 flex items-center justify-center gap-3.5 rounded-lg border border-primary/20 bg-primary/[0.06] px-4 py-[18px]">
      {children}
    </div>
  );
}

function Caption({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[11px] font-medium text-primary">{children}</span>
  );
}

function MutedCaption({ children }: { children: React.ReactNode }) {
  return <span className="text-[11px] text-muted-foreground">{children}</span>;
}

// -----------------------------------------------------------------------------
// Tutorial
// -----------------------------------------------------------------------------

interface P2PTutorialProps {
  /** Called when the user accepts all steps (the final, gated action). */
  onComplete: () => void;
  /** Called when the user cancels from the first step. */
  onCancel: () => void;
  /** Label for the final primary action. Defaults to "Continue". */
  completeLabel?: string;
}

export function P2PTutorial({
  onComplete,
  onCancel,
  completeLabel,
}: P2PTutorialProps) {
  const { t } = useTranslation();
  const [[current, direction], setPage] = useState([0, 0]);
  const [confirmed, setConfirmed] = useState(false);

  const isLast = current === STEP_COUNT - 1;

  const goto = useCallback(
    (next: number) => {
      const clamped = Math.max(0, Math.min(STEP_COUNT - 1, next));
      setPage(([prev]) => [clamped, clamped >= prev ? 1 : -1]);
    },
    [],
  );

  const complete = useCallback(() => {
    markP2PTutorialSeen();
    onComplete();
  }, [onComplete]);

  return (
    <div className="flex flex-col">
      {/* Progress dots (clickable) */}
      <div className="mb-[18px] flex items-center justify-center gap-0.5">
        {Array.from({ length: STEP_COUNT }, (_, i) => (
          <button
            key={i}
            type="button"
            aria-label={t("p2pTutorial.gotoStep", "Go to step {{n}}", { n: i + 1 })}
            aria-current={i === current}
            onClick={() => goto(i)}
            className="flex rounded-md px-[3px] py-2 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
          >
            <span
              className={`h-1.5 rounded-full transition-all duration-300 ${
                i === current
                  ? "w-6 bg-primary"
                  : i < current
                    ? "w-1.5 bg-primary/40"
                    : "w-1.5 bg-border"
              }`}
            />
          </button>
        ))}
      </div>

      {/* Animated step content */}
      <AnimatePresence mode="wait" custom={direction}>
        <motion.div
          key={current}
          custom={direction}
          variants={slideVariants}
          initial="enter"
          animate="center"
          exit="exit"
          transition={{ duration: 0.22, ease: "easeInOut" }}
          className="flex flex-col"
        >
          {current === 0 && (
            <>
              <IllustrationPanel>
                <div className="flex flex-col items-center gap-[7px]">
                  <MiniDoc width={60} height={76} accent="primary" />
                  <Caption>{t("p2pTutorial.yourSpace", "your space")}</Caption>
                </div>
                <svg
                  width="40"
                  height="16"
                  viewBox="0 0 40 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="text-primary rtl:-scale-x-100"
                >
                  <path d="M2 8 H32" strokeDasharray="3 4" />
                  <path d="M27 3 L33 8 L27 13" />
                </svg>
                <div className="flex flex-col items-center gap-[7px]">
                  <div className="flex h-[46px] w-[46px] items-center justify-center rounded-full border-[1.5px] border-dashed border-primary/70 text-primary">
                    <Plus className="h-[18px] w-[18px]" />
                  </div>
                  <MutedCaption>{t("p2pTutorial.invite", "invite")}</MutedCaption>
                </div>
              </IllustrationPanel>
              <StepText
                title={t("p2pTutorial.step1Title", "Invite someone to this space.")}
                body={t(
                  "p2pTutorial.step1Desc",
                  "Right now this space lives only on your device. Inviting turns it into a shared space — you'll both edit the same notes, live.",
                )}
              />
            </>
          )}

          {current === 1 && (
            <>
              <div className="mb-4 flex flex-col items-center gap-[9px] rounded-lg border border-primary/20 bg-primary/[0.06] p-4">
                <div className="flex items-center gap-3">
                  <MiniDoc width={40} height={54} accent="primary" showTitle={false} />
                  <div className="flex flex-col items-center gap-[5px] text-primary">
                    <Lock className="h-[17px] w-[17px]" />
                    <svg width="56" height="6" viewBox="0 0 56 6" fill="none">
                      <circle cx="3" cy="3" r="2.5" fill="currentColor" />
                      <line
                        x1="6"
                        y1="3"
                        x2="50"
                        y2="3"
                        stroke="currentColor"
                        strokeWidth="1.6"
                        strokeDasharray="1 4"
                        strokeLinecap="round"
                      />
                      <circle cx="53" cy="3" r="2.5" fill="currentColor" />
                    </svg>
                  </div>
                  <MiniDoc width={40} height={54} accent="primary" showTitle={false} />
                </div>
                <span className="text-center text-[11px] text-muted-foreground">
                  {t(
                    "p2pTutorial.relayCaption",
                    "a relay finds your peer — then steps aside",
                  )}
                </span>
              </div>
              <StepText
                title={t("p2pTutorial.step2Title", "It syncs device to device.")}
                body={t(
                  "p2pTutorial.step2Desc",
                  "Cypher connects you directly, over an encrypted link. A thin relay finds your peer, then steps aside — no server ever stores your notes.",
                )}
              />
            </>
          )}

          {current === 2 && (
            <>
              <IllustrationPanel>
                <div className="flex flex-col items-center gap-[7px]">
                  <MiniDoc width={54} height={70} accent="neutral" />
                  <MutedCaption>{t("p2pTutorial.you", "you")}</MutedCaption>
                </div>
                <div className="flex flex-col items-center gap-[5px]">
                  <svg
                    width="42"
                    height="18"
                    viewBox="0 0 42 18"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.7"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="text-primary rtl:-scale-x-100"
                  >
                    <path d="M3 9 H36" />
                    <path d="M29 3 L36 9 L29 15" />
                  </svg>
                  <MutedCaption>{t("p2pTutorial.fullCopy", "full copy")}</MutedCaption>
                </div>
                <div className="flex flex-col items-center gap-[7px]">
                  <MiniDoc width={54} height={70} accent="primary" />
                  <Caption>{t("p2pTutorial.them", "them")}</Caption>
                </div>
              </IllustrationPanel>
              <StepText
                title={t("p2pTutorial.step3Title", "They keep a full copy.")}
                body={t(
                  "p2pTutorial.step3Desc",
                  "Inviting replicates this entire space to their device. Archiving or leaving on your side deletes nothing from theirs — once it's sent, there's no recall.",
                )}
              />

              {/* Permanence confirmation gate */}
              <button
                type="button"
                role="checkbox"
                aria-checked={confirmed}
                onClick={() => setConfirmed((v) => !v)}
                className="mt-3 flex w-full items-start gap-2.5 rounded-md py-1 text-start focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                {confirmed ? (
                  <span className="mt-px flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] bg-primary text-primary-foreground">
                    <Check className="h-3 w-3" strokeWidth={3.5} />
                  </span>
                ) : (
                  <span className="mt-px h-[18px] w-[18px] shrink-0 rounded-[5px] border-[1.5px] border-input bg-background" />
                )}
                <span className="text-[13px] leading-relaxed text-muted-foreground">
                  {t("p2pTutorial.confirmPermanence", "I understand this can't be undone.")}
                </span>
              </button>
            </>
          )}
        </motion.div>
      </AnimatePresence>

      {/* Actions */}
      <div className="mt-5 flex items-center gap-2.5">
        <Button
          variant="ghost"
          className="text-muted-foreground"
          onClick={current === 0 ? onCancel : () => goto(current - 1)}
        >
          {current === 0
            ? t("common.cancel", "Cancel")
            : t("common.back", "Back")}
        </Button>
        <Button
          className="ms-auto"
          disabled={isLast && !confirmed}
          onClick={isLast ? complete : () => goto(current + 1)}
        >
          {isLast
            ? (completeLabel ?? t("common.continue", "Continue"))
            : t("common.continue", "Continue")}
        </Button>
      </div>
    </div>
  );
}

function StepText({ title, body }: { title: string; body: string }) {
  return (
    <>
      <h2 className="text-[22px] font-semibold leading-tight tracking-[-0.01em] text-foreground">
        {title}
      </h2>
      <p className="mt-2 text-[13.5px] leading-relaxed text-muted-foreground">
        {body}
      </p>
    </>
  );
}
