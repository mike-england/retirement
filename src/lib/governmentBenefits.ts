import { CPP, OAS, TFSA, getMinimumWithdrawalPercentage } from "@equisoft/tax-ca";

const BENEFIT_REFERENCE_AGE = 65;

export const cppAnnualMaximum = CPP.MAX_PENSION.RETIREMENT;
export const oasAnnualMaximum = OAS.MONTHLY_PAYMENT_MAX * 12;
export const oasClawbackThreshold = OAS.REPAYMENT.MIN;
export const rrifMinimumWithdrawalAge = 72;
export const tfsaAnnualContributionLimit = TFSA.MAX_CONTRIBUTION;

export function calculateCppAnnualBenefit(annualAmountAt65: number, startAge: number) {
  const monthsFromReference = (startAge - BENEFIT_REFERENCE_AGE) * 12;
  const adjustment = monthsFromReference < 0
    ? monthsFromReference * CPP.MONTHLY_DELAY.PENALTY
    : monthsFromReference * CPP.MONTHLY_DELAY.BONUS;
  return Math.max(0, annualAmountAt65 * (1 + adjustment));
}

export function calculateOasAnnualBenefit(annualAmountAt65: number, startAge: number) {
  const eligibleStartAge = Math.max(OAS.MIN_AGE, startAge);
  const deferredMonths = (eligibleStartAge - BENEFIT_REFERENCE_AGE) * 12;
  return Math.max(0, annualAmountAt65 * (1 + deferredMonths * OAS.MONTHLY_DELAY_BONUS));
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
