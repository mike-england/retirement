import { projectRetirementPlan } from "@/lib/simulationEngine";
import type {
  DeterministicProjection,
  FailureAnalysis,
  MonteCarloRun,
  PercentileBand,
  RetirementInputs,
  SimulationOutput,
} from "@/types/retirement";

export function runMonteCarloSimulation(inputs: RetirementInputs): SimulationOutput {
  const random = createRandom(inputs.simulation.randomSeed);
  // The plan can run past the primary's own death if someone else in the household outlives them; targetDeathAge is in each person's own age scale, so compare lifespan lengths, not raw ages.
  const maxLifespanIndex = Math.max(
    inputs.personalInfo.targetDeathAge - inputs.personalInfo.currentAge,
    ...(inputs.personalInfo.additionalPeople ?? []).map((person) => person.targetDeathAge - person.currentAge),
  );
  const yearCount = maxLifespanIndex + 1;
  const projections: DeterministicProjection[] = [];
  const averageAnnualReturns: number[] = [];
  const returnFloor = inputs.assumptions.returnFloor ?? -0.08;
  const returnCeiling = Math.max(returnFloor, inputs.assumptions.returnCeiling ?? 0.15);

  for (let run = 0; run < inputs.simulation.iterations; run += 1) {
    const annualReturns = Array.from({ length: yearCount }, () => boundedLognormalReturn(
      random,
      inputs.assumptions.returnMean,
      inputs.assumptions.returnStdDev,
      returnFloor,
      returnCeiling,
    ));
    const annualInflation = Array.from({ length: yearCount }, () => Math.max(0, normalRandom(
      random,
      inputs.assumptions.inflationMean,
      inputs.assumptions.inflationStdDev,
    )));
    projections.push(projectRetirementPlan(inputs, { annualReturns, annualInflation }));
    averageAnnualReturns.push(average(annualReturns));
  }

  const sortedByEstate = [...projections].sort((first, second) => first.finalEstateValue - second.finalEstateValue);
  const medianRun = projectRetirementPlan(inputs);
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
    failureAnalysis: createFailureAnalysis(projections, averageAnnualReturns),
  };
}

function createFailureAnalysis(projections: DeterministicProjection[], averageAnnualReturns: number[]): FailureAnalysis {
  const failureAgeCounts = new Map<number, number>();
  const failedReturns: number[] = [];
  const successfulReturns: number[] = [];

  projections.forEach((projection, index) => {
    if (projection.portfolioDepleted) {
      failedReturns.push(averageAnnualReturns[index]);
      // The first depleted year in a run marks the age it ran out of money.
      const failureYear = projection.years.find((year) => year.depleted);
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

function lognormalReturn(random: () => number, arithmeticMean: number, standardDeviation: number) {
  if (arithmeticMean <= -1) return -0.999;
  const grossMean = 1 + arithmeticMean;
  const logVariance = Math.log(1 + (standardDeviation ** 2) / (grossMean ** 2));
  const logStandardDeviation = Math.sqrt(logVariance);
  const logMean = Math.log(grossMean) - logVariance / 2;
  const standardNormal = normalRandom(random, 0, 1);
  return Math.exp(logMean + logStandardDeviation * standardNormal) - 1;
}

function boundedLognormalReturn(random: () => number, arithmeticMean: number, standardDeviation: number, floor: number, ceiling: number) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const sample = lognormalReturn(random, arithmeticMean, standardDeviation);
    if (sample >= floor && sample <= ceiling) return sample;
  }
  return Math.min(ceiling, Math.max(floor, arithmeticMean));
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
