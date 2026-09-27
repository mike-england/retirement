"use client";

import { BadgeDollarSign, BriefcaseBusiness, Check, Landmark, SlidersHorizontal, UsersRound, WalletCards } from "lucide-react";
import ReactECharts from "echarts-for-react";
import type { EChartsOption } from "echarts";
import { createPortal } from "react-dom";
import {
  Fragment,
  startTransition,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
} from "react";
import { defaultRetirementInputs } from "@/lib/default-inputs";
import packageJson from "../../package.json";
import { runMonteCarloSimulation } from "@/lib/monteCarlo";
import { sampleAnnualReturn } from "@/lib/simulationEngine";
import { projectWithVariableReturns } from "@/lib/projectionPath";
import {
  availableTaxYears,
  defaultTaxSettings,
  provinceNames,
} from "@/lib/taxRules";
import { ageYearLabel, maxHouseholdAge, monthYearLabel } from "@/lib/planDates";
import { calculateCppAnnualBenefit, cppAnnualMaximum } from "@/lib/governmentBenefits";
import { SimulationCharts } from "@/components/SimulationCharts";
import type {
  DeterministicProjection,
  ContributionSchedule,
  ExistingAssets,
  GicBufferSettings,
  GicFundingSource,
  GicHolding,
  GicMaturityAction,
  IncomeStream,
  ProvinceCode,
  RetirementInputs,
  SimulationOutput,
  SpendingPlan,
  TaxJurisdictionSettings,
  TaxRateBracket,
  TaxSettings,
  WithdrawalAccount,
  YearProjection,
} from "@/types/retirement";

const withdrawalAccountLabels: Record<WithdrawalAccount, string> = {
  interestBearing: "GIC / interest-bearing",
  nonRegistered: "Non-registered",
  tfsa: "TFSA",
  rrsp: "RRSP/RRIF",
};
const defaultWithdrawalOrder: WithdrawalAccount[] = ["interestBearing", "nonRegistered", "tfsa", "rrsp"];
const defaultGicBuffer: GicBufferSettings = {
  enabled: false,
  triggerDrawdown: 0.1,
  recoveryDrawdown: 0.03,
  refillFromSurplus: true,
};

const ledgerLeadColumns = ["Year", "Age", "Phase", "Return"];
const ledgerIncomeColumns = [
  "Employment/Pension",
  "CPP",
  "OAS",
  "RRSP/RRIF",
  "TFSA",
  "Non-reg",
  "GIC",
];
const ledgerTailColumns = [
  "Taxes paid",
  "RRSP start",
  "RRSP end",
  "TFSA start",
  "TFSA end",
  "Non-reg start",
  "Non-reg end",
  "GIC start",
  "GIC end",
  "Net cash",
  "Estate value",
];
const scenarioStorageKey = "retirement-planner.scenarios";

type SavedScenario = {
  id: string;
  name: string;
  inputs: RetirementInputs;
  updatedAt: string;
};

export default function Home() {
  const [inputs, setInputs] = useState(defaultRetirementInputs);
  const [activeView, setActiveView] = useState("Dashboard");
  const [activeInputTab, setActiveInputTab] = useState("People");
  const [projection, setProjection] = useState<DeterministicProjection | null>(
    null,
  );
  const [monteCarloOutput, setMonteCarloOutput] =
    useState<SimulationOutput | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [scenarios, setScenarios] = useState<SavedScenario[]>([]);
  const [activeScenarioId, setActiveScenarioId] = useState("draft");
  const [scenarioName, setScenarioName] = useState("New Scenario");
  const [justSaved, setJustSaved] = useState(false);
  const importInputRef = useRef<HTMLInputElement>(null);
  const gicBuffer = inputs.strategy.gicBuffer ?? defaultGicBuffer;
  const updateGicBuffer = (patch: Partial<GicBufferSettings>) =>
    setInputs((current) => ({
      ...current,
      strategy: { ...current.strategy, gicBuffer: { ...(current.strategy.gicBuffer ?? defaultGicBuffer), ...patch } },
    }));
  const startingGicBalance = deriveGicList(inputs.existingAssets, inputs.personalInfo.currentAge).reduce((sum, gic) => sum + gic.balance, 0)
    + (inputs.personalInfo.additionalPeople ?? []).reduce((sum, person) => sum + deriveGicList(person.existingAssets, person.currentAge).reduce((gicSum, gic) => gicSum + gic.balance, 0), 0);
  const averageInvestmentReturn = projection
    ? projection.years.reduce((sum, year) => sum + year.portfolioReturn, 0) /
      projection.years.length
    : 0;
  const shortfallYears = projection
    ? projection.years.filter(
        (year) => year.spendingTarget - year.netSpendableCash > 1,
      )
    : [];
  const totalUnmetSpending = shortfallYears.reduce(
    (sum, year) => sum + (year.spendingTarget - year.netSpendableCash),
    0,
  );
  const firstShortfallAge = shortfallYears[0]?.age;
  const lifetimeCpp = projection
    ? projection.years.reduce((sum, year) => sum + year.income.cpp, 0)
    : 0;
  const lifetimeOas = projection
    ? projection.years.reduce((sum, year) => sum + year.income.oas, 0)
    : 0;
  const endOfLifeTax = projection
    ? projection.years.reduce((sum, year) => sum + year.estateTax, 0)
    : 0;
  const kpis = projection
    ? [
        [
          firstShortfallAge === undefined ? "Spending goal" : "Funding gap",
          firstShortfallAge === undefined
            ? "Funded"
            : formatCurrency(totalUnmetSpending),
          firstShortfallAge === undefined
            ? "All requested spending is funded"
            : `First shortfall at age ${firstShortfallAge}`,
        ],
        [
          "Final estate",
          formatCurrency(projection.finalEstateValue),
          "After probate and final taxes",
        ],
        [
          "Lifetime tax",
          formatCurrency(projection.lifetimeTax),
          "Federal and provincial, including end-of-life tax",
        ],
        [
          "End-of-life tax",
          formatCurrency(endOfLifeTax),
          endOfLifeTax > 0 ? "One-time deemed-disposition bill, paid from the estate" : "No unrolled-over estate at the end of the plan",
        ],
        [
          "Average investment return",
          formatPercent(averageInvestmentReturn),
          "Annual generated path",
        ],
        ["Lifetime CPP", formatCurrency(lifetimeCpp), "All eligible people"],
        ["Lifetime OAS", formatCurrency(lifetimeOas), "All eligible people"],
        [
          "Portfolio peak age",
          `${projection.portfolioPeakAge}`,
          "Variable-return projection",
        ],
      ]
    : [
        ["Portfolio status", "--", "Variable-return projection"],
        ["Final estate", "--", "After probate and final taxes"],
        ["Lifetime tax", "--", "Federal and provincial"],
        ["End-of-life tax", "--", "One-time deemed-disposition bill"],
        ["Lifetime CPP", "--", "All eligible people"],
        ["Lifetime OAS", "--", "All eligible people"],
        ["Portfolio peak age", "--", "Variable-return projection"],
      ];

  function setNumber(path: string, value: string) {
    const numberValue = Number(value);
    if (!Number.isFinite(numberValue)) return;
    setInputs((current) => {
      const next = structuredClone(current);
      const [section, field] = path.split(".") as [keyof typeof next, string];
      Object.assign(next[section], { [field]: numberValue });
      if (path === "personalInfo.currentAge") {
        next.incomeStreams = next.incomeStreams.map((stream) => ({
          ...stream,
          startAge: Math.max(stream.startAge, numberValue),
        }));
        next.spendingPlan.phases = next.spendingPlan.phases.map((phase) => ({
          ...phase,
          startAge: Math.max(phase.startAge, numberValue),
        }));
      }
      return next;
    });
  }
  function generateReturns() {
    const nextSeed = Date.now() >>> 0;
    applyReturnSeed(nextSeed);
  }

  // Changing the underlying random-generation parameters invalidates any previously locked-in path (bulk-generated or
  // hand-edited), so the Ledger/Dashboard immediately reflect the new assumptions instead of staying frozen at old values.
  function setReturnAssumption(patch: Partial<RetirementInputs["assumptions"]>) {
    setInputs((current) => ({
      ...current,
      assumptions: { ...current.assumptions, ...patch, annualReturnOverrides: {} },
    }));
  }

  function applyReturnSeed(seed: number) {
    // Clearing overrides (rather than freezing every year's value) lets the Ledger keep regenerating live from the
    // seed whenever mean/std-dev/floor/ceiling change, instead of the whole path getting stuck at whatever it was
    // when this seed was picked. Any individual years you've hand-edited via the Ledger's Return cells still stick.
    setInputs((current) => ({
      ...current,
      assumptions: { ...current.assumptions, annualReturnOverrides: {} },
      simulation: { ...current.simulation, randomSeed: seed },
    }));
  }

  function persistScenarios(nextScenarios: SavedScenario[]) {
    setScenarios(nextScenarios);
    window.localStorage.setItem(
      scenarioStorageKey,
      JSON.stringify(nextScenarios),
    );
  }

  function createNewScenario() {
    setActiveScenarioId("draft");
    setScenarioName("New Scenario");
    setInputs(structuredClone(defaultRetirementInputs));
  }

  function saveScenario() {
    const existingScenario = scenarios.find(
      (scenario) => scenario.id === activeScenarioId,
    );
    const id = existingScenario?.id ?? `scenario-${Date.now()}`;
    const scenario: SavedScenario = {
      id,
      name:
        scenarioName.trim() ||
        existingScenario?.name ||
        `Scenario ${scenarios.length + 1}`,
      inputs: structuredClone(inputs),
      updatedAt: new Date().toISOString(),
    };
    persistScenarios(
      existingScenario
        ? scenarios.map((current) => (current.id === id ? scenario : current))
        : [...scenarios, scenario],
    );
    setActiveScenarioId(id);
    setScenarioName(scenario.name);
    setJustSaved(true);
    window.setTimeout(() => setJustSaved(false), 1800);
  }

  function renameSelectedScenario() {
    const name = scenarioName.trim();
    if (activeScenarioId === "draft" || !name) return;
    persistScenarios(
      scenarios.map((scenario) =>
        scenario.id === activeScenarioId
          ? { ...scenario, name, updatedAt: new Date().toISOString() }
          : scenario,
      ),
    );
    setScenarioName(name);
  }

  function loadScenario(id: string) {
    setActiveScenarioId(id);
    if (id === "draft") {
      setScenarioName("New Scenario");
      return;
    }
    const scenario = scenarios.find((current) => current.id === id);
    if (scenario && isRetirementInputs(scenario.inputs)) {
      setScenarioName(scenario.name);
      setInputs(structuredClone(scenario.inputs));
    } else if (scenario) {
      window.alert(
        `"${scenario.name}" uses an older data format and cannot be loaded. Delete it and create a new scenario.`,
      );
    }
  }

  function deleteScenario() {
    const scenario = scenarios.find(
      (current) => current.id === activeScenarioId,
    );
    if (!scenario || !window.confirm(`Delete ${scenario.name}?`)) return;
    persistScenarios(scenarios.filter((current) => current.id !== scenario.id));
    createNewScenario();
  }

  function deleteAllScenarios() {
    if (
      scenarios.length === 0 ||
      !window.confirm(`Delete all ${scenarios.length} saved scenarios?`)
    )
      return;
    persistScenarios([]);
    createNewScenario();
  }

  function exportScenario() {
    const activeScenario = scenarios.find(
      (scenario) => scenario.id === activeScenarioId,
    );
    const payload = JSON.stringify(
      {
        schemaVersion: 1,
        name: activeScenario?.name ?? "New Scenario",
        inputs,
      },
      null,
      2,
    );
    const downloadUrl = URL.createObjectURL(
      new Blob([payload], { type: "application/json" }),
    );
    const link = document.createElement("a");
    link.href = downloadUrl;
    link.download = `${(activeScenario?.name ?? "retirement-scenario").toLowerCase().replace(/[^a-z0-9]+/g, "-")}.json`;
    link.click();
    URL.revokeObjectURL(downloadUrl);
  }

  async function importScenario(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text()) as
        | { name?: string; inputs?: RetirementInputs }
        | RetirementInputs;
      const importedInputs = "inputs" in parsed ? parsed.inputs : parsed;
      if (!isRetirementInputs(importedInputs)) return;
      const importedScenario: SavedScenario = {
        id: `scenario-${Date.now()}`,
        name:
          "name" in parsed && parsed.name
            ? parsed.name
            : file.name.replace(/\.json$/i, ""),
        inputs: importedInputs,
        updatedAt: new Date().toISOString(),
      };
      persistScenarios([...scenarios, importedScenario]);
      setActiveScenarioId(importedScenario.id);
      setScenarioName(importedScenario.name);
      setInputs(structuredClone(importedScenario.inputs));
    } catch {
      return;
    }
  }

  useEffect(() => {
    try {
      const savedScenarios = JSON.parse(
        window.localStorage.getItem(scenarioStorageKey) ?? "[]",
      ) as SavedScenario[];
      if (Array.isArray(savedScenarios))
        setScenarios(savedScenarios);
    } catch {
      setScenarios([]);
    }
  }, []);

  useEffect(() => {
    setInputs((current) => {
      const missingBenefits = defaultRetirementInputs.incomeStreams.filter(
        (defaultStream) =>
          (defaultStream.taxTreatment === "cpp" ||
            defaultStream.taxTreatment === "oas") &&
          !current.incomeStreams.some(
            (stream) => stream.taxTreatment === defaultStream.taxTreatment,
          ),
      );
      return missingBenefits.length === 0
        ? current
        : {
            ...current,
            incomeStreams: [
              ...current.incomeStreams,
              ...structuredClone(missingBenefits),
            ],
          };
    });
  }, []);

  useEffect(() => {
    setProjection(null);
    const debounceTimer = window.setTimeout(() => {
      setIsRunning(true);
      const nextProjection = projectWithVariableReturns(inputs);
      startTransition(() => {
        setProjection(nextProjection);
        setIsRunning(false);
      });
    }, 400);

    return () => window.clearTimeout(debounceTimer);
  }, [inputs]);

  useEffect(() => {
    if (activeView !== "Monte Carlo") return;
    const simulationTimer = window.setTimeout(() => {
      setMonteCarloOutput(runMonteCarloSimulation(inputs));
    }, 0);
    return () => window.clearTimeout(simulationTimer);
  }, [activeView, inputs]);

  return (
    <main className="planner-shell">
      <header className="topbar">
        <div className="brand-mark" aria-hidden="true">
          RP
        </div>
        <strong>Retirement Planner <span className="app-version">v{packageJson.version}</span></strong>
        <div className="scenario-actions">
          <select
            aria-label="Scenario"
            value={activeScenarioId}
            onChange={(event) => loadScenario(event.target.value)}
          >
            <option value="draft">New Scenario</option>
            {scenarios.map((scenario) => (
              <option key={scenario.id} value={scenario.id}>
                {scenario.name}
              </option>
            ))}
          </select>
          <input
            className="scenario-name"
            aria-label="Scenario name"
            value={scenarioName}
            onChange={(event) => setScenarioName(event.target.value)}
            onBlur={renameSelectedScenario}
            placeholder="Scenario name"
          />
          <button className="button button-quiet" onClick={createNewScenario}>
            New
          </button>
          <button
            className={`button button-primary${justSaved ? " button-saved" : ""}`}
            onClick={saveScenario}
          >
            {justSaved ? (<><Check size={14} /> Saved</>) : "Save"}
          </button>
          <button
            className="button button-quiet"
            onClick={() => importInputRef.current?.click()}
          >
            Import
          </button>
          <button className="button button-quiet" onClick={exportScenario}>
            Export
          </button>
          <button
            className="button button-quiet"
            onClick={deleteScenario}
            disabled={activeScenarioId === "draft"}
          >
            Delete
          </button>
          <button
            className="button button-quiet button-delete-all"
            onClick={deleteAllScenarios}
            disabled={scenarios.length === 0}
          >
            Delete all
          </button>
          <input
            ref={importInputRef}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={importScenario}
          />
        </div>
      </header>
      <div className="planner-layout">
        <aside className="sidebar" aria-label="Planning inputs">
          <div className="sidebar-heading">
            <div>
              <p className="eyebrow">Planning inputs</p>
              <h1>Canadian retirement plan</h1>
            </div>
            <span className="status-dot" title="Inputs are ready" />
          </div>
          <nav className="input-tabs" aria-label="Planning input sections">
            {(
              [
                ["People", UsersRound],
                ["Income", BriefcaseBusiness],
                ["Contributions", WalletCards],
                ["Accounts", WalletCards],
                ["Spending", BadgeDollarSign],
                ["Assumptions", SlidersHorizontal],
                ["Strategy", Landmark],
              ] satisfies [string, typeof UsersRound][]
            ).map(([tab, Icon]) => (
              <button key={tab} className={activeInputTab === tab ? "active" : ""} onClick={() => setActiveInputTab(tab)}><Icon size={13} strokeWidth={1.8} /><span>{tab}</span></button>
            ))}
          </nav>
          <div hidden={activeInputTab !== "People"}>
          <section className="input-section">
            <div className="section-title-row">
              <h2>Personal info</h2>
              <button
                type="button"
                className="text-button"
                onClick={() =>
                  setInputs((current) => ({
                    ...current,
                    personalInfo: {
                      ...current.personalInfo,
                      additionalPeople: [
                        ...(current.personalInfo.additionalPeople ?? []),
                        {
                          id: `person-${Date.now()}`,
                          label: "Person",
                          currentAge: current.personalInfo.currentAge,
                          targetDeathAge: current.personalInfo.targetDeathAge,
                          receivesCpp: true,
                          cppPayoutRate: 0.6,
                          receivesOas: true,
                        },
                      ],
                    },
                  }))
                }
              >
                Add person
              </button>
            </div>
            <div className="person-card person-card--primary">
              {(inputs.personalInfo.additionalPeople ?? []).length > 0 && (
                <div className="person-actions">
                  <button
                    type="button"
                    className="text-button"
                    onClick={() =>
                      setInputs((current) => {
                        const [nextPrimary, ...remainingPeople] =
                          current.personalInfo.additionalPeople ?? [];
                        return {
                          ...current,
                          personalInfo: {
                            ...current.personalInfo,
                            label: nextPrimary.label,
                            currentAge: nextPrimary.currentAge,
                            targetDeathAge: nextPrimary.targetDeathAge,
                            receivesCpp: nextPrimary.receivesCpp,
                            receivesOas: nextPrimary.receivesOas,
                            additionalPeople: remainingPeople,
                          },
                        };
                      })
                    }
                  >
                    Remove
                  </button>
                </div>
              )}
              <label className="field-label">
                Name
                <input
                  value={inputs.personalInfo.label ?? "Primary person"}
                  onChange={(event) =>
                    setInputs((current) => ({
                      ...current,
                      personalInfo: {
                        ...current.personalInfo,
                        label: event.target.value,
                      },
                    }))
                  }
                />
              </label>
              <div className="field-grid two-up">
                <NumberField
                  label="Current age"
                  value={inputs.personalInfo.currentAge}
                  onChange={(value) =>
                    setNumber("personalInfo.currentAge", value)
                  }
                />
                <NumberField
                  label="Death age"
                  value={inputs.personalInfo.targetDeathAge}
                  tooltip={`Dies ${monthYearLabel(inputs.personalInfo, inputs.personalInfo.targetDeathAge)}`}
                  onChange={(value) =>
                    setNumber("personalInfo.targetDeathAge", value)
                  }
                />
              </div>
              <div className="field-label-shell">
                <MonthSelect
                  value={inputs.personalInfo.birthMonth}
                  onChange={(value) => setInputs((current) => ({ ...current, personalInfo: { ...current.personalInfo, birthMonth: value } }))}
                />
              </div>
              <label className="field-label">
                Province
                <select
                  value={inputs.personalInfo.province}
                  onChange={(event) =>
                    setInputs((current) => ({
                      ...current,
                      personalInfo: {
                        ...current.personalInfo,
                        province: event.target
                          .value as typeof current.personalInfo.province,
                      },
                    }))
                  }
                >
                  {Object.entries(provinceNames).map(([code, name]) => (
                    <option key={code} value={code}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
              <div className="benefit-toggles">
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={inputs.personalInfo.receivesCpp ?? true}
                    onChange={(event) =>
                      setInputs((current) => ({
                        ...current,
                        personalInfo: {
                          ...current.personalInfo,
                          receivesCpp: event.target.checked,
                        },
                      }))
                    }
                  />{" "}
                  CPP
                </label>
                <NumberField
                  label="CPP payout"
                  min={0}
                  step={1}
                  suffix="%"
                  tooltip={`At ${inputs.strategy.cppStartAge}, ${formatCurrency(calculateCppAnnualBenefit(cppAnnualMaximum * (inputs.personalInfo.cppPayoutRate ?? 0.6), inputs.strategy.cppStartAge))} per year before tax, based on the current maximum CPP and this payout percentage.`}
                  value={oneDecimalPercent(inputs.personalInfo.cppPayoutRate ?? 0.6)}
                  onChange={(value) =>
                    setInputs((current) => ({
                      ...current,
                      personalInfo: {
                        ...current.personalInfo,
                        cppPayoutRate: Math.max(0, Number(value) / 100),
                      },
                    }))
                  }
                />
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={inputs.personalInfo.receivesOas ?? true}
                    onChange={(event) =>
                      setInputs((current) => ({
                        ...current,
                        personalInfo: {
                          ...current.personalInfo,
                          receivesOas: event.target.checked,
                        },
                      }))
                    }
                  />{" "}
                  OAS
                </label>
              </div>
            </div>
            {(inputs.personalInfo.additionalPeople ?? []).map((person) => (
              <div className="person-card" key={person.id}>
                <div className="person-actions">
                  <button
                    type="button"
                    className="text-button"
                    onClick={() =>
                      setInputs((current) => ({
                        ...current,
                        personalInfo: {
                          ...current.personalInfo,
                          additionalPeople: (
                            current.personalInfo.additionalPeople ?? []
                          ).filter((candidate) => candidate.id !== person.id),
                        },
                      }))
                    }
                  >
                    Remove
                  </button>
                </div>
                <label className="field-label">
                  Name
                  <input
                    value={person.label}
                    onChange={(event) =>
                      setInputs((current) => ({
                        ...current,
                        personalInfo: {
                          ...current.personalInfo,
                          additionalPeople: (
                            current.personalInfo.additionalPeople ?? []
                          ).map((candidate) =>
                            candidate.id === person.id
                              ? { ...candidate, label: event.target.value }
                              : candidate,
                          ),
                        },
                      }))
                    }
                  />
                </label>
                <div className="field-grid two-up">
                  <NumberField
                    label="Current age"
                    value={person.currentAge}
                    onChange={(value) =>
                      setInputs((current) => ({
                        ...current,
                        personalInfo: {
                          ...current.personalInfo,
                          additionalPeople: (
                            current.personalInfo.additionalPeople ?? []
                          ).map((candidate) =>
                            candidate.id === person.id
                              ? { ...candidate, currentAge: Number(value) }
                              : candidate,
                          ),
                        },
                      }))
                    }
                  />
                  <NumberField
                    label="Death age"
                    value={person.targetDeathAge}
                    tooltip={`Dies ${monthYearLabel(person, person.targetDeathAge)}`}
                    onChange={(value) =>
                      setInputs((current) => ({
                        ...current,
                        personalInfo: {
                          ...current.personalInfo,
                          additionalPeople: (
                            current.personalInfo.additionalPeople ?? []
                          ).map((candidate) =>
                            candidate.id === person.id
                              ? { ...candidate, targetDeathAge: Number(value) }
                              : candidate,
                          ),
                        },
                      }))
                    }
                  />
                </div>
                <div className="field-label-shell">
                  <MonthSelect
                    value={person.birthMonth}
                    onChange={(value) => setInputs((current) => ({
                      ...current,
                      personalInfo: {
                        ...current.personalInfo,
                        additionalPeople: (current.personalInfo.additionalPeople ?? []).map((candidate) => candidate.id === person.id ? { ...candidate, birthMonth: value } : candidate),
                      },
                    }))}
                  />
                </div>
                <div className="benefit-toggles">
                  <label className="check-row">
                    <input
                      type="checkbox"
                      checked={person.receivesCpp ?? true}
                      onChange={(event) =>
                        setInputs((current) => ({
                          ...current,
                          personalInfo: {
                            ...current.personalInfo,
                            additionalPeople: (
                              current.personalInfo.additionalPeople ?? []
                            ).map((candidate) =>
                              candidate.id === person.id
                                ? {
                                    ...candidate,
                                    receivesCpp: event.target.checked,
                                  }
                                : candidate,
                            ),
                          },
                        }))
                      }
                    />{" "}
                    CPP
                  </label>
                  <NumberField
                    label="CPP payout"
                    min={0}
                    step={1}
                    suffix="%"
                      tooltip={`At ${inputs.strategy.cppStartAge}, ${formatCurrency(calculateCppAnnualBenefit(cppAnnualMaximum * (person.cppPayoutRate ?? 0.6), inputs.strategy.cppStartAge))} per year before tax, based on the current maximum CPP and this payout percentage.`}
                    value={oneDecimalPercent(person.cppPayoutRate ?? 0.6)}
                    onChange={(value) =>
                      setInputs((current) => ({
                        ...current,
                        personalInfo: {
                          ...current.personalInfo,
                          additionalPeople: (
                            current.personalInfo.additionalPeople ?? []
                          ).map((candidate) =>
                            candidate.id === person.id
                              ? {
                                  ...candidate,
                                  cppPayoutRate: Math.max(
                                    0,
                                    Number(value) / 100,
                                  ),
                                }
                              : candidate,
                          ),
                        },
                      }))
                    }
                  />
                  <label className="check-row">
                    <input
                      type="checkbox"
                      checked={person.receivesOas ?? true}
                      onChange={(event) =>
                        setInputs((current) => ({
                          ...current,
                          personalInfo: {
                            ...current.personalInfo,
                            additionalPeople: (
                              current.personalInfo.additionalPeople ?? []
                            ).map((candidate) =>
                              candidate.id === person.id
                                ? {
                                    ...candidate,
                                    receivesOas: event.target.checked,
                                  }
                                : candidate,
                            ),
                          },
                        }))
                      }
                    />{" "}
                    OAS
                  </label>
                </div>
              </div>
            ))}
          </section>
          </div>
          <div hidden={activeInputTab !== "Income"}>
          <IncomeStreamsEditor
            streams={inputs.incomeStreams}
            minimumAge={inputs.personalInfo.currentAge}
            targetDeathAge={inputs.personalInfo.targetDeathAge}
            personalInfo={inputs.personalInfo}
            people={[
              { id: "primary", label: inputs.personalInfo.label ?? "Primary person", currentAge: inputs.personalInfo.currentAge },
              ...(inputs.personalInfo.additionalPeople ?? []).map((person) => ({
                id: person.id,
                label: person.label,
                currentAge: person.currentAge,
              })),
            ]}
            onChange={(incomeStreams) =>
              setInputs((current) => ({ ...current, incomeStreams }))
            }
          />
          </div>
          <div hidden={activeInputTab !== "Contributions"}>
          <ContributionSchedulesEditor
            schedules={inputs.contributionSchedules}
            people={[
              { id: "primary", label: inputs.personalInfo.label ?? "Primary person", currentAge: inputs.personalInfo.currentAge },
              ...(inputs.personalInfo.additionalPeople ?? []).map((person) => ({ id: person.id, label: person.label, currentAge: person.currentAge })),
            ]}
            onChange={(contributionSchedules) => setInputs((current) => ({ ...current, contributionSchedules }))}
          />
          </div>
          <div hidden={activeInputTab !== "Accounts"}>
          <section className="input-section">
            <h2>
              {(inputs.personalInfo.additionalPeople ?? []).length > 0
                ? `${inputs.personalInfo.label || "Primary person"}'s accounts`
                : "Existing assets"}
            </h2>
            <div className="field-grid two-up">
              <NumberField
                label="RRSP / RRIF"
                prefix="$"
                value={inputs.existingAssets.rrspBalance}
                onChange={(value) =>
                  setNumber("existingAssets.rrspBalance", value)
                }
              />
              <NumberField
                label="TFSA"
                prefix="$"
                value={inputs.existingAssets.tfsaBalance}
                onChange={(value) =>
                  setNumber("existingAssets.tfsaBalance", value)
                }
              />
              <NumberField
                label="Non-registered"
                prefix="$"
                value={inputs.existingAssets.nonRegisteredBalance}
                onChange={(value) =>
                  setNumber("existingAssets.nonRegisteredBalance", value)
                }
              />
              <NumberField
                label={
                  <span title="Adjusted cost base is what you originally paid for the non-registered investments, including eligible purchase costs. The amount above it is the unrealized capital gain.">
                    Adjusted cost base
                  </span>
                }
                prefix="$"
                value={inputs.existingAssets.nonRegisteredBookValue}
                onChange={(value) =>
                  setNumber("existingAssets.nonRegisteredBookValue", value)
                }
              />
            </div>
            <div className="field-label-text gic-section-heading">
              <span>GICs / interest-bearing holdings</span>
              <FieldHint text="Guaranteed Investment Certificates, Principal Protected Notes, and similar interest-bearing holdings. Add as many as you like, each with its own start age, term, rate, funding source, and maturity behavior - e.g. a laddered set of GICs, or one starting partway through retirement." />
            </div>
            <GicListEditor
              gics={deriveGicList(inputs.existingAssets, inputs.personalInfo.currentAge)}
              currentAge={inputs.personalInfo.currentAge}
              onChange={(gics) =>
                setInputs((current) => ({
                  ...current,
                  existingAssets: { ...current.existingAssets, gics },
                }))
              }
            />
          </section>
          {(inputs.personalInfo.additionalPeople ?? []).map((person) => {
            const assets = person.existingAssets ?? {
              rrspBalance: 0,
              tfsaBalance: 0,
              nonRegisteredBalance: 0,
              nonRegisteredBookValue: 0,
              interestBearingBalance: 0,
              interestBearingTermYears: 1,
              interestBearingRate: inputs.assumptions.returnMean,
            };
            const updateAssets = (changes: Partial<typeof assets>) =>
              setInputs((current) => ({
                ...current,
                personalInfo: {
                  ...current.personalInfo,
                  additionalPeople: (
                    current.personalInfo.additionalPeople ?? []
                  ).map((candidate) =>
                    candidate.id === person.id
                      ? { ...candidate, existingAssets: { ...assets, ...changes } }
                      : candidate,
                  ),
                },
              }));
            return (
              <section className="input-section" key={person.id}>
                <h2>{person.label || "Person"}&apos;s accounts</h2>
                <div className="field-grid two-up">
                  <NumberField
                    label="RRSP / RRIF"
                    prefix="$"
                    value={assets.rrspBalance}
                    onChange={(value) => updateAssets({ rrspBalance: Number(value) })}
                  />
                  <NumberField
                    label="TFSA"
                    prefix="$"
                    value={assets.tfsaBalance}
                    onChange={(value) => updateAssets({ tfsaBalance: Number(value) })}
                  />
                  <NumberField
                    label="Non-registered"
                    prefix="$"
                    value={assets.nonRegisteredBalance}
                    onChange={(value) => updateAssets({ nonRegisteredBalance: Number(value) })}
                  />
                  <NumberField
                    label={
                      <span title="Adjusted cost base is what this person originally paid for their non-registered investments, including eligible purchase costs. The amount above it is the unrealized capital gain.">
                        Adjusted cost base
                      </span>
                    }
                    prefix="$"
                    value={assets.nonRegisteredBookValue}
                    onChange={(value) => updateAssets({ nonRegisteredBookValue: Number(value) })}
                  />
                </div>
                <div className="field-label-text gic-section-heading">
                  <span>GICs / interest-bearing holdings</span>
                  <FieldHint text="Guaranteed Investment Certificates, Principal Protected Notes, and similar interest-bearing holdings. Add as many as you like, each with its own start age, term, rate, funding source, and maturity behavior." />
                </div>
                <GicListEditor
                  gics={deriveGicList(assets, person.currentAge)}
                  currentAge={person.currentAge}
                  onChange={(gics) => updateAssets({ gics })}
                />
              </section>
            );
          })}
          </div>
          <div hidden={activeInputTab !== "Spending"}>
          <SpendingPlanEditor
            spendingPlan={inputs.spendingPlan}
            minimumAge={inputs.personalInfo.currentAge}
            personalInfo={inputs.personalInfo}
            onChange={(spendingPlan) =>
              setInputs((current) => ({ ...current, spendingPlan }))
            }
          />
          </div>
          <div hidden={activeInputTab !== "Assumptions"}>
          <section className="input-section">
            <h2>Assumptions</h2>
            <div className="field-grid two-up">
              <NumberField
                label="Return mean"
                step={0.1}
                suffix="%"
                value={oneDecimalPercent(inputs.assumptions.returnMean)}
                tooltip="Average annual investment return. It sets the single randomized path used on the Dashboard/Ledger, and is the value Monte Carlo centers every run's randomized returns on — raising it improves most outcomes and the success rate."
                onChange={(value) =>
                  setReturnAssumption({ returnMean: Number(value) / 100 })
                }
              />
              <NumberField
                label="Return StdDev"
                min={0}
                step={0.1}
                suffix="%"
                value={oneDecimalPercent(inputs.assumptions.returnStdDev)}
                tooltip="How much annual returns vary year to year, for both the Dashboard/Ledger's single path and every Monte Carlo run. Higher values widen the spread between Monte Carlo runs — more very good and very bad sequences of returns, which increases the chance of an early bad stretch depleting the portfolio."
                onChange={(value) =>
                  setReturnAssumption({ returnStdDev: Math.max(0, Number(value)) / 100 })
                }
              />
              <NumberField
                label="Return floor"
                step={0.1}
                suffix="%"
                value={oneDecimalPercent(
                  inputs.assumptions.returnFloor ?? -0.08,
                )}
                tooltip="The worst single-year return any randomized path can draw, on the Dashboard/Ledger and in Monte Carlo alike. Returns below this are resampled, so it caps how bad any one simulated year can be."
                onChange={(value) =>
                  setReturnAssumption({
                    returnFloor: Math.min(
                      Number(value) / 100,
                      inputs.assumptions.returnCeiling ?? 0.15,
                    ),
                  })
                }
              />
              <NumberField
                label="Return cap"
                step={0.1}
                suffix="%"
                value={oneDecimalPercent(
                  inputs.assumptions.returnCeiling ?? 0.15,
                )}
                tooltip="The best single-year return any randomized path can draw, on the Dashboard/Ledger and in Monte Carlo alike. Returns above this are resampled, so it caps how good any one simulated year can be."
                onChange={(value) =>
                  setReturnAssumption({
                    returnCeiling: Math.max(
                      Number(value) / 100,
                      inputs.assumptions.returnFloor ?? -0.08,
                    ),
                  })
                }
              />
              <NumberField
                label="Inflation mean"
                min={0}
                step={0.1}
                suffix="%"
                value={oneDecimalPercent(inputs.assumptions.inflationMean)}
                tooltip="Average annual inflation, used to grow spending targets and index income streams across the Dashboard/Ledger and every Monte Carlo run. Higher inflation raises required spending and drains the portfolio faster."
                onChange={(value) =>
                  setNumber(
                    "assumptions.inflationMean",
                    String(Math.max(0, Number(value)) / 100),
                  )
                }
              />
              <NumberField
                label="Inflation StdDev"
                min={0}
                step={0.1}
                suffix="%"
                value={oneDecimalPercent(inputs.assumptions.inflationStdDev)}
                tooltip="How much annual inflation varies year to year, on the Dashboard/Ledger's single path and across Monte Carlo runs. Higher values add another source of randomness that can compound with poor returns to deplete the portfolio faster."
                onChange={(value) =>
                  setNumber(
                    "assumptions.inflationStdDev",
                    String(Math.max(0, Number(value)) / 100),
                  )
                }
              />
              <NumberField
                label="Random seed"
                min={0}
                value={inputs.simulation.randomSeed ?? 42}
                tooltip="Seeds the Dashboard's single randomized return path so it's reproducible. Monte Carlo uses this same seed to start its own independent sequence of random draws across all simulated runs."
                onChange={(value) => {
                  const seed = Number(value);
                  if (Number.isFinite(seed) && seed >= 0) applyReturnSeed(seed);
                }}
              />
            </div>
            {activeInputTab === "Assumptions" && (
              <ReturnDistributionPreview
                mean={inputs.assumptions.returnMean}
                stdDev={inputs.assumptions.returnStdDev}
                floor={inputs.assumptions.returnFloor ?? -0.08}
                ceiling={inputs.assumptions.returnCeiling ?? 0.15}
              />
            )}
            <p className="section-note">
              These drive both the Dashboard&apos;s single projected path and
              every run of the Monte Carlo simulation. Monte Carlo draws a
              random annual return and inflation rate for each year of each
              run from the mean/StdDev below, clamped to the floor/cap, then
              reports how many of those randomized futures avoid running out
              of money.
            </p>
          </section>
          </div>
          <div hidden={activeInputTab !== "Strategy"}>
          <section className="input-section">
            <h2>Withdrawal strategy</h2>
            <div className="field-grid two-up benefit-start-ages">
              <AgeSelect
                label="CPP start age"
                value={inputs.strategy.cppStartAge}
                tooltip={`Starts ${monthYearLabel(inputs.personalInfo, inputs.strategy.cppStartAge)} for the primary person.`}
                onChange={(value) =>
                  setInputs((current) => ({
                    ...current,
                    strategy: { ...current.strategy, cppStartAge: value },
                  }))
                }
              />
              <AgeSelect
                label="OAS start age"
                value={inputs.strategy.oasStartAge}
                tooltip={`Starts ${monthYearLabel(inputs.personalInfo, inputs.strategy.oasStartAge)} for the primary person.`}
                onChange={(value) =>
                  setInputs((current) => ({
                    ...current,
                    strategy: { ...current.strategy, oasStartAge: value },
                  }))
                }
              />
            </div>
            <div className="field-label-text">
              <span>Withdrawal order</span>
              <FieldHint text="Which account gets drawn down first to cover each year's spending shortfall, once income and mandatory RRIF minimums aren't enough. Move an account up to spend it down sooner, or down to preserve it longer (e.g. for estate planning)." />
            </div>
            <ol className="withdrawal-order-list">
              {(inputs.strategy.withdrawalOrder ?? defaultWithdrawalOrder).map((account, index) => (
                <li key={account}>
                  <span>{withdrawalAccountLabels[account]}</span>
                  <span className="withdrawal-order-actions">
                    <button
                      type="button"
                      className="button button-quiet"
                      disabled={index === 0}
                      onClick={() =>
                        setInputs((current) => {
                          const order = [...(current.strategy.withdrawalOrder ?? defaultWithdrawalOrder)];
                          [order[index - 1], order[index]] = [order[index], order[index - 1]];
                          return { ...current, strategy: { ...current.strategy, withdrawalOrder: order } };
                        })
                      }
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="button button-quiet"
                      disabled={index === (inputs.strategy.withdrawalOrder ?? defaultWithdrawalOrder).length - 1}
                      onClick={() =>
                        setInputs((current) => {
                          const order = [...(current.strategy.withdrawalOrder ?? defaultWithdrawalOrder)];
                          [order[index + 1], order[index]] = [order[index], order[index + 1]];
                          return { ...current, strategy: { ...current.strategy, withdrawalOrder: order } };
                        })
                      }
                    >
                      ↓
                    </button>
                  </span>
                </li>
              ))}
            </ol>
            <label className="field-label">
              <span className="field-label-text">
                Withdrawal frequency
                <FieldHint text="How often the withdrawal waterfall runs against realized returns, instead of one lump annual withdrawal. Monthly/quarterly/semi-annual also apply randomized within-year return variation on the Dashboard/Ledger and in Monte Carlo, so a down stretch isn't sold from as if the whole year were flat." />
              </span>
              <select
                value={inputs.strategy.withdrawalFrequency ?? "annual"}
                onChange={(event) =>
                  setInputs((current) => ({
                    ...current,
                    strategy: {
                      ...current.strategy,
                      withdrawalFrequency: event.target.value as typeof current.strategy.withdrawalFrequency,
                    },
                  }))
                }
              >
                <option value="annual">Annual</option>
                <option value="semiAnnual">Semi-annual</option>
                <option value="quarterly">Quarterly</option>
                <option value="monthly">Monthly</option>
              </select>
            </label>
            <label className="check-row emphasis">
              <input
                type="checkbox"
                checked={inputs.strategy.aggressiveRrspMeltdown}
                onChange={(event) =>
                  setInputs((current) => ({
                    ...current,
                    strategy: {
                      ...current.strategy,
                      aggressiveRrspMeltdown: event.target.checked,
                    },
                  }))
                }
              />{" "}
              Aggressive RRSP meltdown
            </label>
          </section>
          <section className="input-section">
            <div className="field-label-text">
              <h2 style={{ display: "inline" }}>GIC buffer strategy</h2>
              <FieldHint text="Instead of always drawing the GIC in a fixed order position, hold it in reserve while the market's own return (isolated from your withdrawals) is near its peak, and draw it first once the market is down significantly from that peak - so you're not selling depressed investments to fund spending. Once the market recovers, it stops drawing the GIC and (optionally) tops it back up from any leftover cash." />
            </div>
            <label className="check-row emphasis">
              <input
                type="checkbox"
                checked={gicBuffer.enabled}
                onChange={(event) => updateGicBuffer({ enabled: event.target.checked })}
              />{" "}
              Reserve the GIC for down markets
            </label>
            {gicBuffer.enabled && (
              <>
                <div className="field-grid two-up">
                  <NumberField
                    label="Draw trigger"
                    suffix="%"
                    step={1}
                    tooltip="How far the market portfolio (RRSP+TFSA+non-registered) has to fall from its highest-ever value before the GIC starts being drawn first. A single bad year rarely justifies this; 10-15% (a real correction, not just noise) is a reasonable starting point."
                    value={oneDecimalPercent(gicBuffer.triggerDrawdown)}
                    onChange={(value) => updateGicBuffer({ triggerDrawdown: Number(value) / 100 })}
                  />
                  <NumberField
                    label="Recovery threshold"
                    suffix="%"
                    step={1}
                    tooltip="Once drawing the GIC, the market has to recover back to within this % of its old peak before the GIC reverts to being reserved (and refilled, if enabled). Keep this lower than the draw trigger, or it'll flip back and forth every year."
                    value={oneDecimalPercent(gicBuffer.recoveryDrawdown)}
                    onChange={(value) => updateGicBuffer({ recoveryDrawdown: Number(value) / 100 })}
                  />
                </div>
                <label className="check-row emphasis">
                  <input
                    type="checkbox"
                    checked={gicBuffer.refillFromSurplus}
                    onChange={(event) => updateGicBuffer({ refillFromSurplus: event.target.checked })}
                  />{" "}
                  Refill the GIC from leftover cash once the market recovers
                </label>
                {gicBuffer.refillFromSurplus && (
                  <NumberField
                    label="Refill target balance"
                    prefix="$"
                    tooltip="Balance to top the GIC back up toward using leftover cash (e.g. RRIF minimums exceeding spending need) while reserved. Defaults to the household's combined starting GIC balance if left blank."
                    value={gicBuffer.targetBalance ?? startingGicBalance}
                    onChange={(value) => updateGicBuffer({ targetBalance: Number(value) })}
                  />
                )}
              </>
            )}
          </section>
          </div>
        </aside>
        <section className="workspace">
          <nav className="view-tabs" aria-label="Workspace views">
            {["Dashboard", "Ledger", "Monte Carlo", "Compare", "Tax Info", "Guide"].map(
              (view) => (
                <button
                  key={view}
                  className={activeView === view ? "active" : ""}
                  onClick={() => setActiveView(view)}
                >
                  {view}
                </button>
              ),
            )}
          </nav>
          <div className="workspace-heading">
            <div>
              <p className="eyebrow">{activeView}</p>
              <h2>
                {activeView === "Dashboard"
                  ? "Plan overview"
                  : activeView === "Ledger"
                    ? "Year-by-year ledger"
                    : activeView === "Monte Carlo"
                      ? "Monte Carlo simulation"
                      : activeView === "Compare"
                        ? "Scenario comparison"
                        : activeView === "Guide"
                          ? "How this tool works"
                          : "Tax information"}
              </h2>
              <p>
                {activeView === "Tax Info"
                  ? `Editable ${inputs.taxSettings.taxYear} tax rules from ${inputs.taxSettings.source}.`
                  : activeView === "Guide"
                    ? "Plain-language notes on every input and assumption in the planner."
                    : activeView === "Monte Carlo"
                      ? "Randomized outcomes for risk testing."
                      : isRunning
                        ? "Updating projection..."
                        : projection
                          ? "Variable-return projection is ready for review."
                          : "Projection will run automatically."}
              </p>
            </div>
          </div>
          {activeView === "Dashboard" && (
            <DashboardView
              kpis={kpis}
              inputs={inputs}
              projection={projection}
            />
          )}
          {activeView === "Ledger" && (
            <LedgerView
              inputs={inputs}
              projection={projection}
              onGenerateReturns={generateReturns}
              onReturnChange={(age, rate) =>
                setInputs((current) => ({
                  ...current,
                  assumptions: {
                    ...current.assumptions,
                    annualReturnOverrides: {
                      ...current.assumptions.annualReturnOverrides,
                      [age]: rate,
                    },
                  },
                }))
              }
            />
          )}
          {activeView === "Monte Carlo" && (
            <MonteCarloView simulationOutput={monteCarloOutput} />
          )}
          {activeView === "Compare" && (
            <CompareView
              scenarios={scenarios}
              draftInputs={inputs}
              draftProjection={projection}
            />
          )}
          {activeView === "Tax Info" && (
            <TaxInformationView
              taxSettings={inputs.taxSettings}
              province={inputs.personalInfo.province}
              onChange={(taxSettings) =>
                setInputs((current) => ({ ...current, taxSettings }))
              }
              onReset={() =>
                setInputs((current) => ({
                  ...current,
                  taxSettings: structuredClone(defaultTaxSettings),
                }))
              }
            />
          )}
          {activeView === "Guide" && <GuideView />}
        </section>
      </div>
    </main>
  );
}

const gicFundingSourceLabels: Record<GicFundingSource, string> = {
  external: "Legacy existing holding",
  registered: "Registered (RRSP/RRIF)",
  nonRegistered: "Non-registered",
};
const gicMaturityActionLabels: Record<GicMaturityAction, string> = {
  renew: "Auto-renew (ladder)",
  cashOut: "Cash out to non-registered",
};

// Existing scenarios only have the legacy single-GIC fields; this presents that as one editable list entry until the
// user actually saves a `gics` array, at which point it takes over.
function deriveGicList(assets: ExistingAssets | undefined, currentAge: number): GicHolding[] {
  if (assets?.gics && assets.gics.length > 0) {
    return assets.gics.map((gic) =>
      gic.fundingSource === "external"
        ? { ...gic, fundingSource: "nonRegistered" }
        : gic,
    );
  }
  const legacyBalance = assets?.interestBearingBalance ?? 0;
  if (legacyBalance <= 0) return [];
  return [{
    id: "legacy",
    label: "GIC",
    balance: legacyBalance,
    rate: assets?.interestBearingRate ?? 0.05,
    termYears: assets?.interestBearingTermYears ?? 1,
    startAge: currentAge,
    fundingSource: "external",
    maturityAction: "renew",
  }];
}

function GicListEditor({
  gics,
  currentAge,
  onChange,
}: {
  gics: GicHolding[];
  currentAge: number;
  onChange: (gics: GicHolding[]) => void;
}) {
  const updateGic = (id: string, patch: Partial<GicHolding>) =>
    onChange(gics.map((gic) => (gic.id === id ? { ...gic, ...patch } : gic)));
  const removeGic = (id: string) => onChange(gics.filter((gic) => gic.id !== id));
  const addGic = () =>
    onChange([
      ...gics,
      {
        id: `gic-${Date.now()}`,
        label: `GIC ${gics.length + 1}`,
        balance: 0,
        rate: 0.05,
        termYears: 1,
        startAge: currentAge,
        fundingSource: "nonRegistered",
        maturityAction: "renew",
      },
    ]);

  return (
    <div className="gic-list">
      {gics.map((gic) => (
        <div className="gic-card" key={gic.id}>
          <div className="gic-card-heading">
            <input
              className="gic-label-input"
              type="text"
              value={gic.label ?? ""}
              placeholder="GIC label"
              onChange={(event) => updateGic(gic.id, { label: event.target.value })}
            />
            <button type="button" className="button button-quiet" onClick={() => removeGic(gic.id)}>
              Remove
            </button>
          </div>
          <div className="field-grid two-up">
            <NumberField
              label="Balance"
              prefix="$"
              value={gic.balance}
              onChange={(value) => updateGic(gic.id, { balance: Number(value) })}
            />
            <NumberField
              label="Rate"
              suffix="%"
              step={0.1}
              tooltip="The guaranteed TOTAL return for the whole term (e.g. '5% for a 2-year GIC' means 5% over those 2 years, not per year). Compounded into an equivalent annual rate internally and never randomized in Monte Carlo."
              value={oneDecimalPercent(gic.rate)}
              onChange={(value) => updateGic(gic.id, { rate: Number(value) / 100 })}
            />
            <NumberField
              label="Term (years)"
              min={1}
              step={1}
              tooltip="How many years this GIC compounds before it matures. Withdrawing early still realizes a proportional share of the deferred growth for tax purposes that year."
              value={gic.termYears}
              onChange={(value) => updateGic(gic.id, { termYears: Math.max(1, Math.round(Number(value))) })}
            />
            <NumberField
              label="Start age"
              min={currentAge}
              step={1}
              tooltip="Age at which this GIC's balance becomes active. Set to the current age for a GIC already held today; set it later to model a GIC starting partway through retirement."
              value={gic.startAge}
              onChange={(value) => updateGic(gic.id, { startAge: Math.round(Number(value)) })}
            />
            <label className="field-label">
              <span className="field-label-text">
                Account type
                <FieldHint text="The account type determines whether GIC interest is taxable. The balance is entered separately and is not deducted from the RRSP, RRIF, or non-registered balance." />
              </span>
              <select
                value={gic.fundingSource}
                onChange={(event) => updateGic(gic.id, { fundingSource: event.target.value as GicFundingSource })}
              >
                {(Object.keys(gicFundingSourceLabels) as GicFundingSource[]).filter((source) => source !== "external").map((source) => (
                  <option key={source} value={source}>{gicFundingSourceLabels[source]}</option>
                ))}
              </select>
            </label>
            <label className="field-label">
              <span className="field-label-text">
                At maturity
                <FieldHint text="'Auto-renew' starts an identical new term immediately, indefinitely (a true ladder). 'Cash out' moves the matured proceeds into the non-registered account instead of continuing." />
              </span>
              <select
                value={gic.maturityAction}
                onChange={(event) => updateGic(gic.id, { maturityAction: event.target.value as GicMaturityAction })}
              >
                {(Object.keys(gicMaturityActionLabels) as GicMaturityAction[]).map((action) => (
                  <option key={action} value={action}>{gicMaturityActionLabels[action]}</option>
                ))}
              </select>
            </label>
          </div>
        </div>
      ))}
      <button type="button" className="button button-quiet" onClick={addGic}>
        + Add GIC
      </button>
    </div>
  );
}

function NumberField({
  label,
  value,
  onChange,
  prefix,
  suffix,
  min,
  max,
  step,
  tooltip,
}: {
  label: ReactNode;
  value: number | string;
  onChange: (value: string) => void;
  prefix?: string;
  suffix?: string;
  min?: number;
  max?: number;
  step?: number;
  tooltip?: string;
}) {
  const [draftValue, setDraftValue] = useState(String(value));
  const [isFocused, setIsFocused] = useState(false);
  const useCommaFormatting = prefix === "$";

  useEffect(() => {
    if (!isFocused) setDraftValue(String(value));
  }, [value, isFocused]);

  function commitValue() {
    const numericValue = Number(draftValue.replace(/,/g, ""));
    if (draftValue === "" || !Number.isFinite(numericValue)) return;
    onChange(String(numericValue));
  }

  const isFinancialValue = prefix === "$" || suffix === "%";
  const displayValue = !isFocused && useCommaFormatting ? formatWithCommas(draftValue) : draftValue;

  return (
    <label className="field-label">
      {tooltip ? (
        <span className="field-label-text">
          {label}
          <FieldHint text={tooltip} />
        </span>
      ) : (
        label
      )}
      <span className={`number-input${isFinancialValue ? " number-input--financial" : ""}`}>
        {prefix && <span>{prefix}</span>}
        <input
          type={useCommaFormatting ? "text" : "number"}
          inputMode={useCommaFormatting ? "decimal" : undefined}
          min={min}
          max={max}
          step={step}
          value={displayValue}
          onFocus={() => setIsFocused(true)}
          onChange={(event) =>
            setDraftValue(useCommaFormatting ? event.target.value.replace(/[^0-9.-]/g, "") : event.target.value)
          }
          onBlur={() => {
            setIsFocused(false);
            commitValue();
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
        />
        {suffix && <span>{suffix}</span>}
      </span>
    </label>
  );
}

const fieldHintTooltipWidth = 240;
const fieldHintViewportMargin = 8;

function FieldHint({ text }: { text: string }) {
  const [isVisible, setIsVisible] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const iconRef = useRef<HTMLSpanElement>(null);

  function showTooltip() {
    const rect = iconRef.current?.getBoundingClientRect();
    if (rect) {
      const halfWidth = fieldHintTooltipWidth / 2;
      const idealCenter = rect.left + rect.width / 2;
      const minCenter = fieldHintViewportMargin + halfWidth;
      const maxCenter = window.innerWidth - fieldHintViewportMargin - halfWidth;
      setPosition({ top: rect.top, left: Math.min(maxCenter, Math.max(minCenter, idealCenter)) });
    }
    setIsVisible(true);
  }

  return (
    <span
      ref={iconRef}
      className="field-hint"
      tabIndex={0}
      onMouseEnter={showTooltip}
      onMouseLeave={() => setIsVisible(false)}
      onFocus={showTooltip}
      onBlur={() => setIsVisible(false)}
    >
      i
      {isVisible &&
        createPortal(
          <span className="field-hint-tooltip" style={{ top: position.top, left: position.left }}>
            {text}
          </span>,
          document.body,
        )}
    </span>
  );
}
function AgeSelect({
  label,
  value,
  onChange,
  tooltip,
}: {
  label: string;
  value: 60 | 65 | 70;
  onChange: (value: 60 | 65 | 70) => void;
  tooltip?: string;
}) {
  return (
    <label className="field-label">
      {tooltip ? (
        <span className="field-label-text">
          {label}
          <FieldHint text={tooltip} />
        </span>
      ) : (
        label
      )}
      <select
        value={value}
        onChange={(event) =>
          onChange(Number(event.target.value) as 60 | 65 | 70)
        }
      >
        <option value={60}>60</option>
        <option value={65}>65</option>
        <option value={70}>70</option>
      </select>
    </label>
  );
}
const ledgerMonthNames = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function MonthSelect({
  value,
  onChange,
  label = "Birth month",
  tooltip = "Used to prorate spending, income, CPP, OAS, and death timing within a year. Leave unknown to use full-year age transitions.",
  defaultMonth,
}: {
  value: number | undefined;
  onChange: (value: number | undefined) => void;
  label?: string;
  tooltip?: string;
  defaultMonth?: number;
}) {
  return (
    <label className="field-label">
      <span className="field-label-text">
        {label}
        <FieldHint text={tooltip} />
      </span>
      <select value={value ?? defaultMonth ?? ""} onChange={(event) => onChange(event.target.value === "" ? undefined : Number(event.target.value))}>
        <option value="">Unknown</option>
        {monthNames.map((name, index) => <option key={name} value={index + 1}>{name}</option>)}
      </select>
    </label>
  );
}

function ChartPlaceholder({
  title,
  description,
  type,
}: {
  title: string;
  description: string;
  type: "area" | "bands" | "lines" | "bars";
}) {
  return (
    <article className="chart-panel">
      <div className="panel-heading">
        <div>
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
        <span className="chart-state">Awaiting data</span>
      </div>
      <div
        className={`chart-placeholder ${type}`}
        aria-label={`${title} placeholder`}
      >
        <div className="grid-lines" />
        <div className="chart-art" />
      </div>
    </article>
  );
}
function ContributionSchedulesEditor({
  schedules,
  people,
  onChange,
}: {
  schedules: ContributionSchedule[];
  people: Array<{ id: string; label: string; currentAge: number }>;
  onChange: (schedules: ContributionSchedule[]) => void;
}) {
  const updateSchedule = (id: string, changes: Partial<ContributionSchedule>) =>
    onChange(schedules.map((schedule) => schedule.id === id ? { ...schedule, ...changes } : schedule));
  const addSchedule = () => onChange([...schedules, {
    id: `contribution-${Date.now()}`,
    ownerId: "primary",
    label: "New contribution plan",
    year: new Date().getFullYear(),
    endYear: new Date().getFullYear() + Math.max(0, 65 - (people.find((person) => person.id === "primary")?.currentAge ?? 0)),
    frequency: "annual",
    annualRrspContribution: 0,
    annualTfsaContribution: 0,
    annualNonRegisteredContribution: 0,
  }]);
  return (
    <section className="input-section">
      <div className="section-title-row">
        <div>
          <h2>Contribution schedules</h2>
        </div>
        <button type="button" className="text-button" onClick={addSchedule}>Add contribution plan</button>
      </div>
      {schedules.map((schedule) => (
        <article className="income-stream-card" key={schedule.id}>
          {(() => {
            const startYear = Number.isFinite(schedule.year) ? schedule.year : new Date().getFullYear();
            const endYear = Number.isFinite(schedule.endYear) ? schedule.endYear : startYear;
            return (
              <>
          <div className="field-grid three-up">
            <label className="field-label">Owner<select value={schedule.ownerId} onChange={(event) => { const owner = people.find((person) => person.id === event.target.value) ?? people[0]; updateSchedule(schedule.id, { ownerId: event.target.value, endYear: Math.max(startYear, new Date().getFullYear() + Math.max(0, 65 - owner.currentAge)) }); }}>{people.map((person) => <option key={person.id} value={person.id}>{person.label}</option>)}</select></label>
            <label className="field-label">Label<input value={schedule.label} onChange={(event) => updateSchedule(schedule.id, { label: event.target.value })} /></label>
          </div>
          <div className="field-grid two-up income-amount-fields">
            <NumberField label="Start year" min={new Date().getFullYear()} value={startYear} tooltip="First calendar year when this contribution applies." onChange={(value) => updateSchedule(schedule.id, { year: Math.min(endYear, Math.round(Number(value))) })} />
            <NumberField label="End year" min={startYear} value={endYear} tooltip="Last calendar year when this contribution applies." onChange={(value) => updateSchedule(schedule.id, { endYear: Math.max(startYear, Math.round(Number(value))) })} />
            <label className="field-label">Frequency<select value={schedule.frequency} onChange={(event) => updateSchedule(schedule.id, { frequency: event.target.value as ContributionSchedule["frequency"] })}><option value="annual">Annual</option><option value="monthly">Monthly</option></select></label>
          </div>
          <div className="field-grid three-up income-contribution-fields">
            <NumberField label="RRSP" prefix="$" value={schedule.annualRrspContribution ?? 0} onChange={(value) => updateSchedule(schedule.id, { annualRrspContribution: Number(value) })} />
            <NumberField label="TFSA" prefix="$" value={schedule.annualTfsaContribution ?? 0} onChange={(value) => updateSchedule(schedule.id, { annualTfsaContribution: Number(value) })} />
            <NumberField label="Non-registered" prefix="$" value={schedule.annualNonRegisteredContribution ?? 0} onChange={(value) => updateSchedule(schedule.id, { annualNonRegisteredContribution: Number(value) })} />
          </div>
          <button type="button" className="text-button danger-text" onClick={() => onChange(schedules.filter((candidate) => candidate.id !== schedule.id))}>Remove contribution plan</button>
              </>
            );
          })()}
        </article>
      ))}
      {schedules.length === 0 && <p className="empty-section">No contribution schedules configured.</p>}
    </section>
  );
}

function IncomeStreamsEditor({
  streams,
  minimumAge,
  targetDeathAge,
  personalInfo,
  people,
  onChange,
}: {
  streams: IncomeStream[];
  minimumAge: number;
  targetDeathAge: number;
  personalInfo: RetirementInputs["personalInfo"];
  people: Array<{ id: string; label: string; currentAge: number }>;
  onChange: (streams: IncomeStream[]) => void;
}) {
  const updateStream = (id: string, changes: Partial<IncomeStream>) =>
    onChange(
      streams.map((stream) =>
        stream.id === id ? { ...stream, ...changes } : stream,
      ),
    );
  const addStream = () =>
    onChange([
      ...streams,
      {
        id: `income-${Date.now()}`,
        ownerId: "primary",
        label: "New income",
        annualAmount: 0,
        startAge: Math.max(65, minimumAge),
        endAge: targetDeathAge,
        taxTreatment: "pension",
        indexationMode: "none",
        startMonth: 1,
        endMonth: 12,
      },
    ]);
  return (
    <section className="input-section">
      <div className="section-title-row">
        <h2>Income streams</h2>
        <button type="button" className="text-button" onClick={addStream}>
          Add income
        </button>
      </div>
      {streams.map((stream) => {
        const owner = people.find((person) => person.id === (stream.ownerId ?? "primary")) ?? people[0];
        const maxAge = maxHouseholdAge(owner, personalInfo);
        return (
        <div className="income-card" key={stream.id}>
          <div className="section-title-row">
            <span className="stream-title">Income stream</span>
            <button
              type="button"
              className="text-button"
              onClick={() =>
                onChange(
                  streams.filter((candidate) => candidate.id !== stream.id),
                )
              }
            >
              Remove
            </button>
          </div>
          <div className="field-grid income-title">
            <label className="field-label">
              Owner
              <select
                value={stream.ownerId ?? "primary"}
                onChange={(event) =>
                  updateStream(stream.id, { ownerId: event.target.value })
                }
              >
                {people.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.label || "Unnamed person"}
                  </option>
                ))}
              </select>
            </label>
            <label className="field-label">
              Label
              <input
                value={stream.label}
                onChange={(event) =>
                  updateStream(stream.id, { label: event.target.value })
                }
              />
            </label>
            <label className="field-label">
              Tax treatment
              <select
                value={stream.taxTreatment}
                onChange={(event) =>
                  updateStream(stream.id, {
                    taxTreatment: event.target
                      .value as IncomeStream["taxTreatment"],
                  })
                }
              >
                <option value="employment">Employment</option>
                <option value="pension">Pension</option>
                <option value="eligibleDividend">Eligible dividend</option>
                <option value="nonEligibleDividend">
                  Non-eligible dividend
                </option>
                <option value="capitalGains">Capital gains</option>
                <option value="taxFree">Tax-free</option>
              </select>
            </label>
          </div>
          <div className="field-grid three-up income-amount-fields">
            <NumberField
              label="Annual amount"
              prefix="$"
              value={stream.annualAmount}
              onChange={(value) =>
                updateStream(stream.id, { annualAmount: Number(value) })
              }
            />
            <NumberField
              label="Start age"
              min={minimumAge}
              max={stream.endAge}
              value={stream.startAge}
              tooltip={`Starts ${monthYearLabel(owner, stream.startAge, undefined, stream.startMonth ?? 1)}`}
              onChange={(value) =>
                updateStream(stream.id, {
                  startAge: Math.min(stream.endAge, Math.max(minimumAge, Number(value))),
                })
              }
            />
            <NumberField
              label="End age"
              min={stream.startAge}
              max={maxAge}
              value={stream.endAge}
              tooltip={`Ends ${monthYearLabel(owner, stream.endAge, undefined, stream.endMonth ?? 12)}`}
              onChange={(value) =>
                updateStream(stream.id, {
                  endAge: Math.min(maxAge, Math.max(stream.startAge, Number(value))),
                })
              }
            />
          </div>
          <div className="field-grid two-up income-indexation-fields">
            <MonthSelect label="Start month" tooltip="Month when this income starts in its first active year. Defaults to January." defaultMonth={1} value={stream.startMonth} onChange={(value) => updateStream(stream.id, { startMonth: value ?? 1 })} />
            <MonthSelect label="End month" tooltip="Month when this income ends in its final active year. Defaults to December." defaultMonth={12} value={stream.endMonth} onChange={(value) => updateStream(stream.id, { endMonth: value ?? 12 })} />
          </div>
          <div className="field-grid two-up income-indexation-fields">
            <label className="field-label">
              <span className="field-label-text">Indexation</span>
              <select
                value={stream.indexationMode}
                onChange={(event) =>
                  updateStream(stream.id, {
                    indexationMode: event.target
                      .value as IncomeStream["indexationMode"],
                  })
                }
              >
                <option value="none">Not indexed</option>
                <option value="fullInflation">Full inflation</option>
                <option value="partialInflation">Partial COLA</option>
                <option value="fixedRate">Fixed annual rate</option>
              </select>
            </label>
            {(stream.indexationMode === "partialInflation" ||
              stream.indexationMode === "fixedRate") && (
              <NumberField
                label={
                  stream.indexationMode === "partialInflation"
                    ? "% of CPI"
                    : "Annual rate"
                }
                suffix="%"
                tooltip={
                  stream.indexationMode === "partialInflation"
                    ? "Portion of simulated inflation this income keeps up with each year, e.g. 90 for a 90% cost-of-living adjustment."
                    : "Flat annual growth rate applied to this income, independent of the simulated inflation path."
                }
                value={(stream.indexationRate ?? 0) * 100}
                onChange={(value) =>
                  updateStream(stream.id, { indexationRate: Number(value) / 100 })
                }
              />
            )}
          </div>
        </div>
        );
      })}
      {streams.length === 0 && (
        <p className="empty-section">No income streams configured.</p>
      )}
    </section>
  );
}
function SpendingPlanEditor({
  spendingPlan,
  minimumAge,
  personalInfo,
  onChange,
}: {
  spendingPlan: SpendingPlan;
  minimumAge: number;
  personalInfo: RetirementInputs["personalInfo"];
  onChange: (spendingPlan: SpendingPlan) => void;
}) {
  const maxAge = maxHouseholdAge(personalInfo, personalInfo);
  const updatePhase = (
    id: string,
    changes: Partial<SpendingPlan["phases"][number]>,
  ) =>
    onChange({
      ...spendingPlan,
      phases: spendingPlan.phases.map((phase) =>
        phase.id === id ? { ...phase, ...changes } : phase,
      ),
    });
  const addPhase = () => {
    const lastPhase = spendingPlan.phases.at(-1);
    const startAge = Math.max(
      minimumAge,
      (lastPhase?.endAge ?? minimumAge - 1) + 1,
    );
    onChange({
      ...spendingPlan,
      phases: [
        ...spendingPlan.phases,
        {
          id: `phase-${Date.now()}`,
          label: "New phase",
          startAge,
          endAge: startAge + 4,
          annualSpending: spendingPlan.desiredAnnualSpending,
        },
      ],
    });
  };
  return (
    <section className="input-section">
      <div className="section-title-row">
        <span className="field-label-text">
          <h2>Spending plan</h2>
          <FieldHint text="Spending phases apply to full calendar years. Start/end ages are converted to years using the primary person's current age; birth month does not affect spending timing." />
        </span>
        <button type="button" className="text-button" onClick={addPhase}>
          Add phase
        </button>
      </div>
      {spendingPlan.phases.map((phase) => (
        <div className="income-card" key={phase.id}>
          <label className="field-label">
            Phase label
            <input
              value={phase.label}
              onChange={(event) =>
                updatePhase(phase.id, { label: event.target.value })
              }
            />
          </label>
          <div className="field-grid three-up">
            <NumberField
              label="Start age"
              min={minimumAge}
              max={phase.endAge}
              value={phase.startAge}
              tooltip={`Applies for the full calendar year ${ageYearLabel(personalInfo, phase.startAge)}.`}
              onChange={(value) =>
                updatePhase(phase.id, {
                  startAge: Math.min(phase.endAge, Math.max(minimumAge, Number(value))),
                })
              }
            />
            <NumberField
              label="End age"
              min={phase.startAge}
              max={maxAge}
              value={phase.endAge}
              tooltip={`Applies through the full calendar year ${ageYearLabel(personalInfo, phase.endAge)}.`}
              onChange={(value) =>
                updatePhase(phase.id, {
                  endAge: Math.min(maxAge, Math.max(phase.startAge, Number(value))),
                })
              }
            />
            <NumberField
              label="Annual spend"
              prefix="$"
              value={phase.annualSpending}
              onChange={(value) =>
                updatePhase(phase.id, { annualSpending: Number(value) })
              }
            />
          </div>
          <button
            type="button"
            className="text-button"
            onClick={() =>
              onChange({
                ...spendingPlan,
                phases: spendingPlan.phases.filter(
                  (candidate) => candidate.id !== phase.id,
                ),
              })
            }
          >
            Remove phase
          </button>
        </div>
      ))}
      <label className="check-row">
        <input
          type="checkbox"
          checked={spendingPlan.indexedToInflation}
          onChange={(event) =>
            onChange({
              ...spendingPlan,
              indexedToInflation: event.target.checked,
            })
          }
        />{" "}
        Indexed to inflation
      </label>
    </section>
  );
}
function DashboardView({
  kpis,
  inputs,
  projection,
}: {
  kpis: string[][];
  inputs: typeof defaultRetirementInputs;
  projection: DeterministicProjection | null;
}) {
  return (
    <>
      <div className="kpi-grid">
        {kpis.map(([label, value, detail]) => (
          <article className="kpi-card" key={label}>
            <p>{label}</p>
            <strong>{value}</strong>
            <span>{detail}</span>
          </article>
        ))}
      </div>
      <SimulationCharts inputs={inputs} projection={projection} />
      <MeltdownImpactView inputs={inputs} />
    </>
  );
}
function portfolioTotal(year: YearProjection) {
  return year.closingBalances.rrsp + year.closingBalances.tfsa + year.closingBalances.nonRegistered + year.closingBalances.interestBearing;
}
function MeltdownImpactView({ inputs }: { inputs: typeof defaultRetirementInputs }) {
  const { withMeltdown, withoutMeltdown } = useMemo(() => {
    const on = projectWithVariableReturns({ ...inputs, strategy: { ...inputs.strategy, aggressiveRrspMeltdown: true } });
    const off = projectWithVariableReturns({ ...inputs, strategy: { ...inputs.strategy, aggressiveRrspMeltdown: false } });
    return { withMeltdown: on, withoutMeltdown: off };
  }, [inputs]);

  const ages = withMeltdown.years.map((year) => year.age);
  const cumulativeTax = (projection: DeterministicProjection) => {
    let running = 0;
    return projection.years.map((year) => (running += year.taxes.totalTax));
  };
  const finalYearTax = (projection: DeterministicProjection) => projection.years.at(-1)?.taxes.totalTax ?? 0;

  const portfolioOption: EChartsOption = {
    animationDuration: 300,
    grid: { top: 36, right: 18, bottom: 60, left: 66 },
    legend: { left: 42, right: 12, bottom: 4, itemGap: 10, textStyle: { fontSize: 10 } },
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "cross" },
      confine: true,
      valueFormatter: (value) => formatCurrency(Number(value)),
    },
    xAxis: { type: "category", data: ages, axisLabel: { fontSize: 10, margin: 14 } },
    yAxis: { type: "value", axisLabel: { formatter: (value: number) => shortCurrency(value), fontSize: 10 }, splitLine: { lineStyle: { color: "#e8edf4" } } },
    series: [
      { name: "With meltdown", type: "line", data: withMeltdown.years.map(portfolioTotal), symbol: "none", itemStyle: { color: "#7c3aed" }, lineStyle: { color: "#7c3aed", width: 2 } },
      { name: "Without meltdown", type: "line", data: withoutMeltdown.years.map(portfolioTotal), symbol: "none", itemStyle: { color: "#94a3b8" }, lineStyle: { color: "#94a3b8", width: 2, type: "dashed" } },
    ],
  };

  const taxOption: EChartsOption = {
    animationDuration: 300,
    grid: { top: 36, right: 18, bottom: 60, left: 66 },
    legend: { left: 42, right: 12, bottom: 4, itemGap: 10, textStyle: { fontSize: 10 } },
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "cross" },
      confine: true,
      valueFormatter: (value) => formatCurrency(Number(value)),
    },
    xAxis: { type: "category", data: ages, axisLabel: { fontSize: 10, margin: 14 } },
    yAxis: { type: "value", axisLabel: { formatter: (value: number) => shortCurrency(value), fontSize: 10 }, splitLine: { lineStyle: { color: "#e8edf4" } } },
    series: [
      { name: "With meltdown", type: "line", data: cumulativeTax(withMeltdown), symbol: "none", itemStyle: { color: "#7c3aed" }, lineStyle: { color: "#7c3aed", width: 2 } },
      { name: "Without meltdown", type: "line", data: cumulativeTax(withoutMeltdown), symbol: "none", itemStyle: { color: "#94a3b8" }, lineStyle: { color: "#94a3b8", width: 2, type: "dashed" } },
    ],
  };

  return (
    <section className="chart-panel chart-panel--meltdown">
      <div className="panel-heading">
        <div>
          <h2>Aggressive RRSP meltdown: impact</h2>
          <p>Same return sequence, strategy toggled on vs. off, so only the withdrawal strategy differs</p>
        </div>
      </div>
      <div className="chart-grid chart-grid--twoup">
        <div>
          <h3>Portfolio balance over time</h3>
          <ReactECharts option={portfolioOption} style={{ height: 260, width: "100%" }} notMerge lazyUpdate />
        </div>
        <div>
          <h3>Cumulative tax paid over time</h3>
          <ReactECharts option={taxOption} style={{ height: 260, width: "100%" }} notMerge lazyUpdate />
        </div>
      </div>
      <div className="meltdown-summary">
        <div>
          <span>Final estate</span>
          <strong>{formatCurrency(withMeltdown.finalEstateValue)}</strong>
          <span className="meltdown-summary-compare">vs {formatCurrency(withoutMeltdown.finalEstateValue)} without</span>
        </div>
        <div>
          <span>Lifetime tax</span>
          <strong>{formatCurrency(withMeltdown.lifetimeTax)}</strong>
          <span className="meltdown-summary-compare">vs {formatCurrency(withoutMeltdown.lifetimeTax)} without</span>
        </div>
        <div>
          <span>Tax in final year</span>
          <strong>{formatCurrency(finalYearTax(withMeltdown))}</strong>
          <span className="meltdown-summary-compare">vs {formatCurrency(finalYearTax(withoutMeltdown))} without</span>
        </div>
      </div>
    </section>
  );
}
function LedgerView({
  inputs,
  projection,
  onGenerateReturns,
  onReturnChange,
}: {
  inputs: typeof defaultRetirementInputs;
  projection: DeterministicProjection | null;
  onGenerateReturns: () => void;
  onReturnChange: (age: number, rate: number) => void;
}) {
  const [expandedAges, setExpandedAges] = useState<Set<number>>(new Set());
  if (!projection)
    return (
      <section className="ledger-panel ledger-panel--dense">
        <div className="panel-heading">
          <div>
            <h2>Variable-return projection</h2>
            <p>Annual balances, tax, and spendable cash</p>
          </div>
        </div>
        <div className="ledger-empty">Updating variable-return projection.</div>
      </section>
    );
  const years = projection.years;
  const plannedSpend = years.reduce(
    (sum, year) => sum + year.spendingTarget,
    0,
  );
  const averageInvestmentReturn =
    years.reduce((sum, year) => sum + year.portfolioReturn, 0) / years.length;
  return (
    <section className="ledger-panel ledger-panel--dense">
      <div className="ledger-summary">
        <div>
          <span>Planned spending</span>
          <strong>{formatCurrency(plannedSpend)}</strong>
        </div>
        <div>
          <span>Lifetime taxes</span>
          <strong>{formatCurrency(projection.lifetimeTax)}</strong>
        </div>
        <div>
          <span>Final estate</span>
          <strong>{formatCurrency(projection.finalEstateValue)}</strong>
        </div>
        <div>
          <span>Average return</span>
          <strong>{formatPercent(averageInvestmentReturn)}</strong>
        </div>
        <div>
          <span>Projection horizon</span>
          <strong>{years.length} years</strong>
        </div>
      </div>
      <div className="panel-heading ledger-heading">
        <div>
          <h2>Variable-return projection</h2>
          <p>Edit a yearly return to override the seeded path for that age.</p>
        </div>
        <button
          className="button button-primary"
          type="button"
          onClick={onGenerateReturns}
        >
          Generate returns
        </button>
      </div>
      <div className="table-wrap ledger-table-wrap">
        <table className="ledger-table">
          <thead>
            <tr>
              {ledgerLeadColumns.map((column) => (
                <th key={column} rowSpan={2}>
                  {column}
                </th>
              ))}
              <th colSpan={ledgerIncomeColumns.length}>Income</th>
              {ledgerTailColumns.map((column) => (
                <th key={column} rowSpan={2}>
                  {column}
                </th>
              ))}
            </tr>
            <tr className="ledger-subheader-row">
              {ledgerIncomeColumns.map((column) => (
                <th key={column}>{column}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {years.map((year) => {
              const phaseIndex = inputs.spendingPlan.phases.findIndex(
                (phase) =>
                  year.age >= phase.startAge && year.age <= phase.endAge,
              );
              const phase = inputs.spendingPlan.phases[phaseIndex];
              const hasSubPeriods = (year.subPeriods?.length ?? 0) > 0;
              const isExpanded = expandedAges.has(year.age);
              return (
                <Fragment key={year.age}>
                <tr
                  className={
                    phaseIndex >= 0
                      ? `phase-row phase-row-${phaseIndex % 3}`
                      : ""
                  }
                >
                  <td>
                    {hasSubPeriods && (
                      <button
                        type="button"
                        className="button button-quiet ledger-expand-toggle"
                        aria-label={isExpanded ? "Collapse" : "Expand"}
                        onClick={() =>
                          setExpandedAges((current) => {
                            const next = new Set(current);
                            if (next.has(year.age)) next.delete(year.age);
                            else next.add(year.age);
                            return next;
                          })
                        }
                      >
                        {isExpanded ? "\u2212" : "+"}
                      </button>
                    )}
                    {year.calendarYear}
                  </td>
                  <td>{year.age}</td>
                  <td>
                    <span className="phase-tag">
                      {phase?.label ?? "Accumulation"}
                    </span>
                  </td>
                  <td>
                    <span className="ledger-return-input">
                      <input
                        type="number"
                        step="0.1"
                        value={oneDecimalPercent(year.portfolioReturn)}
                        onChange={(event) =>
                          onReturnChange(
                            year.age,
                            Number(event.target.value) / 100,
                          )
                        }
                      />
                      %
                    </span>
                  </td>
                  <td>{formatCurrency(year.income.employment)}</td>
                  <td>{formatCurrency(year.income.cpp)}</td>
                  <td>{formatCurrency(year.income.oas)}</td>
                  <td>{formatCurrency(year.income.rrspWithdrawal)}</td>
                  <td>{formatCurrency(year.income.tfsaWithdrawal)}</td>
                  <td>{formatCurrency(year.income.nonRegisteredWithdrawal)}</td>
                  <td>{formatCurrency(year.income.interest + year.income.interestBearingWithdrawal)}</td>
                  <td>{formatCurrency(year.taxes.totalTax)}</td>
                  <td>{formatCurrency(year.openingBalances.rrsp)}</td>
                  <td>{formatCurrency(year.closingBalances.rrsp)}</td>
                  <td>{formatCurrency(year.openingBalances.tfsa)}</td>
                  <td>{formatCurrency(year.closingBalances.tfsa)}</td>
                  <td>{formatCurrency(year.openingBalances.nonRegistered)}</td>
                  <td>{formatCurrency(year.closingBalances.nonRegistered)}</td>
                  <td>
                    {formatCurrency(year.openingBalances.interestBearing)}
                    {year.gicBufferMode && (
                      <span
                        className={`gic-buffer-badge gic-buffer-badge-${year.gicBufferMode}`}
                        title={year.gicBufferMode === "draw" ? "Market drawdown: GIC drawn first this year" : "Market near peak: GIC reserved (and refilled if enabled)"}
                      >
                        {year.gicBufferMode === "draw" ? "draw" : "reserve"}
                      </span>
                    )}
                  </td>
                  <td>{formatCurrency(year.closingBalances.interestBearing)}</td>
                  <td>{formatCurrency(year.netSpendableCash)}</td>
                  <td>{formatCurrency(year.estateValue)}</td>
                </tr>
                {hasSubPeriods && isExpanded && (
                  <tr className="ledger-subperiod-row">
                    <td colSpan={ledgerLeadColumns.length + ledgerIncomeColumns.length + ledgerTailColumns.length}>
                      <div className="ledger-subperiod-sticky">
                        <SubPeriodTable subPeriods={year.subPeriods!} income={year.income} withdrawals={year.withdrawals} />
                      </div>
                    </td>
                  </tr>
                )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
const monthNames = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const subPeriodLabels: Record<number, string[]> = {
  2: ["H1", "H2"],
  4: ["Q1", "Q2", "Q3", "Q4"],
  12: ledgerMonthNames.map((name) => name.slice(0, 3)),
};
function SubPeriodTable({
  subPeriods,
  income,
  withdrawals,
}: {
  subPeriods: NonNullable<YearProjection["subPeriods"]>;
  income: YearProjection["income"];
  withdrawals: YearProjection["withdrawals"];
}) {
  const labels = subPeriodLabels[subPeriods.length] ?? subPeriods.map((_, index) => `${index + 1}`);
  // year.income.X already folds in the waterfall withdrawal (see combinedIncome in fundHousehold), so isolate just the
  // stream-driven portion here before prorating it evenly per period - adding the raw income.X would double-count.
  const periodCount = subPeriods.length || 1;
  const rrspStreamPerPeriod = (income.rrspWithdrawal - withdrawals.rrsp) / periodCount;
  const tfsaStreamPerPeriod = (income.tfsaWithdrawal - withdrawals.tfsa) / periodCount;
  const nonRegisteredStreamPerPeriod = (income.nonRegisteredWithdrawal - withdrawals.nonRegistered) / periodCount;
  const interestBearingStreamPerPeriod = (income.interest + income.interestBearingWithdrawal - withdrawals.interestBearing) / periodCount;
  return (
    <table className="ledger-subperiod-table">
      <thead>
        <tr>
          <th>Period</th>
          <th>Return</th>
          <th>RRSP w/d</th>
          <th>TFSA w/d</th>
          <th>Non-reg w/d</th>
          <th>GIC w/d</th>
          <th>Portfolio value</th>
        </tr>
      </thead>
      <tbody>
        {subPeriods.map((period) => (
          <tr key={period.index}>
            <td>{labels[period.index] ?? period.index + 1}</td>
            <td>{formatPercent(period.portfolioReturn)}</td>
            <td>{formatCurrency(period.withdrawals.rrsp + rrspStreamPerPeriod)}</td>
            <td>{formatCurrency(period.withdrawals.tfsa + tfsaStreamPerPeriod)}</td>
            <td>{formatCurrency(period.withdrawals.nonRegistered + nonRegisteredStreamPerPeriod)}</td>
            <td>{formatCurrency(period.withdrawals.interestBearing + interestBearingStreamPerPeriod)}</td>
            <td>
              {formatCurrency(
                period.closingBalances.rrsp
                + period.closingBalances.tfsa
                + period.closingBalances.nonRegistered
                + period.closingBalances.interestBearing,
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
function MonteCarloView({
  simulationOutput,
}: {
  simulationOutput: SimulationOutput | null;
}) {
  if (!simulationOutput)
    return (
      <section className="ledger-panel">
        <h2>No simulation results yet</h2>
        <p>
          Run the configured simulation to calculate success rate, percentile
          bands, and the median path.
        </p>
      </section>
    );
  return (
    <section className="ledger-panel">
      <div className="panel-heading">
        <div>
          <h2>
            {simulationOutput.runsCompleted.toLocaleString("en-CA")} simulations
            complete
          </h2>
          <p>Portfolio outcome percentile bands</p>
        </div>
        <strong>
          {formatPercent(simulationOutput.kpis.successRate)} success
        </strong>
      </div>
      <MonteCarloPercentileChart simulationOutput={simulationOutput} />
      <FailureAnalysisView failureAnalysis={simulationOutput.failureAnalysis} />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Age</th>
              <th>{worstSurvivingLabel(simulationOutput)}</th>
              <th>Median</th>
              <th>90th percentile</th>
            </tr>
          </thead>
          <tbody>
            {simulationOutput.percentileBands.map((band) => (
              <tr key={band.age}>
                <td>{band.age}</td>
                <td>{formatCurrency(band.pWorstSurviving)}</td>
                <td>{formatCurrency(band.p50)}</td>
                <td>{formatCurrency(band.p90)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function worstSurvivingLabel(simulationOutput: SimulationOutput) {
  const rank = Math.round(simulationOutput.kpis.worstSurvivingPercentileRank * 100);
  return `${rank}th percentile (worst surviving)`;
}

function ReturnDistributionPreview({
  mean,
  stdDev,
  floor,
  ceiling,
}: {
  mean: number;
  stdDev: number;
  floor: number;
  ceiling: number;
}) {
  const stats = useMemo(() => {
    // A fixed seed keeps the preview stable while you tweak other inputs, independent of the scenario's own random seed.
    const random = createPreviewRandom(20260907);
    const sampleCount = 4000;
    const samples = Array.from({ length: sampleCount }, () => sampleAnnualReturn(random, mean, stdDev, floor, ceiling));
    const bucketCount = 20;
    const bucketWidth = (ceiling - floor) / bucketCount || 1;
    const counts = new Array(bucketCount).fill(0);
    for (const sample of samples) {
      const bucketIndex = Math.min(bucketCount - 1, Math.max(0, Math.floor((sample - floor) / bucketWidth)));
      counts[bucketIndex] += 1;
    }
    const labels = Array.from({ length: bucketCount }, (_, index) => `${((floor + index * bucketWidth) * 100).toFixed(0)}%`);
    const realizedMean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
    const variance = samples.reduce((sum, value) => sum + (value - realizedMean) ** 2, 0) / samples.length;
    const negativeShare = samples.filter((value) => value < 0).length / samples.length;
    return {
      labels,
      frequencies: counts.map((count) => count / samples.length),
      realizedMean,
      realizedStdDev: Math.sqrt(variance),
      negativeShare,
      worst: Math.min(...samples),
      best: Math.max(...samples),
    };
  }, [mean, stdDev, floor, ceiling]);

  const option: EChartsOption = {
    animationDuration: 200,
    grid: { top: 12, right: 12, bottom: 46, left: 46 },
    tooltip: {
      trigger: "axis",
      valueFormatter: (value) => formatPercent(Number(value)),
    },
    xAxis: { type: "category", data: stats.labels, axisLabel: { fontSize: 9, rotate: 45 } },
    yAxis: {
      type: "value",
      axisLabel: { formatter: (value: number) => formatPercent(value), fontSize: 10 },
      splitLine: { lineStyle: { color: "#e8edf4" } },
    },
    series: [
      {
        type: "bar",
        data: stats.frequencies,
        itemStyle: { color: "#2563eb" },
        barWidth: "80%",
      },
    ],
  };

  return (
    <div className="return-distribution-preview">
      <div className="field-label-text">
        <span>Return distribution preview</span>
        <FieldHint text="Shows the shape of annual returns these assumptions actually produce (a sample of 4,000 draws), not just the raw mean/std-dev numbers. Returns are drawn from a normal distribution truncated to the floor/cap, with the underlying curve shifted so the average of the truncated draws still lands on your mean. If your floor and cap aren't the same distance from your mean (realistic, since markets usually have more downside room than upside), the shape will skew toward whichever side has more room - that's expected, not an error." />
      </div>
      <ReactECharts option={option} style={{ height: 160, width: "100%" }} notMerge lazyUpdate />
      <p className="return-distribution-stats">
        Realized: {formatPercent(stats.realizedMean)} mean, {formatPercent(stats.realizedStdDev)} std-dev, {formatPercent(stats.negativeShare)} of years negative, range {formatPercent(stats.worst)} to {formatPercent(stats.best)}.
      </p>
    </div>
  );
}

function createPreviewRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function MonteCarloPercentileChart({
  simulationOutput,
}: {
  simulationOutput: SimulationOutput;
}) {
  const bands = simulationOutput.percentileBands;
  const ages = bands.map((band) => band.age);
  const worstRank = Math.round(simulationOutput.kpis.worstSurvivingPercentileRank * 100);
  const option: EChartsOption = {
    animationDuration: 300,
    grid: { top: 36, right: 18, bottom: 60, left: 66 },
    legend: { left: 42, right: 12, bottom: 4, itemGap: 10, textStyle: { fontSize: 10 } },
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "cross" },
      confine: true,
      valueFormatter: (value) => formatCurrency(Number(value)),
    },
    xAxis: { type: "category", data: ages, axisLabel: { fontSize: 10, margin: 14 } },
    yAxis: {
      type: "value",
      axisLabel: { formatter: (value: number) => shortCurrency(value), fontSize: 10 },
      splitLine: { lineStyle: { color: "#e8edf4" } },
    },
    series: [
      {
        name: `${worstRank}th percentile (worst surviving)`,
        type: "line",
        data: bands.map((band) => band.pWorstSurviving),
        symbol: "none",
        itemStyle: { color: "#dc2626" },
        lineStyle: { color: "#dc2626", width: 2 },
      },
      {
        name: "50th percentile (median)",
        type: "line",
        data: bands.map((band) => band.p50),
        symbol: "none",
        itemStyle: { color: "#2563eb" },
        lineStyle: { color: "#2563eb", width: 2 },
      },
      {
        name: "90th percentile",
        type: "line",
        data: bands.map((band) => band.p90),
        symbol: "none",
        itemStyle: { color: "#10b981" },
        lineStyle: { color: "#10b981", width: 2 },
      },
    ],
  };
  return (
    <ReactECharts
      option={option}
      style={{ height: 320, width: "100%" }}
      notMerge
      lazyUpdate
    />
  );
}
function FailureAnalysisView({
  failureAnalysis,
}: {
  failureAnalysis: SimulationOutput["failureAnalysis"];
}) {
  if (failureAnalysis.failedRunCount === 0)
    return (
      <p className="chart-panel-note">
        No simulated runs ran out of money — every path survived to the target
        death age.
      </p>
    );
  const returnGap =
    failureAnalysis.averageReturnSuccessfulRuns -
    failureAnalysis.averageReturnFailedRuns;
  const option: EChartsOption = {
    animationDuration: 300,
    grid: { top: 36, right: 18, bottom: 60, left: 56 },
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "shadow" },
      confine: true,
      formatter: (parameters) =>
        `Age ${(parameters as any[])[0]?.axisValue}<br/>${(parameters as any[])[0]?.value} runs ran out of money here`,
    },
    xAxis: {
      type: "category",
      name: "Age money ran out",
      nameLocation: "middle",
      nameGap: 28,
      data: failureAnalysis.ageDistribution.map((bucket) => bucket.age),
      axisLabel: { fontSize: 10, margin: 14 },
    },
    yAxis: {
      type: "value",
      name: "Failed runs",
      axisLabel: { fontSize: 10 },
      splitLine: { lineStyle: { color: "#e8edf4" } },
    },
    series: [
      {
        name: "Runs that ran out of money",
        type: "bar",
        data: failureAnalysis.ageDistribution.map((bucket) => bucket.failedRunCount),
        itemStyle: { color: "#dc2626" },
      },
    ],
  };
  return (
    <div className="chart-panel chart-panel--failure">
      <div className="panel-heading">
        <div>
          <h2>Why did {failureAnalysis.failedRunCount.toLocaleString("en-CA")} runs run out of money?</h2>
          <p>
            Failed runs averaged {formatPercent(failureAnalysis.averageReturnFailedRuns)} annual
            return vs. {formatPercent(failureAnalysis.averageReturnSuccessfulRuns)} for successful
            runs — a {formatPercent(Math.abs(returnGap))} gap, driven by the sequence and size of
            randomly generated market returns each run experienced.
          </p>
        </div>
      </div>
      <ReactECharts
        option={option}
        style={{ height: 260, width: "100%" }}
        notMerge
        lazyUpdate
      />
    </div>
  );
}
function CompareView({
  scenarios,
  draftInputs,
  draftProjection,
}: {
  scenarios: SavedScenario[];
  draftInputs: RetirementInputs;
  draftProjection: DeterministicProjection | null;
}) {
  const validScenarios = scenarios.filter((scenario) =>
    isRetirementInputs(scenario.inputs),
  );
  const choices = [
    { id: "draft", name: "Current draft", inputs: draftInputs },
    ...validScenarios,
  ];
  const [leftId, setLeftId] = useState("draft");
  const [rightId, setRightId] = useState(validScenarios[0]?.id ?? "");
  const [comparison, setComparison] = useState<{
    left: DeterministicProjection;
    right: DeterministicProjection;
  } | null>(null);
  const [isComparing, setIsComparing] = useState(false);
  const left = choices.find((choice) => choice.id === leftId) ?? choices[0];
  const right = choices.find((choice) => choice.id === rightId);

  useEffect(() => {
    if (!left || !right) {
      setComparison(null);
      return;
    }
    const comparisonTimer = window.setTimeout(() => {
      setIsComparing(true);
      const leftOutput =
        left.id === "draft" && draftProjection
          ? draftProjection
          : projectWithVariableReturns(left.inputs);
      const rightOutput =
        right.id === "draft" && draftProjection
          ? draftProjection
          : projectWithVariableReturns(right.inputs);
      startTransition(() => {
        setComparison({ left: leftOutput, right: rightOutput });
        setIsComparing(false);
      });
    }, 0);
    return () => window.clearTimeout(comparisonTimer);
  }, [leftId, rightId, scenarios, draftInputs, draftProjection]);

  if (choices.length < 2) {
    return (
      <section className="compare-panel">
        <h2>Save another scenario to compare plans</h2>
        <p>
          Use Save after changing inputs, then return here to compare the plan
          outcomes.
        </p>
      </section>
    );
  }

  return (
    <section className="compare-panel">
      <div className="compare-selectors">
        <label className="field-label">
          Scenario A
          <select
            value={leftId}
            onChange={(event) => setLeftId(event.target.value)}
          >
            {choices.map((choice) => (
              <option key={choice.id} value={choice.id}>
                {choice.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field-label">
          Scenario B
          <select
            value={rightId}
            onChange={(event) => setRightId(event.target.value)}
          >
            <option value="">Select scenario</option>
            {choices.map((choice) => (
              <option key={choice.id} value={choice.id}>
                {choice.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {isComparing && (
        <p className="compare-status">Calculating comparison...</p>
      )}
      {comparison && right && (
        <>
          <div className="compare-table">
            <div className="compare-row compare-head">
              <span>Metric</span>
              <strong>{left.name}</strong>
              <strong>{right.name}</strong>
              <span>Difference</span>
            </div>
            <ComparisonRow label="Final estate" left={comparison.left.finalEstateValue} right={comparison.right.finalEstateValue} format={formatCurrency} />
            <ComparisonRow label="Lifetime tax" left={comparison.left.lifetimeTax} right={comparison.right.lifetimeTax} format={formatCurrency} />
            <ComparisonRow label="Lifetime investment drawdowns" left={lifetimeDrawdowns(comparison.left)} right={lifetimeDrawdowns(comparison.right)} format={formatCurrency} />
            <ComparisonRow label="Lifetime CPP" left={lifetimeBenefit(comparison.left, "cpp")} right={lifetimeBenefit(comparison.right, "cpp")} format={formatCurrency} />
            <ComparisonRow label="Lifetime OAS" left={lifetimeBenefit(comparison.left, "oas")} right={lifetimeBenefit(comparison.right, "oas")} format={formatCurrency} />
            <ComparisonRow label="Portfolio peak age" left={comparison.left.portfolioPeakAge} right={comparison.right.portfolioPeakAge} format={(value) => `${Math.round(value)}`} />
            <ComparisonTextRow label="First spending shortfall" left={firstShortfallLabel(comparison.left)} right={firstShortfallLabel(comparison.right)} />
          </div>
          <ComparisonCharts left={comparison.left} right={comparison.right} leftName={left.name} rightName={right.name} />
          <ComparisonAssumptions left={left.inputs} right={right.inputs} leftName={left.name} rightName={right.name} />
        </>
      )}
    </section>
  );
}
function ComparisonTextRow({ label, left, right }: { label: string; left: string; right: string }) {
  return <div className="compare-row"><span>{label}</span><strong>{left}</strong><strong>{right}</strong><span>{left === right ? "Same" : "Different"}</span></div>;
}
function ComparisonCharts({ left, right, leftName, rightName }: { left: DeterministicProjection; right: DeterministicProjection; leftName: string; rightName: string }) {
  const ages = left.years.map((year) => year.age);
  const base = { animationDuration: 250, grid: { top: 34, right: 18, bottom: 54, left: 64 }, tooltip: { trigger: "axis" }, legend: { bottom: 0, textStyle: { fontSize: 10 } }, xAxis: { type: "category", data: ages }, yAxis: { type: "value", axisLabel: { formatter: (value: number) => shortCurrency(value) }, splitLine: { lineStyle: { color: "#e8edf4" } } } };
  const portfolioOption = { ...base, series: [{ name: leftName, type: "line", data: portfolioValues(left), symbol: "none", lineStyle: { color: "#2563eb", width: 2 } }, { name: rightName, type: "line", data: portfolioValues(right), symbol: "none", lineStyle: { color: "#f97316", width: 2 } }] };
  const spendingOption = { ...base, series: [{ name: `${leftName} funded spending`, type: "line", data: fundedSpending(left), symbol: "none", lineStyle: { color: "#2563eb", width: 2 } }, { name: `${rightName} funded spending`, type: "line", data: fundedSpending(right), symbol: "none", lineStyle: { color: "#f97316", width: 2 } }, { name: "Requested spending", type: "line", data: left.years.map((year) => year.spendingTarget), symbol: "none", lineStyle: { color: "#64748b", type: "dashed" } }] };
  return <div className="compare-chart-grid"><article className="chart-panel"><div className="panel-heading"><div><h2>Portfolio comparison</h2><p>Closing balance by age</p></div></div><ReactECharts option={portfolioOption} style={{ height: 275, width: "100%" }} notMerge /></article><article className="chart-panel"><div className="panel-heading"><div><h2>Spending coverage</h2><p>Actual funded spending versus requested target</p></div></div><ReactECharts option={spendingOption} style={{ height: 275, width: "100%" }} notMerge /></article></div>;
}
function ComparisonAssumptions({ left, right, leftName, rightName }: { left: RetirementInputs; right: RetirementInputs; leftName: string; rightName: string }) {
  const rows = [
    ["Province", provinceNames[left.personalInfo.province], provinceNames[right.personalInfo.province]],
    ["People", `${1 + (left.personalInfo.additionalPeople?.length ?? 0)}`, `${1 + (right.personalInfo.additionalPeople?.length ?? 0)}`],
    ["Spending phases", `${left.spendingPlan.phases.length}`, `${right.spendingPlan.phases.length}`],
    ["Return mean", formatPercent(left.assumptions.returnMean), formatPercent(right.assumptions.returnMean)],
    ["Return StdDev", formatPercent(left.assumptions.returnStdDev), formatPercent(right.assumptions.returnStdDev)],
    ["Inflation mean", formatPercent(left.assumptions.inflationMean), formatPercent(right.assumptions.inflationMean)],
    ["CPP / OAS start", `${left.strategy.cppStartAge} / ${left.strategy.oasStartAge}`, `${right.strategy.cppStartAge} / ${right.strategy.oasStartAge}`],
  ];
  return <section className="compare-assumptions"><h2>Assumptions that differ</h2><div className="compare-assumption-table"><div><span>Input</span><strong>{leftName}</strong><strong>{rightName}</strong></div>{rows.filter(([, leftValue, rightValue]) => leftValue !== rightValue).map(([label, leftValue, rightValue]) => <div key={label}><span>{label}</span><strong>{leftValue}</strong><strong>{rightValue}</strong></div>)}{rows.every(([, leftValue, rightValue]) => leftValue === rightValue) && <p>Selected assumptions are the same.</p>}</div></section>;
}
function portfolioValues(projection: DeterministicProjection) { return projection.years.map((year) => year.closingBalances.rrsp + year.closingBalances.tfsa + year.closingBalances.nonRegistered + year.closingBalances.interestBearing); }
function fundedSpending(projection: DeterministicProjection) { return projection.years.map((year) => Math.min(year.spendingTarget, year.netSpendableCash)); }
function lifetimeDrawdowns(projection: DeterministicProjection) { return projection.years.reduce((sum, year) => sum + year.withdrawals.rrsp + year.withdrawals.tfsa + year.withdrawals.nonRegistered + year.withdrawals.interestBearing, 0); }
function lifetimeBenefit(projection: DeterministicProjection, benefit: "cpp" | "oas") { return projection.years.reduce((sum, year) => sum + year.income[benefit], 0); }
function firstShortfallLabel(projection: DeterministicProjection) { const year = projection.years.find((candidate) => candidate.spendingTarget > candidate.netSpendableCash); return year ? `Age ${year.age}` : "None"; }
function ComparisonRow({
  label,
  left,
  right,
  format,
}: {
  label: string;
  left: number;
  right: number;
  format: (value: number) => string;
}) {
  const difference = right - left;
  return (
    <div className="compare-row">
      <span>{label}</span>
      <strong>{format(left)}</strong>
      <strong>{format(right)}</strong>
      <span
        className={
          difference > 0 ? "positive" : difference < 0 ? "negative" : ""
        }
      >
        {difference > 0 ? "+" : ""}
        {format(difference)}
      </span>
    </div>
  );
}
function TaxInformationView({
  taxSettings,
  province,
  onChange,
  onReset,
}: {
  taxSettings: TaxSettings;
  province: ProvinceCode;
  onChange: (taxSettings: TaxSettings) => void;
  onReset: () => void;
}) {
  const [selectedProvince, setSelectedProvince] = useState(province);
  const updateJurisdiction = (
    jurisdiction: "federal" | "provincial",
    changes: Partial<TaxJurisdictionSettings>,
  ) =>
    onChange(
      jurisdiction === "federal"
        ? { ...taxSettings, federal: { ...taxSettings.federal, ...changes } }
        : {
            ...taxSettings,
            provinces: {
              ...taxSettings.provinces,
              [selectedProvince]: {
                ...taxSettings.provinces[selectedProvince],
                ...changes,
              },
            },
          },
    );
  const updateBracket = (
    jurisdiction: "federal" | "provincial",
    surtax: boolean,
    index: number,
    changes: Partial<TaxRateBracket>,
  ) => {
    const rules =
      jurisdiction === "federal"
        ? taxSettings.federal
        : taxSettings.provinces[selectedProvince];
    const key = surtax ? "surtaxBrackets" : "brackets";
    updateJurisdiction(jurisdiction, {
      [key]: rules[key].map((bracket, bracketIndex) =>
        bracketIndex === index ? { ...bracket, ...changes } : bracket,
      ),
    });
  };
  const federal = taxSettings.federal;
  const provincial = taxSettings.provinces[selectedProvince];
  return (
    <section className="tax-panel">
      <div className="tax-toolbar">
        <label className="field-label">
          Province
          <select
            value={selectedProvince}
            onChange={(event) =>
              setSelectedProvince(event.target.value as ProvinceCode)
            }
          >
            {Object.entries(provinceNames).map(([code, name]) => (
              <option key={code} value={code}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label className="field-label">
          Tax year
          <select
            value={taxSettings.taxYear}
            onChange={(event) =>
              onChange({ ...taxSettings, taxYear: Number(event.target.value) })
            }
          >
            {availableTaxYears.map((year) => (
              <option key={year} value={year}>
                {year}
              </option>
            ))}
          </select>
        </label>
        <span className="tax-availability">
          Only tax years with a complete rule set can be selected.
        </span>
        <button className="button button-quiet" type="button" onClick={onReset}>
          Reset tax rules
        </button>
      </div>
      <TaxJurisdictionEditor
        title={`${provinceNames[selectedProvince]} rules`}
        rules={provincial}
        showAbatement={selectedProvince === "QC"}
        showSurtax={selectedProvince === "ON"}
        onChange={(changes) => updateJurisdiction("provincial", changes)}
        onBracketChange={(surtax, index, changes) =>
          updateBracket("provincial", surtax, index, changes)
        }
      />
      <TaxJurisdictionEditor
        title="Federal rules"
        rules={federal}
        onChange={(changes) => updateJurisdiction("federal", changes)}
        onBracketChange={(surtax, index, changes) =>
          updateBracket("federal", surtax, index, changes)
        }
      />
    </section>
  );
}
function TaxJurisdictionEditor({
  title,
  rules,
  showAbatement = false,
  showSurtax = false,
  onChange,
  onBracketChange,
}: {
  title: string;
  rules: TaxJurisdictionSettings;
  showAbatement?: boolean;
  showSurtax?: boolean;
  onChange: (changes: Partial<TaxJurisdictionSettings>) => void;
  onBracketChange: (
    surtax: boolean,
    index: number,
    changes: Partial<TaxRateBracket>,
  ) => void;
}) {
  return (
    <article className="tax-rule-card">
      <h2>{title}</h2>
      <div className="tax-credit-fields">
        <NumberField
          label="Basic personal amount"
          prefix="$"
          value={rules.basicPersonalAmount}
          onChange={(value) => onChange({ basicPersonalAmount: Number(value) })}
        />
        <NumberField
          label="Credit rate"
          suffix="%"
          value={roundedPercent(rules.taxCreditRate)}
          onChange={(value) => onChange({ taxCreditRate: Number(value) / 100 })}
        />
        {showAbatement && (
          <NumberField
            label={
              <span title="Reduces federal income tax for Quebec residents because Quebec administers programs funded federally elsewhere.">
                Quebec federal tax abatement
              </span>
            }
            suffix="%"
            value={roundedPercent(rules.abatementRate)}
            onChange={(value) =>
              onChange({ abatementRate: Number(value) / 100 })
            }
          />
        )}
      </div>
      <TaxBracketTable
        label="Income tax brackets"
        brackets={rules.brackets}
        onChange={(index, changes) => onBracketChange(false, index, changes)}
      />
      {showSurtax && rules.surtaxBrackets.length > 0 && (
        <TaxBracketTable
          label="Surtax tiers"
          brackets={rules.surtaxBrackets}
          onChange={(index, changes) => onBracketChange(true, index, changes)}
        />
      )}
    </article>
  );
}
function TaxBracketTable({
  label,
  brackets,
  onChange,
}: {
  label: string;
  brackets: TaxRateBracket[];
  onChange: (index: number, changes: Partial<TaxRateBracket>) => void;
}) {
  return (
    <div className="tax-bracket-table">
      <h3>{label}</h3>
      <div className="tax-bracket-head">
        <span>From</span>
        <span>To</span>
        <span>Rate</span>
      </div>
      {brackets.map((bracket, index) => (
        <div className="tax-bracket-row" key={`${bracket.from}-${index}`}>
          <input
            type="number"
            aria-label={`${label} ${index + 1} from`}
            value={bracket.from}
            onChange={(event) =>
              onChange(index, { from: Number(event.target.value) })
            }
          />
          <input
            type="number"
            aria-label={`${label} ${index + 1} to`}
            value={bracket.to ?? ""}
            placeholder="No limit"
            onChange={(event) =>
              onChange(index, {
                to:
                  event.target.value === "" ? null : Number(event.target.value),
              })
            }
          />
          <span className="rate-input">
            <input
              type="number"
              value={roundedPercent(bracket.rate)}
              onChange={(event) =>
                onChange(index, { rate: Number(event.target.value) / 100 })
              }
            />
            %
          </span>
        </div>
      ))}
    </div>
  );
}
function GuideView() {
  const sections: { title: string; body: ReactNode }[] = [
    {
      title: "What this tool actually calculates",
      body: (
        <>
          <p>This is a scenario-based planning model. It predicts possible household cash flow, taxes, account balances, and estate values from the assumptions you enter, but it cannot predict which future scenario will occur.</p>
          <p>The Dashboard and Ledger show one seeded variable-return path. Monte Carlo runs the same plan many times with different return and inflation paths, then summarizes the range of outcomes. A high success rate means the modeled portfolio stayed funded; it does not guarantee that result in real life.</p>
          <p>Each simulated year adds income, applies the selected withdrawal schedule, calculates annual tax and OAS recovery tax, reinvests eligible surplus cash, and updates the accounts. With monthly, quarterly, or semi-annual withdrawals, the market return is also split into matching sub-period returns that compound back to the year's return.</p>
        </>
      ),
    },
    {
      title: "People and dates",
      body: (
        <>
          <p><strong>Current age</strong> anchors the simulation. <strong>Death age</strong> is the person's birthday cutoff for age-based income and benefits; the estate is settled in the final simulated year. Birth month, when provided, controls within-year proration.</p>
          <p>Each additional person has their own age, birth month, benefits, accounts, and tax return. Household projections use the longest household lifespan; age-based income belongs to the person who owns that stream.</p>
          <p><strong>Province</strong> selects the provincial tax rules. <strong>CPP/OAS payout %</strong> lets you model less than the maximum benefit.</p>
        </>
      ),
    },
    {
      title: "Income streams",
      body: (
        <>
          <p>Each stream has an owner, amount, age range, tax treatment, and indexation rule. The age controls determine when the stream starts and stops.</p>
          <p>Tax treatment controls how the amount is classified: employment and pension are ordinary income, registered withdrawals are taxable or tax-free as appropriate, dividends receive their modeled treatment, and capital gains use the configured inclusion rate.</p>
          <p>Contribution schedules deposit the configured annual amounts directly into RRSP, TFSA, or non-registered accounts during their active age range. RRSP contributions reduce taxable income; TFSA and non-registered contributions use after-tax cash. All contributions reduce available cash regardless of where the money came from. For a partial or unusual year, create a separate schedule active for that one year with the desired annual amounts.</p>
          <p>Indexation can follow inflation, a portion of inflation, a fixed annual rate, or no increase. The model uses annual income totals; the withdrawal schedule controls how spending draws are distributed within the year.</p>
        </>
      ),
    },
    {
      title: "Accounts",
      body: (
        <>
          <p><strong>RRSP / RRIF</strong>: withdrawals are fully taxed as ordinary income. Once you turn 71, a mandatory minimum withdrawal kicks in automatically each year (the CRA's prescribed percentage of the RRIF's value at the start of that year) - see the "RRIF withdrawal rate" chart to compare it against what's actually withdrawn.</p>
          <p><strong>TFSA</strong>: withdrawals are always tax-free and never counted as income anywhere.</p>
          <p><strong>Non-registered</strong> + <strong>Adjusted cost base (ACB)</strong>: only the gain above your ACB is taxable, and only that portion is a capital gain (taxed at the capital gains inclusion rate on the Assumptions tab, currently 50% or 66.67% included). If ACB equals the account balance there's no gain and changing it further won't do anything; the same applies at death, where any remaining unrealized gain is deemed realized.</p>
          <p><strong>GIC / interest income</strong>: modeled separately from market-return accounts because it earns its own guaranteed rate and is principal-protected. The rate you enter is the total return for the whole term (e.g. 5% for a 2-year GIC means 5% over those 2 years), compounded tax-deferred until the term matures, when the accumulated growth is taxed as ordinary income all at once. An early withdrawal realizes a proportional share of deferred growth.</p>
        </>
      ),
    },
    {
      title: "Spending",
      body: (
        <>
          <p>Spending is defined in phases, each with an annual target and age range. The information icons show the primary person's corresponding dates. Start age cannot be after end age, and the editor caps end ages at the household's modeled lifespan.</p>
          <p>When spending is indexed, each phase grows with cumulative simulated inflation. Otherwise its target stays fixed in nominal dollars.</p>
          <p>The withdrawal order is configurable. The model uses it to cover after-tax spending shortfalls, with RRIF minimums and any configured income streams included in the annual cash-flow calculation. If the accounts cannot fund the target, the projection is marked depleted instead of borrowing an invented balance.</p>
        </>
      ),
    },
    {
      title: "Assumptions: what's random and what isn't",
      body: (
        <>
          <p><strong>Return mean/StdDev</strong> and <strong>Inflation mean/StdDev</strong> define the distributions used to generate paths. <strong>Return floor/ceiling</strong> limit extreme annual returns. The random seed makes the single path reproducible.</p>
          <p>For a non-annual withdrawal frequency, each annual return is decomposed into sub-period returns that preserve the annual compounded result while allowing positive and negative months or quarters within the year.</p>
          <p>The Ledger can override individual annual returns for the single projection. Monte Carlo ignores those overrides and generates fresh paths.</p>
          <p>Tax brackets, basic personal amounts, TFSA room, and OAS thresholds are projected forward using simulated inflation, while tax rates and other rule parameters remain fixed. Future legislation is not modeled.</p>
        </>
      ),
    },
    {
      title: "Strategy",
      body: (
        <>
          <p><strong>Withdrawal frequency</strong> controls when the waterfall runs: annual, semi-annual, quarterly, or monthly. More frequent schedules expose the portfolio to more realistic within-year timing and make the Ledger expandable by period.</p>
          <p>Employment income end ages and months define when each person stops working; household spending and withdrawals begin when the last employment income stream in the household ends. With monthly withdrawals, that first retirement year is prorated from the selected month through December. Income streams also support independent start and end months for partial first or final years.</p>
          <p><strong>CPP/OAS start age</strong> changes the modeled benefit amount: starting early reduces it and delaying increases it. The strategy age determines when the benefit begins.</p>
          <p><strong>Aggressive RRSP meltdown</strong> withdraws additional RRSP/RRIF funds after retirement to fill the current federal bracket. It is a tax strategy approximation, and its annual decision is displayed in the sub-period table as smoothed period amounts when using a non-annual schedule.</p>
          <p><strong>GIC buffer strategy</strong>: a GIC only earns its keep as a sequence-of-returns buffer if it's still there when a real downturn hits - drawing it down on a fixed schedule regardless of market conditions defeats the purpose. Enabling this reserves the GIC while the market portfolio's own return (isolated from your contributions/withdrawals, since decumulation itself shouldn't look like a crash) is near its all-time high, then draws the GIC first once that return index is down more than the "draw trigger" from its peak - so a downturn is funded from the guaranteed GIC instead of selling depressed investments. Once the market recovers back within the "recovery threshold" of its old peak, the GIC reverts to being reserved (and refilled from leftover cash, e.g. RRIF minimums exceeding spending need, if enabled). A single down year is usually noise; 10-15% off the peak is a more meaningful signal that it's worth protecting the rest of the portfolio from selling low. There's deliberately no auto-optimizer here: fitting a trigger/recovery threshold to one guessed-at future return sequence is fitting noise, not a real edge - pick a threshold based on how much of a real correction you want to ride out, not by curve-fitting a simulation.</p>
        </>
      ),
    },
    {
      title: "Death, estate, and probate",
      body: (
        <>
          <p>When someone reaches their target death age, their accounts either roll over tax-free to a surviving person in the household, or - if no one survives them - are deemed disposed: RRSP/RRIF balances and deferred GIC growth become ordinary income, while non-registered growth above the ACB becomes a capital gain.</p>
          <p>What's left after that final tax bill is reduced further by the probate fee rate (Assumptions) to produce the final estate value shown on the Dashboard.</p>
          <p>This one-time deemed-disposition bill is shown as its own <strong>End-of-life tax</strong> KPI card on the Dashboard, separate from <strong>Lifetime tax</strong> - it's paid out of the estate itself, not funded from spending cash flow, so it doesn't indicate a funding shortfall in the Ledger's regular "Taxes paid" column. It's still included in the Lifetime tax total.</p>
        </>
      ),
    },
    {
      title: "OAS clawback (recovery tax)",
      body: (
        <p>Once your other taxable income (excluding your own OAS) exceeds the clawback threshold, 15 cents of every dollar above it is recovered from your OAS, up to a full clawback at the top threshold - both thresholds grow with simulated inflation. This is calculated last each year, after all withdrawals, so it reflects your actual final income for that year.</p>
      ),
    },
    {
      title: "Your data stays on this device",
      body: (
        <>
          <p>All calculations run locally in your browser. This tool has no telemetry, does not send your scenario to a server, and does not store your financial information anywhere off this device.</p>
          <p><strong>Save</strong> keeps a scenario in this browser on this device so you can return to it later. It is not an online account, and it will not automatically appear on another computer or phone.</p>
          <p><strong>Export</strong> downloads a copy of your scenario as a file. Keep that file somewhere safe if you want a backup or need to move the scenario to another device. <strong>Import</strong> lets you choose that file and load the scenario into the app on the new device.</p>
          <p>Clearing browser data or using private browsing can remove locally saved scenarios. Export important scenarios before doing that.</p>
        </>
      ),
    },
    {
      title: "Saving, loading, import & export",
      body: (
        <>
          <p><strong>Save</strong> stores the current scenario in this browser. Saving again updates the selected scenario. <strong>New</strong> starts a fresh scenario without deleting saved ones, and <strong>Delete</strong> removes the selected saved scenario.</p>
          <p><strong>Export</strong> makes a file you can keep as a backup. <strong>Import</strong> loads one of those files back into the app and creates a saved scenario from it. This is the way to move a scenario between devices.</p>
        </>
      ),
    },
    {
      title: "The other tabs",
      body: (
        <>
          <p><strong>Dashboard</strong>: the main projection, KPIs, charts, and strategy comparison.</p>
          <p><strong>Ledger</strong>: the same projection in a year-by-year table. Edit annual returns and expand years to inspect monthly, quarterly, or semi-annual returns and withdrawals.</p>
          <p><strong>Monte Carlo</strong>: randomized runs summarized as percentile bands, success rate, and failure analysis.</p>
          <p><strong>Compare</strong>: run two saved scenarios side by side to see how changing inputs affects the result.</p>
          <p><strong>Tax Info</strong>: the editable tax brackets, credits, and rates used by the model.</p>
        </>
      ),
    },
  ];
  return (
    <section className="guide-panel">
      {sections.map((section) => (
        <article className="guide-card" key={section.title}>
          <h2>{section.title}</h2>
          {section.body}
        </article>
      ))}
    </section>
  );
}
function isRetirementInputs(value: unknown): value is RetirementInputs {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<RetirementInputs>;
  return Boolean(
    candidate.personalInfo &&
      candidate.existingAssets &&
      candidate.spendingPlan &&
      candidate.assumptions &&
      candidate.strategy &&
      candidate.simulation &&
      Array.isArray(candidate.incomeStreams) &&
      Array.isArray(candidate.contributionSchedules),
  );
}
function oneDecimalPercent(rate: number) {
  return (rate * 100).toFixed(1);
}
function roundedPercent(rate: number) {
  return Number((rate * 100).toFixed(4)).toString();
}
function formatWithCommas(rawValue: string) {
  const numericValue = Number(rawValue);
  if (rawValue === "" || !Number.isFinite(numericValue)) return rawValue;
  return numericValue.toLocaleString("en-CA");
}

function formatCurrency(value: number) {
  return new Intl.NumberFormat("en-CA", {
    style: "currency",
    currency: "CAD",
    maximumFractionDigits: 0,
  }).format(value);
}
function shortCurrency(value: number) {
  if (Math.abs(value) >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (Math.abs(value) >= 1_000) return `$${Math.round(value / 1_000)}K`;
  return `$${Math.round(value)}`;
}
function formatPercent(value: number) {
  return new Intl.NumberFormat("en-CA", {
    style: "percent",
    maximumFractionDigits: 1,
  }).format(value);
}
