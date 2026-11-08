import { actualsProjectionOptions, compareActuals } from "@/lib/actuals";
import { projectWithVariableReturns } from "@/lib/projectionPath";
import { forecastInputsForYear, projectRetirementPlan } from "@/lib/simulationEngine";
import type { ActualsBaseline, DeterministicProjection, ForecastRevision, RetirementInputs, StrategySettings } from "@/types/retirement";

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
    const sourceId = baseline.rebase.sourceBaselineId;
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

export function projectWorkingForecast(inputs: RetirementInputs, strategyOverride?: Partial<StrategySettings>) {
  const context = workingForecastContext(inputs);
  if (!context) return projectWithVariableReturns(strategyOverride ? { ...inputs, strategy: { ...inputs.strategy, ...strategyOverride } } : inputs);
  const options = actualsProjectionOptions(context.baseline, context.observations, context.revisions);
  const effectiveDate = `${Number(context.asOf.slice(0, 4)) + 1}-01-01`;
  if (strategyOverride && effectiveDate <= context.baseline.points.at(-1)!.date) {
    const future = forecastInputsForYear(context.baseline.inputs, context.revisions, Number(effectiveDate.slice(0, 4)));
    const settings = { incomeStreams: future.incomeStreams, contributionSchedules: future.contributionSchedules, spendingPlan: future.spendingPlan,
      assumptions: future.assumptions, taxSettings: future.taxSettings, simulation: future.simulation, strategy: { ...future.strategy, ...strategyOverride } };
    const comparison: ForecastRevision = { id: "strategy-comparison", baselineId: context.baseline.id, name: "Strategy comparison", createdAt: "9999-12-31T23:59:59.999Z", effectiveDate, settings,
      rrifConversionAges: Object.fromEntries([{ ...future.personalInfo, id: "primary" }, ...future.personalInfo.additionalPeople].map((person) => [person.id, person.rrifConversionAge])),
      returnPath: { annualReturns: options.annualReturns!, annualInflation: options.annualInflation!, subPeriodReturns: options.subPeriodReturns! } };
    options.forecastRevisions = [...context.revisions.map((revision) => revision.effectiveDate >= effectiveDate
      ? { ...revision, settings: { ...revision.settings, strategy: { ...revision.settings.strategy, ...strategyOverride } } } : revision), comparison];
  }
  return projectRetirementPlan(context.baseline.inputs, options);
}