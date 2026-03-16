import type { AwarenessUser } from '@/editor/sync/awareness';
import style from '../layout/Layout.module.css';
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip';
import { getImageUrl } from '../api/images.api';
import { AvatarPreviewDialog } from './AvatarPreviewDialog';
import { useState } from 'react';

interface ActiveUsersAvatarsProps {
  users: AwarenessUser[];
}

export function ActiveUsersAvatars({ users }: ActiveUsersAvatarsProps) {
  const [previewUser, setPreviewUser] = useState<AwarenessUser | null>(null);

  if (users.length === 0) return null;

  return (
    <TooltipProvider delayDuration={300}>
      <div className={style.usersList}>
        {users.map((user) => {
          const initials = user.name
            ? user.name.charAt(0).toUpperCase()
            : user.peerId.charAt(0).toUpperCase();

          return (
            <Tooltip key={user.peerId}>
              <TooltipTrigger asChild>
                <div
                  className={style.userAvatar}
                  style={{
                    ['--avatar-color' as string]: user.color,
                    ['--avatar-color-text' as string]: '#ffffff',
                    borderColor: user.color,
                  }}
                  onClick={() => user.avatar && setPreviewUser(user)}
                >
                  {user.avatar ? (
                    <img src={getImageUrl(user.avatar)} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  ) : (
                    initials
                  )}
                </div>
              </TooltipTrigger>
              <TooltipContent>
                <p>{user.name || user.peerId}</p>
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>

      <AvatarPreviewDialog
        open={!!previewUser}
        onOpenChange={(open) => { if (!open) setPreviewUser(null); }}
        imageUrl={previewUser?.avatar ? getImageUrl(previewUser.avatar) : null}
        name={previewUser?.name}
      />
    </TooltipProvider>
  );
}
