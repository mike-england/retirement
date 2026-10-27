import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const load = createRequire(import.meta.url);
const sourceRoot = fileURLToPath(new URL("../src/", import.meta.url));
const originalResolve = Module._resolveFilename;
const originalTypeScriptLoader = Module._extensions[".ts"];
Module._resolveFilename = function (request, ...args) {
  return originalResolve.call(this, request.startsWith("@/") ? join(sourceRoot, request.slice(2)) : request, ...args);
};
Module._extensions[".ts"] = function (module, filename) {
  const source = readFileSync(filename, "utf8");
  module._compile(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText, filename);
};
const { projectRetirementPlan, calculateTax } = load("../src/lib/simulationEngine.ts");
const { runMonteCarloSimulation } = load("../src/lib/monteCarlo.ts");
const { defaultRetirementInputs } = load("../src/lib/default-inputs.ts");
const { calculateRrifMinimumWithdrawal } = load("../src/lib/governmentBenefits.ts");
const { parsePlanDate, planDateFor, withPlanDate, monthYearLabel } = load("../src/lib/planDates.ts");
const { hasCompleteFundingSummary, isReturnOverrideUpdate, projectWithVariableReturns } = load("../src/lib/projectionPath.ts");
const { compareActuals, createActualsBaseline, createForecastRevision, isActualsTracking, nextActualsDate, rollingReforecast, saveBalanceObservation } = load("../src/lib/actuals.ts");
const { projectWorkingForecast, workingForecastContext } = load("../src/lib/workingForecast.ts");
const { accountEntriesFor, accountTotal, assetsWithAccounts } = load("../src/lib/accounts.ts");
Module._resolveFilename = originalResolve;
if (originalTypeScriptLoader) Module._extensions[".ts"] = originalTypeScriptLoader;
else delete Module._extensions[".ts"];

function fixture() {
  const inputs = structuredClone(defaultRetirementInputs);
  inputs.personalInfo.currentAge = 65;
  inputs.personalInfo.targetDeathAge = 67;
  inputs.personalInfo.additionalPeople = [{
    id: "partner", label: "Partner", currentAge: 65, targetDeathAge: 67,
    receivesCpp: true, cppPayoutRate: 0.6, receivesOas: true,
    existingAssets: { rrspBalance: 0, tfsaBalance: 0, nonRegisteredBalance: 0, nonRegisteredBookValue: 0 },
  }];
  inputs.incomeStreams = [];
  inputs.contributionSchedules = [];
  inputs.assumptions.returnMean = 0;
  inputs.assumptions.returnStdDev = 0;
  inputs.assumptions.inflationMean = 0;
  inputs.spendingPlan.indexedToInflation = false;
  inputs.spendingPlan.phases = [{ id: "retirement", label: "Retirement", startAge: 65, endAge: 67, annualSpending: 0 }];
  inputs.strategy.withdrawalOrder = ["rrsp", "nonRegistered", "tfsa", "interestBearing"];
  return inputs;
}

function pension(inputs, ownerId = "primary", taxTreatment = "pension", annualAmount = 120_000) {
  inputs.incomeStreams.push({ id: "pension", ownerId, label: "Pension", annualAmount, startAge: 60, endAge: 95, taxTreatment, indexationMode: "none" });
}

function enableSplitting(inputs) {
  inputs.strategy.pensionIncomeSplitting = { enabled: true };
}

function projection(inputs) {
  return projectRetirementPlan(inputs, { calendarYear: 2026 });
}

function actualsFixture() {
  const inputs = fixture();
  inputs.planDate = "2026-10-26";
  inputs.existingAssets.tfsaBalance = 100_000;
  inputs.personalInfo.additionalPeople[0].existingAssets.tfsaBalance = 50_000;
  return { inputs, baseline: createActualsBaseline(inputs, projection(inputs), "Original plan", "original") };
}

test("actuals baselines freeze accounts, inputs, and exact per-person checkpoints without recursive history", () => {
  const { inputs, baseline } = actualsFixture();
  assert.equal(baseline.points[0].portfolioByPerson.primary, 100_000);
  assert.equal(baseline.points[0].portfolioByPerson.partner, 50_000);
  assert.notEqual(baseline.accounts[0].key, baseline.accounts[1].key);
  for (const year of projection(inputs).years) {
    assert.ok(Math.abs(Object.values(year.portfolioByPerson).reduce((total, balance) => total + balance, 0)
      - year.closingBalances.rrsp - year.closingBalances.tfsa - year.closingBalances.nonRegistered - year.closingBalances.interestBearing) < 1e-6);
  }
  inputs.existingAssets.tfsaBalance = 1;
  inputs.assumptions.returnMean = 0.9;
  assert.equal(baseline.inputs.existingAssets.tfsaBalance, 100_000);
  assert.equal(baseline.points[0].portfolioByPerson.primary, 100_000);
  inputs.actuals = { baselines: [baseline], observations: [] };
  const revision = createActualsBaseline(inputs, projection(inputs), "Revision", "revision");
  assert.equal(revision.inputs.actuals, undefined);
});

test("actuals compare complete balances at exact checkpoints without inventing monthly forecasts", () => {
  const { baseline } = actualsFixture();
  const balances = Object.fromEntries(baseline.accounts.map((account) => [account.key, account.ownerId === "primary" ? 110_000 : 48_000]));
  const entry = { id: "entry", baselineId: baseline.id, date: "2026-12-31", balances, note: "Year end" };
  const result = compareActuals(baseline, entry);
  assert.equal(result.actual, 158_000);
  assert.equal(result.planned, 150_000);
  assert.equal(result.difference, 8_000);
  assert.equal(result.percent, 8_000 / 150_000);
  assert.equal(compareActuals(baseline, entry, "primary").actual, 110_000);
  const monthly = compareActuals(baseline, { ...entry, date: "2026-11-30" });
  assert.equal(monthly.actual, 158_000);
  assert.equal(monthly.planned, null);
  assert.equal(monthly.difference, null);
  delete entry.balances[baseline.accounts[1].key];
  assert.equal(compareActuals(baseline, entry).actual, null);
  assert.equal(compareActuals(baseline, entry, "primary").actual, 110_000);
  entry.balances[baseline.accounts[1].key] = 0;
  assert.equal(compareActuals(baseline, entry).actual, 110_000);
});

test("actuals observation updates preserve IDs, partial entries, and other baselines", () => {
  const { baseline } = actualsFixture();
  let tracking = { baselines: [baseline], observations: [], activeBaselineId: baseline.id, cadence: "monthly" };
  const entry = { id: "first", baselineId: baseline.id, date: "2026-11-30", balances: { [baseline.accounts[0].key]: null }, note: "Partial" };
  tracking = saveBalanceObservation(tracking, entry);
  assert.equal(isActualsTracking(JSON.parse(JSON.stringify(tracking))), true);
  tracking = saveBalanceObservation(tracking, { ...entry, id: "replacement", balances: { [baseline.accounts[0].key]: 5_000 } });
  assert.equal(tracking.observations.length, 1);
  assert.equal(tracking.observations[0].id, "first");
  assert.equal(compareActuals(baseline, tracking.observations[0]).actual, null);
  assert.throws(() => saveBalanceObservation(tracking, { ...entry, date: "2026-10-25" }));
  assert.throws(() => saveBalanceObservation(tracking, { ...entry, balances: { bad: -1 } }));
  assert.equal(isActualsTracking({ baselines: [], observations: [{ ...entry, baselineId: "missing" }] }), false);
});

test("actuals recording dates preserve month ends across monthly, quarterly, annual and leap-year steps", () => {
  assert.equal(nextActualsDate("2026-01-31", "monthly"), "2026-02-28");
  assert.equal(nextActualsDate("2026-01-31", "quarterly"), "2026-04-30");
  assert.equal(nextActualsDate("2024-02-29", "annually"), "2025-02-28");
  assert.equal(nextActualsDate("2026-10-26", "monthly"), "2026-11-26");
});

function reforecastFixture(frequency = "annual") {
  const inputs = fixture();
  inputs.planDate = "2026-01-01";
  inputs.personalInfo.additionalPeople = [];
  inputs.personalInfo.receivesCpp = false;
  inputs.personalInfo.receivesOas = false;
  inputs.existingAssets = { rrspBalance: 0, tfsaBalance: 100_000, nonRegisteredBalance: 0, nonRegisteredBookValue: 0 };
  inputs.assumptions.returnMean = 0.1;
  inputs.assumptions.inflationStdDev = 0;
  inputs.strategy.withdrawalFrequency = frequency;
  inputs.simulation.randomSeed = 42;
  return inputs;
}

function reforecastEntry(baseline, date, balance) {
  return { id: date, baselineId: baseline.id, date, balances: { [baseline.accounts[0].key]: balance }, note: "" };
}

function workingForecastFixture() {
  const inputs = reforecastFixture();
  inputs.assumptions.returnMean = 0;
  inputs.existingAssets.rrspBalance = 100_000;
  inputs.strategy.withdrawalOrder = ["tfsa", "rrsp", "nonRegistered", "interestBearing"];
  inputs.spendingPlan.phases[0].annualSpending = 12_000;
  const baseline = createActualsBaseline(inputs, projectWithVariableReturns(inputs), "Frozen", "working");
  const entry = { id: "year-end", baselineId: baseline.id, date: "2026-12-31", note: "",
    balances: Object.fromEntries(baseline.accounts.map((account) => [account.key, account.type === "rrsp" ? 200_000 : 0])) };
  inputs.actuals = saveBalanceObservation({ baselines: [baseline], observations: [] }, entry);
  return { inputs, baseline, entry };
}

test("applied actuals drive the working projection's future withdrawals and taxes", () => {
  const { inputs, baseline } = workingForecastFixture();
  const original = projectWithVariableReturns(baseline.inputs);
  const working = projectWorkingForecast(inputs);
  const rolling = rollingReforecast(baseline, inputs.actuals.observations);
  assert.equal(workingForecastContext(inputs).asOf, "2026-12-31");
  assert.equal(inputs.actuals.workingBaselineId, baseline.id);
  assert.deepEqual(working.years, rolling.projection.years);
  assert.equal(original.years[1].withdrawals.rrsp, 0);
  assert.ok(working.years[1].withdrawals.rrsp > 12_000);
  assert.equal(working.years[1].withdrawals.tfsa, 0);
  assert.ok(working.years[1].taxes.totalTax > original.years[1].taxes.totalTax);
  assert.deepEqual(working.years[0].withdrawals, original.years[0].withdrawals);
});

test("future forecast revisions preserve modeled history, actuals, and the original plan", () => {
  const { inputs, baseline } = workingForecastFixture();
  const before = projectWorkingForecast(inputs);
  const original = JSON.stringify(baseline);
  inputs.spendingPlan.phases[0].annualSpending = 24_000;
  assert.deepEqual(projectWorkingForecast(inputs), before);
  const revision = createForecastRevision(baseline, inputs, "2027-01-01", "Higher spending", "spending");
  inputs.actuals.forecastRevisions = [revision];
  const after = projectWorkingForecast(inputs);
  assert.deepEqual(after.years[0], before.years[0]);
  assert.equal(after.years[1].spendingTarget, 24_000);
  assert.ok(after.years[1].withdrawals.rrsp > before.years[1].withdrawals.rrsp);
  assert.equal(JSON.stringify(baseline), original);
  const archived = JSON.stringify(revision);
  inputs.actuals.observations[0].balances[baseline.accounts[0].key] = 180_000;
  inputs.spendingPlan.phases[0].annualSpending = 30_000;
  assert.equal(JSON.stringify(revision), archived);
  assert.equal(isActualsTracking(JSON.parse(JSON.stringify(inputs.actuals))), true);
  const restored = JSON.parse(JSON.stringify(inputs));
  assert.deepEqual(projectWorkingForecast(restored), projectWorkingForecast(inputs));
});

test("revisions preserve return history and can change future withdrawal frequency and RRIF timing", () => {
  const { inputs, baseline } = workingForecastFixture();
  const before = projectWorkingForecast(inputs);
  inputs.assumptions.returnMean = 0.05;
  inputs.assumptions.annualReturnOverrides = { 66: 0.08 };
  inputs.strategy.withdrawalFrequency = "monthly";
  inputs.personalInfo.rrifConversionAge = 66;
  inputs.actuals.forecastRevisions = [createForecastRevision(baseline, inputs, "2027-01-01", "Monthly", "monthly")];
  const after = projectWorkingForecast(inputs);
  assert.deepEqual(after.years[0], before.years[0]);
  assert.equal(after.years[1].portfolioReturn, 0.08);
  assert.equal(after.years[1].subPeriods.length, 12);
  assert.equal(after.years[1].rrifMinimumWithdrawal, 0);
  assert.ok(after.years[2].rrifMinimumWithdrawal > 0);
});

test("working-forecast source selection and revision validation preserve saved history", () => {
  const { inputs, baseline } = workingForecastFixture();
  const archived = JSON.stringify(inputs.actuals.observations);
  assert.throws(() => createForecastRevision(baseline, inputs, "2026-01-01", "Past"));
  assert.throws(() => createForecastRevision(baseline, inputs, "2027-06-01", "Mid-year"));
  assert.throws(() => createForecastRevision(baseline, { ...inputs, planDate: "2027-01-01" }, "2027-01-01", "Rebase"));
  inputs.actuals.workingBaselineId = null;
  assert.equal(workingForecastContext(inputs), null);
  assert.deepEqual(projectWorkingForecast(inputs), projectWithVariableReturns(inputs));
  assert.equal(JSON.stringify(inputs.actuals.observations), archived);
  assert.equal(isActualsTracking(inputs.actuals), true);
  delete inputs.actuals.workingBaselineId;
  assert.equal(workingForecastContext(inputs).baseline.id, baseline.id);
});

test("working Monte Carlo fixes modeled history and uses applied balances and future revisions", () => {
  const { inputs, baseline } = workingForecastFixture();
  inputs.simulation.iterations = 2;
  inputs.spendingPlan.phases[0].annualSpending = 20_000;
  inputs.actuals.forecastRevisions = [createForecastRevision(baseline, inputs, "2027-01-01", "Revised spending", "mc")];
  const simulation = runMonteCarloSimulation(inputs);
  const working = projectWorkingForecast(inputs);
  assert.equal(simulation.runsCompleted, 2);
  assert.deepEqual(simulation.medianRun.years[0], working.years[0]);
  assert.equal(simulation.medianRun.years[1].spendingTarget, 20_000);
  assert.ok(simulation.medianRun.years[1].withdrawals.rrsp > 20_000);
  assert.ok(Math.abs(simulation.kpis.medianFinalEstate - working.finalEstateValue) < 0.01);
});

for (const frequency of ["annual", "semiAnnual", "quarterly", "monthly"]) {
  test(`${frequency} dated comparisons measure distance from the original frozen plan`, () => {
    const inputs = reforecastFixture(frequency);
    const baseline = createActualsBaseline(inputs, projectWithVariableReturns(inputs), "Frozen", "frozen");
    const frozen = JSON.stringify(baseline);
    const entries = [reforecastEntry(baseline, "2026-06-30", 120_000), reforecastEntry(baseline, "2027-02-28", 130_000)];
    const result = rollingReforecast(baseline, entries, ["2026-03-31"]);
    for (const [date, expected] of [["2026-03-31", 100_000 * 1.1 ** 0.25], ["2026-06-30", 100_000 * 1.1 ** 0.5], ["2027-02-28", 100_000 * 1.1 ** (1 + 2 / 12)]]) {
      assert.ok(Math.abs(result.originalPoints.find((point) => point.date === date).portfolioByPerson.primary - expected) < 1e-6);
    }
    const comparison = compareActuals(baseline, entries[1], "household", result.originalPoints);
    const expectedPlan = 100_000 * 1.1 ** (1 + 2 / 12);
    assert.ok(Math.abs(comparison.planned - expectedPlan) < 1e-6);
    assert.ok(Math.abs(comparison.difference - (130_000 - expectedPlan)) < 1e-6);
    assert.ok(Math.abs(comparison.percent - (130_000 - expectedPlan) / expectedPlan) < 1e-10);
    assert.equal(JSON.stringify(baseline), frozen);
  });

  test(`${frequency} checkpoint capture leaves the simulated year-end path unchanged`, () => {
    const inputs = reforecastFixture(frequency);
    inputs.spendingPlan.phases[0].annualSpending = 12_000;
    inputs.assumptions.returnMean = 0;
    const baseline = createActualsBaseline(inputs, projectWithVariableReturns(inputs), "Frozen", "frozen");
    const normal = projectRetirementPlan(inputs, baseline.returnPath);
    const captured = projectRetirementPlan(inputs, { ...baseline.returnPath, checkpointDates: ["2026-01-01", "2026-02-15", "2026-06-30", "2026-12-31", "2027-04-30"] });
    assert.deepEqual(captured.years, normal.years);
    assert.equal(captured.finalEstateValue, normal.finalEstateValue);
    assert.equal(captured.balanceCheckpoints.find((point) => point.date === "2026-01-01").portfolioByPerson.primary, 100_000);
    const june = frequency === "annual" ? 88_000 : 94_000;
    assert.ok(Math.abs(captured.balanceCheckpoints.find((point) => point.date === "2026-06-30").portfolioByPerson.primary - june) < 0.01);
    assert.ok(Math.abs(captured.balanceCheckpoints.find((point) => point.date === "2026-12-31").portfolioByPerson.primary - normal.years[0].portfolioByPerson.primary) < 0.01);
  });
}

test("monthly original-plan comparisons work before any actuals have been applied and preserve partial-entry status", () => {
  const { baseline } = actualsFixture();
  const original = rollingReforecast(baseline, [], ["2026-11-27", "2027-02-26"]);
  assert.equal(original.originalPoints.find((point) => point.date === "2026-11-27").portfolioByPerson.primary, 100_000);
  const partial = { id: "partial", baselineId: baseline.id, date: "2027-02-26", balances: { [baseline.accounts[0].key]: 110_000 }, note: "Partial" };
  const comparison = compareActuals(baseline, partial, "household", original.originalPoints);
  assert.equal(comparison.planned, 150_000);
  assert.equal(comparison.actual, null);
  assert.equal(comparison.difference, null);
  assert.equal(compareActuals(baseline, partial, "primary", original.originalPoints).difference, 10_000);
});

for (const frequency of ["annual", "semiAnnual", "quarterly", "monthly"]) {
  test(`${frequency} rolling reforecast preserves the frozen path and applies dated balance resets chronologically`, () => {
    const inputs = reforecastFixture(frequency);
    const baseline = createActualsBaseline(inputs, projectWithVariableReturns(inputs), "Frozen", "frozen");
    const frozen = JSON.stringify(baseline);
    assert.deepEqual(rollingReforecast(baseline, []).points, baseline.points);
    const equalStart = rollingReforecast(baseline, [reforecastEntry(baseline, "2026-01-01", 100_000)]);
    for (const point of baseline.points) assert.ok(Math.abs(equalStart.points.find((entry) => entry.date === point.date).portfolioByPerson.primary - point.portfolioByPerson.primary) < 1e-6);
    const first = reforecastEntry(baseline, "2026-12-31", 200_000);
    const next = reforecastEntry(baseline, "2027-06-30", 300_000);
    const updated = rollingReforecast(baseline, [next, first]);
    assert.deepEqual(updated.appliedDates, ["2026-12-31", "2027-06-30"]);
    assert.equal(updated.points.find((point) => point.date === "2026-12-31").portfolioByPerson.primary, 200_000);
    assert.equal(updated.points.find((point) => point.date === "2027-06-30").portfolioByPerson.primary, 300_000);
    assert.ok(Math.abs(updated.points.find((point) => point.date === "2027-12-31").portfolioByPerson.primary - 300_000 * Math.sqrt(1.1)) < 1e-6);
    assert.ok(Math.abs(updated.points.find((point) => point.date === "2028-12-31").portfolioByPerson.primary - 300_000 * Math.sqrt(1.1) * 1.1) < 1e-6);
    const revisedPast = rollingReforecast(baseline, [reforecastEntry(baseline, "2026-12-31", 250_000), next]);
    assert.ok(Math.abs(revisedPast.points.find((point) => point.date === "2028-12-31").portfolioByPerson.primary - updated.points.find((point) => point.date === "2028-12-31").portfolioByPerson.primary) < 1e-6);
    assert.equal(JSON.stringify(baseline), frozen);
  });

  test(`${frequency} actuals do not repeat spending withdrawals already made before the observation`, () => {
    const inputs = reforecastFixture(frequency);
    inputs.assumptions.returnMean = 0;
    inputs.spendingPlan.phases[0].annualSpending = 12_000;
    const baseline = createActualsBaseline(inputs, projectWithVariableReturns(inputs), "Frozen", "frozen");
    const result = rollingReforecast(baseline, [reforecastEntry(baseline, "2026-06-30", 200_000)]);
    const expected = frequency === "annual" ? 200_000 : 194_000;
    assert.ok(Math.abs(result.points.find((point) => point.date === "2026-12-31").portfolioByPerson.primary - expected) < 0.01);
    assert.ok(Math.abs(result.points.find((point) => point.date === "2027-12-31").portfolioByPerson.primary - (expected - 12_000)) < 0.01);
    if (frequency === "monthly") {
      const midMonth = rollingReforecast(baseline, [reforecastEntry(baseline, "2026-06-15", 200_000)]);
      assert.ok(Math.abs(midMonth.points.find((point) => point.date === "2026-12-31").portfolioByPerson.primary - 193_000) < 0.01);
    }
  });
}

test("rolling reforecast retains future calendar schedules and person ages rather than restarting the plan", () => {
  const inputs = reforecastFixture();
  inputs.assumptions.returnMean = 0;
  inputs.incomeStreams = [{ id: "salary", ownerId: "primary", label: "Salary", taxTreatment: "employment", annualAmount: 10_000, startAge: 66, endAge: 67, indexationMode: "none" }];
  inputs.contributionSchedules = [{ id: "saving", ownerId: "primary", label: "Saving", year: 2027, endYear: 2027, frequency: "annual", annualTfsaContribution: 1_000 }];
  const baseline = createActualsBaseline(inputs, projectWithVariableReturns(inputs), "Frozen", "frozen");
  const result = rollingReforecast(baseline, [reforecastEntry(baseline, "2026-12-31", 200_000)]);
  assert.ok(Math.abs(result.points.find((point) => point.date === "2027-12-31").portfolioByPerson.primary - 201_000) < 0.01);
  assert.ok(Math.abs(result.points.find((point) => point.date === "2028-12-31").portfolioByPerson.primary - 201_000) < 0.01);
});

test("rolling reforecast preserves fixed holding rates, skips incomplete entries, and respects real zeros", () => {
  const inputs = reforecastFixture();
  inputs.existingAssets = { rrspBalance: 0, tfsaBalance: 0, nonRegisteredBalance: 0, nonRegisteredBookValue: 0,
    gics: [{ id: "fixed", balance: 100_000, rate: 0.0816, termYears: 2, startAge: 65, fundingSource: "tfsa", maturityAction: "renew" }] };
  const baseline = createActualsBaseline(inputs, projectWithVariableReturns(inputs), "Frozen", "frozen");
  const partial = { ...reforecastEntry(baseline, "2026-11-30", null) };
  const updated = rollingReforecast(baseline, [partial, reforecastEntry(baseline, "2026-12-31", 200_000)]);
  assert.deepEqual(updated.skippedDates, ["2026-11-30"]);
  assert.ok(Math.abs(updated.points.find((point) => point.date === "2027-12-31").portfolioByPerson.primary - 208_000) < 0.01);
  const zero = rollingReforecast(baseline, [reforecastEntry(baseline, "2026-12-31", 0)]);
  assert.equal(zero.points.find((point) => point.date === "2027-12-31").portfolioByPerson.primary, 0);
});

test("rolling reforecast stores unseeded return draws and refuses to guess missing legacy paths", () => {
  const inputs = reforecastFixture("monthly");
  delete inputs.simulation.randomSeed;
  inputs.assumptions.returnStdDev = 0.08;
  const baseline = createActualsBaseline(inputs, projectWithVariableReturns(inputs), "Frozen", "frozen");
  const updated = rollingReforecast(baseline, [reforecastEntry(baseline, "2026-01-01", 100_000)]);
  for (const point of baseline.points) assert.ok(Math.abs(updated.points.find((entry) => entry.date === point.date).portfolioByPerson.primary - point.portfolioByPerson.primary) < 1e-6);
  const legacy = structuredClone(baseline);
  delete legacy.returnPath;
  assert.throws(() => rollingReforecast(legacy, [reforecastEntry(legacy, "2026-12-31", 200_000)]), /new baseline/);
  const malformed = structuredClone(baseline);
  malformed.returnPath.annualReturns.pop();
  assert.throws(() => rollingReforecast(malformed, [reforecastEntry(malformed, "2026-12-31", 200_000)]), /incomplete/);
});

test("only return-override edits can retain the displayed ledger during recalculation", () => {
  const inputs = fixture();
  const edited = { ...inputs, assumptions: { ...inputs.assumptions, annualReturnOverrides: { ...inputs.assumptions.annualReturnOverrides, 65: 0.08 } } };
  assert.equal(isReturnOverrideUpdate(inputs, edited), true);
  assert.equal(isReturnOverrideUpdate(inputs, { ...edited, assumptions: { ...edited.assumptions, annualReturnOverrides: { 65: 0.09, 66: 0.07 } } }), true);
  assert.equal(isReturnOverrideUpdate(inputs, structuredClone(inputs)), false);
  assert.equal(isReturnOverrideUpdate(inputs, { ...edited, personalInfo: { ...inputs.personalInfo, currentAge: 66 } }), false);
  assert.equal(isReturnOverrideUpdate(inputs, { ...edited, existingAssets: { ...inputs.existingAssets, rrspBalance: 500_000 } }), false);
  assert.equal(isReturnOverrideUpdate(inputs, { ...edited, planDate: "2027-01-01" }), false);
  assert.equal(isReturnOverrideUpdate(inputs, { ...edited, assumptions: { ...edited.assumptions, returnMean: 0.1 } }), false);
});

test("funding summaries reject missing fields, invalid numbers, and inconsistent totals", () => {
  const complete = projection(fixture());
  assert.equal(hasCompleteFundingSummary(complete), true);
  assert.equal(hasCompleteFundingSummary(null), false);
  assert.equal(hasCompleteFundingSummary({ years: [] }), false);
  for (const field of ["employmentIncome", "rrspWithdrawals", "tfsaWithdrawals", "nonRegisteredWithdrawals", "interestBearingWithdrawals", "cppIncome", "oasIncome", "totalFunding", "contributions", "totalTax", "netCash", "taxableIncome"]) {
    const incomplete = structuredClone(complete);
    delete incomplete.years[0].taxesByPerson[0][field];
    assert.equal(hasCompleteFundingSummary(incomplete), false, field);
  }
  for (const invalid of [NaN, Infinity, -Infinity]) {
    const incomplete = structuredClone(complete);
    incomplete.years[0].taxesByPerson[0].employmentIncome = invalid;
    assert.equal(hasCompleteFundingSummary(incomplete), false);
  }
  const wrongFunding = structuredClone(complete);
  wrongFunding.years[0].taxesByPerson[0].rrspWithdrawals += 1_000;
  assert.equal(hasCompleteFundingSummary(wrongFunding), false);
  const wrongNet = structuredClone(complete);
  wrongNet.years[0].taxesByPerson[0].netCash += 1_000;
  assert.equal(hasCompleteFundingSummary(wrongNet), false);
});

test("complete zero-funding projections are valid rather than treated as missing data", () => {
  const inputs = fixture();
  inputs.personalInfo.additionalPeople = [];
  inputs.personalInfo.receivesCpp = false;
  inputs.personalInfo.receivesOas = false;
  inputs.existingAssets = { rrspBalance: 0, tfsaBalance: 0, nonRegisteredBalance: 0, nonRegisteredBookValue: 0 };
  const result = projection(inputs);
  assert.equal(result.years[0].taxesByPerson[0].totalFunding, 0);
  assert.equal(hasCompleteFundingSummary(result), true);
});

test("individual account rows aggregate by tax type and produce person and household totals", () => {
  const inputs = fixture();
  const primary = [
    { id: "rrsp-bank", name: "Bank RRSP", balance: 125_000, type: "rrsp", returnType: "market" },
    { id: "rrsp-broker", name: "Brokerage RRSP", balance: 80_000, type: "rrsp", returnType: "market" },
    { id: "tfsa", name: "TFSA", balance: 30_000, type: "tfsa", returnType: "market" },
    { id: "taxable", name: "Brokerage", balance: 20_000, type: "nonRegistered", returnType: "market", bookValue: 15_000 },
  ];
  const partner = [{ id: "savings", name: "Savings", balance: 25_000, type: "nonRegistered", returnType: "savings", annualRate: 0.04 }];
  inputs.existingAssets = assetsWithAccounts(inputs.existingAssets, primary, 65);
  inputs.personalInfo.additionalPeople[0].existingAssets = assetsWithAccounts(undefined, partner, 65);
  assert.equal(accountTotal(primary), 255_000);
  assert.equal(accountTotal(partner), 25_000);
  const year = projection(inputs).years[0];
  assert.equal(year.openingBalances.rrsp, 205_000);
  assert.equal(year.openingBalances.tfsa, 30_000);
  assert.equal(year.openingBalances.nonRegistered, 20_000);
  assert.equal(year.openingBalances.nonRegisteredBookValue, 15_000);
  assert.equal(year.openingBalances.interestBearing, 25_000);
  assert.equal(year.openingBalances.rrsp + year.openingBalances.tfsa + year.openingBalances.nonRegistered + year.openingBalances.interestBearing, accountTotal(primary) + accountTotal(partner));
});

test("legacy accounts preserve balances, cost basis, GIC rates, and projections after migration", () => {
  const inputs = fixture();
  inputs.existingAssets = {
    rrspBalance: 150_000, tfsaBalance: 50_000, nonRegisteredBalance: 20_000, nonRegisteredBookValue: 12_000,
    interestBearingBalance: 99_999,
    gics: [{ id: "gic", label: "Bank GIC", balance: 40_000, rate: 0.1025, termYears: 2, startAge: 65, fundingSource: "nonRegistered", maturityAction: "renew" }],
  };
  const before = projection(inputs);
  const accounts = accountEntriesFor(inputs.existingAssets, 65);
  assert.equal(accountTotal(accounts), 260_000);
  assert.ok(Math.abs(accounts.find((account) => account.id === "gic").annualRate - 0.05) < 1e-12);
  inputs.existingAssets = assetsWithAccounts(inputs.existingAssets, accounts, 65);
  const after = projection(inputs);
  assert.equal(inputs.existingAssets.interestBearingBalance, 0);
  assert.equal(inputs.existingAssets.nonRegisteredBookValue, 12_000);
  assert.ok(Math.abs(before.finalEstateValue - after.finalEstateValue) < 1e-6);
  assert.ok(Math.abs(before.lifetimeTax - after.lifetimeTax) < 1e-6);
  const legacySingle = { rrspBalance: 0, tfsaBalance: 0, nonRegisteredBalance: 0, nonRegisteredBookValue: 0, gics: [], interestBearingBalance: 10_000, interestBearingRate: 0.06, interestBearingTermYears: 1 };
  assert.equal(accountTotal(accountEntriesFor(legacySingle, 65)), 10_000);
});

test("deleting every named account clears legacy balances and does not resurrect holdings", () => {
  const inputs = fixture();
  inputs.existingAssets = {
    rrspBalance: 100_000, tfsaBalance: 50_000, nonRegisteredBalance: 20_000, nonRegisteredBookValue: 10_000,
    interestBearingBalance: 30_000, accounts: [],
  };
  assert.equal(accountTotal(accountEntriesFor(inputs.existingAssets, 65)), 0);
  const opening = projection(inputs).years[0].openingBalances;
  assert.equal(opening.rrsp + opening.tfsa + opening.nonRegistered + opening.interestBearing, 0);
});

for (const type of ["rrsp", "tfsa", "nonRegistered"]) {
  test(`fixed-rate ${type} holdings compound at an annual rate with the correct tax wrapper`, () => {
    const inputs = fixture();
    inputs.personalInfo.receivesCpp = false;
    inputs.personalInfo.receivesOas = false;
    inputs.personalInfo.additionalPeople = [];
    inputs.existingAssets = assetsWithAccounts(undefined, [{
      id: "fixed", name: "Fixed holding", balance: 100_000, type, returnType: "gic", annualRate: 0.05, termYears: 2,
    }], 65);
    const result = projection(inputs);
    assert.ok(Math.abs(result.years[0].closingBalances.interestBearing - 105_000) < 1e-6);
    assert.ok(Math.abs(result.years[1].closingBalances.interestBearing - 110_250) < 1e-6);
    assert.equal(result.years[0].income.interest, 0);
    assert.ok(Math.abs(result.years[1].income.interest - (type === "nonRegistered" ? 10_250 : 0)) < 1e-6);
    if (type === "tfsa") assert.equal(result.years.at(-1).estateTax, 0);
    if (type === "rrsp") assert.ok(result.years.at(-1).estateTax > 0);
    inputs.spendingPlan.phases[0].annualSpending = 50_000;
    const withdrawalYear = projection(inputs).years[0];
    if (type === "rrsp") assert.ok(withdrawalYear.taxes.totalTax > 0);
    if (type === "tfsa") assert.equal(withdrawalYear.taxes.totalTax, 0);
  });
}

test("interest-bearing savings have annual taxation without a user-entered term", () => {
  const inputs = fixture();
  inputs.personalInfo.receivesCpp = false;
  inputs.personalInfo.receivesOas = false;
  inputs.personalInfo.additionalPeople = [];
  inputs.existingAssets = assetsWithAccounts(undefined, [{
    id: "hisa", name: "HISA", balance: 100_000, type: "nonRegistered", returnType: "savings", annualRate: 0.04,
  }], 65);
  const year = projection(inputs).years[0];
  assert.ok(Math.abs(year.income.interest - 4_000) < 1e-6);
  assert.ok(Math.abs(year.closingBalances.interestBearing - 104_000) < 1e-6);
});

test("saved plans keep the same dates and projections when reopened in later months and years", (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: new Date(2026, 9, 26) });
  const inputs = withPlanDate(fixture());
  inputs.personalInfo.receivesCpp = false;
  inputs.personalInfo.receivesOas = false;
  inputs.personalInfo.additionalPeople = [];
  inputs.existingAssets = { rrspBalance: 0, tfsaBalance: 100_000, nonRegisteredBalance: 0, nonRegisteredBookValue: 0 };
  inputs.assumptions.returnMean = 0.12;
  inputs.assumptions.inflationStdDev = 0;
  inputs.strategy.withdrawalFrequency = "monthly";
  inputs.simulation.randomSeed = 42;
  inputs.simulation.iterations = 2;
  const saved = JSON.stringify(inputs);
  const original = projectRetirementPlan(inputs);
  const variable = projectWithVariableReturns(inputs);
  const monteCarlo = runMonteCarloSimulation(inputs);
  assert.equal(inputs.planDate, "2026-10-26");
  assert.equal(original.years[0].calendarYear, 2026);
  assert.ok(Math.abs(original.years[0].closingBalances.tfsa - 100_000 * 1.12 ** ((3 - 25 / 31) / 12)) < 1e-6);
  for (const laterDate of [new Date(2026, 11, 1), new Date(2028, 2, 1)]) {
    context.mock.timers.setTime(laterDate.getTime());
    const reopened = withPlanDate(JSON.parse(saved));
    assert.deepEqual(projectRetirementPlan(reopened), original);
    assert.deepEqual(projectWithVariableReturns(reopened), variable);
    assert.deepEqual(runMonteCarloSimulation(reopened), monteCarlo);
    assert.equal(monthYearLabel(reopened.personalInfo, 66, planDateFor(reopened).getFullYear(), 1), "January 2027");
  }
});

test("legacy scenario dates are assigned once and explicit dates survive migration", () => {
  const legacy = fixture();
  delete legacy.planDate;
  const migrated = withPlanDate(legacy, new Date(2025, 8, 10));
  assert.equal(migrated.planDate, "2025-09-10");
  assert.equal(withPlanDate(migrated, new Date(2028, 0, 1)).planDate, "2025-09-10");
  assert.equal(planDateFor(legacy).getFullYear(), legacy.taxSettings.taxYear);
  assert.equal(parsePlanDate("2026-02-30"), undefined);
  assert.equal(parsePlanDate("2026-10-26T00:00:00Z"), undefined);
  assert.equal(parsePlanDate("2024-02-29").getDate(), 29);
  assert.equal(parsePlanDate("2026-10-26").getMonth(), 9);
});

for (const frequency of ["annual", "semiAnnual", "quarterly", "monthly"]) {
  for (const annualReturn of [0.12, -0.12]) {
    test(`${frequency} returns only grow current balances for the remaining year (${annualReturn})`, () => {
      const inputs = fixture();
      inputs.personalInfo.receivesCpp = false;
      inputs.personalInfo.receivesOas = false;
      inputs.personalInfo.additionalPeople = [];
      inputs.existingAssets = { rrspBalance: 0, tfsaBalance: 100_000, nonRegisteredBalance: 0, nonRegisteredBookValue: 0 };
      inputs.strategy.withdrawalFrequency = frequency;
      inputs.assumptions.returnMean = annualReturn;
      const result = projectRetirementPlan(inputs, { valuationDate: new Date(2026, 9, 1) });
      const expected = 100_000 * (1 + annualReturn) ** 0.25;
      assert.ok(Math.abs(result.years[0].closingBalances.tfsa - expected) < 1e-6);
      assert.ok(Math.abs(result.years[1].closingBalances.tfsa - expected * (1 + annualReturn)) < 1e-6);
      assert.equal(result.years[0].portfolioReturn, annualReturn);
      if (result.years[0].subPeriods) {
        const periods = result.years[0].subPeriods;
        const compounded = periods.reduce((value, period) => value * (1 + period.portfolioReturn), 1);
        assert.ok(Math.abs(compounded - (1 + annualReturn) ** 0.25) < 1e-10);
        assert.ok(periods.slice(0, Math.floor(periods.length * 0.75)).every((period) => period.portfolioReturn === 0));
      }
    });
  }
}

test("interest-bearing growth and taxable interest use the remaining part of the current month", () => {
  const inputs = fixture();
  inputs.personalInfo.receivesCpp = false;
  inputs.personalInfo.receivesOas = false;
  inputs.personalInfo.additionalPeople = [];
  inputs.existingAssets = {
    rrspBalance: 0, tfsaBalance: 0, nonRegisteredBalance: 0, nonRegisteredBookValue: 0,
    gics: [{ id: "hisa", balance: 100_000, rate: 0.04, termYears: 1, startAge: 65, fundingSource: "nonRegistered", maturityAction: "renew" }],
  };
  for (const frequency of ["annual", "semiAnnual", "quarterly", "monthly"]) {
    inputs.strategy.withdrawalFrequency = frequency;
    const year = projectRetirementPlan(inputs, { valuationDate: new Date(2026, 9, 26) }).years[0];
    const expectedInterest = 100_000 * (1.04 ** ((3 - 25 / 31) / 12) - 1);
    assert.ok(Math.abs(year.income.interest - expectedInterest) < 1e-6);
    assert.ok(Math.abs(year.closingBalances.interestBearing - 100_000 - expectedInterest) < 1e-6);
  }
});

test("shared tax calculations retain dividend credits, capital gains, abatement, and provincial surtax", () => {
  const settings = structuredClone(defaultRetirementInputs.taxSettings);
  settings.federal = {
    basicPersonalAmount: 10_000, taxCreditRate: 0.1, abatementRate: 0,
    brackets: [{ from: 0, to: 50_000, rate: 0.1 }, { from: 50_000, to: null, rate: 0.2 }],
    surtaxBrackets: [],
  };
  settings.provinces.BC = {
    basicPersonalAmount: 5_000, taxCreditRate: 0.05, abatementRate: 0.1,
    brackets: [{ from: 0, to: 50_000, rate: 0.05 }, { from: 50_000, to: null, rate: 0.1 }],
    surtaxBrackets: [{ from: 0, to: 5_000, rate: 0 }, { from: 5_000, to: null, rate: 0.2 }],
  };
  const result = calculateTax({ ordinaryIncome: 100_000, capitalGains: 20_000, eligibleDividends: 10_000, nonEligibleDividends: 5_000 }, "BC", 0.5, settings);
  const expectedDividendCredit = 13_800 * 0.150198 + 5_750 * 0.090301;
  const expectedFederal = (5_000 + 79_550 * 0.2 - 1_000 - expectedDividendCredit) * 0.9;
  const expectedProvincialBase = 2_500 + 79_550 * 0.1 - 250;
  const expectedProvincial = expectedProvincialBase + (expectedProvincialBase - 5_000) * 0.2;
  assert.equal(result.capitalGainsTaxableAmount, 10_000);
  assert.equal(result.taxableIncome, 129_550);
  assert.ok(Math.abs(result.dividendTaxCredit - expectedDividendCredit) < 1e-8);
  assert.ok(Math.abs(result.federalTax - expectedFederal) < 1e-8);
  assert.ok(Math.abs(result.provincialTax - expectedProvincial) < 1e-8);
  assert.ok(Math.abs(result.totalTax - expectedFederal - expectedProvincial) < 1e-8);
  assert.equal(calculateTax({ ordinaryIncome: 0, capitalGains: 0, eligibleDividends: 0, nonEligibleDividends: 0 }, "BC", 0.5, settings).totalTax, 0);
});

test("eligible employer pension splitting reduces combined tax and recovery without creating cash", () => {
  const inputs = fixture();
  pension(inputs);
  const before = projection(inputs).years[0];
  enableSplitting(inputs);
  const after = projection(inputs).years[0];
  assert.ok(after.pensionSplit.amount > 0 && after.pensionSplit.amount <= 60_000);
  assert.equal(after.pensionSplit.fromPersonId, "primary");
  assert.ok(after.taxes.totalTax + after.oasClawback < before.taxes.totalTax + before.oasClawback);
  assert.equal(after.taxesByPerson.reduce((sum, person) => sum + person.pensionSplitTransfer, 0), 0);
  assert.ok(Math.abs(after.totalIncome - after.taxes.totalTax - after.netSpendableCash) < 0.01);
  assert.equal(after.withdrawals.rrsp, 0);
  assert.equal(after.taxesByPerson[0].employmentIncome, 120_000);
  assert.equal(after.taxesByPerson[1].employmentIncome, 0);
  assert.equal(before.taxesByPerson[0].employmentIncome, after.taxesByPerson[0].employmentIncome);
  assert.equal(after.taxesByPerson.reduce((sum, person) => sum + person.employmentIncome, 0), after.income.employment);
  assert.ok(Math.abs(after.taxesByPerson.reduce((sum, person) => sum + person.cppIncome, 0) - after.income.cpp) < 0.01);
  assert.ok(Math.abs(after.taxesByPerson.reduce((sum, person) => sum + person.oasIncome, 0) - after.income.oas) < 0.01);
  assert.ok(Math.abs(after.taxesByPerson.reduce((sum, person) => sum + person.taxableIncome, 0) - after.taxes.taxableIncome) < 0.01);
  for (const person of after.taxesByPerson) {
    assert.ok(Math.abs(person.taxableIncome - (person.oasRecoveryIncome - person.oasClawback)) < 0.01);
    assert.ok(Math.abs(person.totalFunding - person.contributions - person.totalTax - person.netCash) < 0.01);
  }
  assert.ok(Math.abs(after.taxesByPerson.reduce((sum, person) => sum + person.totalFunding, 0) - after.totalIncome) < 0.01);
  assert.ok(Math.abs(after.taxesByPerson.reduce((sum, person) => sum + person.netCash, 0) - after.netSpendableCash) < 0.01);
});

for (const taxAwareWithdrawals of [false, true]) {
  test(`funding sources reconcile scheduled streams, account draws, contributions and net cash (tax-aware ${taxAwareWithdrawals})`, () => {
    const inputs = fixture();
    inputs.personalInfo.additionalPeople = [];
    inputs.personalInfo.receivesCpp = false;
    inputs.personalInfo.receivesOas = false;
    inputs.strategy.taxAwareWithdrawals = taxAwareWithdrawals;
    inputs.incomeStreams = [
      ["employment", 10_000], ["rrspWithdrawal", 5_000], ["taxFree", 3_000], ["eligibleDividend", 1_000],
    ].map(([taxTreatment, annualAmount]) => ({
      id: taxTreatment, ownerId: "primary", label: taxTreatment, taxTreatment, annualAmount, startAge: 65, endAge: taxTreatment === "employment" ? 65 : 67, indexationMode: "none",
    }));
    inputs.contributionSchedules = [{ id: "saving", ownerId: "primary", label: "Saving", year: 2026, endYear: 2026, frequency: "annual", annualTfsaContribution: 1_000 }];
    inputs.existingAssets = {
      rrspBalance: 50_000, tfsaBalance: 50_000, nonRegisteredBalance: 50_000, nonRegisteredBookValue: 50_000,
      gics: [{ id: "gic", balance: 50_000, rate: 0, termYears: 1, startAge: 65, fundingSource: "nonRegistered", maturityAction: "renew" }],
    };
    inputs.spendingPlan.phases[0].annualSpending = 180_000;
    const year = projection(inputs).years[0];
    const person = year.taxesByPerson[0];
    const sources = person.employmentIncome + person.rrspWithdrawals + person.tfsaWithdrawals + person.nonRegisteredWithdrawals
      + person.interestBearingWithdrawals + person.oasIncome + person.cppIncome;
    assert.ok(Math.abs(sources - person.totalFunding) < 0.01);
    assert.ok(Math.abs(person.rrspWithdrawals - 5_000 - year.withdrawals.rrsp) < 0.01);
    assert.ok(Math.abs(person.tfsaWithdrawals - 3_000 - year.withdrawals.tfsa) < 0.01);
    assert.ok(Math.abs(person.nonRegisteredWithdrawals - 1_000 - year.withdrawals.nonRegistered) < 0.01);
    assert.ok(person.interestBearingWithdrawals > 0);
    assert.equal(person.contributions, 1_000);
    assert.ok(Math.abs(person.totalFunding - person.contributions - person.totalTax - person.netCash) < 0.01);
    assert.ok(Math.abs(person.totalFunding - year.totalIncome) < 0.01);
    assert.ok(Math.abs(person.netCash - year.netSpendableCash) < 0.01);
  });
}

test("reported taxable income remains accurate with no tax payable and excludes TFSA withdrawals", () => {
  const inputs = fixture();
  for (const person of [inputs.personalInfo, ...inputs.personalInfo.additionalPeople]) {
    person.receivesCpp = false;
    person.receivesOas = false;
  }
  pension(inputs, "primary", "pension", 10_000);
  inputs.existingAssets.tfsaBalance = 100_000;
  inputs.spendingPlan.phases[0].annualSpending = 30_000;
  const year = projection(inputs).years[0];
  assert.ok(year.withdrawals.tfsa > 0);
  assert.equal(year.taxes.totalTax, 0);
  assert.equal(year.taxes.taxableIncome, 10_000);
  assert.equal(year.taxesByPerson[0].taxableIncome, 10_000);
  assert.ok(year.taxesByPerson.every((person) => person.cppIncome === 0 && person.oasIncome === 0));
});

test("projections use detailed splitting by default and Monte Carlo uses simple splitting for its summary", () => {
  const inputs = fixture();
  pension(inputs);
  enableSplitting(inputs);
  inputs.simulation.iterations = 1;
  inputs.assumptions.inflationStdDev = 0;
  assert.deepEqual(projectRetirementPlan(inputs), projectRetirementPlan(inputs, { pensionSplittingPolicy: "detailed" }));
  const simple = projectRetirementPlan(inputs, { pensionSplittingPolicy: "simple", fastWithdrawalSizing: true });
  const simulation = runMonteCarloSimulation(inputs);
  assert.deepEqual(simulation.medianRun, simple);
  assert.equal(simulation.runsCompleted, 1);
  assert.equal(simulation.kpis.medianFinalEstate, simple.finalEstateValue);
});

for (const policy of ["detailed", "simple"]) {
  test(`${policy} splitting preserves the eligible-income limit, tax allocation, and withdrawal order`, () => {
    const inputs = fixture();
    enableSplitting(inputs);
    pension(inputs, "partner", "pension", 120_000);
    inputs.strategy.taxAwareWithdrawals = true;
    inputs.existingAssets.rrspBalance = 300_000;
    inputs.existingAssets.tfsaBalance = 200_000;
    inputs.spendingPlan.phases[0].annualSpending = 130_000;
    const year = projectRetirementPlan(inputs, { calendarYear: 2026, pensionSplittingPolicy: policy }).years[0];
    assert.ok(year.pensionSplit.amount > 0 && year.pensionSplit.amount <= 60_000);
    assert.equal(year.pensionSplit.fromPersonId, "partner");
    assert.ok(Math.abs(year.taxesByPerson.reduce((sum, person) => sum + person.pensionSplitTransfer, 0)) < 0.01);
    assert.equal(year.withdrawals.tfsa, 0);
    assert.ok(year.netSpendableCash >= year.spendingTarget - 0.02);
  });
}

test("splitting uses the first additional person automatically and excludes ineligible pensions", () => {
  const inputs = fixture();
  pension(inputs);
  enableSplitting(inputs);
  assert.equal(projection(inputs).years[0].pensionSplit.toPersonId, "partner");
  inputs.incomeStreams[0].pensionEligibleForSplitting = false;
  assert.equal(projection(inputs).years[0].pensionSplit, undefined);
  inputs.incomeStreams[0].pensionEligibleForSplitting = true;
  inputs.personalInfo.additionalPeople = [];
  assert.equal(projection(inputs).years[0].pensionSplit, undefined);
});

test("ordinary RRSP income and CPP/OAS are not eligible pension income", () => {
  const inputs = fixture();
  enableSplitting(inputs);
  pension(inputs, "primary", "rrspWithdrawal");
  inputs.personalInfo.rrifConversionAge = 64;
  assert.equal(projection(inputs).years[0].pensionSplit, undefined);
});

test("RRIF income qualifies from 65 and employer pension can qualify before 65", () => {
  const inputs = fixture();
  enableSplitting(inputs);
  pension(inputs, "primary", "rrifWithdrawal");
  assert.ok(projection(inputs).years[0].pensionSplit.amount > 0);
  inputs.personalInfo.currentAge = 64;
  inputs.personalInfo.additionalPeople[0].currentAge = 64;
  assert.equal(projection(inputs).years[0].pensionSplit, undefined);
  inputs.incomeStreams[0].taxTreatment = "pension";
  assert.ok(projection(inputs).years[0].pensionSplit.amount > 0);
});

test("the elected direction can be partner to primary and stops after the partner's death", () => {
  const inputs = fixture();
  enableSplitting(inputs);
  pension(inputs, "partner");
  assert.equal(projection(inputs).years[0].pensionSplit.fromPersonId, "partner");
  inputs.personalInfo.additionalPeople[0].targetDeathAge = 65;
  pension(inputs, "primary", "pension", 150_000);
  assert.equal(projection(inputs).years[1].pensionSplit, undefined);
});

test("RRIF conversion starts minimums the next year and omitted settings mean conversion at 71", () => {
  assert.equal(calculateRrifMinimumWithdrawal(100_000, 65, 65), 0);
  assert.ok(calculateRrifMinimumWithdrawal(100_000, 66, 65) > 0);
  assert.equal(calculateRrifMinimumWithdrawal(100_000, 70), 0);
  assert.equal(calculateRrifMinimumWithdrawal(100_000, 71), 0);
  assert.ok(calculateRrifMinimumWithdrawal(100_000, 72) > 0);
  assert.equal(calculateRrifMinimumWithdrawal(100_000, 72), calculateRrifMinimumWithdrawal(100_000, 72, 71));
});

test("unset and explicit age-71 conversion produce identical projections including registered GIC minimums", () => {
  const inputs = fixture();
  inputs.personalInfo.currentAge = 70;
  inputs.personalInfo.targetDeathAge = 73;
  inputs.personalInfo.additionalPeople = [];
  inputs.personalInfo.receivesCpp = false;
  inputs.personalInfo.receivesOas = false;
  delete inputs.personalInfo.rrifConversionAge;
  inputs.existingAssets = {
    rrspBalance: 100_000, tfsaBalance: 0, nonRegisteredBalance: 0, nonRegisteredBookValue: 0,
    gics: [{ id: "registered", balance: 50_000, rate: 0, termYears: 5, startAge: 70, fundingSource: "registered", maturityAction: "renew" }],
  };
  const implicit = projection(inputs);
  inputs.personalInfo.rrifConversionAge = 71;
  assert.deepEqual(projection(inputs), implicit);
  assert.equal(implicit.years[1].rrifMinimumWithdrawal, 0);
  assert.equal(implicit.years[2].rrifMinimumWithdrawal, calculateRrifMinimumWithdrawal(150_000, 72, 71));
});

for (const frequency of ["annual", "monthly"]) {
  test(`fast ${frequency} sizing preserves spending and account preferences near tax/OAS thresholds`, () => {
    const inputs = fixture();
    enableSplitting(inputs);
    inputs.personalInfo.rrifConversionAge = 64;
    inputs.strategy.taxAwareWithdrawals = true;
    inputs.strategy.withdrawalFrequency = frequency;
    inputs.existingAssets.rrspBalance = 500_000;
    inputs.existingAssets.nonRegisteredBalance = 300_000;
    inputs.existingAssets.nonRegisteredBookValue = 200_000;
    inputs.existingAssets.tfsaBalance = 200_000;
    inputs.spendingPlan.phases[0].annualSpending = 140_000;
    const options = { calendarYear: 2026, pensionSplittingPolicy: "simple", annualReturns: [0.1, -0.2, 0.05] };
    const precise = projectRetirementPlan(inputs, { ...options, fastWithdrawalSizing: false });
    const fast = projectRetirementPlan(inputs, { ...options, fastWithdrawalSizing: true });
    assert.equal(fast.portfolioDepleted, precise.portfolioDepleted);
    fast.years.forEach((year, index) => {
      assert.ok(Number.isFinite(year.netSpendableCash));
      assert.ok(year.netSpendableCash >= year.spendingTarget - 0.02);
      assert.ok(Math.abs(year.estateValue - precise.years[index].estateValue) < 1);
      assert.ok(Math.abs(year.oasClawback - precise.years[index].oasClawback) < 0.02);
      assert.equal(year.withdrawals.tfsa, 0);
      if (frequency === "monthly") {
        for (const account of ["rrsp", "tfsa", "nonRegistered", "interestBearing"]) {
          assert.ok(Math.abs(year.subPeriods.reduce((sum, period) => sum + period.withdrawals[account], 0) - year.withdrawals[account]) < 0.02);
        }
      }
    });
  });

  test(`tax-aware ${frequency} withdrawals fund spending without promoting TFSA ahead of RRSP`, () => {
    const inputs = fixture();
    inputs.existingAssets.rrspBalance = 300_000;
    inputs.existingAssets.tfsaBalance = 200_000;
    inputs.spendingPlan.phases[0].annualSpending = 70_000;
    inputs.strategy.withdrawalFrequency = frequency;
    inputs.strategy.taxAwareWithdrawals = true;
    const after = projection(inputs).years[0];
    assert.ok(after.netSpendableCash >= after.spendingTarget - 0.02);
    assert.ok(after.withdrawals.rrsp > 0);
    assert.equal(after.withdrawals.tfsa, 0);
    assert.equal(after.depleted, false);
    if (frequency === "monthly") {
      for (const account of ["rrsp", "tfsa", "nonRegistered", "interestBearing"]) {
        assert.ok(Math.abs(after.subPeriods.reduce((sum, period) => sum + period.withdrawals[account], 0) - after.withdrawals[account]) < 0.02);
      }
    }
  });
}

test("the next non-registered account can supplement RRSP to reduce recovery without touching TFSA", () => {
  const inputs = fixture();
  inputs.existingAssets.rrspBalance = 500_000;
  inputs.existingAssets.nonRegisteredBalance = 300_000;
  inputs.existingAssets.nonRegisteredBookValue = 300_000;
  inputs.existingAssets.tfsaBalance = 200_000;
  inputs.spendingPlan.phases[0].annualSpending = 140_000;
  const before = projection(inputs).years[0];
  inputs.strategy.taxAwareWithdrawals = true;
  const after = projection(inputs).years[0];
  assert.ok(after.withdrawals.rrsp > 0);
  assert.ok(after.withdrawals.nonRegistered > 0);
  assert.equal(after.withdrawals.tfsa, 0);
  assert.ok(after.oasClawback < before.oasClawback);
  assert.ok(after.netSpendableCash >= after.spendingTarget - 0.02);
});

test("TFSA is used normally when it is first in the user's order", () => {
  const inputs = fixture();
  inputs.strategy.taxAwareWithdrawals = true;
  inputs.strategy.withdrawalOrder = ["tfsa", "rrsp", "nonRegistered", "interestBearing"];
  inputs.existingAssets.rrspBalance = 300_000;
  inputs.existingAssets.tfsaBalance = 200_000;
  inputs.spendingPlan.phases[0].annualSpending = 70_000;
  const year = projection(inputs).years[0];
  assert.ok(year.withdrawals.tfsa > 0);
  assert.equal(year.withdrawals.rrsp, 0);
});

for (const frequency of ["annual", "monthly"]) {
  test(`tax-aware withdrawals and aggressive meltdown work together with ${frequency} funding`, () => {
    const inputs = fixture();
    inputs.strategy.taxAwareWithdrawals = true;
    inputs.strategy.withdrawalFrequency = frequency;
    enableSplitting(inputs);
    inputs.existingAssets.rrspBalance = 300_000;
    inputs.spendingPlan.phases[0].annualSpending = 70_000;
    const before = projection(inputs).years[0];
    inputs.strategy.aggressiveRrspMeltdown = true;
    const after = projection(inputs).years[0];
    assert.equal(inputs.strategy.taxAwareWithdrawals, true);
    assert.equal(inputs.strategy.aggressiveRrspMeltdown, true);
    assert.equal(inputs.strategy.pensionIncomeSplitting.enabled, true);
    assert.ok(after.withdrawals.rrsp > before.withdrawals.rrsp);
    assert.ok(after.netSpendableCash >= after.spendingTarget - 0.02);
    assert.ok(Math.abs(after.oasClawback - after.taxesByPerson.reduce((sum, person) => sum + person.oasClawback, 0)) < 0.02);
    assert.equal(after.depleted, false);
    if (frequency === "monthly") {
      assert.ok(Math.abs(after.subPeriods.reduce((sum, period) => sum + period.withdrawals.rrsp, 0) - after.withdrawals.rrsp) < 0.02);
    }
  });
}

test("fully selling a non-registered holding retains its realized capital gain", () => {
  const inputs = fixture();
  inputs.strategy.taxAwareWithdrawals = true;
  inputs.existingAssets.nonRegisteredBalance = 100_000;
  inputs.existingAssets.nonRegisteredBookValue = 0;
  inputs.spendingPlan.phases[0].annualSpending = 200_000;
  const year = projection(inputs).years[0];
  assert.ok(Math.abs(year.withdrawals.nonRegistered - 100_000) < 0.02);
  assert.ok(Math.abs(year.taxes.capitalGainsTaxableAmount - 50_000) < 0.02);
});

test("RRIF minimums include registered GICs and are taxable even with no ordinary RRSP balance", () => {
  const inputs = fixture();
  inputs.strategy.taxAwareWithdrawals = true;
  inputs.personalInfo.rrifConversionAge = 64;
  const before = projection(inputs).years[0];
  inputs.existingAssets.gics = [{ id: "registered", balance: 100_000, rate: 0, termYears: 1, startAge: 65, fundingSource: "registered", maturityAction: "renew" }];
  const year = projection(inputs).years[0];
  assert.ok(year.rrifMinimumWithdrawal > 0);
  assert.ok(Math.abs(year.withdrawals.interestBearing - year.rrifMinimumWithdrawal) < 0.02);
  assert.ok(year.taxes.totalTax > before.taxes.totalTax);
});

test("tax-aware withdrawals preserve the GIC buffer while alternatives remain available", () => {
  const inputs = fixture();
  inputs.strategy.taxAwareWithdrawals = true;
  inputs.strategy.gicBuffer = { enabled: true, triggerDrawdown: 0.1, recoveryDrawdown: 0.03, refillFromSurplus: false };
  inputs.existingAssets.tfsaBalance = 100_000;
  inputs.existingAssets.gics = [{ id: "reserve", balance: 100_000, rate: 0, termYears: 1, startAge: 65, fundingSource: "nonRegistered", maturityAction: "renew" }];
  inputs.spendingPlan.phases[0].annualSpending = 60_000;
  const year = projection(inputs).years[0];
  assert.equal(year.gicBufferMode, "reserve");
  assert.equal(year.withdrawals.interestBearing, 0);
  assert.ok(year.withdrawals.tfsa > 0);
});