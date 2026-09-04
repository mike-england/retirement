import type { RetirementInputs } from "@/types/retirement";
import { defaultTaxSettings } from "@/lib/taxRules";

export const defaultRetirementInputs: RetirementInputs = {
  personalInfo: {
    label: "Primary person",
    currentAge: 50,
    targetDeathAge: 95,
    province: "BC",
    receivesCpp: true,
    cppPayoutRate: 0.6,
    receivesOas: true,
    additionalPeople: [],
  },
  incomeStreams: [
    {
      id: "employment-income",
      ownerId: "primary",
      label: "Employment income",
      annualAmount: 100_000,
      startAge: 50,
      endAge: 64,
      taxTreatment: "employment",
      indexationMode: "fullInflation",
    },
  ],
  existingAssets: {
    rrspBalance: 0,
    tfsaBalance: 0,
    nonRegisteredBalance: 0,
    nonRegisteredBookValue: 0,
    interestBearingBalance: 0,
    interestBearingTermYears: 1,
  },
  spendingPlan: {
    desiredAnnualSpending: 80_000,
    indexedToInflation: true,
    phases: [
      { id: "go-go", label: "Go-Go", startAge: 65, endAge: 74, annualSpending: 80_000 },
      { id: "slow-go", label: "Slow-Go", startAge: 75, endAge: 84, annualSpending: 60_000 },
      { id: "no-go", label: "No-Go", startAge: 85, endAge: 95, annualSpending: 50_000 },
    ],
  },
  assumptions: {
    returnMean: 0.05,
    returnStdDev: 0.12,
    returnFloor: -0.08,
    returnCeiling: 0.15,
    annualReturnOverrides: {},
    inflationMean: 0.02,
    inflationStdDev: 0.01,
  },
  taxSettings: structuredClone(defaultTaxSettings),
  strategy: {
    cppStartAge: 65,
    oasStartAge: 65,
    aggressiveRrspMeltdown: false,
    withdrawalOrder: ["interestBearing", "nonRegistered", "tfsa", "rrsp"],
  },
  simulation: {
    iterations: 1_000,
    randomSeed: 42,
    capitalGainsInclusionRate: 0.5,
    probateFeeRate: 0.015,
  },
};