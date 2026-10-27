import { accountEntriesFor } from "@/lib/accounts";
import { parsePlanDate, planDateFor } from "@/lib/planDates";
import { projectWithVariableReturns } from "@/lib/projectionPath";
import { projectRetirementPlan, subPeriodsPerYear, type ProjectionOptions } from "@/lib/simulationEngine";
import type { ActualsBaseline, ActualsTracking, BalanceObservation, DeterministicProjection, ForecastRevision, ProjectionBalanceOverride, RetirementInputs } from "@/types/retirement";

export type RollingReforecast = { points: ActualsBaseline["points"]; originalPoints: ActualsBaseline["points"]; appliedDates: string[]; skippedDates: string[]; projection?: DeterministicProjection };

function freezeReturnPath(projection: DeterministicProjection): NonNullable<ActualsBaseline["returnPath"]> {
  if (projection.years.some((year) => !Array.isArray(year.periodReturns) || year.periodReturns.length === 0)) throw new Error("Recalculate the plan before freezing its return path.");
  return {
    annualReturns: projection.years.map((year) => year.portfolioReturn),
    annualInflation: projection.years.map((year) => year.inflationRate),
    subPeriodReturns: projection.years.map((year) => [...year.periodReturns]),
  };
}

function validReturnPath(baseline: ActualsBaseline, path: ActualsBaseline["returnPath"]): boolean {
  if (!path) return false;
  const years = Number(baseline.points.at(-1)!.date.slice(0, 4)) - Number(baseline.planDate.slice(0, 4)) + 1;
  const periods = subPeriodsPerYear(baseline.inputs.strategy.withdrawalFrequency);
  return Array.isArray(path.annualReturns) && path.annualReturns.length === years && path.annualReturns.every(Number.isFinite)
    && Array.isArray(path.annualInflation) && path.annualInflation.length === years && path.annualInflation.every(Number.isFinite)
    && Array.isArray(path.subPeriodReturns) && path.subPeriodReturns.length === years
    && path.subPeriodReturns.every((returns) => Array.isArray(returns) && returns.length === periods && returns.every(Number.isFinite));
}

export function resolveActualsReturnPath(baseline: ActualsBaseline): NonNullable<ActualsBaseline["returnPath"]> {
  let path = baseline.returnPath;
  if (!path) {
    if (baseline.inputs.simulation.randomSeed === undefined) throw new Error("This older baseline did not store its random return path. Freeze a new baseline to enable a matching reforecast.");
    const regenerated = projectWithVariableReturns(baseline.inputs);
    const matches = baseline.points.filter((point) => point.date !== baseline.planDate).every((point) => {
      const year = regenerated.years.find((year) => `${year.calendarYear}-12-31` === point.date);
      return year && baseline.people.every((person) => Math.abs(year.portfolioByPerson[person.id] - point.portfolioByPerson[person.id]) < 0.02);
    });
    if (!matches) throw new Error("The older baseline cannot be reproduced with the current calculator. Freeze a new baseline rather than changing the original forecast.");
    path = freezeReturnPath(regenerated);
  }
  if (!validReturnPath(baseline, path)) throw new Error("This baseline's frozen return path is incomplete. Freeze a new baseline to reforecast safely.");
  return path;
}

export function actualsProjectionOptions(baseline: ActualsBaseline, observations: BalanceObservation[], revisions: ForecastRevision[] = [], originalPath = resolveActualsReturnPath(baseline)): ProjectionOptions {
  const activeRevisions = revisions.filter((revision) => revision.baselineId === baseline.id).sort((first, second) => first.effectiveDate.localeCompare(second.effectiveDate) || first.createdAt.localeCompare(second.createdAt));
  const path = structuredClone(originalPath);
  for (let index = 0; index < path.annualReturns.length; index += 1) {
    const year = Number(baseline.planDate.slice(0, 4)) + index;
    const revision = activeRevisions.filter((revision) => revision.effectiveDate <= `${year}-01-01`).at(-1);
    if (revision) {
      path.annualReturns[index] = revision.returnPath.annualReturns[index];
      path.annualInflation[index] = revision.returnPath.annualInflation[index];
      path.subPeriodReturns[index] = [...revision.returnPath.subPeriodReturns[index]];
    }
  }
  const balanceOverrides: ProjectionBalanceOverride[] = observations.filter((entry) => entry.baselineId === baseline.id && compareActuals(baseline, entry).actual !== null && compareActuals(baseline, entry).expected > 0)
    .map((entry) => {
      if (!parsePlanDate(entry.date) || entry.date < baseline.planDate || entry.date > baseline.points.at(-1)!.date) throw new Error("Actuals fall outside the working baseline's dates. Correct the entry or choose a new baseline.");
      const people: ProjectionBalanceOverride["people"] = Object.fromEntries(baseline.people.map((person) => [person.id, { rrsp: 0, tfsa: 0, nonRegistered: 0, gics: {} }]));
      for (const account of baseline.accounts.filter((account) => account.activeDate <= entry.date)) {
        const balance = entry.balances[account.key]!;
        if (account.returnType === "market") people[account.ownerId][account.type] += balance;
        else people[account.ownerId].gics[account.accountId] = balance;
      }
      return { date: entry.date, people };
    });
  return { ...path, balanceOverrides, forecastRevisions: activeRevisions };
}

export function createForecastRevision(baseline: ActualsBaseline, inputs: RetirementInputs, effectiveDate: string, name: string, id = crypto.randomUUID()): ForecastRevision {
  const lastActual = inputs.actuals?.observations.filter((entry) => entry.baselineId === baseline.id && compareActuals(baseline, entry).actual !== null).map((entry) => entry.date).sort().at(-1) ?? baseline.planDate;
  if (!parsePlanDate(effectiveDate) || !effectiveDate.endsWith("-01-01") || effectiveDate <= lastActual || effectiveDate > baseline.points.at(-1)!.date) throw new Error("Choose a January 1 after the latest actuals date and within the frozen plan.");
  const anchors = (plan: RetirementInputs) => [{ ...plan.personalInfo, id: "primary" }, ...plan.personalInfo.additionalPeople].map((person) => ({
    id: person.id, currentAge: person.currentAge, targetDeathAge: person.targetDeathAge, birthMonth: person.birthMonth,
    receivesCpp: person.receivesCpp, cppPayoutRate: person.cppPayoutRate, receivesOas: person.receivesOas,
    accounts: accountEntriesFor(person.id === "primary" ? plan.existingAssets : person.existingAssets, person.currentAge, plan.assumptions.returnMean)
      .map((account) => ({ id: account.id, type: account.type, returnType: account.returnType, balance: account.balance, bookValue: account.bookValue, annualRate: account.annualRate, termYears: account.termYears, startAge: account.startAge, maturityAction: account.maturityAction })),
  }));
  if (localDateValue(planDateFor(inputs)) !== baseline.planDate || inputs.personalInfo.province !== baseline.inputs.personalInfo.province || JSON.stringify(anchors(inputs)) !== JSON.stringify(anchors(baseline.inputs))) throw new Error("Keep the plan date, people, starting accounts and benefit entitlements unchanged for a forecast revision. Record balances in Actuals, or freeze a new baseline for structural changes.");
  const settings = structuredClone({ incomeStreams: inputs.incomeStreams, contributionSchedules: inputs.contributionSchedules, spendingPlan: inputs.spendingPlan,
    assumptions: inputs.assumptions, taxSettings: inputs.taxSettings, strategy: inputs.strategy, simulation: inputs.simulation });
  const projection = projectWithVariableReturns({ ...baseline.inputs, ...settings });
  return { id, baselineId: baseline.id, name: name.trim() || `Forecast from ${effectiveDate.slice(0, 4)}`, effectiveDate, createdAt: new Date().toISOString(), settings,
    observations: structuredClone(inputs.actuals?.observations.filter((entry) => entry.baselineId === baseline.id) ?? []),
    rrifConversionAges: Object.fromEntries([{ ...inputs.personalInfo, id: "primary" }, ...inputs.personalInfo.additionalPeople].map((person) => [person.id, person.rrifConversionAge])), returnPath: freezeReturnPath(projection) };
}

export function localDateValue(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function createActualsBaseline(inputs: RetirementInputs, projection: DeterministicProjection, name: string, id = crypto.randomUUID()): ActualsBaseline {
  const planDate = localDateValue(planDateFor(inputs));
  const people = [{ ...inputs.personalInfo, id: "primary", existingAssets: inputs.existingAssets }, ...(inputs.personalInfo.additionalPeople ?? [])];
  const accounts = people.flatMap((person) => accountEntriesFor(person.existingAssets, person.currentAge, inputs.assumptions.returnMean).map((account) => ({
    key: JSON.stringify([person.id, account.id]), ownerId: person.id, accountId: account.id, name: account.name,
    type: account.type, returnType: account.returnType, startingBalance: account.balance,
    activeDate: account.returnType !== "market" && (account.startAge ?? person.currentAge) > person.currentAge
      ? `${planDateFor(inputs).getFullYear() + account.startAge! - person.currentAge}-01-01` : planDate,
  })));
  if (accounts.length === 0 || projection.years.length === 0) throw new Error("Add accounts before freezing a baseline.");
  if (accounts.some((account) => !Number.isFinite(account.startingBalance) || account.startingBalance < 0)) throw new Error("Check account balances before freezing a baseline.");
  const frozenInputs = structuredClone(inputs);
  delete frozenInputs.actuals;
  const starting = Object.fromEntries(people.map((person) => [person.id, accounts.filter((account) => account.ownerId === person.id && account.activeDate <= planDate)
    .reduce((total, account) => total + account.startingBalance, 0)]));
  const points = [{ date: planDate, portfolioByPerson: starting }, ...projection.years.map((year) => {
    if (!year.portfolioByPerson || people.some((person) => !Number.isFinite(year.portfolioByPerson[person.id]))) throw new Error("The plan is updating. Try again when the projection is ready.");
    return { date: `${year.calendarYear}-12-31`, portfolioByPerson: { ...year.portfolioByPerson } };
  }).filter((point) => point.date > planDate)];
  return structuredClone({ id, name: name.trim() || "Original plan", createdAt: new Date().toISOString(), planDate,
    inputs: frozenInputs, people: people.map((person) => ({ id: person.id, label: person.label || "Person" })), accounts, points, returnPath: freezeReturnPath(projection) });
}

export function rollingReforecast(baseline: ActualsBaseline, observations: BalanceObservation[], comparisonDates: string[] = [], revisions: ForecastRevision[] = []): RollingReforecast {
  const activeRevisions = revisions.filter((revision) => revision.baselineId === baseline.id);
  const entries = [...new Map(observations.filter((entry) => entry.baselineId === baseline.id).map((entry) => [entry.date, entry])).values()]
    .sort((first, second) => first.date.localeCompare(second.date));
  const complete = entries.filter((entry) => {
    const result = compareActuals(baseline, entry);
    return result.actual !== null && result.expected > 0;
  });
  const skippedDates = entries.filter((entry) => !complete.includes(entry)).map((entry) => entry.date);
  const captureDates = [...new Set([...comparisonDates, ...entries.map((entry) => entry.date)])].filter((date) => parsePlanDate(date)
    && date >= baseline.planDate && date <= baseline.points.at(-1)!.date && !baseline.points.some((point) => point.date === date));
  if (complete.length === 0 && captureDates.length === 0 && activeRevisions.length === 0) return { points: structuredClone(baseline.points), originalPoints: structuredClone(baseline.points), appliedDates: [], skippedDates };
  if (complete.some((entry) => !parsePlanDate(entry.date) || entry.date < baseline.planDate || entry.date > baseline.points.at(-1)!.date)) throw new Error("Actuals must fall within the frozen plan's dates. Use a new baseline to extend the plan horizon.");
  const returnPath = resolveActualsReturnPath(baseline);
  const originalPoints = new Map(baseline.points.map((point) => [point.date, structuredClone(point)]));
  if (captureDates.length > 0) {
    const original = projectRetirementPlan(baseline.inputs, { ...returnPath, checkpointDates: captureDates });
    const matches = baseline.points.filter((point) => point.date !== baseline.planDate).every((point) => {
      const year = original.years.find((year) => `${year.calendarYear}-12-31` === point.date);
      return year && baseline.people.every((person) => Math.abs(year.portfolioByPerson[person.id] - point.portfolioByPerson[person.id]) < 0.02);
    });
    if (!matches) throw new Error("The frozen plan cannot be reproduced by the current calculator. Freeze a new baseline to calculate reliable dated comparisons.");
    for (const point of original.balanceCheckpoints ?? []) originalPoints.set(point.date, point);
    if (captureDates.some((date) => !originalPoints.has(date)) || [...originalPoints.values()].some((point) => baseline.people.some((person) => !Number.isFinite(point.portfolioByPerson[person.id])))) throw new Error("Unable to calculate the original plan at the requested dates.");
  }
  const original = [...originalPoints.values()].sort((first, second) => first.date.localeCompare(second.date));
  if (complete.length === 0 && activeRevisions.length === 0) return { points: structuredClone(original), originalPoints: original, appliedDates: [], skippedDates };
  const projection = projectRetirementPlan(baseline.inputs, actualsProjectionOptions(baseline, complete, activeRevisions, returnPath));
  if (projection.years.some((year) => Object.values(year.portfolioByPerson).some((balance) => !Number.isFinite(balance)))) throw new Error("The reforecast produced an invalid balance. Check the actual balances and frozen return assumptions.");
  const firstAdjustment = [complete[0]?.date, ...activeRevisions.map((revision) => revision.effectiveDate)].filter((date): date is string => Boolean(date)).sort()[0];
  const points = new Map(original.filter((point) => point.date < firstAdjustment).map((point) => [point.date, structuredClone(point)]));
  for (const year of projection.years) {
    const date = `${year.calendarYear}-12-31`;
    if (date >= firstAdjustment && date > baseline.planDate) points.set(date, { date, portfolioByPerson: year.portfolioByPerson });
  }
  for (const entry of complete) points.set(entry.date, { date: entry.date, portfolioByPerson: Object.fromEntries(baseline.people.map((person) => [person.id, compareActuals(baseline, entry, person.id).actual ?? 0])) });
  return { points: [...points.values()].sort((first, second) => first.date.localeCompare(second.date)), originalPoints: original, appliedDates: complete.map((entry) => entry.date), skippedDates, projection };
}

export function compareActuals(baseline: ActualsBaseline, observation: BalanceObservation, ownerId = "household", originalPoints = baseline.points) {
  if (observation.baselineId !== baseline.id) throw new Error("This entry belongs to another baseline.");
  const accounts = baseline.accounts.filter((account) => account.activeDate <= observation.date && (ownerId === "household" || account.ownerId === ownerId));
  const entered = accounts.filter((account) => typeof observation.balances[account.key] === "number" && Number.isFinite(observation.balances[account.key]) && observation.balances[account.key]! >= 0);
  const recorded = entered.reduce((total, account) => total + observation.balances[account.key]!, 0);
  const actual = entered.length === accounts.length ? recorded : null;
  const point = originalPoints.find((point) => point.date === observation.date);
  const planned = point ? ownerId === "household" ? Object.values(point.portfolioByPerson).reduce((total, balance) => total + balance, 0) : point.portfolioByPerson[ownerId] ?? null : null;
  const difference = actual !== null && planned !== null ? actual - planned : null;
  return { actual, recorded, entered: entered.length, expected: accounts.length, planned, difference,
    percent: difference !== null && planned !== null && planned > 0 ? difference / planned : null };
}

export function saveBalanceObservation(tracking: ActualsTracking, observation: BalanceObservation): ActualsTracking {
  const baseline = tracking.baselines.find((baseline) => baseline.id === observation.baselineId);
  if (!baseline || !parsePlanDate(observation.date) || observation.date < baseline.planDate || observation.date > baseline.points.at(-1)!.date) throw new Error("Choose a date within the baseline's plan dates.");
  if (Object.values(observation.balances).some((value) => value !== null && (!Number.isFinite(value) || value < 0))) throw new Error("Balances must be zero or a positive amount; leave unknown balances blank.");
  const existing = tracking.observations.find((entry) => entry.baselineId === observation.baselineId && entry.date === observation.date);
  const saved = structuredClone({ ...observation, id: existing?.id ?? observation.id });
  const complete = compareActuals(baseline, saved);
  return { ...tracking, ...(complete.actual !== null && complete.expected > 0 ? { workingBaselineId: baseline.id } : {}), observations: [...tracking.observations.filter((entry) => entry.id !== saved.id), saved].sort((first, second) => first.date.localeCompare(second.date)) };
}

export function nextActualsDate(value: string, cadence: NonNullable<ActualsTracking["cadence"]>): string {
  const date = parsePlanDate(value);
  if (!date) return localDateValue();
  const months = cadence === "monthly" ? 1 : cadence === "quarterly" ? 3 : 12;
  const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  const nextLastDay = new Date(date.getFullYear(), date.getMonth() + months + 1, 0).getDate();
  return localDateValue(new Date(date.getFullYear(), date.getMonth() + months, date.getDate() === lastDay ? nextLastDay : Math.min(date.getDate(), nextLastDay)));
}

export function isActualsTracking(value: unknown): value is ActualsTracking {
  if (!value || typeof value !== "object") return false;
  const tracking = value as ActualsTracking;
  if (!Array.isArray(tracking.baselines) || !Array.isArray(tracking.observations)) return false;
  if (tracking.cadence !== undefined && !["monthly", "quarterly", "annually"].includes(tracking.cadence)) return false;
  const baselinesValid = tracking.baselines.every((baseline) => baseline && typeof baseline.id === "string" && typeof baseline.name === "string"
    && Boolean(parsePlanDate(baseline.planDate)) && Number.isFinite(new Date(baseline.createdAt).getTime()) && baseline.inputs && typeof baseline.inputs === "object"
    && Array.isArray(baseline.people) && baseline.people.length > 0 && baseline.people.every((person) => person && typeof person.id === "string" && typeof person.label === "string")
    && Array.isArray(baseline.accounts) && baseline.accounts.length > 0 && baseline.accounts.every((account) => account && typeof account.key === "string" && typeof account.ownerId === "string"
      && typeof account.name === "string" && Number.isFinite(account.startingBalance) && account.startingBalance >= 0 && Boolean(parsePlanDate(account.activeDate)))
    && Array.isArray(baseline.points) && baseline.points.length > 0 && baseline.points.every((point) => point && Boolean(parsePlanDate(point.date)) && point.portfolioByPerson
      && baseline.people.every((person) => Number.isFinite(point.portfolioByPerson[person.id]))));
  if (!baselinesValid || (tracking.activeBaselineId !== undefined && !tracking.baselines.some((baseline) => baseline.id === tracking.activeBaselineId))) return false;
  if (tracking.workingBaselineId !== undefined && tracking.workingBaselineId !== null && !tracking.baselines.some((baseline) => baseline.id === tracking.workingBaselineId)) return false;
  if (tracking.baselines.some((baseline) => baseline.returnPath !== undefined && !validReturnPath(baseline, baseline.returnPath))) return false;
  if (tracking.forecastRevisions !== undefined && (!Array.isArray(tracking.forecastRevisions) || tracking.forecastRevisions.some((revision) => {
    if (!revision || typeof revision.id !== "string" || typeof revision.name !== "string" || !parsePlanDate(revision.effectiveDate) || !revision.effectiveDate.endsWith("-01-01") || !Number.isFinite(new Date(revision.createdAt).getTime())) return true;
    const baseline = tracking.baselines.find((entry) => entry.id === revision.baselineId);
    if (!baseline || revision.effectiveDate <= baseline.planDate || revision.effectiveDate > baseline.points.at(-1)!.date || !revision.settings
      || !Array.isArray(revision.settings.incomeStreams) || !Array.isArray(revision.settings.contributionSchedules) || !revision.settings.spendingPlan || !revision.settings.assumptions || !revision.settings.taxSettings || !revision.settings.strategy || !revision.settings.simulation) return true;
    if (revision.rrifConversionAges && Object.values(revision.rrifConversionAges).some((age) => age !== undefined && (!Number.isFinite(age) || age < 0 || age > 71))) return true;
    if (revision.observations !== undefined && !isActualsTracking({ baselines: [baseline], observations: revision.observations })) return true;
    return !validReturnPath({ ...baseline, inputs: { ...baseline.inputs, ...revision.settings } }, revision.returnPath);
  }))) return false;
  return tracking.observations.every((entry) => entry && typeof entry.id === "string" && typeof entry.note === "string" && Boolean(parsePlanDate(entry.date))
    && tracking.baselines.some((baseline) => baseline.id === entry.baselineId && entry.date >= baseline.planDate)
    && entry.balances && typeof entry.balances === "object" && !Array.isArray(entry.balances)
    && Object.values(entry.balances).every((balance) => balance === null || (typeof balance === "number" && Number.isFinite(balance) && balance >= 0)));
}