import { Dialog as DialogPrimitive } from "radix-ui";
import { AnimatePresence, motion } from "framer-motion";
import { XIcon } from "lucide-react";

interface AvatarPreviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  imageUrl: string | null;
  name?: string | null;
}

export function AvatarPreviewDialog({
  open,
  onOpenChange,
  imageUrl,
  name,
}: AvatarPreviewDialogProps) {
  if (!imageUrl) return null;

  return (
    <AnimatePresence>
      {open && (
        <DialogPrimitive.Root open modal>
          <DialogPrimitive.Portal forceMount>
            <DialogPrimitive.Overlay asChild>
              <motion.div
                className="fixed inset-0 z-50 bg-black/50 supports-backdrop-filter:backdrop-blur-2xl"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.25, ease: "easeOut" }}
                onClick={() => onOpenChange(false)}
              />
            </DialogPrimitive.Overlay>
            <DialogPrimitive.Content asChild>
              <motion.div
                className="fixed inset-0 z-50 flex items-center justify-center outline-none"
                initial={{ opacity: 0, scale: 0.9, y: 20 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.9, y: 20 }}
                transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
                onClick={() => onOpenChange(false)}
              >
                <DialogPrimitive.Title className="sr-only">
                  {name || "Avatar"}
                </DialogPrimitive.Title>

                <div
                  className="relative flex flex-col items-center gap-5"
                  onClick={(e) => e.stopPropagation()}
                >
                  <img
                    src={imageUrl}
                    alt={name || "Avatar"}
                    className="max-h-[70vh] max-w-[90vw] sm:max-w-[min(28rem,85vw)] rounded-2xl object-contain shadow-2xl"
                  />
                  {name && (
                    <p className="text-base font-medium text-white/90 drop-shadow-md">
                      {name}
                    </p>
                  )}
                </div>

                <motion.button
                  onClick={() => onOpenChange(false)}
                  className="fixed top-[max(1rem,env(safe-area-inset-top,1rem))] right-[max(1rem,env(safe-area-inset-right,1rem))] z-50 flex size-9 items-center justify-center rounded-full bg-white/10 text-white/80 transition-colors hover:bg-white/20 hover:text-white"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.2, delay: 0.1 }}
                >
                  <XIcon className="size-5" />
                  <span className="sr-only">Close</span>
                </motion.button>
              </motion.div>
            </DialogPrimitive.Content>
          </DialogPrimitive.Portal>
        </DialogPrimitive.Root>
      )}
    </AnimatePresence>
  );
}
