import type { AwarenessUser } from '@cypherkit/editor/sync/awareness';
import style from '../layout/Layout.module.css';
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip';
import { useAssetUrl } from '../api/images.api';
import { AvatarPreviewDialog } from './AvatarPreviewDialog';
import { useState } from 'react';
import { Laptop, Monitor, Smartphone, Tablet } from 'lucide-react';

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
  users: AwarenessUser[];
}

function UserAvatarItem({ user, onClick }: { user: AwarenessUser; onClick: () => void }) {
  const avatarUrl = useAssetUrl(user.avatar);
  const initials = user.name
    ? user.name.charAt(0).toUpperCase()
    : user.peerId.charAt(0).toUpperCase();

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className={style.userAvatar}
          style={{
            ['--avatar-color' as string]: user.color,
            ['--avatar-color-text' as string]: '#ffffff',
            borderColor: user.color,
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
          <span>{user.name || user.peerId}</span>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

export function ActiveUsersAvatars({ users }: ActiveUsersAvatarsProps) {
  const [previewUser, setPreviewUser] = useState<AwarenessUser | null>(null);
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
        name={previewUser?.name}
      />
    </TooltipProvider>
  );
}
