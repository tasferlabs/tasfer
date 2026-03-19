import { useTranslation } from "react-i18next";
import type { ICalendarPage } from "../../api/pages.api";
import { pageToStartMin, formatTimeRange } from "./utils";
import style from "./CalendarPage.module.css";

export function EventOverlay({
  page,
  deltaMinutes,
}: {
  page: ICalendarPage;
  deltaMinutes: number;
}) {
  const { t } = useTranslation();
  const startMin = pageToStartMin(page) + deltaMinutes;
  const duration = page.duration || 60;
  return (
    <div className={style.eventOverlay}>
      <div className={style.eventTitle}>{page.title || t("common.untitled", "Untitled")}</div>
      <div className={style.eventTime}>
        {formatTimeRange(startMin, startMin + duration)}
      </div>
    </div>
  );
}
