import type {
  AccountBalances,
  AccountWithdrawals,
  ContributionSchedule,
  DeterministicProjection,
  GicBufferSettings,
  GicFundingSource,
  GicHolding,
  GicMaturityAction,
  GicPositionState,
  IncomeBySource,
  IncomeStream,
  ProvinceCode,
  RetirementInputs,
  SubPeriodProjection,
  TaxRateBracket,
  TaxResult,
  TaxSettings,
  WithdrawalAccount,
  WithdrawalFrequency,
  YearProjection,
} from "@/types/retirement";
import { defaultTaxSettings } from "@/lib/taxRules";
import {
  calculateCppAnnualBenefit,
  calculateOasAnnualBenefit,
  calculateOasClawback,
  calculateRrifMinimumWithdrawal,
  cppAnnualMaximum,
  oasAnnualMaximum,
  tfsaAnnualContributionLimit,
} from "@/lib/governmentBenefits";

type TaxableIncome = {
  ordinaryIncome: number;
  capitalGains: number;
  eligibleDividends: number;
  nonEligibleDividends: number;
};

// A GicHolding config with its rate already converted to an effective annual rate, ready to instantiate as a GicPositionState.
type ResolvedGicConfig = {
  id: string;
  balance: number;
  annualRate: number;
  termYears: number;
  startAge: number;
  fundingSource: GicFundingSource;
  maturityAction: GicMaturityAction;
};

// Each person files their own tax return: their own brackets, basic personal amount, and only their own accounts/income count toward it.
type PersonRoster = {
  id: string;
  label: string;
  currentAge: number;
  targetDeathAge: number;
  birthMonth?: number;
  receivesCpp: boolean;
  cppPayoutRate: number;
  receivesOas: boolean;
  gicConfigs: ResolvedGicConfig[];
};

type PersonYearState = {
  id: string;
  age: number;
  balances: AccountBalances;
  income: IncomeBySource;
  withdrawals: AccountWithdrawals;
  fixedTaxable: TaxableIncome;
  tax: TaxResult;
  cashContribution: number;
  monthlyRrspContribution: number;
  monthlyTfsaContribution: number;
  monthlyNonRegisteredContribution: number;
};

export type ProjectionOptions = {
  calendarYear?: number;
  annualReturns?: number[];
  annualInflation?: number[];
  // Per year index, the realized return for each sub-period (month/quarter/half) when withdrawalFrequency isn't "annual". Falls back to an internally generated split if omitted.
  subPeriodReturns?: number[][];
};

export function subPeriodsPerYear(frequency: WithdrawalFrequency | undefined): number {
  switch (frequency) {
    case "monthly": return 12;
    case "quarterly": return 4;
    case "semiAnnual": return 2;
    default: return 1;
  }
}

// How much the sub-period returns are allowed to wobble around their share of the (already-drawn) annual return.
const SUB_PERIOD_VOLATILITY_DAMPING = 0.6;

const DEFAULT_WITHDRAWAL_ORDER: WithdrawalAccount[] = ["interestBearing", "nonRegistered", "tfsa", "rrsp"];

// Reserved while the market sub-portfolio is near its peak (drawdown below recoveryDrawdown), drawn first once a real
// drawdown hits (past triggerDrawdown), with hysteresis in between so a single noisy year doesn't flip the mode back and forth.
function nextGicBufferMode(
  previousMode: "reserve" | "draw",
  drawdown: number,
  triggerDrawdown: number,
  recoveryDrawdown: number,
): "reserve" | "draw" {
  if (previousMode === "draw") return drawdown <= recoveryDrawdown ? "reserve" : "draw";
  return drawdown >= triggerDrawdown ? "draw" : "reserve";
}

function effectiveWithdrawalOrder(baseOrder: WithdrawalAccount[], bufferMode: "reserve" | "draw"): WithdrawalAccount[] {
  const withoutGic = baseOrder.filter((account) => account !== "interestBearing");
  return bufferMode === "draw" ? ["interestBearing", ...withoutGic] : [...withoutGic, "interestBearing"];
}

function totalInterestBearingAcross(balancesByPerson: Record<string, AccountBalances>) {
  return Object.values(balancesByPerson).reduce((sum, balances) => sum + balances.interestBearing, 0);
}

// Splits one year's already-drawn annual return into N sub-period returns that compound back to exactly that annual number,
// so a down year isn't withdrawn from as if returns were flat all year, without changing any annual-level Monte Carlo statistics.
export function decomposeAnnualReturn(
  random: () => number,
  annualReturn: number,
  subPeriodCount: number,
  annualStdDev: number,
): number[] {
  if (subPeriodCount <= 1) return [annualReturn];
  const targetLogReturn = Math.log(1 + Math.max(annualReturn, -0.999));
  const subPeriodStdDev = (Math.max(0, annualStdDev) * SUB_PERIOD_VOLATILITY_DAMPING) / Math.sqrt(subPeriodCount);
  const rawLogReturns = Array.from(
    { length: subPeriodCount },
    () => targetLogReturn / subPeriodCount + subPeriodStdDev * standardNormal(random),
  );
  const drift = (targetLogReturn - rawLogReturns.reduce((sum, value) => sum + value, 0)) / subPeriodCount;
  return rawLogReturns.map((logReturn) => Math.exp(logReturn + drift) - 1);
}

function standardNormal(random: () => number) {
  const first = Math.max(random(), Number.MIN_VALUE);
  const second = random();
  return Math.sqrt(-2 * Math.log(first)) * Math.cos(2 * Math.PI * second);
}

// Abramowitz & Stegun 7.1.26 error-function approximation (max error ~1.5e-7).
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * absX);
  const poly = ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
  return sign * (1 - poly * Math.exp(-absX * absX));
}

function standardNormalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

// Peter Acklam's rational approximation of the inverse standard normal CDF (relative error < 1.15e-9).
function inverseStandardNormalCdf(p: number): number {
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const pLow = 0.02425;
  const pHigh = 1 - pLow;
  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p <= pHigh) {
    const q = p - 0.5;
    const r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q
      / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  const q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
    / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

// A proper truncated normal, sampled via inverse-CDF (not rejection sampling or a clip-and-shift transform): pick a
// uniform value between how much probability mass sits below the floor and below the ceiling, then invert it back to
// a return. This always succeeds in one step and never artificially piles years up exactly at a bound (unlike hard
// clamping) - density naturally tapers off approaching floor/ceiling instead. The underlying (pre-truncation) mean is
// solved for (not just set to targetMean) so the truncated distribution's actual average still lands on target -
// this is what naturally "prefers one side": if floor/ceiling sit off-center from targetMean, the solved mean skews
// the shape toward whichever side has more room, rather than forcing symmetric floor/ceiling to get an accurate
// average. Shared by the deterministic Ledger path and Monte Carlo.
export function sampleAnnualReturn(random: () => number, targetMean: number, standardDeviation: number, floor: number, ceiling: number): number {
  if (ceiling <= floor) return targetMean;
  const stdDev = Math.max(0, standardDeviation);
  if (stdDev === 0) return Math.min(ceiling, Math.max(floor, targetMean));
  const untruncatedMean = solveUntruncatedMean(targetMean, stdDev, floor, ceiling);
  const probabilityBelowFloor = standardNormalCdf((floor - untruncatedMean) / stdDev);
  const probabilityBelowCeiling = standardNormalCdf((ceiling - untruncatedMean) / stdDev);
  const uniformInRange = probabilityBelowFloor + random() * Math.max(0, probabilityBelowCeiling - probabilityBelowFloor);
  const clampedUniform = Math.min(1 - 1e-12, Math.max(1e-12, uniformInRange));
  const value = untruncatedMean + inverseStandardNormalCdf(clampedUniform) * stdDev;
  return Math.min(ceiling, Math.max(floor, value));
}

function standardNormalPdf(z: number): number {
  return Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
}

// Mean of a normal(mu, stdDev) truncated to [floor, ceiling].
function truncatedNormalMean(mu: number, stdDev: number, floor: number, ceiling: number): number {
  const alpha = (floor - mu) / stdDev;
  const beta = (ceiling - mu) / stdDev;
  const mass = standardNormalCdf(beta) - standardNormalCdf(alpha);
  if (mass <= 1e-12) return Math.min(ceiling, Math.max(floor, mu));
  return mu + stdDev * (standardNormalPdf(alpha) - standardNormalPdf(beta)) / mass;
}

// Same (targetMean, stdDev, floor, ceiling) tuple is reused across every year and every Monte Carlo run, so caching the
// bisection result avoids re-solving it on every single sample.
const untruncatedMeanCache = new Map<string, number>();
function solveUntruncatedMean(targetMean: number, stdDev: number, floor: number, ceiling: number): number {
  const cacheKey = `${targetMean}|${stdDev}|${floor}|${ceiling}`;
  const cached = untruncatedMeanCache.get(cacheKey);
  if (cached !== undefined) return cached;
  let low = floor - 6 * stdDev;
  let high = ceiling + 6 * stdDev;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const mid = (low + high) / 2;
    if (truncatedNormalMean(mid, stdDev, floor, ceiling) < targetMean) low = mid;
    else high = mid;
  }
  const solved = (low + high) / 2;
  if (untruncatedMeanCache.size > 500) untruncatedMeanCache.clear();
  untruncatedMeanCache.set(cacheKey, solved);
  return solved;
}


function createFallbackRandom(seed?: number) {
  if (seed === undefined) return Math.random;
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function projectRetirementPlan(
  inputs: RetirementInputs,
  options: ProjectionOptions = {},
): DeterministicProjection {
  const baseYear = options.calendarYear ?? new Date().getFullYear();
  const years: YearProjection[] = [];
  const roster = buildRoster(inputs);
  let balancesByPerson = initialBalancesByPerson(inputs, roster);
  const startedGicIds = startedGicIdsSeed(roster);
  let cumulativeInflation = 1;
  // Streams with "partialInflation"/"fixedRate" indexing compound independently of the shared inflation multiplier.
  const streamIndexMultipliers: Record<string, number> = Object.fromEntries(
    inputs.incomeStreams.map((stream) => [stream.id, 1]),
  );
  let lifetimeTax = 0;
  let peakValue = totalPortfolioAcross(balancesByPerson);
  let portfolioPeakAge = inputs.personalInfo.currentAge;
  let portfolioDepleted = false;
  const gicBufferSettings: GicBufferSettings | undefined = inputs.strategy.gicBuffer;
  // Tracks the market's own performance, isolated from contributions/withdrawals (like a fund's NAV), so decumulation itself
  // is never mistaken for a market drawdown - only actual negative returns move this index down from its peak.
  let marketIndex = 1;
  let marketIndexPeak = 1;
  let gicBufferMode: "reserve" | "draw" = "reserve";
  const initialGicTotal = totalInterestBearingAcross(balancesByPerson);
  // "age" throughout this loop always tracks the primary's age; other people's targetDeathAge is in their OWN age scale, so compare by year index (years since simulation start), not raw age.
  const maxLifespanIndex = Math.max(...roster.map((person) => person.targetDeathAge - person.currentAge));
  const finalAge = inputs.personalInfo.currentAge + maxLifespanIndex;
  const livingIds = new Set(roster.map((person) => person.id));
  const fallbackRetirementAge = Math.min(
    ...inputs.spendingPlan.phases.map((phase) => phase.startAge),
    finalAge + 1,
  );
  const householdRetirement = householdRetirementDate(inputs, roster, fallbackRetirementAge);
  const retirementStartAge = householdRetirement.age;
  const retirementStartMonth = householdRetirement.month;
  const subPeriodCount = subPeriodsPerYear(inputs.strategy.withdrawalFrequency);
  // Used only when the caller doesn't supply pre-generated subPeriodReturns, so a bare projectRetirementPlan(inputs) call is still deterministic per seed.
  const fallbackRandom = createFallbackRandom(inputs.simulation.randomSeed);

  for (
    let age = inputs.personalInfo.currentAge, index = 0;
    index <= maxLifespanIndex;
    age += 1, index += 1
  ) {
    const openingBalancesByPerson = mapValues(balancesByPerson, cloneBalances);
    const inflationRate = options.annualInflation?.[index] ?? inputs.assumptions.inflationMean;
    const portfolioReturn = options.annualReturns?.[index] ?? inputs.assumptions.returnMean;
    const periodReturns = subPeriodCount <= 1
      ? [portfolioReturn]
      : options.subPeriodReturns?.[index]
        ?? decomposeAnnualReturn(fallbackRandom, portfolioReturn, subPeriodCount, inputs.assumptions.returnStdDev);
    const activePhase = inputs.spendingPlan.phases.find(
      (phase) => age >= phase.startAge && age <= phase.endAge,
    );
    const annualSpendingTarget = activePhase
      ? activePhase.annualSpending * (inputs.spendingPlan.indexedToInflation ? cumulativeInflation : 1)
      : 0;
    const spendingTarget = age < retirementStartAge
      ? 0
      : age === retirementStartAge && subPeriodCount > 1
        ? annualSpendingTarget * (subPeriodCount - retirementStartMonth + 1) / subPeriodCount
        : annualSpendingTarget;

    let withdrawalOrderForYear = inputs.strategy.withdrawalOrder ?? DEFAULT_WITHDRAWAL_ORDER;
    let gicRefillCap = 0;
    if (gicBufferSettings?.enabled) {
      // Uses the index as it stood entering this year (last year's realized returns only) - this year's own return isn't
      // "known" yet when the withdrawal decision is made, matching how a real investor would decide.
      const drawdown = marketIndexPeak <= 0 ? 0 : (marketIndexPeak - marketIndex) / marketIndexPeak;
      gicBufferMode = nextGicBufferMode(gicBufferMode, drawdown, gicBufferSettings.triggerDrawdown, gicBufferSettings.recoveryDrawdown);
      withdrawalOrderForYear = effectiveWithdrawalOrder(withdrawalOrderForYear, gicBufferMode);
      if (gicBufferMode === "reserve" && gicBufferSettings.refillFromSurplus) {
        const currentGicTotal = totalInterestBearingAcross(openingBalancesByPerson);
        const target = gicBufferSettings.targetBalance ?? initialGicTotal;
        gicRefillCap = Math.max(0, target - currentGicTotal);
      }
    }
    marketIndex *= 1 + portfolioReturn;
    marketIndexPeak = Math.max(marketIndexPeak, marketIndex);

    const result = fundHousehold(
      inputs,
      roster,
      balancesByPerson,
      index,
      cumulativeInflation,
      streamIndexMultipliers,
      spendingTarget,
      retirementStartAge,
      age,
      baseYear + index,
      portfolioReturn,
      periodReturns,
      withdrawalOrderForYear,
      gicRefillCap,
      startedGicIds,
      annualSpendingTarget,
      retirementStartMonth,
    );


    // With sub-annual withdrawals, growth was already applied period-by-period inside fundHousehold; annual mode still grows once, after the single withdrawal pass.
    balancesByPerson = result.growthAlreadyApplied
      ? result.balancesByPerson
      : Object.fromEntries(
        Object.entries(result.balancesByPerson).map(([personId, balances]) => [
          personId,
          applyAnnualReturn(balances, portfolioReturn, 1),
        ]),
      );
    let estateValue = totalPortfolioAcross(balancesByPerson);
    const yearTax = result.tax.totalTax;
    let yearEstateTax = 0;

    // Anyone reaching their own death age this year has their accounts settled: rolled over tax-free to a surviving person, or fully taxed/probated if no one is left.
    const dyingThisYear = roster.filter((person) => livingIds.has(person.id) && person.currentAge + index === person.targetDeathAge);
    if (dyingThisYear.length > 0) {
      for (const person of dyingThisYear) livingIds.delete(person.id);
      const survivorId = roster.find((person) => livingIds.has(person.id))?.id;
      if (survivorId) {
        for (const person of dyingThisYear) {
          balancesByPerson[survivorId] = mergeBalances(balancesByPerson[survivorId], balancesByPerson[person.id]);
          balancesByPerson[person.id] = zeroBalances();
        }
      } else {
        const grossEstate = totalPortfolioAcross(balancesByPerson);
        yearEstateTax = dyingThisYear.reduce((sum, person) => sum + calculateTax(
          {
            // Any deferred (not-yet-matured) GIC/PPN growth is deemed realized at death, same as the RRSP.
            ordinaryIncome: balancesByPerson[person.id].rrsp + balancesByPerson[person.id].interestBearingAccrued,
            capitalGains: Math.max(0, balancesByPerson[person.id].nonRegistered - balancesByPerson[person.id].nonRegisteredBookValue),
            eligibleDividends: 0,
            nonEligibleDividends: 0,
          },
          inputs.personalInfo.province,
          inputs.simulation.capitalGainsInclusionRate,
          inputs.taxSettings,
        ).totalTax, 0);
        estateValue = Math.max(0, grossEstate - yearEstateTax);
        estateValue *= 1 - inputs.simulation.probateFeeRate;
      }
    }

    lifetimeTax += yearTax + yearEstateTax;
    const closingBalancesByPerson = mapValues(balancesByPerson, cloneBalances);
    const currentPortfolio = totalPortfolioAcross(closingBalancesByPerson);
    if (currentPortfolio > peakValue) {
      peakValue = currentPortfolio;
      portfolioPeakAge = age;
    }
    const depleted = result.depleted || (age < finalAge && currentPortfolio <= 0);
    portfolioDepleted ||= depleted;

    years.push({
      age,
      calendarYear: baseYear + index,
      openingBalances: sumBalances(openingBalancesByPerson),
      closingBalances: sumBalances(closingBalancesByPerson),
      income: result.income,
      withdrawals: result.withdrawals,
      rrifMinimumWithdrawal: result.rrifMinimumWithdrawal,
      totalIncome: result.totalIncome,
      taxes: { ...result.tax, totalTax: yearTax },
      taxesByPerson: result.taxesByPerson,
      oasClawback: result.oasClawback,
      recurringNetIncome: result.recurringNetIncome,
      netSpendableCash: result.netSpendableCash,
      spendingTarget,
      portfolioReturn,
      inflationRate,
      estateValue,
      estateTax: yearEstateTax,
      depleted,
      gicBufferMode: gicBufferSettings?.enabled ? gicBufferMode : undefined,
      subPeriods: result.subPeriods,
    });
    cumulativeInflation *= 1 + inflationRate;
    for (const stream of inputs.incomeStreams) {
      if (stream.indexationMode === "partialInflation") {
        streamIndexMultipliers[stream.id] *= 1 + (stream.indexationRate ?? 0) * inflationRate;
      } else if (stream.indexationMode === "fixedRate") {
        streamIndexMultipliers[stream.id] *= 1 + (stream.indexationRate ?? 0);
      }
    }
  }

  return {
    years,
    finalEstateValue: years.at(-1)?.estateValue ?? 0,
    lifetimeTax,
    portfolioPeakAge,
    portfolioDepleted,
  };
}

// "GIC rate" is entered as the TOTAL guaranteed return over the whole term (e.g. "5% for a 2-year GIC"), matching how
// these products are usually marketed - not a per-year rate. Convert it to the effective annual rate actually compounded.
function effectiveAnnualGicRate(totalRateOverTerm: number, termYears: number) {
  return Math.pow(1 + totalRateOverTerm, 1 / termYears) - 1;
}

// Resolves a person's configured GIC ladder into ready-to-use configs (effective annual rate already computed). Falls
// back to the legacy single-GIC fields (as one "external, renew forever, starts immediately" entry) for scenarios
// saved before the ladder was configurable, or when `gics` is simply empty.
function resolveGicConfigs(assets: { gics?: GicHolding[]; interestBearingBalance?: number; interestBearingTermYears?: number; interestBearingRate?: number } | undefined, currentAge: number, fallbackAnnualRate: number): ResolvedGicConfig[] {
  if (assets?.gics && assets.gics.length > 0) {
    return assets.gics.map((holding, index) => {
      const termYears = Math.max(1, finiteNumber(holding.termYears, 1));
      return {
        id: holding.id || `gic-${index}`,
        balance: Math.max(0, finiteNumber(holding.balance, 0)),
        annualRate: effectiveAnnualGicRate(finiteNumber(holding.rate, fallbackAnnualRate), termYears),
        termYears,
        startAge: finiteNumber(holding.startAge, currentAge),
        fundingSource: holding.fundingSource ?? "nonRegistered",
        maturityAction: holding.maturityAction ?? "renew",
      };
    });
  }
  const legacyBalance = finiteNumber(assets?.interestBearingBalance, 0);
  if (legacyBalance <= 0) return [];
  const termYears = Math.max(1, finiteNumber(assets?.interestBearingTermYears, 1));
  return [{
    id: "legacy",
    balance: legacyBalance,
    annualRate: effectiveAnnualGicRate(finiteNumber(assets?.interestBearingRate, fallbackAnnualRate), termYears),
    termYears,
    startAge: currentAge,
    fundingSource: "nonRegistered",
    maturityAction: "renew",
  }];
}

function buildRoster(inputs: RetirementInputs): PersonRoster[] {
  return [
    {
      id: "primary",
      label: inputs.personalInfo.label || "Primary person",
      currentAge: inputs.personalInfo.currentAge,
      targetDeathAge: inputs.personalInfo.targetDeathAge,
      birthMonth: inputs.personalInfo.birthMonth,
      receivesCpp: inputs.personalInfo.receivesCpp ?? true,
      cppPayoutRate: Math.max(0, finiteNumber(inputs.personalInfo.cppPayoutRate, 0.6)),
      receivesOas: inputs.personalInfo.receivesOas ?? true,
      gicConfigs: resolveGicConfigs(inputs.existingAssets, inputs.personalInfo.currentAge, inputs.assumptions.returnMean),
    },
    ...(inputs.personalInfo.additionalPeople ?? []).map((person) => {
      const currentAge = finiteNumber(person.currentAge, inputs.personalInfo.currentAge);
      return {
        id: person.id,
        label: person.label || "Person",
        currentAge,
        targetDeathAge: finiteNumber(person.targetDeathAge, inputs.personalInfo.targetDeathAge),
        birthMonth: person.birthMonth,
        receivesCpp: person.receivesCpp ?? true,
        cppPayoutRate: Math.max(0, finiteNumber(person.cppPayoutRate, 0.6)),
        receivesOas: person.receivesOas ?? true,
        gicConfigs: resolveGicConfigs(person.existingAssets, currentAge, inputs.assumptions.returnMean),
      };
    }),
  ];
}

function initialBalancesByPerson(inputs: RetirementInputs, roster: PersonRoster[]): Record<string, AccountBalances> {
  const balances: Record<string, AccountBalances> = {};
  for (const person of roster) {
    const assets = person.id === "primary"
      ? inputs.existingAssets
      : inputs.personalInfo.additionalPeople?.find((candidate) => candidate.id === person.id)?.existingAssets;
    // GICs whose start age has already arrived (typically age <= currentAge) are active from day one; later ones are
    // instantiated once the simulation reaches their start age (see startNewGics in fundHousehold).
    const gicPositions: GicPositionState[] = person.gicConfigs
      .filter((config) => config.startAge <= person.currentAge)
      .map((config) => ({
        id: config.id,
        balance: config.balance,
        accrued: 0,
        fundingSource: config.fundingSource,
        termElapsed: 0,
        termYears: config.termYears,
        annualRate: config.annualRate,
        maturityAction: config.maturityAction,
      }));
    balances[person.id] = {
      rrsp: assets?.rrspBalance ?? 0,
      tfsa: assets?.tfsaBalance ?? 0,
      nonRegistered: assets?.nonRegisteredBalance ?? 0,
      nonRegisteredBookValue: assets?.nonRegisteredBookValue ?? 0,
      interestBearing: gicPositions.reduce((sum, position) => sum + position.balance, 0),
      interestBearingAccrued: 0,
      taxableInterestBearingAccrued: 0,
      gicPositions,
    };
  }
  return balances;
}

function startedGicIdsSeed(roster: PersonRoster[]): Set<string> {
  const started = new Set<string>();
  for (const person of roster) {
    for (const config of person.gicConfigs) {
      if (config.startAge <= person.currentAge) started.add(config.id);
    }
  }
  return started;
}

function householdRetirementDate(inputs: RetirementInputs, roster: PersonRoster[], fallbackAge: number) {
  const employmentEndDates = roster.flatMap((person) => {
    const streams = inputs.incomeStreams.filter((stream) => (stream.ownerId || "primary") === person.id && stream.taxTreatment === "employment");
    return streams.length === 0 ? [] : [streams.reduce((latest, stream) => {
      const yearIndex = stream.endAge - person.currentAge;
      const month = stream.endMonth ?? 12;
      return yearIndex * 12 + month > latest.value
        ? { value: yearIndex * 12 + month, yearIndex, month }
        : latest;
    }, { value: Number.NEGATIVE_INFINITY, yearIndex: 0, month: 1 })];
  });
  const earliest = employmentEndDates.reduce((best, date) => date.yearIndex * 12 + date.month < best.value ? { value: date.yearIndex * 12 + date.month, yearIndex: date.yearIndex, month: date.month } : best, { value: Number.POSITIVE_INFINITY, yearIndex: fallbackAge - roster[0].currentAge, month: 1 });
  return { age: roster[0].currentAge + earliest.yearIndex, month: earliest.month };
}


// Funds one calendar year across every person's own income/accounts/tax return, then rolls the results up into household totals.
function fundHousehold(
  inputs: RetirementInputs,
  roster: PersonRoster[],
  balancesByPerson: Record<string, AccountBalances>,
  yearIndex: number,
  inflationMultiplier: number,
  streamIndexMultipliers: Record<string, number>,
  spendingTarget: number,
  retirementStartAge: number,
  age: number,
  calendarYear: number,
  portfolioReturn: number,
  periodReturns: number[],
  withdrawalOrder: WithdrawalAccount[],
  gicRefillCap: number,
  startedGicIds: Set<string>,
  annualSpendingTarget: number,
  retirementStartMonth: number,
) {
  const states: PersonYearState[] = roster.map((person) => {
    const fixed = personFixedIncome(inputs, person, yearIndex, calendarYear, inflationMultiplier, streamIndexMultipliers);
    const opening = balancesByPerson[person.id];
    // Each GIC/PPN position uses its own guaranteed rate (not the market return) and compounds within its own term.
    // Only non-registered GIC growth is taxable; registered GIC growth remains tax-sheltered.
    let totalInterestIncome = 0;
    let cashedOutTotal = 0;
    const grownPositions: GicPositionState[] = [];
    for (const position of opening.gicPositions) {
      const growth = position.balance * Math.max(0, position.annualRate);
      const accruedAfterGrowth = position.accrued + growth;
      const termElapsed = position.termElapsed + 1;
      const maturityReached = termElapsed >= position.termYears;
      if (!maturityReached) {
        grownPositions.push({ ...position, accrued: accruedAfterGrowth, termElapsed });
        continue;
      }
      if (position.fundingSource !== "registered") totalInterestIncome += accruedAfterGrowth;
      if (position.maturityAction === "cashOut") {
        cashedOutTotal += position.balance;
      } else {
        grownPositions.push({ ...position, accrued: 0, termElapsed: 0 });
      }
    }
    const fixedTaxable = { ...fixed.taxableIncome, ordinaryIncome: fixed.taxableIncome.ordinaryIncome + totalInterestIncome };
    return {
      id: person.id,
      age: person.currentAge + yearIndex,
      balances: {
        ...cloneBalances(opening),
        gicPositions: grownPositions,
        interestBearing: grownPositions.reduce((sum, position) => sum + position.balance, 0),
        interestBearingAccrued: grownPositions.reduce((sum, position) => sum + position.accrued, 0),
        taxableInterestBearingAccrued: grownPositions.reduce((sum, position) => sum + (position.fundingSource === "registered" ? 0 : position.accrued), 0),
        // Contributions from income streams (e.g. salary deductions) land directly in the relevant account.
        rrsp: opening.rrsp + fixed.rrspContribution + (periodReturns.length <= 1 ? fixed.monthlyRrspContribution * 12 : 0),
        tfsa: opening.tfsa + fixed.tfsaContribution + (periodReturns.length <= 1 ? fixed.monthlyTfsaContribution * 12 : 0),
        nonRegistered: opening.nonRegistered + fixed.nonRegisteredContribution + (periodReturns.length <= 1 ? fixed.monthlyNonRegisteredContribution * 12 : 0) + cashedOutTotal,
        nonRegisteredBookValue: opening.nonRegisteredBookValue + fixed.nonRegisteredContribution + (periodReturns.length <= 1 ? fixed.monthlyNonRegisteredContribution * 12 : 0) + cashedOutTotal,
      },
      income: { ...fixed.income, interest: fixed.income.interest + totalInterestIncome },
      withdrawals: { rrsp: 0, tfsa: 0, nonRegistered: 0, interestBearing: 0 },
      fixedTaxable,
      cashContribution: fixed.cashContribution,
      monthlyRrspContribution: fixed.monthlyRrspContribution,
      monthlyTfsaContribution: fixed.monthlyTfsaContribution,
      monthlyNonRegisteredContribution: fixed.monthlyNonRegisteredContribution,
      tax: calculateTax(fixedTaxable, inputs.personalInfo.province, inputs.simulation.capitalGainsInclusionRate, inputs.taxSettings),
    };
  });

  startNewGicsForYear(states, roster, age, inputs, startedGicIds);

  const netCashTotal = () => states.reduce((sum, state) => sum + Math.max(0, cashFromIncome(state.income) + sumWithdrawals(state.withdrawals) - state.tax.totalTax - state.cashContribution), 0);
  const recurringNetIncome = states.reduce((sum, state) => sum + Math.max(0, cashFromIncome(state.income) - state.tax.totalTax - state.cashContribution), 0);
  // Snapshot each state's tax bill with zero withdrawals, so sub-period cash-flow math can prorate the FIXED income across the year instead of treating it as fully received in period 1.
  const fixedTaxBaselineByState = new Map(states.map((state) => [state.id, state.tax.totalTax]));

  // RRIF minimum withdrawals are mandatory once converted (by 71), regardless of spending need, based on the fund's value at the start of the year.
  const rrifMinimumByState = new Map(states.map((state) => [
    state.id,
    Math.max(0, Math.min(calculateRrifMinimumWithdrawal(balancesByPerson[state.id].rrsp, state.age), state.balances.rrsp)),
  ]));
  const rrifMinimumWithdrawal = [...rrifMinimumByState.values()].reduce((sum, amount) => sum + amount, 0);

  const withdrawRrifMinimum = (state: PersonYearState, amount: number) => {
    if (amount <= 0) return;
    state.balances = removeWithdrawal(state.balances, "rrsp", amount);
    state.withdrawals.rrsp += amount;
    state.tax = calculateTax(
      taxableIncomeForYear(state.fixedTaxable, state.withdrawals, state.balances),
      inputs.personalInfo.province,
      inputs.simulation.capitalGainsInclusionRate,
      inputs.taxSettings,
    );
  };

  // Interest-bearing balances get no further tax benefit from staying invested (already taxed annually as it accrues), so they're drawn down first by default.
  // Falls back to the historical default order for scenarios saved before withdrawal order was configurable; may already be reordered by the GIC buffer strategy for this year.
  const subPeriodCount = periodReturns.length;
  let subPeriods: SubPeriodProjection[] | undefined;

  if (subPeriodCount <= 1) {
    // Single annual withdrawal, unchanged: growth is applied once by the caller, after this whole pass.
    for (const state of states) withdrawRrifMinimum(state, rrifMinimumByState.get(state.id) ?? 0);
    for (const account of withdrawalOrder) {
      for (const state of states) {
        const requiredCash = spendingTarget - netCashTotal();
        const available = state.balances[account];
        if (requiredCash <= 0 || available <= 0) continue;
        const amount = requiredWithdrawal(requiredCash, available, account, state.balances, state.withdrawals, state.fixedTaxable, inputs);
        if (amount <= 0) continue;
        state.balances = removeWithdrawal(state.balances, account, amount);
        state.withdrawals[account] += amount;
        state.tax = calculateTax(
          taxableIncomeForYear(state.fixedTaxable, state.withdrawals, state.balances),
          inputs.personalInfo.province,
          inputs.simulation.capitalGainsInclusionRate,
          inputs.taxSettings,
        );
      }
    }
  } else {
    // Sub-annual withdrawals: apply each period's own realized return before drawing on it, so a down period isn't sold from as if the year were flat.
    subPeriods = [];
    for (let period = 0; period < subPeriodCount; period += 1) {
      for (const state of states) {
        const periodContributionFactor = 12 / subPeriodCount;
        state.balances.rrsp += state.monthlyRrspContribution * periodContributionFactor;
        state.balances.tfsa += state.monthlyTfsaContribution * periodContributionFactor;
        state.balances.nonRegistered += state.monthlyNonRegisteredContribution * periodContributionFactor;
        state.balances.nonRegisteredBookValue += state.monthlyNonRegisteredContribution * periodContributionFactor;
        state.balances = applyAnnualReturn(state.balances, periodReturns[period], 1 / subPeriodCount);
      }
      const withdrawalsBefore = new Map(states.map((state) => [state.id, { ...state.withdrawals }]));
      // Mandatory RRIF minimum installments are spread evenly across periods (matches how real RRIF minimums are usually paid out) instead of vanishing from the monthly breakdown as one hidden annual lump.
      for (const state of states) withdrawRrifMinimum(state, (rrifMinimumByState.get(state.id) ?? 0) / subPeriodCount);
      // Compare cumulative cash-so-far against the cumulative (not per-period-flat) spending target, so tax-bracket effects from earlier periods still carry through correctly.
      const cumulativeTarget = age < retirementStartAge
        ? 0
        : age === retirementStartAge
          ? (annualSpendingTarget * Math.max(0, period - retirementStartMonth + 2)) / subPeriodCount
          : (spendingTarget * (period + 1)) / subPeriodCount;
      const elapsedFraction = (period + 1) / subPeriodCount;
      // Prorates the FIXED (annual) recurring income by how much of the year has elapsed, rather than crediting the whole year's income as already banked in period 1.
      const netCashSoFar = () => states.reduce((sum, state) => {
        const fixedTaxBaseline = fixedTaxBaselineByState.get(state.id) ?? 0;
        const recurringNet = cashFromIncome(state.income) - fixedTaxBaseline - state.cashContribution;
        const withdrawalTax = state.tax.totalTax - fixedTaxBaseline;
        return sum + Math.max(0, recurringNet * elapsedFraction + sumWithdrawals(state.withdrawals) - withdrawalTax);
      }, 0);
      for (const account of withdrawalOrder) {
        for (const state of states) {
          const requiredCash = cumulativeTarget - netCashSoFar();
          const available = state.balances[account];
          if (requiredCash <= 0 || available <= 0) continue;
          const amount = requiredWithdrawal(requiredCash, available, account, state.balances, state.withdrawals, state.fixedTaxable, inputs);
          if (amount <= 0) continue;
          state.balances = removeWithdrawal(state.balances, account, amount);
          state.withdrawals[account] += amount;
          state.tax = calculateTax(
            taxableIncomeForYear(state.fixedTaxable, state.withdrawals, state.balances),
            inputs.personalInfo.province,
            inputs.simulation.capitalGainsInclusionRate,
            inputs.taxSettings,
          );
        }
      }
      const periodWithdrawals = states.reduce((total, state) => {
        const before = withdrawalsBefore.get(state.id)!;
        return {
          rrsp: total.rrsp + (state.withdrawals.rrsp - before.rrsp),
          tfsa: total.tfsa + (state.withdrawals.tfsa - before.tfsa),
          nonRegistered: total.nonRegistered + (state.withdrawals.nonRegistered - before.nonRegistered),
          interestBearing: total.interestBearing + (state.withdrawals.interestBearing - before.interestBearing),
        };
      }, { rrsp: 0, tfsa: 0, nonRegistered: 0, interestBearing: 0 } as AccountWithdrawals);
      subPeriods.push({
        index: period,
        portfolioReturn: periodReturns[period],
        withdrawals: periodWithdrawals,
        closingBalances: sumBalances(Object.fromEntries(states.map((state) => [state.id, state.balances]))),
      });
    }
  }

  if (inputs.strategy.aggressiveRrspMeltdown && spendingTarget > 0) {
    // Smoothed evenly across periods below, so it doesn't show up as a single hidden 13th withdrawal.
    const meltByState = new Map<string, number>();
    for (const state of states) {
      if (state.balances.rrsp <= 0) continue;
      const currentOrdinaryIncome = taxableIncomeForYear(state.fixedTaxable, state.withdrawals, state.balances).ordinaryIncome;
      const nextLimit = nextFederalBracketLimit(currentOrdinaryIncome, inputs.taxSettings);
      const meltAmount = Math.min(state.balances.rrsp, Math.max(0, nextLimit - currentOrdinaryIncome));
      if (meltAmount <= 0) continue;
      meltByState.set(state.id, meltAmount);
      state.balances = removeWithdrawal(state.balances, "rrsp", meltAmount);
      state.withdrawals.rrsp += meltAmount;
      state.tax = calculateTax(
        taxableIncomeForYear(state.fixedTaxable, state.withdrawals, state.balances),
        inputs.personalInfo.province,
        inputs.simulation.capitalGainsInclusionRate,
        inputs.taxSettings,
      );
    }
    const totalMelted = [...meltByState.values()].reduce((sum, amount) => sum + amount, 0);
    // The melt amount can only be known once the full year's income is in, so it's spread evenly back across periods for
    // display rather than dumped entirely into the last one - a smoothed approximation, but the final period still lands
    // on the true end-of-year balance.
    if (subPeriods && totalMelted > 0) {
      const meltPerPeriod = totalMelted / subPeriods.length;
      subPeriods.forEach((period, periodIndex) => {
        const meltSoFar = meltPerPeriod * (periodIndex + 1);
        period.withdrawals = { ...period.withdrawals, rrsp: period.withdrawals.rrsp + meltPerPeriod };
        period.closingBalances = { ...period.closingBalances, rrsp: Math.max(0, period.closingBalances.rrsp - (totalMelted - meltSoFar)) };
      });
    }
  }

  // OAS recovery tax: applied against each person's final income for the year (including any withdrawals above), so it
  // reflects the actual year's outcome. Designed to be re-run safely (it always recomputes from each state's untouched
  // base income rather than compounding on top of its own previous reduction), because a clawback discovered here can
  // itself create a cash shortfall that needs another withdrawal top-up below.
  const baseFixedTaxableByState = new Map(states.map((state) => [state.id, state.fixedTaxable]));
  const baseOasByState = new Map(states.map((state) => [state.id, state.income.oas]));
  const applyOasClawback = () => {
    let total = 0;
    for (const state of states) {
      const baseOas = baseOasByState.get(state.id) ?? 0;
      if (baseOas <= 0) continue;
      const baseFixedTaxable = baseFixedTaxableByState.get(state.id)!;
      const totalOrdinaryIncome = taxableIncomeForYear(baseFixedTaxable, state.withdrawals, state.balances).ordinaryIncome;
      const otherOrdinaryIncome = totalOrdinaryIncome - baseOas;
      const clawback = calculateOasClawback(baseOas, otherOrdinaryIncome, state.age, inflationMultiplier);
      total += clawback;
      state.income = { ...state.income, oas: baseOas - clawback };
      state.fixedTaxable = { ...baseFixedTaxable, ordinaryIncome: baseFixedTaxable.ordinaryIncome - clawback };
      state.tax = calculateTax(
        taxableIncomeForYear(state.fixedTaxable, state.withdrawals, state.balances),
        inputs.personalInfo.province,
        inputs.simulation.capitalGainsInclusionRate,
        inputs.taxSettings,
      );
    }
    return total;
  };
  let oasClawback = applyOasClawback();

  // The clawback above is only known once withdrawals are finalized, and reduces net cash after the fact - if that
  // pushes below the spending target, draw a bit more (same order) instead of reporting a shortfall/"depleted" year
  // while other accounts still hold plenty. Re-deriving the clawback each pass converges quickly since it's capped at
  // a fraction of OAS itself, so each extra withdrawal needed shrinks geometrically.
  const withdrawalsBeforeTopUp = new Map(states.map((state) => [state.id, { ...state.withdrawals }]));
  for (let attempt = 0; attempt < 16; attempt += 1) {
    if (spendingTarget - netCashTotal() <= 0) break;
    let drewAny = false;
    for (const account of withdrawalOrder) {
      for (const state of states) {
        const requiredCash = spendingTarget - netCashTotal();
        const available = state.balances[account];
        if (requiredCash <= 0 || available <= 0) continue;
        const amount = requiredWithdrawal(requiredCash, available, account, state.balances, state.withdrawals, state.fixedTaxable, inputs);
        if (amount <= 0) continue;
        state.balances = removeWithdrawal(state.balances, account, amount);
        state.withdrawals[account] += amount;
        state.tax = calculateTax(
          taxableIncomeForYear(state.fixedTaxable, state.withdrawals, state.balances),
          inputs.personalInfo.province,
          inputs.simulation.capitalGainsInclusionRate,
          inputs.taxSettings,
        );
        drewAny = true;
      }
    }
    if (!drewAny) break;
    oasClawback = applyOasClawback();
  }
  // The top-up amount is only known after the full year's clawback is resolved, so - like the meltdown above - it's
  // spread evenly back across periods for display rather than dumped entirely into the last one.
  const totalTopUp = states.reduce((total, state) => {
    const before = withdrawalsBeforeTopUp.get(state.id)!;
    return {
      rrsp: total.rrsp + (state.withdrawals.rrsp - before.rrsp),
      tfsa: total.tfsa + (state.withdrawals.tfsa - before.tfsa),
      nonRegistered: total.nonRegistered + (state.withdrawals.nonRegistered - before.nonRegistered),
      interestBearing: total.interestBearing + (state.withdrawals.interestBearing - before.interestBearing),
    };
  }, { rrsp: 0, tfsa: 0, nonRegistered: 0, interestBearing: 0 } as AccountWithdrawals);
  if (subPeriods && (totalTopUp.rrsp + totalTopUp.tfsa + totalTopUp.nonRegistered + totalTopUp.interestBearing) > 0) {
    const perPeriod: AccountWithdrawals = {
      rrsp: totalTopUp.rrsp / subPeriods.length,
      tfsa: totalTopUp.tfsa / subPeriods.length,
      nonRegistered: totalTopUp.nonRegistered / subPeriods.length,
      interestBearing: totalTopUp.interestBearing / subPeriods.length,
    };
    subPeriods.forEach((period, periodIndex) => {
      const remainingPeriods = subPeriods!.length - (periodIndex + 1);
      period.withdrawals = {
        rrsp: period.withdrawals.rrsp + perPeriod.rrsp,
        tfsa: period.withdrawals.tfsa + perPeriod.tfsa,
        nonRegistered: period.withdrawals.nonRegistered + perPeriod.nonRegistered,
        interestBearing: period.withdrawals.interestBearing + perPeriod.interestBearing,
      };
      period.closingBalances = {
        ...period.closingBalances,
        rrsp: Math.max(0, period.closingBalances.rrsp - perPeriod.rrsp * remainingPeriods),
        tfsa: Math.max(0, period.closingBalances.tfsa - perPeriod.tfsa * remainingPeriods),
        nonRegistered: Math.max(0, period.closingBalances.nonRegistered - perPeriod.nonRegistered * remainingPeriods),
        interestBearing: Math.max(0, period.closingBalances.interestBearing - perPeriod.interestBearing * remainingPeriods),
      };
    });
  }

  // Any leftover retirement-era cash beyond the spending need (RRIF minimum, meltdown, or income exceeding spending) gets reinvested rather than vanishing.
  // Before retirement, saving is explicit per income stream (RRSP/TFSA/non-registered contributions above) - any other leftover salary is assumed spent on living, not auto-invested.
  // Before a spending phase begins, leftover employment income is assumed spent on ordinary living costs rather than
  // silently invested. This matters when employment ends before the first retirement spending phase starts.
  const finalSurplus = spendingTarget > 0 ? Math.max(0, netCashTotal() - spendingTarget) : 0;
  if (finalSurplus > 0) {
    const surplusState = states.find((state) => state.id === "primary") ?? states[0];
    // When the GIC buffer strategy is reserving/refilling, leftover cash tops the GIC back up first, before TFSA/non-registered.
    const gicContribution = Math.min(finalSurplus, Math.max(0, gicRefillCap));
    const remainingSurplus = finalSurplus - gicContribution;
    // TFSA is fully tax-free, so it's filled first (up to the annual room) before falling back to non-registered.
    const tfsaRoom = Math.max(0, tfsaAnnualContributionLimit * inflationMultiplier);
    const tfsaContribution = Math.min(remainingSurplus, tfsaRoom);
    const nonRegisteredContribution = remainingSurplus - tfsaContribution;
    surplusState.balances.interestBearing += gicContribution;
    surplusState.balances.tfsa += tfsaContribution;
    surplusState.balances.nonRegistered += nonRegisteredContribution;
    surplusState.balances.nonRegisteredBookValue += nonRegisteredContribution;
  }

  const netSpendableCash = netCashTotal();
  const combinedIncome = states.reduce((total, state) => ({
    employment: total.employment + state.income.employment,
    cpp: total.cpp + state.income.cpp,
    oas: total.oas + state.income.oas,
    interest: total.interest + state.income.interest,
    rrspWithdrawal: total.rrspWithdrawal + state.income.rrspWithdrawal + state.withdrawals.rrsp,
    tfsaWithdrawal: total.tfsaWithdrawal + state.income.tfsaWithdrawal + state.withdrawals.tfsa,
    nonRegisteredWithdrawal: total.nonRegisteredWithdrawal + state.income.nonRegisteredWithdrawal + state.withdrawals.nonRegistered,
    interestBearingWithdrawal: total.interestBearingWithdrawal + state.income.interestBearingWithdrawal + state.withdrawals.interestBearing,
  }), { employment: 0, cpp: 0, oas: 0, interest: 0, rrspWithdrawal: 0, tfsaWithdrawal: 0, nonRegisteredWithdrawal: 0, interestBearingWithdrawal: 0 } as IncomeBySource);
  const combinedWithdrawals = states.reduce((total, state) => ({
    rrsp: total.rrsp + state.withdrawals.rrsp,
    tfsa: total.tfsa + state.withdrawals.tfsa,
    nonRegistered: total.nonRegistered + state.withdrawals.nonRegistered,
    interestBearing: total.interestBearing + state.withdrawals.interestBearing,
  }), { rrsp: 0, tfsa: 0, nonRegistered: 0, interestBearing: 0 } as AccountWithdrawals);
  const combinedTax = combineTax(states.map((state) => state.tax));
  const balancesByPersonNext = Object.fromEntries(states.map((state) => [state.id, state.balances]));
  const taxesByPerson = states.map((state) => ({
    id: state.id,
    label: roster.find((person) => person.id === state.id)?.label ?? state.id,
    federalTax: state.tax.federalTax,
    provincialTax: state.tax.provincialTax,
    totalTax: state.tax.totalTax,
  }));

  return {
    balancesByPerson: balancesByPersonNext,
    income: combinedIncome,
    withdrawals: combinedWithdrawals,
    rrifMinimumWithdrawal,
    tax: combinedTax,
    taxesByPerson,
    oasClawback,
    totalIncome: cashFromIncome(combinedIncome),
    recurringNetIncome,
    netSpendableCash,
    // A shortfall only means the portfolio is actually "depleted" if there's nothing left anywhere to draw from -
    // otherwise it's just a same-year timing/rounding gap (e.g. a late-discovered OAS clawback the top-up above
    // couldn't fully close), which shouldn't be reported as running out of money while millions remain in other accounts.
    depleted: netSpendableCash < spendingTarget - 0.01
      && states.reduce((sum, state) => sum + totalPortfolio(state.balances), 0) <= 0.01,
    subPeriods,
    growthAlreadyApplied: subPeriodCount > 1,
  };
}

// Instantiates any GIC whose configured start age arrives this year. The configured balance is a separate holding;
// fundingSource only determines whether its interest is registered or taxable.
function startNewGicsForYear(
  states: PersonYearState[],
  roster: PersonRoster[],
  age: number,
  inputs: RetirementInputs,
  startedGicIds: Set<string>,
) {
  for (const state of states) {
    const person = roster.find((candidate) => candidate.id === state.id);
    if (!person) continue;
    for (const config of person.gicConfigs) {
      if (config.startAge !== age || startedGicIds.has(config.id)) continue;
      startedGicIds.add(config.id);
      let netAmount = config.balance;
      if (netAmount <= 0) continue;
      const newPosition: GicPositionState = {
        id: config.id,
        balance: netAmount,
        accrued: 0,
        fundingSource: config.fundingSource,
        termElapsed: 0,
        termYears: config.termYears,
        annualRate: config.annualRate,
        maturityAction: config.maturityAction,
      };
      state.balances = {
        ...state.balances,
        gicPositions: [...state.balances.gicPositions, newPosition],
        interestBearing: state.balances.interestBearing + netAmount,
        taxableInterestBearingAccrued: state.balances.taxableInterestBearingAccrued,
      };
    }
  }
}

// A household-level summary of otherwise-separate tax returns; marginal rate reports the highest bracket anyone in the household is in.
function combineTax(results: TaxResult[]): TaxResult {
  const totalTax = results.reduce((sum, result) => sum + result.totalTax, 0);
  const federalTax = results.reduce((sum, result) => sum + result.federalTax, 0);
  const provincialTax = results.reduce((sum, result) => sum + result.provincialTax, 0);
  const dividendTaxCredit = results.reduce((sum, result) => sum + result.dividendTaxCredit, 0);
  const capitalGainsTaxableAmount = results.reduce((sum, result) => sum + result.capitalGainsTaxableAmount, 0);
  const marginalRate = results.reduce((max, result) => Math.max(max, result.marginalRate), 0);
  const totalTaxableIncome = results.reduce((sum, result) => sum + (result.averageRate === 0 ? 0 : result.totalTax / result.averageRate), 0);
  return {
    federalTax,
    provincialTax,
    dividendTaxCredit,
    capitalGainsTaxableAmount,
    totalTax,
    marginalRate,
    averageRate: totalTaxableIncome === 0 ? 0 : totalTax / totalTaxableIncome,
  };
}

// Resolves how much a stream's amount has grown: full/partial CPI use the shared inflation multiplier (scaled by the partial factor), fixedRate compounds on its own.
function streamIndexMultiplier(stream: IncomeStream, inflationMultiplier: number, streamIndexMultipliers: Record<string, number>) {
  switch (stream.indexationMode) {
    case "fullInflation":
      return inflationMultiplier;
    case "partialInflation":
    case "fixedRate":
      return streamIndexMultipliers[stream.id] ?? 1;
    default:
      return 1;
  }
}

function personFixedIncome(inputs: RetirementInputs, person: PersonRoster, yearIndex: number, calendarYear: number, inflationMultiplier: number, streamIndexMultipliers: Record<string, number>) {
  const income: IncomeBySource = { employment: 0, cpp: 0, oas: 0, interest: 0, rrspWithdrawal: 0, tfsaWithdrawal: 0, nonRegisteredWithdrawal: 0, interestBearingWithdrawal: 0 };
  const taxableIncome: TaxableIncome = { ordinaryIncome: 0, capitalGains: 0, eligibleDividends: 0, nonEligibleDividends: 0 };
  const age = person.currentAge + yearIndex;
  let rrspContribution = 0;
  let tfsaContribution = 0;
  let nonRegisteredContribution = 0;
  let cashContribution = 0;
  let monthlyRrspContribution = 0;
  let monthlyTfsaContribution = 0;
  let monthlyNonRegisteredContribution = 0;

  for (const stream of inputs.incomeStreams) {
    const ownerId = stream.ownerId || "primary";
    if (ownerId !== person.id) continue;
    // Death is a birthday cutoff: the person's final age year is prorated when a birth month is available.
    const deathBindsFirst = person.targetDeathAge < stream.endAge;
    const effectiveEndAge = deathBindsFirst ? person.targetDeathAge : stream.endAge;
    const eligibleForAge = age >= stream.startAge && age <= effectiveEndAge;
    const eligibleForBenefitStart = (stream.taxTreatment !== "cpp" || age >= inputs.strategy.cppStartAge)
      && (stream.taxTreatment !== "oas" || age >= Math.max(65, inputs.strategy.oasStartAge));
    if (!eligibleForAge || !eligibleForBenefitStart) continue;
    const baseAmount = stream.taxTreatment === "cpp"
      ? calculateCppAnnualBenefit(stream.annualAmount || cppAnnualMaximum, inputs.strategy.cppStartAge)
      : stream.taxTreatment === "oas"
        ? calculateOasAnnualBenefit(stream.annualAmount || oasAnnualMaximum, inputs.strategy.oasStartAge)
        : stream.annualAmount;
    // Employment/pension income ending at retirement is paid through the selected retirement month in that final work year.
    const proration = incomeProrationFraction(
      age,
      stream.startAge,
      effectiveEndAge,
      stream.startMonth ?? 1,
      deathBindsFirst ? person.birthMonth : stream.endMonth ?? 12,
      yearIndex,
      true,
    );
    const indexMultiplier = streamIndexMultiplier(stream, inflationMultiplier, streamIndexMultipliers);
    const amount = baseAmount * indexMultiplier * proration;
    if (stream.taxTreatment === "cpp") {
      income.cpp += amount;
      taxableIncome.ordinaryIncome += amount;
    } else if (stream.taxTreatment === "oas") {
      income.oas += amount;
      taxableIncome.ordinaryIncome += amount;
    } else if (stream.taxTreatment === "employment" || stream.taxTreatment === "pension") {
      income.employment += amount;
      taxableIncome.ordinaryIncome += amount;
    } else if (stream.taxTreatment === "rrspWithdrawal") {
      income.rrspWithdrawal += amount;
      taxableIncome.ordinaryIncome += amount;
    }
    else if (stream.taxTreatment === "taxFree") income.tfsaWithdrawal += amount;
    else {
      income.nonRegisteredWithdrawal += amount;
      if (stream.taxTreatment === "eligibleDividend") taxableIncome.eligibleDividends += amount;
      else if (stream.taxTreatment === "nonEligibleDividend") taxableIncome.nonEligibleDividends += amount;
      else if (stream.taxTreatment === "capitalGains") taxableIncome.capitalGains += amount;
    }
  }

  const schedules = (inputs.contributionSchedules ?? []).filter((schedule) => schedule.ownerId === person.id);
  for (const schedule of schedules) {
    const endYear = schedule.endYear ?? schedule.year;
    if (calendarYear < schedule.year || calendarYear > endYear) continue;
    const proration = 1;
    const multiplier = proration;
    const frequencyMultiplier = schedule.frequency === "monthly" ? 12 : 1;
    const rrspAmount = Math.max(0, schedule.annualRrspContribution ?? 0) * frequencyMultiplier * multiplier;
    const tfsaAmount = Math.max(0, schedule.annualTfsaContribution ?? 0) * frequencyMultiplier * multiplier;
    const nonRegisteredAmount = Math.max(0, schedule.annualNonRegisteredContribution ?? 0) * frequencyMultiplier * multiplier;
    if (schedule.frequency === "monthly") {
      monthlyRrspContribution += rrspAmount / 12;
      monthlyTfsaContribution += tfsaAmount / 12;
      monthlyNonRegisteredContribution += nonRegisteredAmount / 12;
    } else {
      rrspContribution += rrspAmount;
      tfsaContribution += tfsaAmount;
      nonRegisteredContribution += nonRegisteredAmount;
    }
    cashContribution += rrspAmount + tfsaAmount + nonRegisteredAmount;
    taxableIncome.ordinaryIncome = Math.max(0, taxableIncome.ordinaryIncome - rrspAmount);
  }

  if (age <= person.targetDeathAge) {
    if (person.receivesCpp && age >= inputs.strategy.cppStartAge) {
      // Was targetDeathAge + 1, which the age <= targetDeathAge guard above made unreachable - the death year never actually prorated. Fixed to cut off on the death birthday itself.
      const proration = incomeProrationFraction(age, inputs.strategy.cppStartAge, person.targetDeathAge, person.birthMonth, person.birthMonth, yearIndex);
      const cppAmount = calculateCppAnnualBenefit(cppAnnualMaximum * person.cppPayoutRate, inputs.strategy.cppStartAge) * inflationMultiplier * proration;
      income.cpp += cppAmount;
      taxableIncome.ordinaryIncome += cppAmount;
    }
    if (person.receivesOas && age >= Math.max(65, inputs.strategy.oasStartAge)) {
      const oasStartAge = Math.max(65, inputs.strategy.oasStartAge);
      const proration = incomeProrationFraction(age, oasStartAge, person.targetDeathAge, person.birthMonth, person.birthMonth, yearIndex);
      const oasAmount = calculateOasAnnualBenefit(oasAnnualMaximum, inputs.strategy.oasStartAge) * inflationMultiplier * proration;
      income.oas += oasAmount;
      taxableIncome.ordinaryIncome += oasAmount;
    }
  }

  return { income, taxableIncome, rrspContribution, tfsaContribution, nonRegisteredContribution, cashContribution, monthlyRrspContribution, monthlyTfsaContribution, monthlyNonRegisteredContribution };
}

function incomeProrationFraction(
  age: number,
  startAge: number,
  endAge: number,
  startMonth: number | undefined,
  endMonth: number | undefined,
  yearIndex: number,
  endMonthInclusive = false,
) {
  if (startAge === endAge) return 1;
  if (age === startAge) return !startMonth || yearIndex === 0 ? 1 : (13 - startMonth) / 12;
  if (age === endAge) return !endMonth ? 1 : (endMonthInclusive ? endMonth : endMonth - 1) / 12;
  return 1;
}

function finiteNumber(value: unknown, fallback: number) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : fallback;
}

function mapValues<T, U>(record: Record<string, T>, mapper: (value: T) => U): Record<string, U> {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, mapper(value)]));
}

function sumBalances(balancesByPerson: Record<string, AccountBalances>): AccountBalances {
  return Object.values(balancesByPerson).reduce((total, balances) => ({
    rrsp: total.rrsp + balances.rrsp,
    tfsa: total.tfsa + balances.tfsa,
    nonRegistered: total.nonRegistered + balances.nonRegistered,
    nonRegisteredBookValue: total.nonRegisteredBookValue + balances.nonRegisteredBookValue,
    interestBearing: total.interestBearing + balances.interestBearing,
    interestBearingAccrued: total.interestBearingAccrued + balances.interestBearingAccrued,
    taxableInterestBearingAccrued: total.taxableInterestBearingAccrued + balances.taxableInterestBearingAccrued,
    gicPositions: [],
  }), { rrsp: 0, tfsa: 0, nonRegistered: 0, nonRegisteredBookValue: 0, interestBearing: 0, interestBearingAccrued: 0, taxableInterestBearingAccrued: 0, gicPositions: [] });
}

function totalPortfolioAcross(balancesByPerson: Record<string, AccountBalances>) {
  return Object.values(balancesByPerson).reduce((sum, balances) => sum + totalPortfolio(balances), 0);
}

// Models a spousal RRSP/RRIF rollover: the deceased's accounts move to the survivor tax-free rather than being deemed disposed.
function mergeBalances(target: AccountBalances, source: AccountBalances): AccountBalances {
  return {
    rrsp: target.rrsp + source.rrsp,
    tfsa: target.tfsa + source.tfsa,
    nonRegistered: target.nonRegistered + source.nonRegistered,
    nonRegisteredBookValue: target.nonRegisteredBookValue + source.nonRegisteredBookValue,
    interestBearing: target.interestBearing + source.interestBearing,
    interestBearingAccrued: target.interestBearingAccrued + source.interestBearingAccrued,
    taxableInterestBearingAccrued: target.taxableInterestBearingAccrued + source.taxableInterestBearingAccrued,
    gicPositions: [...target.gicPositions, ...source.gicPositions],
  };
}

function zeroBalances(): AccountBalances {
  return { rrsp: 0, tfsa: 0, nonRegistered: 0, nonRegisteredBookValue: 0, interestBearing: 0, interestBearingAccrued: 0, taxableInterestBearingAccrued: 0, gicPositions: [] };
}

export function calculateTax(
  taxableIncome: TaxableIncome,
  province: ProvinceCode,
  capitalGainsInclusionRate: number,
  taxSettings: TaxSettings = defaultTaxSettings,
): TaxResult {
  const capitalGainsTaxableAmount = Math.max(0, taxableIncome.capitalGains) * capitalGainsInclusionRate;
  const eligibleDividendTaxableAmount = Math.max(0, taxableIncome.eligibleDividends) * 1.38;
  const nonEligibleDividendTaxableAmount = Math.max(0, taxableIncome.nonEligibleDividends) * 1.15;
  const totalTaxableIncome = Math.max(0, taxableIncome.ordinaryIncome)
    + capitalGainsTaxableAmount
    + eligibleDividendTaxableAmount
    + nonEligibleDividendTaxableAmount;
  const grossFederalTax = bracketTax(totalTaxableIncome, taxSettings.federal.brackets);
  const federalBasicCredit = Math.min(taxSettings.federal.basicPersonalAmount, totalTaxableIncome)
    * taxSettings.federal.taxCreditRate;
  const federalDividendCredit = eligibleDividendTaxableAmount * 0.150198
    + nonEligibleDividendTaxableAmount * 0.090301;
  const federalTaxBeforeAbatement = Math.max(0, grossFederalTax - federalBasicCredit - federalDividendCredit);
  const federalTax = federalTaxBeforeAbatement * (1 - taxSettings.provinces[province].abatementRate);
  const provincialSettings = taxSettings.provinces[province];
  const provincialBaseTax = Math.max(0, bracketTax(totalTaxableIncome, provincialSettings.brackets)
    - Math.min(provincialSettings.basicPersonalAmount, totalTaxableIncome) * provincialSettings.taxCreditRate);
  const provincialTax = provincialBaseTax + bracketTax(provincialBaseTax, provincialSettings.surtaxBrackets);
  const totalTax = federalTax + provincialTax;
  const marginalRate = totalTaxableIncome === 0
    ? 0
    : marginalTaxRate(totalTaxableIncome, province, taxSettings);

  return {
    federalTax,
    provincialTax,
    dividendTaxCredit: federalDividendCredit,
    capitalGainsTaxableAmount,
    totalTax,
    marginalRate,
    averageRate: totalTaxableIncome === 0 ? 0 : totalTax / totalTaxableIncome,
  };
}

function requiredWithdrawal(
  requiredCash: number,
  available: number,
  account: keyof AccountWithdrawals,
  balances: AccountBalances,
  withdrawals: AccountWithdrawals,
  fixedTaxable: TaxableIncome,
  inputs: RetirementInputs,
) {
  let low = 0;
  let high = available;
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const candidate = (low + high) / 2;
    const candidateWithdrawals = { ...withdrawals, [account]: withdrawals[account] + candidate };
    const candidateTax = calculateTax(
      taxableIncomeForYear(fixedTaxable, candidateWithdrawals, balances),
      inputs.personalInfo.province,
      inputs.simulation.capitalGainsInclusionRate,
      inputs.taxSettings,
    );
    const candidateNetCash = candidate - (candidateTax.totalTax - calculateTax(
      taxableIncomeForYear(fixedTaxable, withdrawals, balances),
      inputs.personalInfo.province,
      inputs.simulation.capitalGainsInclusionRate,
      inputs.taxSettings,
    ).totalTax);
    if (candidateNetCash >= requiredCash) high = candidate;
    else low = candidate;
  }
  return high;
}

function taxableIncomeForYear(
  fixedTaxable: TaxableIncome,
  withdrawals: AccountWithdrawals,
  startingBalances: AccountBalances,
): TaxableIncome {
  const nonRegisteredGainRatio = startingBalances.nonRegistered <= 0
    ? 0
    : Math.max(0, startingBalances.nonRegistered - startingBalances.nonRegisteredBookValue) / startingBalances.nonRegistered;
  // Cashing out early crystallizes a proportional share of the still-deferred (untaxed) growth for that term.
  const interestBearingAccruedRatio = startingBalances.interestBearing <= 0
    ? 0
    : startingBalances.taxableInterestBearingAccrued / startingBalances.interestBearing;
  return {
    ...fixedTaxable,
    ordinaryIncome: fixedTaxable.ordinaryIncome + withdrawals.rrsp + withdrawals.interestBearing * interestBearingAccruedRatio,
    capitalGains: fixedTaxable.capitalGains + withdrawals.nonRegistered * nonRegisteredGainRatio,
  };
}

function marginalTaxRate(taxableIncome: number, province: ProvinceCode, taxSettings: TaxSettings) {
  const federal = bracketRate(taxableIncome, taxSettings.federal.brackets);
  const provincial = bracketRate(taxableIncome, taxSettings.provinces[province].brackets);
  return (federal * (1 - taxSettings.provinces[province].abatementRate)) + provincial;
}

function bracketTax(income: number, brackets: TaxRateBracket[]) {
  let tax = 0;
  for (const bracket of brackets) {
    const upperLimit = bracket.to ?? Number.POSITIVE_INFINITY;
    const portion = Math.max(0, Math.min(income, upperLimit) - bracket.from);
    tax += portion * bracket.rate;
    if (income <= upperLimit) break;
  }
  return tax;
}

function bracketRate(income: number, brackets: TaxRateBracket[]) {
  return brackets.find((bracket) => income >= bracket.from && (bracket.to === null || income <= bracket.to))?.rate ?? 0;
}

function nextFederalBracketLimit(income: number, taxSettings: TaxSettings) {
  const brackets = taxSettings.federal.brackets;
  const matchIndex = brackets.findIndex((bracket) => income < (bracket.to ?? Number.POSITIVE_INFINITY));
  // Already in (or past) the top bracket: there's no next bracket to "fill up to", so don't melt further.
  if (matchIndex === -1 || matchIndex === brackets.length - 1) return income;
  return brackets[matchIndex].to ?? income;
}

function removeWithdrawal(balances: AccountBalances, account: keyof AccountWithdrawals, amount: number): AccountBalances {
  const next = cloneBalances(balances);
  if (account === "nonRegistered") {
    const balanceBefore = next.nonRegistered;
    const bookValueReduction = balanceBefore === 0 ? 0 : next.nonRegisteredBookValue * (amount / balanceBefore);
    next.nonRegistered = Math.max(0, balanceBefore - amount);
    next.nonRegisteredBookValue = Math.max(0, next.nonRegisteredBookValue - bookValueReduction);
  } else if (account === "interestBearing") {
    // Reduces every GIC position proportionally to how much of the aggregate balance it holds, so each rung's own
    // deferred-growth ratio stays consistent with what's actually left in it.
    const balanceBefore = next.interestBearing;
    const ratio = balanceBefore === 0 ? 0 : Math.min(1, amount / balanceBefore);
    next.gicPositions = next.gicPositions.map((position) => ({
      ...position,
      balance: Math.max(0, position.balance - position.balance * ratio),
      accrued: Math.max(0, position.accrued - position.accrued * ratio),
    }));
    next.interestBearing = Math.max(0, balanceBefore - amount);
    next.interestBearingAccrued = next.gicPositions.reduce((sum, position) => sum + position.accrued, 0);
  } else {
    next[account] = Math.max(0, next[account] - amount);
  }
  return next;
}

// periodFraction is 1 for a full annual pass, or 1/subPeriodCount when compounding a single sub-period. portfolioReturn
// is already period-scaled by the caller (e.g. one month's decomposed return) - only each GIC position's own ANNUAL
// rate needs converting to an equivalent period rate here, since it's principal-protected and grows independent of
// the market return.
function applyAnnualReturn(balances: AccountBalances, portfolioReturn: number, periodFraction: number): AccountBalances {
  const returnMultiplier = Math.max(0, 1 + portfolioReturn);
  const gicPositions = balances.gicPositions.map((position) => ({
    ...position,
    balance: position.balance * ((1 + Math.max(0, position.annualRate)) ** periodFraction),
  }));
  return {
    rrsp: balances.rrsp * returnMultiplier,
    tfsa: balances.tfsa * returnMultiplier,
    nonRegistered: balances.nonRegistered * returnMultiplier,
    nonRegisteredBookValue: balances.nonRegisteredBookValue,
    interestBearing: gicPositions.reduce((sum, position) => sum + position.balance, 0),
    interestBearingAccrued: balances.interestBearingAccrued,
    taxableInterestBearingAccrued: balances.taxableInterestBearingAccrued,
    gicPositions,
  };
}

function cashFromIncome(income: IncomeBySource) {
  return income.employment + income.cpp + income.oas
    + income.rrspWithdrawal + income.tfsaWithdrawal + income.nonRegisteredWithdrawal + income.interestBearingWithdrawal;
}

function sumWithdrawals(withdrawals: AccountWithdrawals) {
  return withdrawals.rrsp + withdrawals.tfsa + withdrawals.nonRegistered + withdrawals.interestBearing;
}

function totalPortfolio(balances: AccountBalances) {
  return balances.rrsp + balances.tfsa + balances.nonRegistered + balances.interestBearing;
}

function cloneBalances(balances: AccountBalances): AccountBalances {
  return { ...balances, gicPositions: balances.gicPositions.map((position) => ({ ...position })) };
}
