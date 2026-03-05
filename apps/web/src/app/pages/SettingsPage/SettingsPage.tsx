import { useTranslation } from "react-i18next";
import { Preferences } from "./PreferencesTab/Preferences";
import { Data } from "./DataTab/Data";
import style from "./SettingsPage.module.css";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export default function SettingsPage() {
  const [t] = useTranslation("SettingsPage");
  return (
    <div className={style.container}>
      <p className="text-4xl">{t`Settings`}</p>

      <Tabs defaultValue="preferences">
        <TabsList className={style.tabsList}>
          <TabsTrigger value="preferences">{t`Preferences`}</TabsTrigger>
          <TabsTrigger value="data">{t`Export`}</TabsTrigger>
          {/* <TabsTrigger value="profile">{t`Profile`}</TabsTrigger> */}
          {/* <TabsTrigger value="security">{t`Security`}</TabsTrigger> */}
          {/* <TabsTrigger value="workspace">{t`Workspace`}</TabsTrigger> */}
          {/* <TabsTrigger value="billing">{t`Billing`}</TabsTrigger> */}
          {/* <TabsTrigger value="notifications">{t`Notifications`}</TabsTrigger> */}
        </TabsList>
        <TabsContent value={"preferences"}>
          <Preferences />
        </TabsContent>
        <TabsContent value={"data"}>
          <Data />
        </TabsContent>
        {/* <TabsContent value={"profile"}></TabsContent> */}
        {/* <TabsContent value={"security"}>
          <Security />
        </TabsContent> */}
        {/* <TabsContent value={"workspace"}></TabsContent> */}
        {/* <TabsContent value={"billing"}></TabsContent> */}
        {/* <TabsContent value={"notifications"}></TabsContent> */}
      </Tabs>
    </div>
  );
}
