import * as DialogPrimitive from "@radix-ui/react-dialog";
import { AnimatePresence, motion } from "framer-motion";
import React from "react";
import { useTranslation } from "react-i18next";
import style from "./Layout.module.css";
import { SidebarContent } from "./SidebarContent";

export function FloatingSidebar({
  open,
  setOpen,
}: {
  open: boolean;
  setOpen: React.Dispatch<React.SetStateAction<boolean>>;
}) {
  const { i18n } = useTranslation();

  return (
    <AnimatePresence>
      {open && (
        <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
          <DialogPrimitive.Portal>
            <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
            <DialogPrimitive.Content asChild>
              <motion.div
                className={style.floatingSidebar}
                initial={{ x: i18n.dir() === "rtl" ? "100%" : "-100%" }}
                animate={{ x: 0 }}
                exit={{ x: i18n.dir() === "rtl" ? "100%" : "-100%" }}
                transition={{ type: "spring", bounce: 0, duration: 0.2 }}
              >
                <SidebarContent setOpen={setOpen} />
              </motion.div>
            </DialogPrimitive.Content>
          </DialogPrimitive.Portal>
        </DialogPrimitive.Root>
      )}
    </AnimatePresence>
  );
}

