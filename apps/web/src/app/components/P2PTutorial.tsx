import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowRight,
  GitBranch,
  Network,
  ShieldAlert,
} from "lucide-react";
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

interface Step {
  icon: React.ElementType;
  titleKey: string;
  titleFallback: string;
  descKey: string;
  descFallback: string;
  accentClass: string;
  glowClass: string;
  ringClass: string;
}

const STEPS: Step[] = [
  {
    icon: Network,
    titleKey: "p2pTutorial.directConnection",
    titleFallback: "Direct connection",
    descKey: "p2pTutorial.directConnectionDesc",
    descFallback:
      "Your devices connect directly to each other. There is no server in between, no cloud, no middleman. Data flows peer-to-peer.",
    accentClass: "text-primary",
    glowClass: "bg-primary/15",
    ringClass: "ring-primary/20 bg-primary/10",
  },
  {
    icon: GitBranch,
    titleKey: "p2pTutorial.dataReplicates",
    titleFallback: "Data lives on every device",
    descKey: "p2pTutorial.dataReplicatesDesc",
    descFallback:
      "When you share a space, a full copy of the data is replicated to every member's device. Each peer holds an independent copy that works offline.",
    accentClass: "text-amber-600 dark:text-amber-400",
    glowClass: "bg-amber-500/15",
    ringClass: "ring-amber-500/20 bg-amber-500/10",
  },
  {
    icon: ShieldAlert,
    titleKey: "p2pTutorial.noTakebacks",
    titleFallback: "What's shared stays shared",
    descKey: "p2pTutorial.noTakebacksDesc",
    descFallback:
      "Once data reaches another device, you cannot take it back. There is no \"unshare\". This is how distributed systems work. Only share with people you trust.",
    accentClass: "text-destructive",
    glowClass: "bg-destructive/15",
    ringClass: "ring-destructive/20 bg-destructive/10",
  },
];

const slideVariants = {
  enter: (direction: number) => ({
    x: direction > 0 ? 80 : -80,
    opacity: 0,
  }),
  center: {
    x: 0,
    opacity: 1,
  },
  exit: (direction: number) => ({
    x: direction > 0 ? -80 : 80,
    opacity: 0,
  }),
};

interface P2PTutorialProps {
  /** Called when the user finishes or dismisses the tutorial. */
  onComplete: () => void;
}

export function P2PTutorial({ onComplete }: P2PTutorialProps) {
  const { t } = useTranslation();
  const [[current, direction], setPage] = useState([0, 0]);

  const step = STEPS[current];
  const isLast = current === STEPS.length - 1;

  const next = useCallback(() => {
    if (isLast) {
      markP2PTutorialSeen();
      onComplete();
    } else {
      setPage([current + 1, 1]);
    }
  }, [current, isLast, onComplete]);

  const Icon = step.icon;

  return (
    <div className="flex flex-col items-center">
      {/* Progress dots */}
      <div className="flex items-center gap-2 mb-6">
        {STEPS.map((_, i) => (
          <div
            key={i}
            className={`h-1.5 rounded-full transition-all duration-300 ${
              i === current
                ? "w-6 bg-primary"
                : i < current
                  ? "w-1.5 bg-primary/40"
                  : "w-1.5 bg-border"
            }`}
          />
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
          transition={{ duration: 0.25, ease: "easeInOut" }}
          className="flex flex-col items-center w-full"
        >
          {/* Icon with glow */}
          <div className="relative mb-5">
            <div
              className={`absolute inset-0 rounded-full blur-2xl scale-150 ${step.glowClass}`}
            />
            <div
              className={`relative flex h-16 w-16 items-center justify-center rounded-full ring-1 ${step.ringClass}`}
            >
              <Icon className={`h-7 w-7 ${step.accentClass}`} />
            </div>
          </div>

          {/* Title */}
          <h2 className="text-lg font-semibold text-foreground text-center">
            {t(step.titleKey, step.titleFallback)}
          </h2>

          {/* Description */}
          <p className="text-sm text-muted-foreground mt-2.5 text-center max-w-[300px] leading-relaxed">
            {t(step.descKey, step.descFallback)}
          </p>

          {/* Step-specific accent bar */}
          <div
            className={`mt-5 h-0.5 w-12 rounded-full opacity-40 ${
              current === 0
                ? "bg-primary"
                : current === 1
                  ? "bg-amber-500"
                  : "bg-destructive"
            }`}
          />
        </motion.div>
      </AnimatePresence>

      {/* Action buttons */}
      <div className="flex w-full gap-2.5 mt-7">
        {!isLast ? (
          <>
            <Button
              variant="ghost"
              className="flex-1 text-muted-foreground"
              onClick={() => {
                markP2PTutorialSeen();
                onComplete();
              }}
            >
              {t("p2pTutorial.skip", "Skip")}
            </Button>
            <Button className="flex-1" onClick={next}>
              {t("common.continue", "Continue")}
              <ArrowRight className="h-4 w-4 ms-1 rtl:-scale-x-100" />
            </Button>
          </>
        ) : (
          <Button className="w-full" onClick={next}>
            {t("p2pTutorial.gotIt", "I understand, continue")}
          </Button>
        )}
      </div>
    </div>
  );
}
