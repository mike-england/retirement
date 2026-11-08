import { accountEntriesFor, assetsWithAccounts } from "@/lib/accounts";
import { parsePlanDate, planDateFor } from "@/lib/planDates";
import { projectWithVariableReturns } from "@/lib/projectionPath";
import { forecastInputsForYear, projectRetirementPlan, subPeriodsPerYear, type ProjectionOptions } from "@/lib/simulationEngine";
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
  const activeRevisions = [...new Map([...(baseline.rebase?.revisions ?? []), ...revisions.filter((revision) => revision.baselineId === baseline.id)]
    .map((revision) => [revision.id, revision])).values()]
    .sort((first, second) => first.effectiveDate.localeCompare(second.effectiveDate) || first.createdAt.localeCompare(second.createdAt));
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
  const combined = new Map((baseline.rebase?.observations ?? []).map((entry) => [entry.date, entry]));
  for (const entry of observations.filter((entry) => entry.baselineId === baseline.id)) combined.set(entry.date, entry);
  const balanceOverrides: ProjectionBalanceOverride[] = [...combined.values()].sort((first, second) => first.date.localeCompare(second.date))
    .filter((entry) => compareActuals(baseline, entry).actual !== null && compareActuals(baseline, entry).expected > 0)
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

export function hasForecastAssumptionChanges(inputs: RetirementInputs, reference: RetirementInputs): boolean {
  const fields = ["incomeStreams", "contributionSchedules", "spendingPlan", "assumptions", "taxSettings", "strategy"] as const;
  return fields.some((field) => JSON.stringify(inputs[field]) !== JSON.stringify(reference[field]))
    || (["randomSeed", "capitalGainsInclusionRate", "probateFeeRate"] as const).some((field) => inputs.simulation[field] !== reference.simulation[field])
    || [{ ...inputs.personalInfo, id: "primary" }, ...inputs.personalInfo.additionalPeople].some((person) => {
      const saved = person.id === "primary" ? reference.personalInfo : reference.personalInfo.additionalPeople.find((entry) => entry.id === person.id);
      return (person.rrifConversionAge ?? 71) !== (saved?.rrifConversionAge ?? 71);
    });
}

export function createForecastRevision(baseline: ActualsBaseline, inputs: RetirementInputs, effectiveDate: string, name: string, id = crypto.randomUUID()): ForecastRevision {
  const lastActual = inputs.actuals?.observations.filter((entry) => entry.baselineId === baseline.id && compareActuals(baseline, entry).actual !== null).map((entry) => entry.date).sort().at(-1) ?? baseline.rebase?.date ?? baseline.planDate;
  if (!parsePlanDate(effectiveDate) || !effectiveDate.endsWith("-01-01") || effectiveDate <= lastActual || effectiveDate > baseline.points.at(-1)!.date) throw new Error("Choose a January 1 after the latest actuals date and within the frozen plan.");
  const anchors = (plan: RetirementInputs) => [{ ...plan.personalInfo, id: "primary" }, ...plan.personalInfo.additionalPeople].map((person) => ({
    id: person.id, currentAge: person.currentAge, targetDeathAge: person.targetDeathAge, birthMonth: person.birthMonth,
    receivesCpp: person.receivesCpp, cppPayoutRate: person.cppPayoutRate, receivesOas: person.receivesOas,
    accounts: accountEntriesFor(person.id === "primary" ? plan.existingAssets : person.existingAssets, person.currentAge, plan.assumptions.returnMean)
      .map((account) => ({ id: account.id, type: account.type, returnType: account.returnType, balance: account.balance, bookValue: account.bookValue, annualRate: account.annualRate, termYears: account.termYears, startAge: account.startAge, maturityAction: account.maturityAction })),
  }));
  const referenceInputs = baseline.rebase?.editableInputs ?? baseline.inputs;
  if (localDateValue(planDateFor(inputs)) !== localDateValue(planDateFor(referenceInputs)) || inputs.personalInfo.province !== referenceInputs.personalInfo.province || JSON.stringify(anchors(inputs)) !== JSON.stringify(anchors(referenceInputs))) throw new Error("Keep the plan date, people, starting accounts and benefit entitlements unchanged for a forecast revision. Record balances in Actuals, or freeze a new baseline for structural changes.");
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

export function saveInitialBalanceObservation(inputs: RetirementInputs, projection: DeterministicProjection, observation: Omit<BalanceObservation, "baselineId">): ActualsTracking {
  if (inputs.actuals?.baselines.length) throw new Error("This scenario already has a baseline. Select it before recording balances.");
  const baseline = createActualsBaseline(inputs, projection, "Original plan");
  const tracking: ActualsTracking = { ...inputs.actuals, baselines: [baseline], observations: [], activeBaselineId: baseline.id };
  return saveBalanceObservation(tracking, { ...observation, baselineId: baseline.id });
}

export function deleteActualsBaseline(tracking: ActualsTracking, baselineId: string): ActualsTracking {
  const index = tracking.baselines.findIndex((baseline) => baseline.id === baselineId);
  if (index < 0) throw new Error("This baseline no longer exists.");
  if (tracking.baselines.some((baseline) => baseline.rebase?.sourceBaselineId === baselineId)) throw new Error("Delete newer baselines based on this one first.");
  const baselines = tracking.baselines.filter((baseline) => baseline.id !== baselineId);
  const observations = tracking.observations.filter((entry) => entry.baselineId !== baselineId);
  const replacement = baselines[Math.max(0, index - 1)];
  const completeEntries = tracking.observations.filter((entry) => {
    const baseline = tracking.baselines.find((baseline) => baseline.id === entry.baselineId);
    return baseline && compareActuals(baseline, entry).actual !== null && compareActuals(baseline, entry).expected > 0;
  }).sort((first, second) => first.date.localeCompare(second.date));
  const workingId = tracking.workingBaselineId === undefined ? completeEntries.at(-1)?.baselineId ?? null : tracking.workingBaselineId;
  const workingReplacement = [replacement, ...[...baselines].reverse()].find((baseline) => baseline && (baseline.rebase
    || completeEntries.some((entry) => entry.baselineId === baseline.id)));
  return { ...tracking, baselines, observations,
    activeBaselineId: tracking.activeBaselineId === baselineId || !tracking.activeBaselineId ? replacement?.id : tracking.activeBaselineId,
    workingBaselineId: workingId === baselineId ? workingReplacement?.id ?? null : workingId,
    forecastRevisions: tracking.forecastRevisions?.filter((revision) => revision.baselineId !== baselineId) };
}

export function deleteActualsEntry(tracking: ActualsTracking, baselineId: string, observationId: string) {
  const baseline = tracking.baselines.find((entry) => entry.id === baselineId);
  const observation = baseline && actualsHistory(baseline, tracking).find((entry) => entry.id === observationId);
  if (!baseline || !observation) throw new Error("This balance entry no longer exists.");
  const observationIds = new Set([observation.id]);
  const visited = new Set<string>();
  let source: ActualsBaseline | undefined = baseline;
  while (source?.rebase && observation.date <= source.rebase.date && !visited.has(source.id)) {
    visited.add(source.id);
    const archived = source.rebase.observations.find((entry) => entry.date === observation.date);
    if (!archived) break;
    observationIds.add(archived.id);
    const sourceId = source.rebase.sourceBaselineId;
    source = tracking.baselines.find((entry) => entry.id === sourceId);
  }
  const dependsOnEntry = (entries: BalanceObservation[] | undefined) => entries?.some((entry) => observationIds.has(entry.id)) ?? false;
  let added = true;
  while (added) {
    added = false;
    for (const entry of tracking.baselines) {
      if (entry.rebase?.date !== observation.date) continue;
      const anchor = entry.rebase.observations.find((candidate) => candidate.date === observation.date);
      const copies = tracking.observations.filter((candidate) => candidate.baselineId === entry.id && candidate.date === observation.date);
      if (anchor && (observationIds.has(anchor.id) || copies.some((candidate) => observationIds.has(candidate.id)))) {
        for (const candidate of [anchor, ...copies]) {
          if (!observationIds.has(candidate.id)) { observationIds.add(candidate.id); added = true; }
        }
      }
    }
  }
  const removedIds = new Set(tracking.baselines.filter((entry) => entry.rebase?.date === observation.date
    && dependsOnEntry(entry.rebase.observations)).map((entry) => entry.id));
  const survivingSourceId = (id: string): string => {
    const seen = new Set<string>();
    while (removedIds.has(id)) {
      if (seen.has(id)) throw new Error("The baseline history contains a dependency cycle. No history was removed.");
      seen.add(id);
      const parent = tracking.baselines.find((entry) => entry.id === id)?.rebase?.sourceBaselineId;
      if (!parent || !tracking.baselines.some((entry) => entry.id === parent)) throw new Error("A source baseline is missing. No history was removed.");
      id = parent;
    }
    return id;
  };
  const affected = new Set(tracking.baselines.filter((entry) => entry.rebase && (dependsOnEntry(entry.rebase.observations)
    || entry.rebase.revisions.some((revision) => dependsOnEntry(revision.observations)) || removedIds.has(entry.rebase.sourceBaselineId))).map((entry) => entry.id));
  added = true;
  while (added) {
    added = false;
    for (const entry of tracking.baselines) {
      if (entry.rebase && affected.has(entry.rebase.sourceBaselineId) && !affected.has(entry.id)) { affected.add(entry.id); added = true; }
    }
  }
  const aliases = new Map<string, string>();
  const entriesByDate = new Map<string, BalanceObservation>();
  const keepObservation = (entry: BalanceObservation, ownerId: string) => {
    if (observationIds.has(entry.id)) return;
    const key = JSON.stringify([ownerId, entry.date]);
    const existing = entriesByDate.get(key);
    if (existing) {
      const keys = new Set([...Object.keys(existing.balances), ...Object.keys(entry.balances)]);
      if (existing.note !== entry.note || [...keys].some((key) => (existing.balances[key] ?? null) !== (entry.balances[key] ?? null))) {
        throw new Error(`Two different saved entries would share ${entry.date}. Resolve that date in the source baselines first. No history was removed.`);
      }
      aliases.set(entry.id, existing.id);
    } else entriesByDate.set(key, { ...structuredClone(entry), baselineId: ownerId });
  };
  for (const entry of tracking.observations.filter((entry) => !removedIds.has(entry.baselineId))) keepObservation(entry, entry.baselineId);
  for (const entry of tracking.observations.filter((entry) => removedIds.has(entry.baselineId))) keepObservation(entry, survivingSourceId(entry.baselineId));
  for (const entry of tracking.baselines.filter((entry) => removedIds.has(entry.id))) {
    for (const archived of entry.rebase?.observations ?? []) keepObservation(archived, survivingSourceId(entry.id));
  }
  const normaliseObservations = (entries: BalanceObservation[], ownerId: string) => entries.filter((entry) => !observationIds.has(entry.id))
    .map((entry) => ({ ...structuredClone(entry), id: aliases.get(entry.id) ?? entry.id, baselineId: ownerId }));
  const normaliseRevision = (revision: ForecastRevision, ownerId: string): ForecastRevision => ({ ...structuredClone(revision), baselineId: ownerId,
    observations: revision.observations === undefined ? undefined : normaliseObservations(revision.observations, ownerId) });
  const revisionMap = new Map((tracking.forecastRevisions ?? []).map((revision) => [revision.id, normaliseRevision(revision, survivingSourceId(revision.baselineId))]));
  for (const entry of tracking.baselines.filter((entry) => removedIds.has(entry.id))) {
    for (const revision of entry.rebase?.revisions ?? []) {
      if (!revisionMap.has(revision.id)) revisionMap.set(revision.id, normaliseRevision(revision, survivingSourceId(entry.id)));
    }
  }
  const baselines = structuredClone(tracking.baselines.filter((entry) => !removedIds.has(entry.id)));
  for (const entry of baselines) {
    if (!entry.rebase) continue;
    entry.rebase.sourceBaselineId = survivingSourceId(entry.rebase.sourceBaselineId);
    entry.rebase.observations = normaliseObservations(entry.rebase.observations, entry.id);
    entry.rebase.revisions = entry.rebase.revisions.map((revision) => normaliseRevision(revision, entry.id));
  }
  const pending = new Set([...affected].filter((id) => !removedIds.has(id)));
  const rebuiltBaselines: ActualsBaseline[] = [];
  while (pending.size) {
    const entry = baselines.find((entry) => pending.has(entry.id) && entry.rebase && !pending.has(entry.rebase.sourceBaselineId));
    if (!entry?.rebase) throw new Error("The baseline history contains a dependency cycle. No history was removed.");
    const parent = baselines.find((candidate) => candidate.id === entry.rebase!.sourceBaselineId);
    const anchor = entry.rebase.observations.find((candidate) => candidate.date === entry.rebase!.date);
    if (!parent || !anchor || compareActuals(entry, anchor).actual === null) throw new Error("A later rebase is missing its complete balance entry. No history was removed.");
    const forecast = projectRetirementPlan(entry.inputs, actualsProjectionOptions(entry, []));
    entry.points = [...structuredClone(parent.points.filter((point) => point.date < entry.rebase!.date)),
      { date: entry.rebase.date, portfolioByPerson: Object.fromEntries(entry.people.map((person) => [person.id, compareActuals(entry, anchor, person.id).actual ?? 0])) },
      ...forecast.years.filter((year) => `${year.calendarYear}-12-31` > entry.rebase!.date).map((year) => ({ date: `${year.calendarYear}-12-31`, portfolioByPerson: year.portfolioByPerson }))];
    rebuiltBaselines.push(entry);
    pending.delete(entry.id);
  }
  const observations = [...entriesByDate.values()].sort((first, second) => first.date.localeCompare(second.date));
  const forecastRevisions = [...revisionMap.values()];
  const hasAppliedBalances = (candidate: ActualsBaseline) => Boolean(candidate.rebase) || observations.some((entry) => entry.baselineId === candidate.id
    && compareActuals(candidate, entry).actual !== null && compareActuals(candidate, entry).expected > 0);
  const inferredWorkingId = tracking.workingBaselineId === undefined ? tracking.observations.filter((entry) => {
    const owner = tracking.baselines.find((candidate) => candidate.id === entry.baselineId);
    return owner && compareActuals(owner, entry).actual !== null && compareActuals(owner, entry).expected > 0;
  }).sort((first, second) => first.date.localeCompare(second.date)).at(-1)?.baselineId : tracking.workingBaselineId;
  const activeBaselineId = tracking.activeBaselineId ? survivingSourceId(tracking.activeBaselineId) : undefined;
  const working = baselines.find((entry) => entry.id === (inferredWorkingId ? survivingSourceId(inferredWorkingId) : undefined) && hasAppliedBalances(entry));
  const selected = baselines.find((entry) => entry.id === activeBaselineId && hasAppliedBalances(entry));
  const fallback = selected ?? [...baselines].reverse().find(hasAppliedBalances);
  const workingBaselineId = tracking.workingBaselineId === null ? null : working?.id ?? fallback?.id ?? null;
  const result: ActualsTracking = { ...tracking, baselines, observations, forecastRevisions, activeBaselineId, workingBaselineId };
  if (!isActualsTracking(result)) throw new Error("Unable to rebuild valid tracking history. No history was removed.");
  return { tracking: result, date: observation.date,
    removedBaselines: tracking.baselines.filter((entry) => removedIds.has(entry.id)),
    rebuiltBaselines, removedObservationCount: tracking.observations.filter((entry) => observationIds.has(entry.id)).length,
    removedRevisionCount: 0 };
}

export function actualsHistory(baseline: ActualsBaseline, tracking: ActualsTracking): BalanceObservation[] {
  const entries = new Map((baseline.rebase?.observations ?? []).filter((entry) => entry.date < baseline.rebase!.date).map((entry) => [entry.date, entry]));
  for (const entry of tracking.observations.filter((entry) => entry.baselineId === baseline.id)) entries.set(entry.date, entry);
  return [...entries.values()].sort((first, second) => first.date.localeCompare(second.date));
}

export function selectedActualsAccounts(inputs: RetirementInputs) {
  const tracking = inputs.actuals;
  const baseline = tracking?.baselines.find((entry) => entry.id === tracking.activeBaselineId) ?? tracking?.baselines.at(-1);
  if (!tracking || !baseline) return null;
  const entries = new Map([...(baseline.rebase?.observations ?? []), ...tracking.observations.filter((entry) => entry.baselineId === baseline.id)]
    .map((entry) => [entry.date, entry]));
  const latest = [...entries.values()].filter((entry) => compareActuals(baseline, entry).actual !== null && compareActuals(baseline, entry).expected > 0)
    .sort((first, second) => first.date.localeCompare(second.date)).at(-1);
  const date = latest?.date ?? baseline.rebase?.date ?? baseline.planDate;
  const accounts = baseline.accounts.filter((account) => account.activeDate <= date).map((account) => ({
    ...account, balance: latest ? latest.balances[account.key]! : account.startingBalance,
  }));
  return { baseline, date, isActuals: Boolean(latest), accounts, total: accounts.reduce((total, account) => total + account.balance, 0) };
}

export function rebaseFromActuals(inputs: RetirementInputs, source: ActualsBaseline, date: string, name: string, id = crypto.randomUUID()): RetirementInputs {
  const tracking = inputs.actuals;
  const entry = tracking?.observations.find((entry) => entry.baselineId === source.id && entry.date === date);
  if (!tracking || !entry || !parsePlanDate(date) || date < (source.rebase?.date ?? source.planDate) || date > source.points.at(-1)!.date
    || compareActuals(source, entry).actual === null || compareActuals(source, entry).expected === 0) throw new Error("Choose a complete saved household balance entry within this baseline's dates.");
  const archived = new Map((source.rebase?.observations ?? []).map((observation) => [observation.date, observation]));
  for (const observation of tracking.observations.filter((observation) => observation.baselineId === source.id && observation.date <= date)) archived.set(observation.date, observation);
  const observations = [...archived.values()].map((observation) => ({ ...structuredClone(observation), baselineId: id }));
  const revisions = [...(source.rebase?.revisions ?? []), ...(tracking.forecastRevisions ?? []).filter((revision) => revision.baselineId === source.id)]
    .map((revision) => ({ ...structuredClone(revision), baselineId: id,
      observations: revision.observations?.map((observation) => ({ ...structuredClone(observation), baselineId: id })) }));
  const effective = forecastInputsForYear(source.inputs, revisions, Number(date.slice(0, 4)));
  const editable = structuredClone(effective);
  delete editable.actuals;
  editable.planDate = date;
  const elapsedYears = Number(date.slice(0, 4)) - Number(source.planDate.slice(0, 4));
  const updateAccounts = (ownerId: string, assets: RetirementInputs["existingAssets"] | undefined, age: number) => assetsWithAccounts(assets,
    accountEntriesFor(assets, age, effective.assumptions.returnMean).map((account) => ({ ...account,
      balance: entry.balances[JSON.stringify([ownerId, account.id])] ?? account.balance })), age + elapsedYears);
  editable.existingAssets = updateAccounts("primary", effective.existingAssets, effective.personalInfo.currentAge);
  editable.personalInfo.currentAge += elapsedYears;
  editable.personalInfo.additionalPeople = effective.personalInfo.additionalPeople.map((person) => ({ ...person, currentAge: person.currentAge + elapsedYears,
    existingAssets: updateAccounts(person.id, person.existingAssets, person.currentAge) }));
  const baseline: ActualsBaseline = { ...structuredClone(source), id, name: name.trim() || `Rebased ${date}`, createdAt: new Date().toISOString(),
    accounts: source.accounts.map((account) => ({ ...account, startingBalance: entry.balances[account.key] ?? account.startingBalance })),
    rebase: { date, sourceBaselineId: source.id, editableInputs: editable, observations, revisions } };
  const savedEntry = { ...structuredClone(entry), id: crypto.randomUUID(), baselineId: id };
  const nextInputs: RetirementInputs = { ...structuredClone(inputs), planDate: editable.planDate, existingAssets: editable.existingAssets,
    personalInfo: { ...editable.personalInfo, rrifConversionAge: inputs.personalInfo.rrifConversionAge,
      additionalPeople: editable.personalInfo.additionalPeople.map((person) => ({ ...person,
        rrifConversionAge: inputs.personalInfo.additionalPeople.find((current) => current.id === person.id)?.rrifConversionAge })) },
    actuals: { ...tracking, baselines: [...tracking.baselines, baseline], activeBaselineId: id, workingBaselineId: id,
      observations: [...tracking.observations, savedEntry] } };
  const nextYear = Number(date.slice(0, 4)) + 1;
  const futureReference = forecastInputsForYear(source.inputs, revisions, nextYear);
  if (hasForecastAssumptionChanges(nextInputs, futureReference)) {
    const effectiveDate = `${nextYear}-01-01`;
    if (effectiveDate > source.points.at(-1)!.date) throw new Error("No full future calendar years remain for edited assumptions. Keep the saved assumptions or extend the editable plan and freeze a separate baseline.");
    revisions.push(createForecastRevision(baseline, nextInputs, effectiveDate, `${baseline.name} · future assumptions`));
  }
  const projection = projectRetirementPlan(baseline.inputs, actualsProjectionOptions(baseline, []));
  baseline.points = [...source.points.filter((point) => point.date < date),
    { date, portfolioByPerson: Object.fromEntries(source.people.map((person) => [person.id, compareActuals(source, entry, person.id).actual ?? 0])) },
    ...projection.years.filter((year) => `${year.calendarYear}-12-31` > date).map((year) => ({ date: `${year.calendarYear}-12-31`, portfolioByPerson: year.portfolioByPerson }))];
  return nextInputs;
}

export function rollingReforecast(baseline: ActualsBaseline, observations: BalanceObservation[], comparisonDates: string[] = [], revisions: ForecastRevision[] = []): RollingReforecast {
  const activeRevisions = revisions.filter((revision) => revision.baselineId === baseline.id);
  const entries = [...new Map([...(baseline.rebase?.observations ?? []), ...observations.filter((entry) => entry.baselineId === baseline.id)]
    .map((entry) => [entry.date, entry])).values()]
    .sort((first, second) => first.date.localeCompare(second.date));
  const complete = entries.filter((entry) => {
    const result = compareActuals(baseline, entry);
    return result.actual !== null && result.expected > 0;
  });
  const skippedDates = entries.filter((entry) => !complete.includes(entry)).map((entry) => entry.date);
  const captureDates = [...new Set([...comparisonDates, ...entries.map((entry) => entry.date)])].filter((date) => parsePlanDate(date)
    && date >= (baseline.rebase?.date ?? baseline.planDate) && date <= baseline.points.at(-1)!.date && !baseline.points.some((point) => point.date === date));
  if (complete.length === 0 && captureDates.length === 0 && activeRevisions.length === 0) return { points: structuredClone(baseline.points), originalPoints: structuredClone(baseline.points), appliedDates: [], skippedDates };
  if (complete.some((entry) => !parsePlanDate(entry.date) || entry.date < baseline.planDate || entry.date > baseline.points.at(-1)!.date)) throw new Error("Actuals must fall within the frozen plan's dates. Use a new baseline to extend the plan horizon.");
  const returnPath = resolveActualsReturnPath(baseline);
  const originalPoints = new Map(baseline.points.map((point) => [point.date, structuredClone(point)]));
  if (captureDates.length > 0) {
    const original = projectRetirementPlan(baseline.inputs, { ...actualsProjectionOptions(baseline, [], [], returnPath), checkpointDates: captureDates });
    const matches = baseline.points.filter((point) => point.date !== baseline.planDate && (!baseline.rebase || point.date > baseline.rebase.date)).every((point) => {
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
  if (!baseline || !parsePlanDate(observation.date) || observation.date < (baseline.rebase?.date ?? baseline.planDate) || observation.date > baseline.points.at(-1)!.date) throw new Error("Choose a date within the baseline's plan dates.");
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
  if (tracking.baselines.some((baseline) => {
    if (baseline.rebase === undefined) return false;
    const rebase = baseline.rebase;
    if (!rebase || !parsePlanDate(rebase.date) || rebase.date < baseline.planDate || rebase.date > baseline.points.at(-1)!.date
      || rebase.sourceBaselineId === baseline.id || !tracking.baselines.some((source) => source.id === rebase.sourceBaselineId)
      || !rebase.editableInputs || rebase.editableInputs.planDate !== rebase.date || !rebase.editableInputs.personalInfo || !rebase.editableInputs.existingAssets
      || !Array.isArray(rebase.observations) || !Array.isArray(rebase.revisions) || rebase.observations.some((entry) => !entry || entry.date > rebase.date)) return true;
    const reference = { ...baseline };
    delete reference.rebase;
    return !isActualsTracking({ baselines: [reference], observations: rebase.observations, forecastRevisions: rebase.revisions })
      || !rebase.observations.some((entry) => entry.date === rebase.date && compareActuals(baseline, entry).actual !== null);
  })) return false;
  if (tracking.forecastRevisions !== undefined && (!Array.isArray(tracking.forecastRevisions) || tracking.forecastRevisions.some((revision) => {
    if (!revision || typeof revision.id !== "string" || typeof revision.name !== "string" || !parsePlanDate(revision.effectiveDate) || !revision.effectiveDate.endsWith("-01-01") || !Number.isFinite(new Date(revision.createdAt).getTime())) return true;
    const baseline = tracking.baselines.find((entry) => entry.id === revision.baselineId);
    if (!baseline || revision.effectiveDate <= baseline.planDate || revision.effectiveDate > baseline.points.at(-1)!.date || !revision.settings
      || !Array.isArray(revision.settings.incomeStreams) || !Array.isArray(revision.settings.contributionSchedules) || !revision.settings.spendingPlan || !revision.settings.assumptions || !revision.settings.taxSettings || !revision.settings.strategy || !revision.settings.simulation) return true;
    if (revision.rrifConversionAges && Object.values(revision.rrifConversionAges).some((age) => age !== undefined && (!Number.isFinite(age) || age < 0 || age > 71))) return true;
    if (revision.observations !== undefined && !isActualsTracking({ baselines: [{ ...baseline, rebase: undefined }], observations: revision.observations })) return true;
    return !validReturnPath({ ...baseline, inputs: { ...baseline.inputs, ...revision.settings } }, revision.returnPath);
  }))) return false;
  return tracking.observations.every((entry) => entry && typeof entry.id === "string" && typeof entry.note === "string" && Boolean(parsePlanDate(entry.date))
    && tracking.baselines.some((baseline) => baseline.id === entry.baselineId && entry.date >= baseline.planDate)
    && entry.balances && typeof entry.balances === "object" && !Array.isArray(entry.balances)
    && Object.values(entry.balances).every((balance) => balance === null || (typeof balance === "number" && Number.isFinite(balance) && balance >= 0)));
}