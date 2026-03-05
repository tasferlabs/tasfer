import type { AwarenessUser } from '@/editor/sync/awareness';
import style from '../layout/Layout.module.css';
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip';

interface ActiveUsersAvatarsProps {
  users: AwarenessUser[];
}

export function ActiveUsersAvatars({ users }: ActiveUsersAvatarsProps) {
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
                >
                  {user.avatar ? (
                    <img src={`/api/images/${user.avatar}`} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
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
    </TooltipProvider>
  );
}
