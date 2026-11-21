import { describe, expect, it } from "vitest";

import { quoted } from "../src/approval/approval-summary.ts";
import {
  localDueTimeText,
  recurrenceText,
} from "../src/time/local-time-text.ts";

describe("Plain words for an Approval summary", () => {
  it("writes a local due time with its weekday", () => {
    expect(localDueTimeText("2026-11-26T09:00")).toBe("Thu 26 Nov 2026, 09:00");
    expect(localDueTimeText("2027-02-28T23:59")).toBe("Sun 28 Feb 2027, 23:59");
    expect(localDueTimeText("2026-02-30T09:00")).toBe(
      "2026-02-30T09:00 (not a real date and time)"
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

  it("quotes text on one line and cuts it at the limit", () => {
    expect(quoted("Call\n  Ana")).toBe('"Call Ana"');
    const cut = quoted("a".repeat(400));
    expect([...cut]).toHaveLength(302);
    expect(cut.endsWith('…"')).toBe(true);
  });
});
