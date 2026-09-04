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
  annualRrspContribution?: number;
  annualTfsaContribution?: number;
  annualNonRegisteredContribution?: number;
}

export interface ExistingAssets {
  rrspBalance: number;
  tfsaBalance: number;
  nonRegisteredBalance: number;
  nonRegisteredBookValue: number;
  interestBearingBalance?: number;
  interestBearingTermYears?: number;
  interestBearingRate?: number;
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

export interface StrategySettings {
  cppStartAge: 60 | 65 | 70;
  oasStartAge: 60 | 65 | 70;
  aggressiveRrspMeltdown: boolean;
  // Order accounts are drawn down to cover each year's spending shortfall, e.g. ["interestBearing", "nonRegistered", "tfsa", "rrsp"].
  withdrawalOrder: WithdrawalAccount[];
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
  existingAssets: ExistingAssets;
  spendingPlan: SpendingPlan;
  assumptions: MarketAssumptions;
  taxSettings: TaxSettings;
  strategy: StrategySettings;
  simulation: SimulationSettings;
}

export interface AccountBalances {
  rrsp: number;
  tfsa: number;
  nonRegistered: number;
  nonRegisteredBookValue: number;
  interestBearing: number;
  interestBearingAccrued: number;
  interestBearingTermElapsed: number;
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
  depleted: boolean;
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