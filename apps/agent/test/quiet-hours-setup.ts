import { DateTime, Effect } from "effect";

import { defaultBehaviorConfig } from "../src/behavior/behavior-config.ts";
import { Journal } from "../src/journal/journal.ts";
import { OwnerPreferences } from "../src/preferences/owner-preferences.ts";
import { moveBriefToNewQuietHoursEnd } from "../src/schedule/brief.ts";
import { Schedules } from "../src/schedule/schedules.ts";

const minutesInDay = 24 * 60;

const clockText = (minutes: number) => {
  const wrapped = ((minutes % minutesInDay) + minutesInDay) % minutesInDay;
  const hour = Math.floor(wrapped / 60);
  const minute = wrapped % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
};

const localMinutesNow = (timeZone: string) => {
  const zone = DateTime.zoneMakeNamedUnsafe(timeZone);
  const { hour, minute } = DateTime.toParts(
    DateTime.setZone(DateTime.nowUnsafe(), zone)
  );
  return hour * 60 + minute;
};

interface MinutesFromNow {
  readonly startMinutes: number;
  readonly endMinutes: number;
}

const quietHoursFromNow = (
  timeZone: string,
  { startMinutes, endMinutes }: MinutesFromNow
) => {
  const localMinutes = localMinutesNow(timeZone);
  return {
    start: clockText(localMinutes + startMinutes),
    end: clockText(localMinutes + endMinutes),
  };
};

export const quietHoursLaterToday = (timeZone: string) =>
  OwnerPreferences.pipe(
    Effect.flatMap((preferences) =>
      preferences.setQuietHours(
        quietHoursFromNow(timeZone, { startMinutes: 120, endMinutes: 180 }),
        defaultBehaviorConfig.quietHours,
        "test-setup"
      )
    )
  );

export const quietHoursAndBriefFromNow = Effect.fnUntraced(
  function* quietHoursAndBriefFromNow(
    timeZone: string,
    minutesFromNow: MinutesFromNow
  ) {
    const preferences = yield* OwnerPreferences;
    const { previous, quietHours } = yield* preferences.setQuietHours(
      quietHoursFromNow(timeZone, minutesFromNow),
      defaultBehaviorConfig.quietHours,
      "test-setup"
    );
    yield* moveBriefToNewQuietHoursEnd(
      { schedules: yield* Schedules, journal: yield* Journal },
      { oldEnd: previous.end, newEnd: quietHours.end, eventId: "test-setup" }
    );
  }
);

export const quietHoursAndBriefLaterToday = (timeZone: string) =>
  quietHoursAndBriefFromNow(timeZone, { startMinutes: 120, endMinutes: 180 });
