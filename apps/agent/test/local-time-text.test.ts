import { DateTime, Option } from "effect";
import { describe, expect, it } from "vitest";

import { quoted } from "../src/approval/approval-summary.ts";
import {
  localDueTimeText,
  recurrenceText,
} from "../src/time/local-time-text.ts";

describe("Plain words for an Approval summary", () => {
  it("writes a local due time with its weekday", () => {
    expect(localDueTimeText("2026-11-26T09:00", Option.none())).toBe(
      "Thu 26 Nov 2026, 09:00"
    );
    expect(localDueTimeText("2027-02-28T23:59", Option.none())).toBe(
      "Sun 28 Feb 2027, 23:59"
    );
    expect(localDueTimeText("2026-02-30T09:00", Option.none())).toBe(
      "2026-02-30T09:00 (not a real date and time)"
    );
  });

  it("says when a local due time falls in a daylight saving gap of the time zone", () => {
    const warsaw = Option.some(DateTime.zoneMakeNamedUnsafe("Europe/Warsaw"));

    expect(localDueTimeText("2026-03-29T02:30", warsaw)).toBe(
      "Sun 29 Mar 2026, 02:30 (this time does not exist in Europe/Warsaw, so it is due Sun 29 Mar 2026, 03:30)"
    );
    expect(localDueTimeText("2026-11-26T09:00", warsaw)).toBe(
      "Thu 26 Nov 2026, 09:00"
    );
  });

  it("writes each repeat rule", () => {
    expect(recurrenceText({ _tag: "Daily", time: "08:00" })).toBe(
      "every day at 08:00"
    );
    expect(
      recurrenceText({
        _tag: "Weekly",
        weekdays: ["Monday", "Wednesday", "Friday"],
        time: "09:00",
      })
    ).toBe("every Monday, Wednesday and Friday at 09:00");
    expect(recurrenceText({ _tag: "Monthly", day: 5, time: "18:00" })).toBe(
      "on day 5 of each month at 18:00"
    );
    expect(
      recurrenceText({ _tag: "Monthly", day: "last", time: "18:00" })
    ).toBe("on the last day of each month at 18:00");
  });

  it("quotes text exactly, with all of its characters and spaces", () => {
    expect(quoted("Call\n  Ana ")).toBe('"Call\n  Ana "');
    expect(quoted("a".repeat(400))).toBe(`"${"a".repeat(400)}"`);
  });
});
