import { useMemo } from "react";
import { DateTime } from "luxon";
import { formatDurationLabel, DURATION_OPTIONS } from "@/lib/utils";
import DateTimePicker from "@/components/datetimepickers/DateTimePicker";
import {
  Combobox,
  ComboboxContent,
  ComboboxInput,
  ComboboxList,
  ComboboxItem,
} from "@/components/ui/combobox";
import { useTranslation } from "react-i18next";
import style from "./CalendarPage.module.css";

export function PreviewScheduleControls({
  scheduledAt,
  duration,
  onChange,
}: {
  scheduledAt: string | null;
  duration: number | null;
  onChange: (scheduledAt: string, duration: number | null) => void;
}) {
  const { t } = useTranslation();
  const tz = DateTime.local().zoneName;
  const currentDuration = duration ?? 60;

  const durationLabels = useMemo(
    () => DURATION_OPTIONS.map((d) => formatDurationLabel(d, t)),
    [t],
  );

  const handleDateChange = (value: string | null) => {
    if (!value) return;
    onChange(value, duration);
  };

  const handleDurationChange = (val: string) => {
    const idx = durationLabels.indexOf(val);
    if (idx !== -1 && scheduledAt) onChange(scheduledAt, DURATION_OPTIONS[idx]);
  };

  return (
    <div className={style.previewSchedule}>
      <DateTimePicker
        type="datetime"
        value={scheduledAt}
        onChange={handleDateChange}
        timezone={tz}
        size="small"
      />
      <Combobox
        items={durationLabels}
        value={formatDurationLabel(currentDuration, t)}
        onValueChange={(val) => {
          if (val != null) handleDurationChange(val);
        }}
      >
        <ComboboxInput placeholder={formatDurationLabel(currentDuration, t)} />
        <ComboboxContent>
          <ComboboxList>
            {(item) => (
              <ComboboxItem key={item} value={item}>
                {item}
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
    </div>
  );
}
