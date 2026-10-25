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

test("explicit RRIF conversion starts minimums the next year while omitted settings retain legacy minimums", () => {
  assert.equal(calculateRrifMinimumWithdrawal(100_000, 65, 65), 0);
  assert.ok(calculateRrifMinimumWithdrawal(100_000, 66, 65) > 0);
  assert.equal(calculateRrifMinimumWithdrawal(100_000, 70), 0);
  assert.ok(calculateRrifMinimumWithdrawal(100_000, 71) > 0);
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