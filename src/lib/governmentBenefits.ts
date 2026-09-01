import { CPP, OAS, TFSA, getMinimumWithdrawalPercentage } from "@equisoft/tax-ca";

const BENEFIT_REFERENCE_AGE = 65;

export const cppAnnualMaximum = CPP.MAX_PENSION.RETIREMENT;
export const oasAnnualMaximum = OAS.MONTHLY_PAYMENT_MAX * 12;
export const oasClawbackThreshold = OAS.REPAYMENT.MIN;
export const rrifMinimumWithdrawalAge = 71;
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

// Approximates the OAS recovery tax: 15c per dollar of net income (excluding this year's own OAS) above the threshold, up to a full clawback. Real CRA rules use last year's income; thresholds here are inflated forward for a multi-decade projection.
export function calculateOasClawback(grossOasAmount: number, otherTaxableIncome: number, age: number, inflationMultiplier: number) {
  if (grossOasAmount <= 0) return 0;
  const repaymentMin = OAS.REPAYMENT.MIN * inflationMultiplier;
  const repaymentMax = OAS.getRepaymentMax(age) * inflationMultiplier;
  if (otherTaxableIncome <= repaymentMin) return 0;
  if (otherTaxableIncome >= repaymentMax) return grossOasAmount;
  return Math.min(grossOasAmount, (otherTaxableIncome - repaymentMin) * OAS.REPAYMENT.RATIO);
}

// RRIFs must be converted from an RRSP by the end of the year the holder turns 71, then carry a mandatory minimum withdrawal each year based on the fund's value at the start of that year.
export function calculateRrifMinimumWithdrawal(openingRrspBalance: number, age: number) {
  if (age < rrifMinimumWithdrawalAge || openingRrspBalance <= 0) return 0;
  // The prescribed factor table tops out at 95; CRA holds the rate flat at the age-95 factor beyond that.
  return openingRrspBalance * getMinimumWithdrawalPercentage(Math.min(age, 95));
}
