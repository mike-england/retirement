import { decomposeAnnualReturn, forecastInputsForYear, projectRetirementPlan, sampleAnnualReturn, subPeriodsPerYear } from "@/lib/simulationEngine";
import { actualsProjectionOptions } from "@/lib/actuals";
import { workingForecastContext } from "@/lib/workingForecast";
import { planDateFor } from "@/lib/planDates";
import type {
  DeterministicProjection,
  FailureAnalysis,
  MonteCarloRun,
  PercentileBand,
  RetirementInputs,
  SimulationOutput,
} from "@/types/retirement";

export function runMonteCarloSimulation(inputs: RetirementInputs, onProgress?: (completed: number, total: number) => void): SimulationOutput {
  const working = workingForecastContext(inputs);
  const simulationInputs = working?.baseline.inputs ?? inputs;
  const workingOptions = working ? actualsProjectionOptions(working.baseline, working.observations, working.revisions) : {};
  const baseYear = planDateFor(simulationInputs).getFullYear();
  const fixedThroughYear = working ? Number(working.asOf.slice(0, 4)) : -Infinity;
  const random = createRandom(inputs.simulation.randomSeed);
  // The plan can run past the primary's own death if someone else in the household outlives them; targetDeathAge is in each person's own age scale, so compare lifespan lengths, not raw ages.
  const maxLifespanIndex = Math.max(
    simulationInputs.personalInfo.targetDeathAge - simulationInputs.personalInfo.currentAge,
    ...(simulationInputs.personalInfo.additionalPeople ?? []).map((person) => person.targetDeathAge - person.currentAge),
  );
  const yearCount = maxLifespanIndex + 1;
  if (working && fixedThroughYear >= baseYear + yearCount - 1) throw new Error("No full future calendar years remain for working-forecast Monte Carlo analysis.");
  const projections: DeterministicProjection[] = [];
  const averageAnnualReturns: number[] = [];
  const yearlyInputs = Array.from({ length: yearCount }, (_, index) => forecastInputsForYear(simulationInputs, working?.revisions ?? [], baseYear + index));
  let lastProgressAt = Date.now();
  onProgress?.(0, inputs.simulation.iterations);

  for (let run = 0; run < inputs.simulation.iterations; run += 1) {
    const annualReturns = yearlyInputs.map((plan, index) => {
      if (baseYear + index <= fixedThroughYear) return workingOptions.annualReturns![index];
      const floor = plan.assumptions.returnFloor ?? -0.08;
      return sampleAnnualReturn(random, plan.assumptions.returnMean, plan.assumptions.returnStdDev, floor, Math.max(floor, plan.assumptions.returnCeiling ?? 0.15));
    });
    const annualInflation = yearlyInputs.map((plan, index) => baseYear + index <= fixedThroughYear ? workingOptions.annualInflation![index]
      : Math.max(0, normalRandom(random, plan.assumptions.inflationMean, plan.assumptions.inflationStdDev)));
    const subPeriodReturns = annualReturns.map((annualReturn, index) => {
      if (baseYear + index <= fixedThroughYear) return workingOptions.subPeriodReturns![index];
      return decomposeAnnualReturn(random, annualReturn, subPeriodsPerYear(yearlyInputs[index].strategy.withdrawalFrequency), yearlyInputs[index].assumptions.returnStdDev);
    });
    const result = projectRetirementPlan(simulationInputs, { ...workingOptions, annualReturns, annualInflation, subPeriodReturns, pensionSplittingPolicy: "simple", fastWithdrawalSizing: true });
    if (working) result.portfolioDepleted = result.years.some((year) => year.calendarYear > fixedThroughYear && year.depleted);
    projections.push(result);
    averageAnnualReturns.push(average(annualReturns.filter((_, index) => baseYear + index > fixedThroughYear)));
    if (onProgress && Date.now() - lastProgressAt >= 100) {
      onProgress(run + 1, inputs.simulation.iterations);
      lastProgressAt = Date.now();
    }
  }

  onProgress?.(projections.length, inputs.simulation.iterations);
  const sortedByEstate = [...projections].sort((first, second) => first.finalEstateValue - second.finalEstateValue);
  const medianRun = projectRetirementPlan(simulationInputs, { ...workingOptions, pensionSplittingPolicy: "simple", fastWithdrawalSizing: true });
  const successfulRuns = projections.filter((projection) => !projection.portfolioDepleted).length;
  const successRate = projections.length === 0 ? 0 : successfulRuns / projections.length;
  // The bottom (1 - successRate) share of runs run out of money, so that rank marks the worst run that still survives.
  const worstSurvivingPercentileRank = Math.min(0.99, Math.max(0.01, 1 - successRate));

  return {
    kpis: {
      successRate,
      medianFinalEstate: percentile(sortedByEstate.map((projection) => projection.finalEstateValue), 0.5),
      medianLifetimeTax: percentile(projections.map((projection) => projection.lifetimeTax), 0.5),
      medianPortfolioPeakAge: percentile(projections.map((projection) => projection.portfolioPeakAge), 0.5),
      worstSurvivingPercentileRank,
    },
    percentileBands: createPercentileBands(projections, worstSurvivingPercentileRank),
    medianRun,
    runsCompleted: projections.length,
    failureAnalysis: createFailureAnalysis(projections, averageAnnualReturns, fixedThroughYear),
  };
}

function createFailureAnalysis(projections: DeterministicProjection[], averageAnnualReturns: number[], fixedThroughYear = -Infinity): FailureAnalysis {
  const failureAgeCounts = new Map<number, number>();
  const failedReturns: number[] = [];
  const successfulReturns: number[] = [];

  projections.forEach((projection, index) => {
    if (projection.portfolioDepleted) {
      failedReturns.push(averageAnnualReturns[index]);
      // The first depleted year in a run marks the age it ran out of money.
      const failureYear = projection.years.find((year) => year.calendarYear > fixedThroughYear && year.depleted);
      if (failureYear) failureAgeCounts.set(failureYear.age, (failureAgeCounts.get(failureYear.age) ?? 0) + 1);
    } else {
      successfulReturns.push(averageAnnualReturns[index]);
    }
  });

  return {
    failedRunCount: failedReturns.length,
    ageDistribution: [...failureAgeCounts.entries()]
      .sort(([firstAge], [secondAge]) => firstAge - secondAge)
      .map(([age, failedRunCount]) => ({ age, failedRunCount })),
    averageReturnFailedRuns: average(failedReturns),
    averageReturnSuccessfulRuns: average(successfulReturns),
  };
}

function average(values: number[]) {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function createPercentileBands(projections: DeterministicProjection[], worstSurvivingPercentileRank: number): PercentileBand[] {
  const yearCount = projections[0]?.years.length ?? 0;
  return Array.from({ length: yearCount }, (_, index) => {
    const values = projections.map((projection) => portfolioValueAt(projection, index));
    return {
      age: projections[0].years[index].age,
      pWorstSurviving: percentile(values, worstSurvivingPercentileRank),
      p10: percentile(values, 0.1),
      p50: percentile(values, 0.5),
      p90: percentile(values, 0.9),
    };
  });
}

function portfolioValueAt(projection: DeterministicProjection, yearIndex: number) {
  const year = projection.years[yearIndex];
  if (!year) return 0;
  return year.closingBalances.rrsp + year.closingBalances.tfsa + year.closingBalances.nonRegistered + year.closingBalances.interestBearing;
}

function percentile(values: number[], percentileValue: number) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((first, second) => first - second);
  const index = (sorted.length - 1) * percentileValue;
  const lowerIndex = Math.floor(index);
  const upperIndex = Math.ceil(index);
  const interpolation = index - lowerIndex;
  return sorted[lowerIndex] * (1 - interpolation) + sorted[upperIndex] * interpolation;
}

function normalRandom(random: () => number, mean: number, standardDeviation: number) {
  const first = Math.max(random(), Number.MIN_VALUE);
  const second = random();
  const standardNormal = Math.sqrt(-2 * Math.log(first)) * Math.cos(2 * Math.PI * second);
  return mean + standardNormal * standardDeviation;
}

function createRandom(seed?: number) {
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
