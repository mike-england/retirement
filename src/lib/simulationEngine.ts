import type {
  AccountBalances,
  AccountWithdrawals,
  DeterministicProjection,
  IncomeBySource,
  IncomeStream,
  ProvinceCode,
  RetirementInputs,
  TaxRateBracket,
  TaxResult,
  TaxSettings,
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
  interestBearingTermYears: number;
  interestBearingRate: number;
};

type PersonYearState = {
  id: string;
  age: number;
  balances: AccountBalances;
  income: IncomeBySource;
  withdrawals: AccountWithdrawals;
  fixedTaxable: TaxableIncome;
  tax: TaxResult;
};

export type ProjectionOptions = {
  calendarYear?: number;
  annualReturns?: number[];
  annualInflation?: number[];
};

export function projectRetirementPlan(
  inputs: RetirementInputs,
  options: ProjectionOptions = {},
): DeterministicProjection {
  const baseYear = options.calendarYear ?? new Date().getFullYear();
  const years: YearProjection[] = [];
  const roster = buildRoster(inputs);
  let balancesByPerson = initialBalancesByPerson(inputs, roster);
  let cumulativeInflation = 1;
  // Streams with "partialInflation"/"fixedRate" indexing compound independently of the shared inflation multiplier.
  const streamIndexMultipliers: Record<string, number> = Object.fromEntries(
    inputs.incomeStreams.map((stream) => [stream.id, 1]),
  );
  let lifetimeTax = 0;
  let peakValue = totalPortfolioAcross(balancesByPerson);
  let portfolioPeakAge = inputs.personalInfo.currentAge;
  let portfolioDepleted = false;
  // "age" throughout this loop always tracks the primary's age; other people's targetDeathAge is in their OWN age scale, so compare by year index (years since simulation start), not raw age.
  const maxLifespanIndex = Math.max(...roster.map((person) => person.targetDeathAge - person.currentAge));
  const finalAge = inputs.personalInfo.currentAge + maxLifespanIndex;
  const livingIds = new Set(roster.map((person) => person.id));
  const retirementStartAge = Math.min(
    ...inputs.spendingPlan.phases.map((phase) => phase.startAge),
    finalAge + 1,
  );

  for (
    let age = inputs.personalInfo.currentAge, index = 0;
    index <= maxLifespanIndex;
    age += 1, index += 1
  ) {
    const openingBalancesByPerson = mapValues(balancesByPerson, cloneBalances);
    const inflationRate = options.annualInflation?.[index] ?? inputs.assumptions.inflationMean;
    const portfolioReturn = options.annualReturns?.[index] ?? inputs.assumptions.returnMean;
    const activePhase = inputs.spendingPlan.phases.find(
      (phase) => age >= phase.startAge && age <= phase.endAge,
    );
    const spendingTarget = activePhase
      ? activePhase.annualSpending * (inputs.spendingPlan.indexedToInflation ? cumulativeInflation : 1)
      : 0;

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
      portfolioReturn,
    );

    balancesByPerson = Object.fromEntries(
      Object.entries(result.balancesByPerson).map(([personId, balances]) => [
        personId,
        applyAnnualReturn(balances, portfolioReturn, roster.find((person) => person.id === personId)?.interestBearingRate ?? portfolioReturn),
      ]),
    );
    let estateValue = totalPortfolioAcross(balancesByPerson);
    let yearTax = result.tax.totalTax;

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
        const estateTax = dyingThisYear.reduce((sum, person) => sum + calculateTax(
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
        yearTax += estateTax;
        estateValue = Math.max(0, grossEstate - estateTax);
        estateValue *= 1 - inputs.simulation.probateFeeRate;
      }
    }

    lifetimeTax += yearTax;
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
      depleted,
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
      interestBearingTermYears: Math.max(1, finiteNumber(inputs.existingAssets.interestBearingTermYears, 1)),
      interestBearingRate: finiteNumber(inputs.existingAssets.interestBearingRate, inputs.assumptions.returnMean),
    },
    ...(inputs.personalInfo.additionalPeople ?? []).map((person) => ({
      id: person.id,
      label: person.label || "Person",
      currentAge: finiteNumber(person.currentAge, inputs.personalInfo.currentAge),
      targetDeathAge: finiteNumber(person.targetDeathAge, inputs.personalInfo.targetDeathAge),
      birthMonth: person.birthMonth,
      receivesCpp: person.receivesCpp ?? true,
      cppPayoutRate: Math.max(0, finiteNumber(person.cppPayoutRate, 0.6)),
      receivesOas: person.receivesOas ?? true,
      interestBearingTermYears: Math.max(1, finiteNumber(person.existingAssets?.interestBearingTermYears, 1)),
      interestBearingRate: finiteNumber(person.existingAssets?.interestBearingRate, inputs.assumptions.returnMean),
    })),
  ];
}

function initialBalancesByPerson(inputs: RetirementInputs, roster: PersonRoster[]): Record<string, AccountBalances> {
  const balances: Record<string, AccountBalances> = {};
  for (const person of roster) {
    const assets = person.id === "primary"
      ? inputs.existingAssets
      : inputs.personalInfo.additionalPeople?.find((candidate) => candidate.id === person.id)?.existingAssets;
    balances[person.id] = {
      rrsp: assets?.rrspBalance ?? 0,
      tfsa: assets?.tfsaBalance ?? 0,
      nonRegistered: assets?.nonRegisteredBalance ?? 0,
      nonRegisteredBookValue: assets?.nonRegisteredBookValue ?? 0,
      interestBearing: assets?.interestBearingBalance ?? 0,
      interestBearingAccrued: 0,
      interestBearingTermElapsed: 0,
    };
  }
  return balances;
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
  portfolioReturn: number,
) {
  const states: PersonYearState[] = roster.map((person) => {
    const fixed = personFixedIncome(inputs, person, yearIndex, inflationMultiplier, streamIndexMultipliers);
    const opening = balancesByPerson[person.id];
    // GIC/PPN-style interest uses its own guaranteed rate (not the market return) and compounds tax-deferred within the term; the full accumulated growth is only taxed the year the term matures.
    const growth = opening.interestBearing * Math.max(0, person.interestBearingRate);
    const accruedAfterGrowth = opening.interestBearingAccrued + growth;
    const termElapsed = opening.interestBearingTermElapsed + 1;
    const maturityReached = termElapsed >= person.interestBearingTermYears;
    const interestIncome = maturityReached ? accruedAfterGrowth : 0;
    const fixedTaxable = { ...fixed.taxableIncome, ordinaryIncome: fixed.taxableIncome.ordinaryIncome + interestIncome };
    return {
      id: person.id,
      age: person.currentAge + yearIndex,
      balances: {
        ...cloneBalances(opening),
        interestBearingAccrued: maturityReached ? 0 : accruedAfterGrowth,
        interestBearingTermElapsed: maturityReached ? 0 : termElapsed,
        // Contributions from income streams (e.g. salary deductions) land directly in the relevant account.
        rrsp: opening.rrsp + fixed.rrspContribution,
        tfsa: opening.tfsa + fixed.tfsaContribution,
        nonRegistered: opening.nonRegistered + fixed.nonRegisteredContribution,
        nonRegisteredBookValue: opening.nonRegisteredBookValue + fixed.nonRegisteredContribution,
      },
      income: { ...fixed.income, interest: fixed.income.interest + interestIncome },
      withdrawals: { rrsp: 0, tfsa: 0, nonRegistered: 0, interestBearing: 0 },
      fixedTaxable,
      tax: calculateTax(fixedTaxable, inputs.personalInfo.province, inputs.simulation.capitalGainsInclusionRate, inputs.taxSettings),
    };
  });

  const netCashTotal = () => states.reduce((sum, state) => sum + Math.max(0, cashFromIncome(state.income) + sumWithdrawals(state.withdrawals) - state.tax.totalTax), 0);
  const recurringNetIncome = states.reduce((sum, state) => sum + Math.max(0, cashFromIncome(state.income) - state.tax.totalTax), 0);

  // RRIF minimum withdrawals are mandatory once converted (by 71), regardless of spending need, based on the fund's value at the start of the year.
  let rrifMinimumWithdrawal = 0;
  for (const state of states) {
    const minimumWithdrawal = calculateRrifMinimumWithdrawal(balancesByPerson[state.id].rrsp, state.age);
    if (minimumWithdrawal <= 0) continue;
    const amount = Math.min(minimumWithdrawal, state.balances.rrsp);
    if (amount <= 0) continue;
    rrifMinimumWithdrawal += amount;
    state.balances = removeWithdrawal(state.balances, "rrsp", amount);
    state.withdrawals.rrsp += amount;
    state.tax = calculateTax(
      taxableIncomeForYear(state.fixedTaxable, state.withdrawals, state.balances),
      inputs.personalInfo.province,
      inputs.simulation.capitalGainsInclusionRate,
      inputs.taxSettings,
    );
  }

  // Interest-bearing balances get no further tax benefit from staying invested (already taxed annually as it accrues), so they're drawn down first by default.
  // Falls back to the historical default order for scenarios saved before withdrawal order was configurable.
  const withdrawalOrder = inputs.strategy.withdrawalOrder ?? ["interestBearing", "nonRegistered", "tfsa", "rrsp"];
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

  if (inputs.strategy.aggressiveRrspMeltdown && age >= retirementStartAge) {
    for (const state of states) {
      if (state.balances.rrsp <= 0) continue;
      const currentOrdinaryIncome = taxableIncomeForYear(state.fixedTaxable, state.withdrawals, state.balances).ordinaryIncome;
      const nextLimit = nextFederalBracketLimit(currentOrdinaryIncome, inputs.taxSettings);
      const meltAmount = Math.min(state.balances.rrsp, Math.max(0, nextLimit - currentOrdinaryIncome));
      if (meltAmount <= 0) continue;
      state.balances = removeWithdrawal(state.balances, "rrsp", meltAmount);
      state.withdrawals.rrsp += meltAmount;
      state.tax = calculateTax(
        taxableIncomeForYear(state.fixedTaxable, state.withdrawals, state.balances),
        inputs.personalInfo.province,
        inputs.simulation.capitalGainsInclusionRate,
        inputs.taxSettings,
      );
    }
  }

  // OAS recovery tax: applied last, against each person's final income for the year (including any withdrawals above), so it reflects the actual year's outcome.
  let oasClawback = 0;
  for (const state of states) {
    if (state.income.oas <= 0) continue;
    const totalOrdinaryIncome = taxableIncomeForYear(state.fixedTaxable, state.withdrawals, state.balances).ordinaryIncome;
    const otherOrdinaryIncome = totalOrdinaryIncome - state.income.oas;
    const clawback = calculateOasClawback(state.income.oas, otherOrdinaryIncome, state.age, inflationMultiplier);
    if (clawback <= 0) continue;
    oasClawback += clawback;
    state.income = { ...state.income, oas: state.income.oas - clawback };
    state.fixedTaxable = { ...state.fixedTaxable, ordinaryIncome: state.fixedTaxable.ordinaryIncome - clawback };
    state.tax = calculateTax(
      taxableIncomeForYear(state.fixedTaxable, state.withdrawals, state.balances),
      inputs.personalInfo.province,
      inputs.simulation.capitalGainsInclusionRate,
      inputs.taxSettings,
    );
  }

  // Any leftover retirement-era cash beyond the spending need (RRIF minimum, meltdown, or income exceeding spending) gets reinvested rather than vanishing.
  // Before retirement, saving is explicit per income stream (RRSP/TFSA/non-registered contributions above) - any other leftover salary is assumed spent on living, not auto-invested.
  const finalSurplus = age >= retirementStartAge ? Math.max(0, netCashTotal() - spendingTarget) : 0;
  if (finalSurplus > 0) {
    const surplusState = states.find((state) => state.id === "primary") ?? states[0];
    // TFSA is fully tax-free, so it's filled first (up to the annual room) before falling back to non-registered.
    const tfsaRoom = Math.max(0, tfsaAnnualContributionLimit * inflationMultiplier);
    const tfsaContribution = Math.min(finalSurplus, tfsaRoom);
    const nonRegisteredContribution = finalSurplus - tfsaContribution;
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
    depleted: netSpendableCash < spendingTarget,
  };
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

function personFixedIncome(inputs: RetirementInputs, person: PersonRoster, yearIndex: number, inflationMultiplier: number, streamIndexMultipliers: Record<string, number>) {
  const income: IncomeBySource = { employment: 0, cpp: 0, oas: 0, interest: 0, rrspWithdrawal: 0, tfsaWithdrawal: 0, nonRegisteredWithdrawal: 0, interestBearingWithdrawal: 0 };
  const taxableIncome: TaxableIncome = { ordinaryIncome: 0, capitalGains: 0, eligibleDividends: 0, nonEligibleDividends: 0 };
  const age = person.currentAge + yearIndex;
  let rrspContribution = 0;
  let tfsaContribution = 0;
  let nonRegisteredContribution = 0;

  for (const stream of inputs.incomeStreams) {
    const ownerId = stream.ownerId || "primary";
    if (ownerId !== person.id) continue;
    const eligibleForAge = age >= stream.startAge && age <= Math.min(stream.endAge, person.targetDeathAge);
    const eligibleForBenefitStart = (stream.taxTreatment !== "cpp" || age >= inputs.strategy.cppStartAge)
      && (stream.taxTreatment !== "oas" || age >= Math.max(65, inputs.strategy.oasStartAge));
    if (!eligibleForAge || !eligibleForBenefitStart) continue;
    const baseAmount = stream.taxTreatment === "cpp"
      ? calculateCppAnnualBenefit(stream.annualAmount || cppAnnualMaximum, inputs.strategy.cppStartAge)
      : stream.taxTreatment === "oas"
        ? calculateOasAnnualBenefit(stream.annualAmount || oasAnnualMaximum, inputs.strategy.oasStartAge)
        : stream.annualAmount;
    const proration = incomeProrationFraction(age, stream.startAge, stream.endAge, person.birthMonth, yearIndex);
    const indexMultiplier = streamIndexMultiplier(stream, inflationMultiplier, streamIndexMultipliers);
    const amount = baseAmount * indexMultiplier * proration;
    if (stream.taxTreatment === "cpp") {
      income.cpp += amount;
      taxableIncome.ordinaryIncome += amount;
    } else if (stream.taxTreatment === "oas") {
      income.oas += amount;
      taxableIncome.ordinaryIncome += amount;
    } else if (stream.taxTreatment === "employment" || stream.taxTreatment === "pension") {
      // RRSP contributions are tax-deductible (reduce taxable income); TFSA/non-registered contributions come from after-tax cash and don't.
      const streamIndexMultiplierWithProration = indexMultiplier * proration;
      const streamRrspContribution = Math.min(amount, (stream.annualRrspContribution ?? 0) * streamIndexMultiplierWithProration);
      const afterRrsp = amount - streamRrspContribution;
      const streamTfsaContribution = Math.min(afterRrsp, (stream.annualTfsaContribution ?? 0) * streamIndexMultiplierWithProration);
      const afterTfsa = afterRrsp - streamTfsaContribution;
      const streamNonRegisteredContribution = Math.min(afterTfsa, (stream.annualNonRegisteredContribution ?? 0) * streamIndexMultiplierWithProration);
      rrspContribution += streamRrspContribution;
      tfsaContribution += streamTfsaContribution;
      nonRegisteredContribution += streamNonRegisteredContribution;
      income.employment += afterTfsa - streamNonRegisteredContribution;
      taxableIncome.ordinaryIncome += amount - streamRrspContribution;
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

  if (age <= person.targetDeathAge) {
    if (person.receivesCpp && age >= inputs.strategy.cppStartAge) {
      const proration = incomeProrationFraction(age, inputs.strategy.cppStartAge, person.targetDeathAge + 1, person.birthMonth, yearIndex);
      const cppAmount = calculateCppAnnualBenefit(cppAnnualMaximum * person.cppPayoutRate, inputs.strategy.cppStartAge) * inflationMultiplier * proration;
      income.cpp += cppAmount;
      taxableIncome.ordinaryIncome += cppAmount;
    }
    if (person.receivesOas && age >= Math.max(65, inputs.strategy.oasStartAge)) {
      const oasStartAge = Math.max(65, inputs.strategy.oasStartAge);
      const proration = incomeProrationFraction(age, oasStartAge, person.targetDeathAge + 1, person.birthMonth, yearIndex);
      const oasAmount = calculateOasAnnualBenefit(oasAnnualMaximum, inputs.strategy.oasStartAge) * inflationMultiplier * proration;
      income.oas += oasAmount;
      taxableIncome.ordinaryIncome += oasAmount;
    }
  }

  return { income, taxableIncome, rrspContribution, tfsaContribution, nonRegisteredContribution };
}

// Approximates a mid-year start/end of eligibility using birth month; skipped for single-year windows (would double-shrink) and for the plan's first year (already ongoing, not a new mid-year start).
function incomeProrationFraction(age: number, startAge: number, endAge: number, birthMonth: number | undefined, yearIndex: number) {
  if (!birthMonth || startAge === endAge) return 1;
  if (age === startAge) return yearIndex === 0 ? 1 : (13 - birthMonth) / 12;
  if (age === endAge) return (birthMonth - 1) / 12;
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
    interestBearingTermElapsed: 0,
  }), { rrsp: 0, tfsa: 0, nonRegistered: 0, nonRegisteredBookValue: 0, interestBearing: 0, interestBearingAccrued: 0, interestBearingTermElapsed: 0 });
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
    interestBearingTermElapsed: Math.max(target.interestBearingTermElapsed, source.interestBearingTermElapsed),
  };
}

function zeroBalances(): AccountBalances {
  return { rrsp: 0, tfsa: 0, nonRegistered: 0, nonRegisteredBookValue: 0, interestBearing: 0, interestBearingAccrued: 0, interestBearingTermElapsed: 0 };
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
    : startingBalances.interestBearingAccrued / startingBalances.interestBearing;
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
    const balanceBefore = next.interestBearing;
    const accruedReduction = balanceBefore === 0 ? 0 : next.interestBearingAccrued * (amount / balanceBefore);
    next.interestBearing = Math.max(0, balanceBefore - amount);
    next.interestBearingAccrued = Math.max(0, next.interestBearingAccrued - accruedReduction);
  } else {
    next[account] = Math.max(0, next[account] - amount);
  }
  return next;
}

function applyAnnualReturn(balances: AccountBalances, portfolioReturn: number, interestBearingRate: number): AccountBalances {
  const returnMultiplier = Math.max(0, 1 + portfolioReturn);
  // GICs/PPNs carry their own guaranteed rate rather than the market return, and are principal-protected (never decline).
  const interestMultiplier = 1 + Math.max(0, interestBearingRate);
  return {
    rrsp: balances.rrsp * returnMultiplier,
    tfsa: balances.tfsa * returnMultiplier,
    nonRegistered: balances.nonRegistered * returnMultiplier,
    nonRegisteredBookValue: balances.nonRegisteredBookValue,
    interestBearing: balances.interestBearing * interestMultiplier,
    interestBearingAccrued: balances.interestBearingAccrued,
    interestBearingTermElapsed: balances.interestBearingTermElapsed,
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
  return { ...balances };
}
