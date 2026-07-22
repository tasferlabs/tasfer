import type { ICalendarPage } from "../../api/pages.api";
import { TitlePreview } from "../../TitlePreview";
import { pageToStartMin, formatTimeRange } from "./utils";
import style from "./CalendarPage.module.css";

export function EventOverlay({
  page,
  deltaMinutes,
}: {
  page: ICalendarPage;
  deltaMinutes: number;
}) {
  const startMin = pageToStartMin(page) + deltaMinutes;
  const duration = page.duration || 60;
  return (
    <div className={style.eventOverlay}>
      <div className={style.eventTitle}>
        <TitlePreview
          title={page.title}
          titleMd={page.titleMd}
          mathFontSize={12}
        />
      </div>
      <div className={style.eventTime}>
        {formatTimeRange(startMin, startMin + duration)}
      </div>
    </div>
  );
}
