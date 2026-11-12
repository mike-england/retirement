import { CPP, OAS, TFSA, getMinimumWithdrawalPercentage } from "@equisoft/tax-ca";
import type { OasResidencySettings } from "@/types/retirement";

const BENEFIT_REFERENCE_AGE = 65;

export const cppAnnualMaximum = CPP.MAX_PENSION.RETIREMENT;
export const oasAnnualMaximum = OAS.MONTHLY_PAYMENT_MAX * 12;
export const oasClawbackThreshold = OAS.REPAYMENT.MIN;
export const rrifMinimumWithdrawalAge = 72;
export const tfsaAnnualContributionLimit = TFSA.MAX_CONTRIBUTION;

export function calculateCppAnnualBenefit(annualAmountAt65: number, startAge: number, annualEstimates?: Partial<Record<60 | 65 | 70, number>>) {
  const estimate = annualEstimates?.[startAge as 60 | 65 | 70];
  if (typeof estimate === "number" && Number.isFinite(estimate) && estimate >= 0) return estimate;
  const monthsFromReference = (startAge - BENEFIT_REFERENCE_AGE) * 12;
  const adjustment = monthsFromReference < 0
    ? monthsFromReference * CPP.MONTHLY_DELAY.PENALTY
    : monthsFromReference * CPP.MONTHLY_DELAY.BONUS;
  return Math.max(0, annualAmountAt65 * (1 + adjustment));
}

export function calculateOasAnnualBenefit(annualAmountAt65: number, startAge: number, residency?: OasResidencySettings, payoutRate?: number) {
  const eligibleStartAge = Math.min(70, Math.max(OAS.MIN_AGE, startAge));
  const deferredMonths = (eligibleStartAge - BENEFIT_REFERENCE_AGE) * 12;
  if (typeof payoutRate === "number" && Number.isFinite(payoutRate)) {
    return Math.max(0, annualAmountAt65 * Math.min(1, Math.max(0, payoutRate)) * (1 + deferredMonths * OAS.MONTHLY_DELAY_BONUS));
  }
  const estimate = residency?.annualEstimates?.[eligibleStartAge as 65 | 70];
  if (typeof estimate === "number" && Number.isFinite(estimate) && estimate >= 0) return estimate;
  if (!residency) return Math.max(0, annualAmountAt65 * (1 + deferredMonths * OAS.MONTHLY_DELAY_BONUS));
  const yearsAt65 = Math.min(40, Math.max(0, Math.floor(Number.isFinite(residency.yearsAt65) ? residency.yearsAt65 : 0)));
  const additionalResidence = residency.livesInCanada && residency.continueResidence;
  const yearsAtStart = Math.min(40, yearsAt65 + (additionalResidence ? Math.floor(eligibleStartAge - 65) : 0));
  const minimumYears = residency.livesInCanada ? 10 : 20;
  if (!residency.eligibilityOverride && yearsAtStart < minimumYears) return 0;
  const firstEligibleAge = residency.eligibilityOverride ? 65 : 65 + Math.max(0, minimumYears - yearsAt65);
  const initialYears = Math.min(40, yearsAt65 + (additionalResidence ? firstEligibleAge - 65 : 0));
  const partialWithDeferral = initialYears / 40 * (1 + Math.max(0, eligibleStartAge - firstEligibleAge) * 12 * OAS.MONTHLY_DELAY_BONUS);
  const partialAtStart = yearsAtStart / 40;
  const fullEligibilityAge = yearsAt65 >= 40 ? 65 : additionalResidence ? 65 + 40 - yearsAt65 : Infinity;
  const fullWithDeferral = eligibleStartAge >= fullEligibilityAge ? 1 + (eligibleStartAge - fullEligibilityAge) * 12 * OAS.MONTHLY_DELAY_BONUS : 0;
  return Math.max(0, annualAmountAt65 * Math.max(partialWithDeferral, partialAtStart, fullWithDeferral));
}

// Annual recovery liability uses net income before the recovery deduction; prior-year-based monthly withholding is not modeled.
export function calculateOasClawback(grossOasAmount: number, netIncome: number, age: number, inflationMultiplier: number) {
  if (grossOasAmount <= 0) return 0;
  const repaymentMin = OAS.REPAYMENT.MIN * inflationMultiplier;
  const repaymentMax = OAS.getRepaymentMax(age) * inflationMultiplier;
  if (netIncome <= repaymentMin) return 0;
  if (netIncome >= repaymentMax) return grossOasAmount;
  return Math.min(grossOasAmount, (netIncome - repaymentMin) * OAS.REPAYMENT.RATIO);
}

// RRIFs must be converted from an RRSP by the end of the year the holder turns 71, then carry a mandatory minimum withdrawal each year based on the fund's value at the start of that year.
export function calculateRrifMinimumWithdrawal(openingRrspBalance: number, age: number, conversionAge = rrifMinimumWithdrawalAge - 1) {
  if (age <= conversionAge || openingRrspBalance <= 0) return 0;
  // The prescribed factor table tops out at 95; CRA holds the rate flat at the age-95 factor beyond that.
  return openingRrspBalance * getMinimumWithdrawalPercentage(Math.min(age, 95));
}
