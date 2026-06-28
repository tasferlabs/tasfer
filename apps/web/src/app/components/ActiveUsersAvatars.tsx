import {
  type CursorUser,
  getColorForPeer,
  getDisplayName,
  isSamePerson,
} from "@cypherkit/provider-core/cursors";
import style from '../layout/Layout.module.css';
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip';
import { useAssetUrl } from '../api/images.api';
import { useAuth } from '../contexts/AuthContext';
import { AvatarPreviewDialog } from './AvatarPreviewDialog';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Laptop, Monitor, Smartphone, Tablet } from 'lucide-react';

/**
 * Label to use when a peer has no display name: "You" when the presence is the
 * local user's own other tab (same device), otherwise a friendly "Anonymous".
 */
function useNameFallback(): (user: CursorUser) => string {
  const { t } = useTranslation();
  const { user: self } = useAuth();
  return (user: CursorUser) =>
    isSamePerson(user, self?.id)
      ? t("collaboration.you", "You")
      : t("collaboration.anonymous", "Anonymous");
}

function DeviceIcon({ deviceType }: { deviceType?: string }) {
  const cls = "h-3 w-3 shrink-0 opacity-70";
  switch (deviceType) {
    case "laptop": return <Laptop className={cls} />;
    case "desktop": return <Monitor className={cls} />;
    case "phone": return <Smartphone className={cls} />;
    case "tablet": return <Tablet className={cls} />;
    default: return null;
  }
}

interface ActiveUsersAvatarsProps {
  users: CursorUser[];
}

function UserAvatarItem({ user, onClick }: { user: CursorUser; onClick: () => void }) {
  const nameFallback = useNameFallback();
  const avatarUrl = useAssetUrl(user.avatar);
  const displayName = getDisplayName(user, nameFallback(user));
  const initials = displayName.charAt(0).toUpperCase();
  // Color stays keyed on a per-peer-stable value so distinct anonymous peers
  // still get distinct colors instead of all collapsing onto one.
  const color = user.color ?? getColorForPeer(user.name || user.peerId);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className={style.userAvatar}
          style={{
            ['--avatar-color' as string]: color,
            ['--avatar-color-text' as string]: '#ffffff',
            borderColor: color,
          }}
          onClick={onClick}
        >
          {avatarUrl ? (
            <img src={avatarUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          ) : (
            initials
          )}
        </div>
      </TooltipTrigger>
      <TooltipContent>
        <div className="flex items-center gap-1.5">
          <DeviceIcon deviceType={user.deviceType} />
          <span>{displayName}</span>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

export function ActiveUsersAvatars({ users }: ActiveUsersAvatarsProps) {
  const nameFallback = useNameFallback();
  const [previewUser, setPreviewUser] = useState<CursorUser | null>(null);
  const previewAvatarUrl = useAssetUrl(previewUser?.avatar);

  if (users.length === 0) return null;

  return (
    <TooltipProvider delayDuration={300}>
      <div className={style.usersList}>
        {users.map((user) => (
          <UserAvatarItem
            key={user.peerId}
            user={user}
            onClick={() => user.avatar && setPreviewUser(user)}
          />
        ))}
      </div>

      <AvatarPreviewDialog
        open={!!previewUser}
        onOpenChange={(open) => { if (!open) setPreviewUser(null); }}
        imageUrl={previewAvatarUrl}
        name={previewUser ? getDisplayName(previewUser, nameFallback(previewUser)) : null}
      />
    </TooltipProvider>
  );
}
