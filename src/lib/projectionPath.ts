import { projectRetirementPlan } from "@/lib/simulationEngine";
import type { DeterministicProjection, RetirementInputs } from "@/types/retirement";

export function projectWithVariableReturns(inputs: RetirementInputs): DeterministicProjection {
  const annualReturns = generateAnnualReturns(inputs).map((generatedReturn, index) =>
    inputs.assumptions.annualReturnOverrides[inputs.personalInfo.currentAge + index] ?? generatedReturn,
  );
  return projectRetirementPlan(inputs, { annualReturns });
}

export function generateAnnualReturns(inputs: RetirementInputs, seed = inputs.simulation.randomSeed) {
  // The plan can run past the primary's own death if someone else in the household outlives them; targetDeathAge is in each person's own age scale, so compare lifespan lengths, not raw ages.
  const maxLifespanIndex = Math.max(
    inputs.personalInfo.targetDeathAge - inputs.personalInfo.currentAge,
    ...(inputs.personalInfo.additionalPeople ?? []).map((person) => person.targetDeathAge - person.currentAge),
  );
  const yearCount = maxLifespanIndex + 1;
  const random = createRandom(seed);
  const { floor, ceiling } = returnBounds(inputs);
  const targetMean = Math.min(ceiling, Math.max(floor, inputs.assumptions.returnMean));
  const returns = Array.from({ length: yearCount }, () => boundedNormalRandom(
    random,
    inputs.assumptions.returnMean,
    inputs.assumptions.returnStdDev,
    floor,
    ceiling,
  ));
  return calibrateArithmeticMean(returns, targetMean, floor, ceiling);
}

function returnBounds(inputs: RetirementInputs) {
  const floor = inputs.assumptions.returnFloor ?? -0.08;
  return { floor, ceiling: Math.max(floor, inputs.assumptions.returnCeiling ?? 0.15) };
}

function boundedNormalRandom(random: () => number, mean: number, standardDeviation: number, floor: number, ceiling: number) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const sample = normalRandom(random, mean, standardDeviation);
    if (sample >= floor && sample <= ceiling) return sample;
  }
  return Math.min(ceiling, Math.max(floor, mean));
}

function calibrateArithmeticMean(returns: number[], targetMean: number, floor: number, ceiling: number) {
  const adjusted = [...returns];
  let remainingAdjustment = targetMean * adjusted.length - adjusted.reduce((sum, rate) => sum + rate, 0);

  while (Math.abs(remainingAdjustment) > 1e-10) {
    const eligibleIndexes = adjusted.flatMap((rate, index) => {
      const hasRoom = remainingAdjustment > 0 ? rate < ceiling : rate > floor;
      return hasRoom ? [index] : [];
    });
    if (eligibleIndexes.length === 0) break;

    const adjustmentPerReturn = remainingAdjustment / eligibleIndexes.length;
    let appliedAdjustment = 0;
    for (const index of eligibleIndexes) {
      const adjustedRate = Math.min(ceiling, Math.max(floor, adjusted[index] + adjustmentPerReturn));
      appliedAdjustment += adjustedRate - adjusted[index];
      adjusted[index] = adjustedRate;
    }
    if (Math.abs(appliedAdjustment) < 1e-12) break;
    remainingAdjustment -= appliedAdjustment;
  }

  return adjusted;
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
