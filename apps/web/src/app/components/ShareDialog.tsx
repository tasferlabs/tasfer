// import { Button } from "@/components/ui/button";
// import {
//   Dialog,
//   DialogContent,
//   DialogDescription,
//   DialogHeader,
//   DialogTitle,
// } from "@/components/ui/dialog";
// import {
//   Drawer,
//   DrawerContent,
//   DrawerFooter,
//   DrawerHeader,
//   DrawerTitle,
// } from "@/components/ui/drawer";
// import { Input } from "@/components/ui/input";
// import {
//   Select,
//   SelectContent,
//   SelectItem,
//   SelectTrigger,
//   SelectValue,
// } from "@/components/ui/select";
// import { Switch } from "@/components/ui/switch";
// import { useQueryClient } from "@tanstack/react-query";
// import { useState } from "react";
// import { useTranslation } from "react-i18next";
// import {
//   useSharePage
// } from "../api/shares.api";
// import useResponsive from "../hooks/useResponsive";
//
// interface ShareDialogProps {
//   pageId: string;
//   open: boolean;
//   onOpenChange: (open: boolean) => void;
// }
//
// export function ShareDialog({ pageId, open, onOpenChange }: ShareDialogProps) {
//   const { t } = useTranslation();
//   const queryClient = useQueryClient();
//   const isMobile = useResponsive("(max-width: 768px)");
//   const [email, setEmail] = useState("");
//   const [permission, setPermission] = useState<"view" | "edit">("view");
//   const [includeChildren, setIncludeChildren] = useState(false);
//   const [error, setError] = useState("");
//
//   const { mutate: sharePage, isPending: isSharing } = useSharePage({
//     onSuccess: () => {
//       queryClient.invalidateQueries({ queryKey: ["page-shares", pageId] });
//       setEmail("");
//       setError("");
//     },
//     onError: (err) => setError(err.message),
//   });
//
//   const handleShare = (e: React.FormEvent) => {
//     e.preventDefault();
//     setError("");
//     if (!email.trim()) return;
//     sharePage({ pageId, email: email.trim(), permission, includeChildren });
//   };
//
//   const content = (
//     <div className="space-y-4">
//       <form onSubmit={handleShare} className="space-y-3">
//         {error && (
//           <div className="rounded-md bg-destructive/10 p-2 text-sm text-destructive">
//             {error}
//           </div>
//         )}
//
//         <div className="flex gap-2">
//           <Input
//             type="email"
//             value={email}
//             onChange={(e) => setEmail(e.target.value)}
//             placeholder={t`Email address`}
//             className="flex-1"
//           />
//           <Select
//             value={permission}
//             onValueChange={(v) => setPermission(v as "view" | "edit")}
//           >
//             <SelectTrigger className="w-24">
//               <SelectValue />
//             </SelectTrigger>
//             <SelectContent>
//               <SelectItem value="view">{t`View`}</SelectItem>
//               <SelectItem value="edit">{t`Edit`}</SelectItem>
//             </SelectContent>
//           </Select>
//         </div>
//
//         <div className="flex items-center justify-between">
//           <label htmlFor="include-children" className="text-sm">
//             {t`Include nested pages`}
//           </label>
//           <Switch
//             id="include-children"
//             checked={includeChildren}
//             onCheckedChange={setIncludeChildren}
//           />
//         </div>
//
//         <Button type="submit" loading={isSharing} className="w-full">
//           {t`Share`}
//         </Button>
//       </form>
//     </div>
//   );
//
//   if (isMobile) {
//     return (
//       <Drawer open={open} onOpenChange={onOpenChange}>
//         <DrawerContent>
//           <div className="mx-auto w-full max-w-sm pb-6">
//             <DrawerHeader>
//               <DrawerTitle>{t`Share page`}</DrawerTitle>
//             </DrawerHeader>
//             <div className="px-4">{content}</div>
//             <DrawerFooter className="pt-4">
//               <Button variant="outline" onClick={() => onOpenChange(false)}>
//                 {t`Close`}
//               </Button>
//             </DrawerFooter>
//           </div>
//         </DrawerContent>
//       </Drawer>
//     );
//   }
//
//   return (
//     <Dialog open={open} onOpenChange={onOpenChange}>
//       <DialogContent>
//         <DialogHeader>
//           <DialogTitle>{t`Share page`}</DialogTitle>
//           <DialogDescription>
//             {t`Invite others to view or edit this page`}
//           </DialogDescription>
//         </DialogHeader>
//         {content}
//       </DialogContent>
//     </Dialog>
//   );
// }
