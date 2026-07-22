import useResponsive from "@/app/hooks/useResponsive";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  ChevronRight,
  Download,
  Info,
  SlidersHorizontal,
  User,
} from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import { TopActionBarPortal } from "../../layout/TopActionBarSlot";
import { Data } from "./DataTab/Data";
import { Information } from "./InformationTab/Information";
import { Preferences } from "./PreferencesTab/Preferences";
import { Profile } from "./ProfileTab/Profile";
import style from "./SettingsPage.module.css";

const TABS = ["profile", "preferences", "data", "information"] as const;
type Tab = (typeof TABS)[number];
const DEFAULT_TAB = "profile";

const TAB_ICONS: Record<Tab, React.ElementType> = {
  profile: User,
  preferences: SlidersHorizontal,
  data: Download,
  information: Info,
};

const CONTENT: Record<Tab, React.FC> = {
  profile: Profile,
  preferences: Preferences,
  data: Data,
  information: Information,
};

export default function SettingsPage() {
  const [t] = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const isMobile = useResponsive("(max-width: 640px)");
  const [openDrawer, setOpenDrawer] = useState<Tab | null>(null);

  const tabParam = searchParams.get("tab") || "";
  const activeTab = (TABS as readonly string[]).includes(tabParam)
    ? tabParam
    : DEFAULT_TAB;

  function handleTabChange(value: string) {
    setSearchParams(value === DEFAULT_TAB ? {} : { tab: value }, {
      replace: true,
    });
  }

  const tabLabels: Record<Tab, string> = {
    profile: t("settings.profile", "Profile"),
    preferences: t("settings.preferences", "Preferences"),
    data: t("export.title", "Export"),
    information: t("settings.information.title", "Information"),
  };

  if (isMobile) {
    const DrawerContentComponent = openDrawer ? CONTENT[openDrawer] : null;

    return (
      <div className={style.scrollHost}>
        <div className={style.container}>
          <TopActionBarPortal>
            <span className={style.heading}>
              {t("settings.title", "Settings")}
            </span>
          </TopActionBarPortal>

          <div className={style.list}>
            {TABS.map((tab) => {
              const Icon = TAB_ICONS[tab];
              return (
                <button
                  key={tab}
                  className={style.listItem}
                  onClick={() => setOpenDrawer(tab)}
                >
                  <Icon size={20} />
                  <span className={style.listItemLabel}>{tabLabels[tab]}</span>
                  <ChevronRight size={18} className={style.listItemChevron} />
                </button>
              );
            })}
          </div>

          <Drawer
            open={openDrawer !== null}
            onOpenChange={(open) => {
              if (!open) setOpenDrawer(null);
            }}
            direction="bottom"
          >
            <DrawerContent>
              <DrawerHeader>
                <DrawerTitle>
                  {openDrawer ? tabLabels[openDrawer] : ""}
                </DrawerTitle>
              </DrawerHeader>
              <div className={style.drawerBody}>
                {DrawerContentComponent && <DrawerContentComponent />}
              </div>
            </DrawerContent>
          </Drawer>
        </div>
      </div>
    );
  }

  return (
    <div className={style.scrollHost}>
      <div className={style.container}>
        <TopActionBarPortal>
          <span className={style.heading}>
            {t("settings.title", "Settings")}
          </span>
        </TopActionBarPortal>

        <Tabs value={activeTab} onValueChange={handleTabChange}>
          <TabsList className={style.tabsList}>
            <TabsTrigger value="profile">
              {t("settings.profile", "Profile")}
            </TabsTrigger>
            <TabsTrigger value="preferences">
              {t("settings.preferences", "Preferences")}
            </TabsTrigger>
            <TabsTrigger value="data">
              {t("export.title", "Export")}
            </TabsTrigger>
            <TabsTrigger value="information">
              {t("settings.information.title", "Information")}
            </TabsTrigger>
          </TabsList>
          <TabsContent value={"profile"}>
            <Profile />
          </TabsContent>
          <TabsContent value={"preferences"}>
            <Preferences />
          </TabsContent>
          <TabsContent value={"data"}>
            <Data />
          </TabsContent>
          <TabsContent value={"information"}>
            <Information />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
