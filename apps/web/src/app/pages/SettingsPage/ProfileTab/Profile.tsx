import { updateProfile } from "@/app/api/auth.api";
import { getImageUrl, uploadImage } from "@/app/api/images.api";
import { useAuth } from "@/app/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { Camera, Trash } from "lucide-react";
import React from "react";
import { useTranslation } from "react-i18next";
import styles from "./Profile.module.css";

export function Profile() {
  const { t } = useTranslation("SettingsPage");
  const { user, updateUser } = useAuth();

  const [name, setName] = React.useState(user?.name ?? "");
  const [avatarId, setAvatarId] = React.useState<string | null>(
    user?.avatar ?? null,
  );
  const [uploading, setUploading] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const hasChanges =
    name !== (user?.name ?? "") || avatarId !== (user?.avatar ?? null);

  function handleAvatarClick() {
    fileInputRef.current?.click();
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      setUploading(true);
      const image = await uploadImage(file);
      setAvatarId(image.id);
    } catch (err) {
      console.error("Failed to upload avatar:", err);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  function handleRemoveAvatar() {
    setAvatarId(null);
  }

  async function handleSave() {
    if (!hasChanges) return;

    try {
      setSaving(true);
      const updated = await updateProfile({
        name: name.trim(),
        avatar: avatarId,
      });
      updateUser(updated);
    } catch (err) {
      console.error("Failed to update profile:", err);
    } finally {
      setSaving(false);
    }
  }

  const initials = (user?.name ?? "?").charAt(0).toUpperCase();

  return (
    <div className={styles.container}>
      <div className={styles.section}>
        <div className={styles.row}>
          <div className={styles.column}>
            <p className={cn("text-sm", styles.title)}>{t`Avatar`}</p>
            <p className="text-sm opacity-75">{t`Click to upload a profile picture`}</p>
          </div>

          <div className={styles.avatarSection}>
            <div className="flex justify-center items-center gap-3">
              {avatarId && (
                <Button
                  variant="destructive"
                  size="icon-sm"
                  onClick={handleRemoveAvatar}
                  className="w-fit px-1 pe-2 gap-1"
                >
                  <Trash size={12} />
                  {t`Remove`}
                </Button>
              )}
              <div
                className={styles.avatarWrapper}
                onClick={handleAvatarClick}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => e.key === "Enter" && handleAvatarClick()}
              >
                {avatarId ? (
                  <img
                    src={getImageUrl(avatarId)}
                    alt="Avatar"
                    className={styles.avatar}
                  />
                ) : (
                  <div className={styles.avatarPlaceholder}>{initials}</div>
                )}
                <div className={styles.avatarOverlay}>
                  <Camera size={20} />
                </div>
              </div>

              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/gif,image/webp"
                onChange={handleFileChange}
                hidden
              />
            </div>
          </div>
        </div>
      </div>

      <div className={styles.section}>
        <div className={styles.row}>
          <div className={styles.column}>
            <p className={cn("text-sm", styles.title)}>{t`Name`}</p>
            <p className="text-sm opacity-75">{t`Your display name`}</p>
          </div>

          <Input
            className={styles.nameInput}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t`Enter your name`}
          />
        </div>
      </div>

      <div className={styles.actions}>
        <Button
          onClick={handleSave}
          disabled={!hasChanges || saving}
          loading={saving || uploading}
        >
          {t`Save`}
        </Button>
      </div>
    </div>
  );
}
