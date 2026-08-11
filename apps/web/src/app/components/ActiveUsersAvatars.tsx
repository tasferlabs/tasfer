import {
  type CursorUser,
  getColorForPeer,
  getDisplayName,
  isSamePerson,
} from "@tasfer/provider-core/cursors";
import style from '../layout/Layout.module.css';
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip';
import { useAssetUrl } from '../api/images.api';
import { useAuth } from '../contexts/AuthContext';
import { AvatarPreviewDialog } from './AvatarPreviewDialog';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Laptop, Monitor, MonitorSmartphone, Smartphone, Tablet } from 'lucide-react';
import { collidingDisplayNames, isCollidingName } from '@/lib/presenceLabels';
import { groupPresenceByPerson } from '@/lib/presenceGroups';
import { DeviceCountBadge } from './DeviceCountBadge';

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
    default: return <MonitorSmartphone className={cls} />;
  }
}

/** Names a device by its form factor, for the multi-device tooltip. */
function useDeviceLabel(): (deviceType?: string) => string {
  const { t } = useTranslation();
  return (deviceType) => {
    switch (deviceType) {
      case "laptop": return t("common.deviceType.laptop", "Laptop");
      case "desktop": return t("common.deviceType.desktop", "Desktop");
      case "phone": return t("common.deviceType.phone", "Phone");
      case "tablet": return t("common.deviceType.tablet", "Tablet");
      default: return t("common.deviceType.unknown", "Unrecognised device");
    }
  };
}

interface ActiveUsersAvatarsProps {
  users: CursorUser[];
}

function UserAvatarItem({
  user,
  displayName,
  showDevice,
  devices,
  onClick,
}: {
  user: CursorUser;
  displayName: string;
  showDevice: boolean;
  /** Every device this person is here from — one entry means no badge. */
  devices: CursorUser[];
  onClick: () => void;
}) {
  const { t } = useTranslation();
  const deviceLabel = useDeviceLabel();
  const avatarUrl = useAssetUrl(user.avatar);
  const initials = displayName.charAt(0).toUpperCase();
  // Color stays keyed on a per-peer-stable value so distinct anonymous peers
  // still get distinct colors instead of all collapsing onto one.
  const color = user.color ?? getColorForPeer(user.name || user.peerId);
  const multiDevice = devices.length > 1;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className={style.avatarSlot} onClick={onClick}>
          <div
            className={style.userAvatar}
            style={{
              ['--avatar-color' as string]: color,
              ['--avatar-color-text' as string]: '#ffffff',
              borderColor: color,
            }}
          >
            {avatarUrl ? (
              <img src={avatarUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            ) : (
              initials
            )}
          </div>
          <DeviceCountBadge count={devices.length} color={color} />
        </div>
      </TooltipTrigger>
      <TooltipContent>
        {multiDevice ? (
          // The badge says how many; the tooltip says which, so a stack of two
          // is not left as a number to guess at.
          <div className="flex flex-col gap-1">
            <span className="font-medium">{displayName}</span>
            <span className="opacity-70">
              {t("collaboration.connectedFrom", {
                count: devices.length,
                defaultValue_one: "Connected from {{count, number}} device",
                defaultValue_other: "Connected from {{count, number}} devices",
              })}
            </span>
            <ul className="flex flex-col gap-0.5">
              {devices.map((device) => (
                <li key={device.peerId} className="flex items-center gap-1.5">
                  <DeviceIcon deviceType={device.deviceType} />
                  <span>{deviceLabel(device.deviceType)}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <div className="flex items-center gap-1.5">
            {/* The device icon only earns its place when it disambiguates: shown
                solely when another connected user shares this display name. */}
            {showDevice && user.deviceType && <DeviceIcon deviceType={user.deviceType} />}
            <span>{displayName}</span>
          </div>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

export function ActiveUsersAvatars({ users }: ActiveUsersAvatarsProps) {
  const nameFallback = useNameFallback();
  const [previewUser, setPreviewUser] = useState<CursorUser | null>(null);
  const previewAvatarUrl = useAssetUrl(previewUser?.avatar);

  if (users.length === 0) return null;

  // One avatar per person: their other devices and tabs become a count on the
  // badge rather than avatars of their own.
  const people = groupPresenceByPerson(users);
  // Resolve every person's display name once, then flag the ones that collide so
  // a device icon is only added where it's actually needed to tell people apart.
  const displayNames = people.map(({ user }) =>
    getDisplayName(user, nameFallback(user)),
  );
  const colliding = collidingDisplayNames(displayNames);

  return (
    <TooltipProvider delayDuration={300}>
      <div className={style.usersList}>
        {people.map(({ user, devices }, i) => (
          <UserAvatarItem
            key={user.peerId}
            user={user}
            displayName={displayNames[i]}
            showDevice={isCollidingName(displayNames[i], colliding)}
            devices={devices}
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
