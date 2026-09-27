import { decomposeAnnualReturn, projectRetirementPlan, sampleAnnualReturn, subPeriodsPerYear } from "@/lib/simulationEngine";
import type { DeterministicProjection, RetirementInputs } from "@/types/retirement";

export function projectWithVariableReturns(inputs: RetirementInputs): DeterministicProjection {
  const annualReturns = generateAnnualReturns(inputs).map((generatedReturn, index) =>
    inputs.assumptions.annualReturnOverrides[inputs.personalInfo.currentAge + index] ?? generatedReturn,
  );
  const subPeriodCount = subPeriodsPerYear(inputs.strategy.withdrawalFrequency);
  const subPeriodReturns = subPeriodCount <= 1
    ? undefined
    : (() => {
      // Offset from the annual seed so the within-year noise isn't a repeat of the annual draw sequence.
      const random = createRandom((inputs.simulation.randomSeed ?? 0) + 1);
      return annualReturns.map((annualReturn) => decomposeAnnualReturn(random, annualReturn, subPeriodCount, inputs.assumptions.returnStdDev));
    })();
  return projectRetirementPlan(inputs, { annualReturns, subPeriodReturns });
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
  return Array.from(
    { length: yearCount },
    () => sampleAnnualReturn(random, targetMean, inputs.assumptions.returnStdDev, floor, ceiling),
  );
}

function returnBounds(inputs: RetirementInputs) {
  const floor = inputs.assumptions.returnFloor ?? -0.08;
  return { floor, ceiling: Math.max(floor, inputs.assumptions.returnCeiling ?? 0.15) };
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
