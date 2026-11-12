import { actualsProjectionOptions, compareActuals } from "@/lib/actuals";
import { projectWithVariableReturns } from "@/lib/projectionPath";
import { forecastInputsForYear, projectRetirementPlan } from "@/lib/simulationEngine";
import type { ActualsBaseline, DeterministicProjection, ForecastRevision, RetirementInputs, SpendingPlan, StrategySettings, WithdrawalAccount } from "@/types/retirement";

export function workingForecastContext(inputs: RetirementInputs) {
  const tracking = inputs.actuals;
  if (!tracking || tracking.workingBaselineId === null) return null;
  const latest = tracking.observations.filter((entry) => {
    const baseline = tracking.baselines.find((baseline) => baseline.id === entry.baselineId);
    return baseline && compareActuals(baseline, entry).actual !== null && compareActuals(baseline, entry).expected > 0;
  }).sort((first, second) => first.date.localeCompare(second.date)).at(-1);
  const baselineId = tracking.workingBaselineId ?? latest?.baselineId;
  const baseline = tracking.baselines.find((entry) => entry.id === baselineId);
  if (!baseline) return null;
  const observations = tracking.observations.filter((entry) => entry.baselineId === baseline.id);
  const revisions = [...(baseline.rebase?.revisions ?? []), ...(tracking.forecastRevisions ?? []).filter((entry) => entry.baselineId === baseline.id)];
  const asOf = observations.filter((entry) => compareActuals(baseline, entry).actual !== null).map((entry) => entry.date).sort().at(-1) ?? baseline.rebase?.date ?? baseline.planDate;
  return { baseline, observations, revisions, asOf };
}

export function workingForecastRebaseMarkers(inputs: RetirementInputs) {
  const context = workingForecastContext(inputs);
  if (!context) return [];
  const visited = new Set<string>();
  const datesByYear = new Map<number, Set<string>>();
  let baseline: ActualsBaseline | undefined = context.baseline;
  while (baseline?.rebase && !visited.has(baseline.id)) {
    visited.add(baseline.id);
    const date = baseline.rebase.date;
    const year = Number(date.slice(0, 4));
    const dates = datesByYear.get(year) ?? new Set<string>();
    dates.add(date);
    datesByYear.set(year, dates);
    const sourceId: string = baseline.rebase.sourceBaselineId;
    baseline = inputs.actuals?.baselines.find((entry) => entry.id === sourceId);
  }
  return [...datesByYear].sort(([first], [second]) => first - second).map(([calendarYear, dates]) => ({
    calendarYear, dates: [...dates].sort(),
    age: context.baseline.inputs.personalInfo.currentAge + calendarYear - Number(context.baseline.planDate.slice(0, 4)),
  }));
}

export function workingForecastSummary(inputs: RetirementInputs, projection: DeterministicProjection | null) {
  const context = workingForecastContext(inputs);
  if (!context) return null;
  const entries = new Map([...(context.baseline.rebase?.observations ?? []), ...context.observations].map((entry) => [entry.date, entry]));
  const candidate = entries.get(context.asOf);
  const observation = candidate && compareActuals(context.baseline, candidate).actual !== null ? candidate : undefined;
  const accounts = context.baseline.accounts.filter((account) => account.activeDate <= context.asOf).map((account) => ({
    ...account, owner: context.baseline.people.find((person) => person.id === account.ownerId)?.label ?? account.ownerId,
    balance: observation?.balances[account.key] ?? null,
  }));
  const totalBalance = observation ? compareActuals(context.baseline, observation).actual : null;
  const futureYears = projection?.years.filter((year) => year.calendarYear > Number(context.asOf.slice(0, 4))) ?? [];
  const shortfalls = futureYears.filter((year) => year.spendingTarget - year.netSpendableCash > 1);
  return { asOf: context.asOf, baseline: context.baseline, accounts, totalBalance, nextYear: futureYears[0] ?? null,
    totalGap: shortfalls.reduce((total, year) => total + year.spendingTarget - year.netSpendableCash, 0),
    firstGapYear: shortfalls[0]?.calendarYear ?? null, futureYearCount: futureYears.length };
}

export function projectWorkingForecast(inputs: RetirementInputs, strategyOverride?: Partial<StrategySettings>, spendingOverride?: SpendingPlan, preserveScheduledStrategies = false) {
  const context = workingForecastContext(inputs);
  if (!context) return projectWithVariableReturns(strategyOverride || spendingOverride
    ? { ...inputs, strategy: { ...inputs.strategy, ...strategyOverride }, spendingPlan: spendingOverride ?? inputs.spendingPlan } : inputs);
  const options = actualsProjectionOptions(context.baseline, context.observations, context.revisions);
  const effectiveDate = `${Number(context.asOf.slice(0, 4)) + 1}-01-01`;
  if ((strategyOverride || spendingOverride) && effectiveDate <= context.baseline.points.at(-1)!.date) {
    const future = forecastInputsForYear(context.baseline.inputs, context.revisions, Number(effectiveDate.slice(0, 4)));
    const settings = { incomeStreams: future.incomeStreams, contributionSchedules: future.contributionSchedules, spendingPlan: spendingOverride ?? future.spendingPlan,
      assumptions: future.assumptions, taxSettings: future.taxSettings, simulation: future.simulation, strategy: { ...future.strategy, ...strategyOverride } };
    const comparison: ForecastRevision = { id: "strategy-comparison", baselineId: context.baseline.id, name: "Strategy comparison", createdAt: "9999-12-31T23:59:59.999Z", effectiveDate, settings,
      rrifConversionAges: Object.fromEntries([{ ...future.personalInfo, id: "primary" }, ...future.personalInfo.additionalPeople].map((person) => [person.id, person.rrifConversionAge])),
      returnPath: { annualReturns: options.annualReturns!, annualInflation: options.annualInflation!, subPeriodReturns: options.subPeriodReturns! } };
    options.forecastRevisions = [...context.revisions.map((revision) => !preserveScheduledStrategies && revision.effectiveDate >= effectiveDate
      ? { ...revision, settings: { ...revision.settings, strategy: { ...revision.settings.strategy, ...strategyOverride } } } : revision), comparison];
  }
  return projectRetirementPlan(context.baseline.inputs, options);
}

export interface MaximumSpendingResult {
  multiplier: number;
  spendingPlan: SpendingPlan;
  finalPortfolio: number;
  finalEstate: number;
  limitingAge: number;
  randomSeed: number;
  workingForecast: boolean;
  evaluations: number;
}

export function maximizeSpending(inputs: RetirementInputs, onProgress?: (evaluations: number) => void, strategyOverride?: Partial<StrategySettings>, preserveScheduledStrategies = false): MaximumSpendingResult {
  const phases = inputs.spendingPlan.phases;
  if (!phases.length || phases.some((phase) => !Number.isFinite(phase.annualSpending) || phase.annualSpending < 0)
    || !phases.some((phase) => phase.annualSpending > 0)) throw new Error("Enter at least one positive spending phase, with no negative phase amounts.");
  const stableInputs = { ...inputs, simulation: { ...inputs.simulation, randomSeed: inputs.simulation.randomSeed ?? 42 } };
  const context = workingForecastContext(stableInputs);
  const fixedThroughYear = context ? Number(context.asOf.slice(0, 4)) : -Infinity;
  let evaluations = 0;
  function evaluate(multiplier: number) {
    const spendingPlan = { ...inputs.spendingPlan, desiredAnnualSpending: inputs.spendingPlan.desiredAnnualSpending * multiplier,
      phases: phases.map((phase) => ({ ...phase, annualSpending: phase.annualSpending * multiplier })) };
    const projection = projectWorkingForecast(stableInputs, strategyOverride, spendingPlan, preserveScheduledStrategies);
    const futureYears = projection.years.filter((year) => year.calendarYear > fixedThroughYear);
    if (!futureYears.some((year) => year.spendingTarget > 0)) throw new Error("No positive spending remains in the future projection. Check phase dates and retirement timing.");
    const funded = futureYears.every((year) => year.netSpendableCash >= year.spendingTarget - 0.01);
    evaluations += 1;
    onProgress?.(evaluations);
    return { spendingPlan, projection, funded, futureYears };
  }
  let low = 0;
  let high = 1;
  let best = evaluate(0.000001);
  if (!best.funded) throw new Error("The plan cannot fund even minimal spending throughout its horizon. Review income, contributions, and withdrawal settings.");
  low = 0.000001;
  let candidate = evaluate(high);
  while (candidate.funded && high < 1_048_576) {
    low = high;
    best = candidate;
    high *= 2;
    candidate = evaluate(high);
  }
  if (candidate.funded) throw new Error("No spending limit was found within the search range. Review the plan's income and spending phases.");
  let rejected = candidate;
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const midpoint = (low + high) / 2;
    candidate = evaluate(midpoint);
    if (candidate.funded) {
      low = midpoint;
      best = candidate;
    } else {
      high = midpoint;
      rejected = candidate;
    }
  }
  const finalBalances = best.projection.years.at(-1)!.closingBalances;
  const limitingYear = rejected.futureYears.find((year) => year.netSpendableCash < year.spendingTarget - 0.01) ?? rejected.futureYears.at(-1)!;
  return {
    multiplier: low,
    spendingPlan: best.spendingPlan,
    finalPortfolio: finalBalances.rrsp + finalBalances.tfsa + finalBalances.nonRegistered + finalBalances.interestBearing,
    finalEstate: best.projection.finalEstateValue,
    limitingAge: limitingYear.age,
    randomSeed: stableInputs.simulation.randomSeed,
    workingForecast: context !== null,
    evaluations,
  };
}

export type WithdrawalObjective = "spending" | "estate" | "tax";

export interface WithdrawalOrderCandidate {
  order: WithdrawalAccount[];
  funded: boolean;
  fundingGap: number;
  finalEstate: number;
  lifetimeTax: number;
  oasRecovery: number;
  spendingMultiplier: number | null;
  maximumSpending?: MaximumSpendingResult;
  spendingError?: string;
}

export interface WithdrawalOrderSuggestion {
  objective: WithdrawalObjective;
  current: WithdrawalOrderCandidate;
  suggested: WithdrawalOrderCandidate;
  ranked: WithdrawalOrderCandidate[];
  equivalentOrders: number;
  randomSeed: number;
  workingForecast: boolean;
}

export function suggestWithdrawalOrder(inputs: RetirementInputs, objective: WithdrawalObjective,
  onProgress?: (completed: number, total: number, evaluations: number) => void): WithdrawalOrderSuggestion {
  const accounts: WithdrawalAccount[] = ["interestBearing", "nonRegistered", "tfsa", "rrsp"];
  const currentOrder = [...new Set([...(inputs.strategy.withdrawalOrder ?? accounts), ...accounts])].filter((account) => accounts.includes(account));
  function permutations(remaining: WithdrawalAccount[]): WithdrawalAccount[][] {
    return remaining.length === 0 ? [[]] : remaining.flatMap((account) =>
      permutations(remaining.filter((other) => other !== account)).map((tail) => [account, ...tail]));
  }
  const orders = permutations(currentOrder);
  const stableInputs = { ...inputs, simulation: { ...inputs.simulation, randomSeed: inputs.simulation.randomSeed ?? 42 } };
  const context = workingForecastContext(stableInputs);
  const fixedThroughYear = context ? Number(context.asOf.slice(0, 4)) : -Infinity;
  const candidates: WithdrawalOrderCandidate[] = [];
  let evaluations = 0;
  onProgress?.(0, orders.length, evaluations);
  for (const order of orders) {
    const strategyOverride = { withdrawalOrder: order };
    const projection = projectWorkingForecast(stableInputs, strategyOverride, undefined, true);
    const futureYears = projection.years.filter((year) => year.calendarYear > fixedThroughYear);
    if (!futureYears.length) throw new Error("No future years remain for withdrawal-order comparison.");
    evaluations += 1;
    const fundingGap = futureYears.reduce((total, year) => total + Math.max(0, year.spendingTarget - year.netSpendableCash), 0);
    const candidate: WithdrawalOrderCandidate = {
      order,
      funded: futureYears.every((year) => year.netSpendableCash >= year.spendingTarget - 0.01),
      fundingGap,
      finalEstate: projection.finalEstateValue,
      lifetimeTax: futureYears.reduce((total, year) => total + year.taxes.totalTax + year.estateTax, 0),
      oasRecovery: futureYears.reduce((total, year) => total + year.oasClawback, 0),
      spendingMultiplier: null,
    };
    if (objective === "spending") {
      let previousEvaluations = 0;
      try {
        candidate.maximumSpending = maximizeSpending(stableInputs, (count) => {
          evaluations += count - previousEvaluations;
          previousEvaluations = count;
          onProgress?.(candidates.length, orders.length, evaluations);
        }, strategyOverride, true);
        candidate.spendingMultiplier = candidate.maximumSpending.multiplier;
      } catch (failure) {
        candidate.spendingError = failure instanceof Error ? failure.message : "Unable to estimate spending for this order.";
      }
    }
    candidates.push(candidate);
    onProgress?.(candidates.length, orders.length, evaluations);
  }
  if (objective === "spending" && candidates.every((candidate) => candidate.spendingMultiplier === null)) {
    throw new Error(candidates[0].spendingError ?? "No withdrawal order supports a maximum-spending estimate.");
  }
  function compare(first: WithdrawalOrderCandidate, second: WithdrawalOrderCandidate) {
    if (objective === "spending") {
      if (first.spendingMultiplier === null) return second.spendingMultiplier === null ? 0 : 1;
      if (second.spendingMultiplier === null) return -1;
      return Math.round(second.spendingMultiplier * 1e8) - Math.round(first.spendingMultiplier * 1e8);
    }
    if (first.funded !== second.funded) return first.funded ? -1 : 1;
    const gapDifference = Math.round(first.fundingGap) - Math.round(second.fundingGap);
    if (!first.funded && gapDifference !== 0) return gapDifference;
    return objective === "estate" ? Math.round(second.finalEstate) - Math.round(first.finalEstate)
      : Math.round(first.lifetimeTax) - Math.round(second.lifetimeTax);
  }
  const ranked = [...candidates].sort(compare);
  return {
    objective,
    current: candidates[0],
    suggested: ranked[0],
    ranked,
    equivalentOrders: ranked.filter((candidate) => compare(candidate, ranked[0]) === 0).length,
    randomSeed: stableInputs.simulation.randomSeed,
    workingForecast: context !== null,
  };
}