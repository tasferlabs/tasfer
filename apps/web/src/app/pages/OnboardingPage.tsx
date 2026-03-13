import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Camera } from "lucide-react";
import React from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { updateProfile } from "../api/auth.api";
import { getImageUrl, uploadImage } from "../api/images.api";
import { useAuth } from "../contexts/AuthContext";

export default function OnboardingPage() {
  const { t } = useTranslation("OnboardingPage");
  const { updateUser } = useAuth();
  const navigate = useNavigate();

  const [name, setName] = React.useState("");
  const [avatarId, setAvatarId] = React.useState<string | null>(null);
  const [uploading, setUploading] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState("");
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      setUploading(true);
      const image = await uploadImage(file);
      setAvatarId(image.id);
    } catch {
      setError(t`Failed to upload image`);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    const trimmed = name.trim();
    if (!trimmed) {
      setError(t`Please enter your name`);
      return;
    }

    try {
      setSaving(true);
      const updated = await updateProfile({
        name: trimmed,
        ...(avatarId !== null && { avatar: avatarId }),
      });
      updateUser(updated);
      navigate("/", { replace: true });
    } catch {
      setError(t`Failed to save profile`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center space-y-2">
          <h1 className="text-2xl font-semibold text-foreground">
            {t`Welcome to Cypher`}
          </h1>
          <p className="text-sm text-muted-foreground">
            {t`Set up your profile to get started`}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
          {error && (
            <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              {error}
            </div>
          )}

          <div className="flex flex-col items-center gap-3">
            <div
              className="relative w-20 h-20 rounded-full overflow-hidden cursor-pointer flex-shrink-0"
              onClick={() => fileInputRef.current?.click()}
              role="button"
              tabIndex={0}
              onKeyDown={(e) =>
                e.key === "Enter" && fileInputRef.current?.click()
              }
            >
              {avatarId ? (
                <img
                  src={getImageUrl(avatarId)}
                  alt="Avatar"
                  className="w-full h-full object-cover"
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center bg-muted text-muted-foreground text-3xl font-semibold">
                  {name.trim() ? name.trim().charAt(0).toUpperCase() : "?"}
                </div>
              )}
              <div className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 hover:opacity-100 transition-opacity text-white">
                <Camera size={20} />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">{t`Upload a photo (optional)`}</p>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/gif,image/webp"
              onChange={handleFileChange}
              hidden
            />
          </div>

          <div className="space-y-2">
            <label
              htmlFor="name"
              className="text-sm font-medium text-foreground"
            >
              {t`Name`}
            </label>
            <Input
              id="name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t`Your name`}
              required
              autoComplete="name"
              autoFocus
            />
          </div>

          <Button
            type="submit"
            loading={saving || uploading}
            disabled={!name.trim()}
            className="w-full"
          >
            {t`Continue`}
          </Button>
        </form>
      </div>
    </div>
  );
}
