import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronDown,
  Laptop,
  MonitorSmartphone,
  Pause,
  Play,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { RelativeDate } from "@/components/ui/relative-date";
import { useConfirmation } from "@/app/components/ConfirmationDialog";
import useMobileLayout from "@/app/hooks/useMobileLayout";
import {
  getDeviceSyncStatus,
  setDeviceSyncPaused,
  useOwnDevices,
} from "@/app/api/devices.api";
import type { DeviceInfo } from "@/platform";
import { cn } from "@/lib/utils";
import styles from "./DeviceList.module.css";
import useResponsive from "@/app/hooks/useResponsive";

/**
 * When this device last heard from another one, by either of the two signals a
 * device carries: an actual connection, and the handshake where it advertised
 * its version vector. The freshest of the two is what "last active" means here
 * — a device can hand over its vector on a connection that carried nothing, and
 * either way it was reachable at that moment.
 */
function lastActiveAt(device: DeviceInfo): number {
  const seen = device.lastSeen ? Date.parse(device.lastSeen) : 0;
  const synced = device.lastSyncedAt ? Date.parse(device.lastSyncedAt) : 0;
  return Math.max(
    Number.isNaN(seen) ? 0 : seen,
    Number.isNaN(synced) ? 0 : synced,
  );
}

/** The freshest activity as an ISO string, or null for a device never met. */
function lastActiveIso(device: DeviceInfo): string | null {
  const at = lastActiveAt(device);
  return at > 0 ? new Date(at).toISOString() : null;
}

/**
 * Most recently active first, devices never met last. The device asking is
 * pinned to the top regardless: it has no activity of its own to sort by — it
 * never connects to itself — so a timestamp would only bury it at random.
 */
function byActivity(a: DeviceInfo, b: DeviceInfo): number {
  if (a.current !== b.current) return a.current ? -1 : 1;
  return lastActiveAt(b) - lastActiveAt(a);
}

/**
 * The whole devices section of Profile: what this identity is joined to, how
 * many, and the two ways in. It keeps the shape the rest of the tab uses — a
 * heading, one line under it, controls on the end side — so the count rides in
 * the button that acts on it rather than taking a line of its own. A count is a
 * fact about what managing would open, not a third thing to read.
 *
 * Linking is the section's own action and belongs to Profile, which owns the
 * dialog, so it arrives as `onLinkDevice`.
 *
 * Pausing is person-private and reversible: it replicates to this person's own
 * devices (so a device paused on the laptop is paused on the phone too), the
 * paused device is never told, and resuming lets the two catch up through the
 * ordinary handshake. It is housekeeping — one fewer connection to keep alive —
 * and deliberately not offered as a way to cut a device off: what it already
 * holds, it keeps.
 */
export function DeviceList({ onLinkDevice }: { onLinkDevice: () => void }) {
  const { t } = useTranslation();
  const devices = useOwnDevices();
  const [open, setOpen] = useState(false);
  const isSmallScreen = useResponsive("(max-width: 768px)");

  // What the count is a count of: the devices this one still talks to. A paused
  // device is one the person has already set aside, and the manager keeps it
  // folded away for the same reason — counting it here would make a number they
  // chose to shrink look like it never moved.
  const liveCount = devices.filter((device) => !device.syncPaused).length;

  // Zero is a number the button can carry: every device paused leaves a list
  // worth opening and nothing to count. English has no plural form for it, so
  // the numberless wording is a key of its own rather than a suffix.
  const manageLabel =
    liveCount === 0
      ? t("device.manageAll", "Manage devices")
      : t("device.manageCount", "Manage {{count, number}} devices", {
          count: liveCount,
        });

  return (
    <>
      <div className={styles.summary}>
        <div className={styles.summaryText}>
          <p className={styles.summaryTitle}>
            {t("device.sectionTitle", "Your devices")}
          </p>
          <p className={styles.summaryDescription}>
            {t(
              "device.sectionDescription",
              "Linked devices share all your spaces and appear as you.",
            )}
          </p>

          {/* Stands where the plain count used to, carrying it: how many
              devices there are answers what managing would open, so it belongs
              under the section's text rather than beside the button linking
              one, where the two would read as rival options. It wears the link
              colour all the same — it is a way in, not a third line to read.
              It appears on having devices, not on the count being above zero:
              with every one of them paused, the way back to them is exactly
              what the person came for. */}
          {devices.length > 0 && !isSmallScreen && (
            <Button
              variant="ghost"
              size="sm"
              className={styles.summaryManage}
              onClick={() => setOpen(true)}
            >
              {manageLabel}
            </Button>
          )}
        </div>

        <div className={styles.summaryActions}>
          <Button variant="outline" onClick={onLinkDevice}>
            <MonitorSmartphone size={16} />
            {t("device.title", "Link a device")}
          </Button>
        </div>
        {devices.length > 0 && isSmallScreen && (
          <Button
            variant="ghost"
            // size="sm"
            // className={styles.summaryManage}
            onClick={() => setOpen(true)}
            // className="mt-2"
          >
            {manageLabel}
          </Button>
        )}
      </div>

      <DeviceManager devices={devices} open={open} onOpenChange={setOpen} />
    </>
  );
}

/**
 * The full list, on the surface the viewport can carry: a drawer where a
 * centred dialog would leave a sliver, a dialog everywhere else.
 */
function DeviceManager({
  devices,
  open,
  onOpenChange,
}: {
  devices: DeviceInfo[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const { isMobile } = useMobileLayout();
  const { getConfirmation } = useConfirmation();
  const [pending, setPending] = useState<string | null>(null);
  const [showPaused, setShowPaused] = useState(false);

  const label = (device: DeviceInfo) =>
    device.note.trim() || t("device.unnamed", "Unnamed device");

  const { live, paused } = useMemo(() => {
    const sorted = [...devices].sort(byActivity);
    return {
      live: sorted.filter((device) => !device.syncPaused),
      paused: sorted.filter((device) => device.syncPaused),
    };
  }, [devices]);

  // With every device paused there is no live list to show instead, so the
  // group opens and its header stops being a control.
  const pausedOpen = showPaused || live.length === 0;

  async function setPaused(device: DeviceInfo, next: boolean) {
    if (next) {
      // Read before asking, not after: whether that device left holding
      // changes nobody else has is the whole of what makes pausing it costly,
      // and it is the one thing the person cannot see for themselves.
      const status = await getDeviceSyncStatus(device.publicKey);
      const stranded = status.unsyncedOps ?? 0;
      const confirmed = await getConfirmation({
        title: t("device.pauseTitle", "Pause syncing with {{name}}?", {
          name: label(device),
        }),
        description:
          stranded > 0
            ? t("device.pauseBodyPending", {
                count: stranded,
                defaultValue_one:
                  "Your devices stop connecting to it until you resume. It last reported {{count, number}} change that never reached this device, and that change stays on it meanwhile.",
                defaultValue_other:
                  "Your devices stop connecting to it until you resume. It last reported {{count, number}} changes that never reached this device, and those changes stay on it meanwhile.",
              })
            : t(
                "device.pauseBody",
                "Your devices stop connecting to it until you resume. Anything written on it while it is paused stays there.",
              ),
        confirmText: t("device.pauseConfirm", "Pause"),
      });
      if (!confirmed) return;
    }

    setPending(device.publicKey);
    try {
      await setDeviceSyncPaused(device.publicKey, next);
    } finally {
      setPending(null);
    }
  }

  const title = t("device.sectionTitle", "Your devices");
  const description = t(
    "device.manageDescription",
    "Pausing a device stops your devices dialling it until you resume. Nothing on it is deleted, and it is never told.",
  );

  const Title = isMobile ? DrawerTitle : DialogTitle;
  const Description = isMobile ? DrawerDescription : DialogDescription;
  const Header = isMobile ? DrawerHeader : DialogHeader;

  const body = (
    <>
      <Header className={styles.header}>
        <Title>{title}</Title>
        <Description>{description}</Description>
      </Header>

      <div className={styles.list}>
        {live.map((device) => (
          <DeviceRow
            key={device.publicKey}
            device={device}
            name={label(device)}
            busy={pending === device.publicKey}
            onSetPaused={setPaused}
          />
        ))}

        {paused.length > 0 && (
          <>
            {/* Folded away by default: these are the devices the person has
                already decided about, kept to hand only for undoing it. With
                nothing live left, it opens — an empty sheet says less. */}
            <button
              type="button"
              className={styles.groupLabel}
              onClick={() => setShowPaused((v) => !v)}
              aria-expanded={pausedOpen}
              aria-controls="device-list-paused"
              disabled={live.length === 0}
            >
              <ChevronDown
                size={14}
                aria-hidden
                className={cn(
                  styles.disclosure,
                  !pausedOpen && styles.collapsed,
                )}
              />
              {t("device.pausedGroup", "Paused")}
              <span className={styles.groupCount}>· {paused.length}</span>
            </button>
            <div id="device-list-paused" className={styles.group}>
              {pausedOpen &&
                paused.map((device) => (
                  <DeviceRow
                    key={device.publicKey}
                    device={device}
                    name={label(device)}
                    busy={pending === device.publicKey}
                    onSetPaused={setPaused}
                  />
                ))}
            </div>
          </>
        )}
      </div>

      {/* This surface's dialog wears no close cross, so it says its own way out.
          Nothing here is staged — every button has already taken effect — so it
          dismisses rather than commits. */}
      <div className={styles.footer}>
        <Button variant="outline" onClick={() => onOpenChange(false)}>
          {t("common.done", "Done")}
        </Button>
      </div>
    </>
  );

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={onOpenChange}>
        <DrawerContent>
          <div className={styles.drawerBody}>{body}</div>
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={styles.dialog}>{body}</DialogContent>
    </Dialog>
  );
}

function DeviceRow({
  device,
  name,
  busy,
  onSetPaused,
}: {
  device: DeviceInfo;
  name: string;
  busy: boolean;
  onSetPaused: (device: DeviceInfo, next: boolean) => void;
}) {
  const { t } = useTranslation();
  const activeAt = lastActiveIso(device);

  return (
    <div className={cn(styles.row, device.syncPaused && styles.rowPaused)}>
      <Laptop size={16} className={styles.icon} aria-hidden />
      <div className={styles.text}>
        <p className={styles.name}>
          <span className={styles.nameText}>{name}</span>
          {device.current && (
            <span className={styles.badge}>
              {t("device.thisDevice", "This device")}
            </span>
          )}
        </p>
        <p className={styles.meta}>
          {device.current && device.syncPaused ? (
            // A device cannot pause or resume itself, so this one can only
            // report the decision and say where it can be undone.
            t(
              "device.pausedHere",
              "Paused from another of your devices — resume it there.",
            )
          ) : device.current ? (
            // "Last active" is last contact with another device, and a device
            // never dials itself — so the one asking has no such moment, and
            // saying it "never connected" reads as a fault. When it was linked
            // is the true thing this row can say about itself.
            <>
              {t("device.linkedPrefix", "Linked")}{" "}
              <RelativeDate date={device.linkedAt} />
            </>
          ) : activeAt ? (
            <RelativeDate date={activeAt} />
          ) : (
            t("device.neverConnected", "Never connected")
          )}
        </p>
      </div>
      {/* The device answering has nothing to pause: it is the one asking. */}
      {!device.current &&
        (device.syncPaused ? (
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => onSetPaused(device, false)}
            aria-label={t(
              "device.resumeLabel",
              "Resume syncing with {{name}}",
              {
                name,
              },
            )}
          >
            <Play size={14} aria-hidden />
            {t("device.resume", "Resume")}
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => onSetPaused(device, true)}
            aria-label={t("device.pauseLabel", "Pause syncing with {{name}}", {
              name,
            })}
          >
            <Pause size={14} aria-hidden />
            {t("device.pauseConfirm", "Pause")}
          </Button>
        ))}
    </div>
  );
}
