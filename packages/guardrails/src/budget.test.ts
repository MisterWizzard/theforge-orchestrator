import { describe, expect, it } from 'vitest';
import {
  adaptiveDailyUsd,
  budgetConfigFromValues,
  budgetPeriod,
  DEFAULT_MAX_DAILY_USD,
  type BudgetConfig,
} from './budget.js';

const budget: BudgetConfig = { monthlyUsd: 200, resetDay: 1, maxDailyUsd: 50 };

describe('budgetPeriod', () => {
  it('is the calendar month when the reset day is the 1st', () => {
    expect(budgetPeriod('2026-10-12', 1)).toEqual({
      start: '2026-10-01',
      next: '2026-11-01',
      daysLeft: 20,
      length: 31,
    });
    expect(budgetPeriod('2026-10-01', 1).daysLeft).toBe(31);
    expect(budgetPeriod('2026-10-31', 1).daysLeft).toBe(1);
  });

  it('runs from the reset day to the day before the next one', () => {
    expect(budgetPeriod('2026-10-12', 15)).toEqual({
      start: '2026-09-15',
      next: '2026-10-15',
      daysLeft: 3,
      length: 30,
    });
    expect(budgetPeriod('2026-10-15', 15).start).toBe('2026-10-15');
  });

  it('crosses a year boundary in both directions', () => {
    expect(budgetPeriod('2026-12-31', 1)).toMatchObject({ next: '2027-01-01', daysLeft: 1 });
    expect(budgetPeriod('2026-01-05', 15)).toMatchObject({
      start: '2025-12-15',
      next: '2026-01-15',
      daysLeft: 10,
    });
  });

  it('counts the length of February correctly', () => {
    expect(budgetPeriod('2027-02-10', 1).length).toBe(28);
    expect(budgetPeriod('2028-02-10', 1).length).toBe(29);
  });

  it('rejects a reset day that not every month has, and a malformed day', () => {
    expect(() => budgetPeriod('2026-10-12', 29)).toThrow(RangeError);
    expect(() => budgetPeriod('2026-10-12', 0)).toThrow(RangeError);
    expect(() => budgetPeriod('2026-10-12', 1.5)).toThrow(RangeError);
    expect(() => budgetPeriod('12/10/2026', 1)).toThrow(RangeError);
  });
});

describe('adaptiveDailyUsd', () => {
  it('starts a period at an even share of the allowance, above the flat floor', () => {
    const cap = adaptiveDailyUsd(6, budget, '2026-10-01', 0);
    expect(cap.dailyUsd).toBe(6.45); // 200 / 31 = 6.4516, floored to the cent
    expect(cap.limitedBy).toBe('pace');
    expect(cap.remainingUsd).toBe(200);
  });

  it('raises the cap when earlier days left money unspent', () => {
    // 11 days in, only $20 spent: $180 over the 20 days left is $9 a day.
    const cap = adaptiveDailyUsd(6, budget, '2026-10-12', 20);
    expect(cap.dailyUsd).toBe(9);
    expect(cap.paceUsd).toBe(9);
    expect(cap.limitedBy).toBe('pace');
  });

  it('lowers the cap toward the floor after a heavy start but not below it while money remains', () => {
    // $150 gone by the 5th: $50 over 27 days is under $2 a day, so the floor holds.
    const cap = adaptiveDailyUsd(6, budget, '2026-10-05', 150);
    expect(cap.dailyUsd).toBe(6);
    expect(cap.limitedBy).toBe('base');
  });

  it('never exceeds what is left, even below the floor', () => {
    const cap = adaptiveDailyUsd(6, budget, '2026-10-10', 195);
    expect(cap.dailyUsd).toBe(5);
    expect(cap.limitedBy).toBe('remaining');
  });

  it('is zero once the allowance is spent, and ignores an overshoot', () => {
    expect(adaptiveDailyUsd(6, budget, '2026-10-10', 200).dailyUsd).toBe(0);
    expect(adaptiveDailyUsd(6, budget, '2026-10-10', 260).dailyUsd).toBe(0);
    expect(adaptiveDailyUsd(6, budget, '2026-10-10', 260).remainingUsd).toBe(0);
  });

  it('goes harder at the end of the period, up to the daily maximum', () => {
    // Three days left with $180 unspent would be $60 a day; the maximum holds it at $50.
    const cap = adaptiveDailyUsd(6, budget, '2026-10-29', 20);
    expect(cap.paceUsd).toBe(60);
    expect(cap.dailyUsd).toBe(50);
    expect(cap.limitedBy).toBe('max');
  });

  it('spends the remainder on the last day when it is under the maximum', () => {
    const cap = adaptiveDailyUsd(6, budget, '2026-10-31', 170);
    expect(cap.dailyUsd).toBe(30);
    expect(cap.limitedBy).toBe('remaining');
  });

  it('floors to the cent so the cap never rounds past the allowance', () => {
    const tight: BudgetConfig = { monthlyUsd: 100, resetDay: 1, maxDailyUsd: 50 };
    // Three days left (29th to 31st): 100 / 3 = 33.333..., floored to 33.33.
    expect(adaptiveDailyUsd(1, tight, '2026-10-29', 0).dailyUsd).toBe(33.33);
    expect(adaptiveDailyUsd(1, tight, '2026-10-29', 0).paceUsd).toBeCloseTo(33.333, 3);
  });

  it('does not move within a day: the cap depends only on spend before the day', () => {
    // The same arguments give the same answer however much has been spent today,
    // because today's spend is not an input.
    expect(adaptiveDailyUsd(6, budget, '2026-10-12', 20)).toEqual(
      adaptiveDailyUsd(6, budget, '2026-10-12', 20),
    );
  });

  it('treats a non-finite or negative spend as nothing spent', () => {
    expect(adaptiveDailyUsd(6, budget, '2026-10-12', Number.NaN).remainingUsd).toBe(200);
    expect(adaptiveDailyUsd(6, budget, '2026-10-12', -5).remainingUsd).toBe(200);
  });

  it('keeps the whole period within the allowance when every day spends its cap', () => {
    // Simulate a month in which each day spends exactly its cap. Spend must never pass the
    // allowance, and the maximum has to be what stops the early days from taking too much.
    let spent = 0;
    for (let day = 1; day <= 31; day += 1) {
      const date = `2026-10-${String(day).padStart(2, '0')}`;
      spent += adaptiveDailyUsd(6, budget, date, spent).dailyUsd;
      expect(spent).toBeLessThanOrEqual(200);
    }
    expect(spent).toBeGreaterThan(190);
  });
});

describe('budgetConfigFromValues', () => {
  it('is off unless a monthly figure is given', () => {
    expect(budgetConfigFromValues({})).toBeUndefined();
    expect(budgetConfigFromValues({ monthlyUsd: '' })).toBeUndefined();
    expect(budgetConfigFromValues({ resetDay: 5, maxDailyUsd: 10 })).toBeUndefined();
  });

  it('takes defaults for the rest', () => {
    expect(budgetConfigFromValues({ monthlyUsd: '200' })).toEqual({
      monthlyUsd: 200,
      resetDay: 1,
      maxDailyUsd: DEFAULT_MAX_DAILY_USD,
    });
  });

  it('accepts strings and numbers and an optional count-from date', () => {
    expect(
      budgetConfigFromValues({
        monthlyUsd: 150.5,
        resetDay: '15',
        maxDailyUsd: '40',
        countFrom: '2026-10-12T00:00:00+11:00',
      }),
    ).toEqual({
      monthlyUsd: 150.5,
      resetDay: 15,
      maxDailyUsd: 40,
      countFrom: '2026-10-12T00:00:00+11:00',
    });
  });

  it('refuses a present-but-unusable value instead of quietly turning the budget off', () => {
    expect(() => budgetConfigFromValues({ monthlyUsd: 'lots' })).toThrow(RangeError);
    expect(() => budgetConfigFromValues({ monthlyUsd: 0 })).toThrow(RangeError);
    expect(() => budgetConfigFromValues({ monthlyUsd: -5 })).toThrow(RangeError);
    expect(() => budgetConfigFromValues({ monthlyUsd: 200, resetDay: 31 })).toThrow(RangeError);
    expect(() => budgetConfigFromValues({ monthlyUsd: 200, maxDailyUsd: 0 })).toThrow(RangeError);
    expect(() => budgetConfigFromValues({ monthlyUsd: 200, countFrom: 'yesterday-ish' })).toThrow(
      RangeError,
    );
  });
});
