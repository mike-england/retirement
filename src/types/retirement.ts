export type TaxTreatment =
  | "employment"
  | "pension"
  | "cpp"
  | "oas"
  | "rrspWithdrawal"
  | "eligibleDividend"
  | "nonEligibleDividend"
  | "capitalGains"
  | "taxFree";

export type ProvinceCode =
  | "AB"
  | "BC"
  | "MB"
  | "NB"
  | "NL"
  | "NS"
  | "NT"
  | "NU"
  | "ON"
  | "PE"
  | "QC"
  | "SK"
  | "YT";

export type AccountType = "rrsp" | "tfsa" | "nonRegistered";

export interface TaxRateBracket {
  from: number;
  to: number | null;
  rate: number;
}

export interface TaxJurisdictionSettings {
  basicPersonalAmount: number;
  taxCreditRate: number;
  abatementRate: number;
  brackets: TaxRateBracket[];
  surtaxBrackets: TaxRateBracket[];
}

export interface TaxSettings {
  taxYear: number;
  source: string;
  federal: TaxJurisdictionSettings;
  provinces: Record<ProvinceCode, TaxJurisdictionSettings>;
}

export interface PersonalInfo {
  label: string;
  currentAge: number;
  targetDeathAge: number;
  birthMonth?: number;
  province: ProvinceCode;
  receivesCpp: boolean;
  cppPayoutRate: number;
  receivesOas: boolean;
  additionalPeople: PlanPerson[];
}

export interface PlanPerson {
  id: string;
  label: string;
  currentAge: number;
  targetDeathAge: number;
  birthMonth?: number;
  receivesCpp: boolean;
  cppPayoutRate: number;
  receivesOas: boolean;
  existingAssets?: ExistingAssets;
}

export type IndexationMode = "none" | "fullInflation" | "partialInflation" | "fixedRate";

export interface IncomeStream {
  id: string;
  ownerId: string;
  label: string;
  annualAmount: number;
  startAge: number;
  endAge: number;
  taxTreatment: TaxTreatment;
  indexationMode: IndexationMode;
  // Fraction of simulated inflation for "partialInflation" (e.g. 0.9 = 90% COLA), or a flat annual rate for "fixedRate" (e.g. 0.015 = 1.5%/yr).
  indexationRate?: number;
  startMonth?: number;
  endMonth?: number;
}

export interface ContributionSchedule {
  id: string;
  ownerId: string;
  label: string;
  year: number;
  endYear: number;
  frequency: "annual" | "monthly";
  annualRrspContribution?: number;
  annualTfsaContribution?: number;
  annualNonRegisteredContribution?: number;
}

export interface ExistingAssets {
  rrspBalance: number;
  tfsaBalance: number;
  nonRegisteredBalance: number;
  nonRegisteredBookValue: number;
  // Deprecated: a single implicit GIC starting immediately, kept only so older saved scenarios still load. New scenarios use `gics` below.
  interestBearingBalance?: number;
  interestBearingTermYears?: number;
  interestBearingRate?: number;
  // A ladder of GICs/PPNs, each with its own start age, term, rate, funding source, and maturity behavior.
  gics?: GicHolding[];
}

// The tax status of the GIC holding. "external" is retained as a legacy alias for non-registered saved scenarios.
export type GicFundingSource = "external" | "registered" | "nonRegistered";
// What happens to a GIC's proceeds when its term matures: "renew" starts an identical new term immediately (a true
// ladder, indefinitely), "cashOut" moves the proceeds into the non-registered account instead of continuing.
export type GicMaturityAction = "renew" | "cashOut";

export interface GicHolding {
  id: string;
  label?: string;
  balance: number;
  // Total guaranteed return for the whole term (e.g. "5% for a 2-year GIC" = 5% over those 2 years), same convention as the legacy single-GIC rate.
  rate: number;
  termYears: number;
  startAge: number;
  fundingSource: GicFundingSource;
  maturityAction: GicMaturityAction;
}

export interface SpendingPhase {
  id: string;
  label: string;
  startAge: number;
  endAge: number;
  annualSpending: number;
}

export interface SpendingPlan {
  desiredAnnualSpending: number;
  indexedToInflation: boolean;
  phases: SpendingPhase[];
}

export interface MarketAssumptions {
  returnMean: number;
  returnStdDev: number;
  returnFloor: number;
  returnCeiling: number;
  annualReturnOverrides: Record<number, number>;
  inflationMean: number;
  inflationStdDev: number;
}

export type WithdrawalAccount = "interestBearing" | "nonRegistered" | "tfsa" | "rrsp";

// How often the withdrawal waterfall runs against realized (already-applied) sub-period returns, instead of one lump annual withdrawal.
export type WithdrawalFrequency = "annual" | "semiAnnual" | "quarterly" | "monthly";

export interface StrategySettings {
  cppStartAge: 60 | 65 | 70;
  oasStartAge: 60 | 65 | 70;
  aggressiveRrspMeltdown: boolean;
  // Order accounts are drawn down to cover each year's spending shortfall, e.g. ["interestBearing", "nonRegistered", "tfsa", "rrsp"].
  withdrawalOrder: WithdrawalAccount[];
  // Defaults to "annual" (a single year-end withdrawal) for scenarios saved before this was configurable.
  withdrawalFrequency?: WithdrawalFrequency;
  // Uses the GIC/PPN as a sequence-of-returns buffer instead of a fixed withdrawal-order position: reserved (and optionally
  // refilled) while markets are near their peak, then drawn preferentially once the market portfolio is in a real drawdown.
  gicBuffer?: GicBufferSettings;
}

export interface GicBufferSettings {
  enabled: boolean;
  // Peak-to-current drawdown of the market-linked sub-portfolio (RRSP+TFSA+non-registered) that flips the GIC to being drawn first, e.g. 0.10 = 10% down from its peak.
  triggerDrawdown: number;
  // Drawdown level (measured the same way) at which the market is considered recovered and the GIC reverts to being reserved. Should be <= triggerDrawdown to avoid flip-flopping year to year.
  recoveryDrawdown: number;
  // While reserved, redirects any leftover cash (e.g. RRIF minimums exceeding spending need) into the GIC first, up to targetBalance, before TFSA/non-registered.
  refillFromSurplus: boolean;
  // Balance to refill toward; defaults to the household's combined starting GIC balance when unset.
  targetBalance?: number;
}


export interface SimulationSettings {
  iterations: number;
  randomSeed?: number;
  capitalGainsInclusionRate: 0.5 | 0.6667;
  probateFeeRate: number;
}

export interface RetirementInputs {
  personalInfo: PersonalInfo;
  incomeStreams: IncomeStream[];
  contributionSchedules: ContributionSchedule[];
  existingAssets: ExistingAssets;
  spendingPlan: SpendingPlan;
  assumptions: MarketAssumptions;
  taxSettings: TaxSettings;
  strategy: StrategySettings;
  simulation: SimulationSettings;
}

// Live simulation state for a single GIC ladder rung (distinct from the GicHolding config it was created from).
export interface GicPositionState {
  id: string;
  balance: number;
  accrued: number;
  fundingSource: GicFundingSource;
  termElapsed: number;
  termYears: number;
  // Effective annual compounding rate (already converted from the configured total-for-term rate).
  annualRate: number;
  maturityAction: GicMaturityAction;
}

export interface AccountBalances {
  rrsp: number;
  tfsa: number;
  nonRegistered: number;
  nonRegisteredBookValue: number;
  // Aggregate across all gicPositions below - kept in sync whenever positions change, and is what withdrawals/display use.
  interestBearing: number;
  interestBearingAccrued: number;
  taxableInterestBearingAccrued: number;
  gicPositions: GicPositionState[];
}

export interface AccountWithdrawals {
  rrsp: number;
  tfsa: number;
  nonRegistered: number;
  interestBearing: number;
}

export interface IncomeBySource {
  employment: number;
  cpp: number;
  oas: number;
  interest: number;
  rrspWithdrawal: number;
  tfsaWithdrawal: number;
  nonRegisteredWithdrawal: number;
  interestBearingWithdrawal: number;
}

export interface TaxResult {
  federalTax: number;
  provincialTax: number;
  dividendTaxCredit: number;
  capitalGainsTaxableAmount: number;
  totalTax: number;
  marginalRate: number;
  averageRate: number;
}

export interface PersonTaxBreakdown {
  id: string;
  label: string;
  federalTax: number;
  provincialTax: number;
  totalTax: number;
}

export interface YearProjection {
  age: number;
  calendarYear: number;
  openingBalances: AccountBalances;
  closingBalances: AccountBalances;
  income: IncomeBySource;
  withdrawals: AccountWithdrawals;
  rrifMinimumWithdrawal: number;
  totalIncome: number;
  taxes: TaxResult;
  taxesByPerson: PersonTaxBreakdown[];
  oasClawback: number;
  recurringNetIncome: number;
  netSpendableCash: number;
  spendingTarget: number;
  portfolioReturn: number;
  inflationRate: number;
  estateValue: number;
  // One-time deemed-disposition tax on death (RRSP/RRIF, deferred GIC growth, and non-registered gains), only nonzero the
  // year the last household member dies with no surviving person to roll over to. Kept separate from `taxes` (which
  // reflects that year's ordinary living income tax) since it's paid from the estate, not funded from annual cash flow.
  estateTax: number;
  depleted: boolean;
  // Only populated when strategy.gicBuffer.enabled: whether the GIC was being drawn (market drawdown past trigger) or reserved/refilled that year.
  gicBufferMode?: "draw" | "reserve";
  // Only populated when strategy.withdrawalFrequency isn't "annual": the within-year breakdown driving the withdrawal waterfall.
  subPeriods?: SubPeriodProjection[];
}

// One sub-annual slice (month/quarter/half-year) of a YearProjection: its own realized return and the withdrawals it triggered.
export interface SubPeriodProjection {
  index: number;
  portfolioReturn: number;
  withdrawals: AccountWithdrawals;
  closingBalances: AccountBalances;
}

export interface DeterministicProjection {
  years: YearProjection[];
  finalEstateValue: number;
  lifetimeTax: number;
  portfolioPeakAge: number;
  portfolioDepleted: boolean;
}

export interface PercentileBand {
  age: number;
  pWorstSurviving: number;
  p10: number;
  p50: number;
  p90: number;
}

export interface MonteCarloRun {
  years: YearProjection[];
  finalEstateValue: number;
  lifetimeTax: number;
  portfolioDepleted: boolean;
}

export interface SimulationKpis {
  successRate: number;
  medianFinalEstate: number;
  medianLifetimeTax: number;
  medianPortfolioPeakAge: number;
  worstSurvivingPercentileRank: number;
}

export interface FailureAgeBucket {
  age: number;
  failedRunCount: number;
}

export interface FailureAnalysis {
  failedRunCount: number;
  ageDistribution: FailureAgeBucket[];
  averageReturnFailedRuns: number;
  averageReturnSuccessfulRuns: number;
}

export interface SimulationOutput {
  kpis: SimulationKpis;
  percentileBands: PercentileBand[];
  medianRun: DeterministicProjection;
  runsCompleted: number;
  failureAnalysis: FailureAnalysis;
}