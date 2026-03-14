import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import { Preferences } from "./PreferencesTab/Preferences";
import { Data } from "./DataTab/Data";
import { Profile } from "./ProfileTab/Profile";
import { Security } from "./SecurityTab/Security";
import style from "./SettingsPage.module.css";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

const TABS = ["profile", "security", "preferences", "data"] as const;
const DEFAULT_TAB = "profile";

export default function SettingsPage() {
  const [t] = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();

  const tabParam = searchParams.get("tab") || "";
  const activeTab = (TABS as readonly string[]).includes(tabParam)
    ? tabParam
    : DEFAULT_TAB;

  function handleTabChange(value: string) {
    setSearchParams(value === DEFAULT_TAB ? {} : { tab: value }, {
      replace: true,
    });
  }

  return (
    <div className={style.container}>
      <p className="text-4xl">{t`Settings`}</p>

      <Tabs value={activeTab} onValueChange={handleTabChange}>
        <TabsList className={style.tabsList}>
          <TabsTrigger value="profile">{t`Profile`}</TabsTrigger>
          <TabsTrigger value="security">{t`Security`}</TabsTrigger>
          <TabsTrigger value="preferences">{t`Preferences`}</TabsTrigger>
          <TabsTrigger value="data">{t`Export`}</TabsTrigger>
          {/* <TabsTrigger value="workspace">{t`Workspace`}</TabsTrigger> */}
          {/* <TabsTrigger value="billing">{t`Billing`}</TabsTrigger> */}
          {/* <TabsTrigger value="notifications">{t`Notifications`}</TabsTrigger> */}
        </TabsList>
        <TabsContent value={"profile"}>
          <Profile />
        </TabsContent>
        <TabsContent value={"security"}>
          <Security />
        </TabsContent>
        <TabsContent value={"preferences"}>
          <Preferences />
        </TabsContent>
        <TabsContent value={"data"}>
          <Data />
        </TabsContent>
        {/* <TabsContent value={"workspace"}></TabsContent> */}
        {/* <TabsContent value={"billing"}></TabsContent> */}
        {/* <TabsContent value={"notifications"}></TabsContent> */}
      </Tabs>
    </div>
  );
}
