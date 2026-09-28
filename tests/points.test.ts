import { describe, expect, it } from "vitest";
import { calculateReservation } from "../src/billing/points";

describe("point reservation allocation", () => {
  it("consumes daily points before bonus points", () => {
    expect(calculateReservation(70, 50, 100)).toEqual({ dailyAmount: 50, bonusAmount: 20 });
  });

  it("uses only daily points when sufficient", () => {
    expect(calculateReservation(30, 50, 100)).toEqual({ dailyAmount: 30, bonusAmount: 0 });
  });

  it("rejects insufficient or invalid reservations", () => {
    expect(calculateReservation(151, 50, 100)).toBeNull();
    expect(calculateReservation(0, 50, 100)).toBeNull();
    expect(calculateReservation(10, -1, 100)).toBeNull();
  });
});
