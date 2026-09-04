"use client";

import { BadgeDollarSign, BriefcaseBusiness, Check, Landmark, SlidersHorizontal, UsersRound, WalletCards } from "lucide-react";
import ReactECharts from "echarts-for-react";
import type { EChartsOption } from "echarts";
import { createPortal } from "react-dom";
import {
  startTransition,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
} from "react";
import { defaultRetirementInputs } from "@/lib/default-inputs";
import { runMonteCarloSimulation } from "@/lib/monteCarlo";
import {
  generateAnnualReturns,
  projectWithVariableReturns,
} from "@/lib/projectionPath";
import {
  availableTaxYears,
  defaultTaxSettings,
  provinceNames,
} from "@/lib/taxRules";
import { SimulationCharts } from "@/components/SimulationCharts";
import type {
  DeterministicProjection,
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
  const averageInvestmentReturn = projection
    ? projection.years.reduce((sum, year) => sum + year.portfolioReturn, 0) /
      projection.years.length
    : 0;
  const shortfallYears = projection
    ? projection.years.filter(
        (year) => year.spendingTarget > year.netSpendableCash,
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
          "Federal and provincial",
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

  function applyReturnSeed(seed: number) {
    const returns = generateAnnualReturns(inputs, seed);
    const annualReturnOverrides = Object.fromEntries(
      returns.map((rate, index) => [
        inputs.personalInfo.currentAge + index,
        rate,
      ]),
    );
    setInputs((current) => ({
      ...current,
      assumptions: { ...current.assumptions, annualReturnOverrides },
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
    if (scenario) {
      setScenarioName(scenario.name);
      setInputs(structuredClone(scenario.inputs));
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
        setScenarios(
          savedScenarios.filter((scenario) =>
            isRetirementInputs(scenario.inputs),
          ),
        );
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
        <strong>Retirement Planner</strong>
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
                  onChange={(value) =>
                    setNumber("personalInfo.targetDeathAge", value)
                  }
                />
              </div>
              <div className="field-label-shell">
                <MonthSelect
                  value={inputs.personalInfo.birthMonth}
                  onChange={(value) =>
                    setInputs((current) => ({
                      ...current,
                      personalInfo: {
                        ...current.personalInfo,
                        birthMonth: value,
                      },
                    }))
                  }
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
                    onChange={(value) =>
                      setInputs((current) => ({
                        ...current,
                        personalInfo: {
                          ...current.personalInfo,
                          additionalPeople: (
                            current.personalInfo.additionalPeople ?? []
                          ).map((candidate) =>
                            candidate.id === person.id
                              ? { ...candidate, birthMonth: value }
                              : candidate,
                          ),
                        },
                      }))
                    }
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
            people={[
              { id: "primary", label: inputs.personalInfo.label ?? "Primary person" },
              ...(inputs.personalInfo.additionalPeople ?? []).map((person) => ({
                id: person.id,
                label: person.label,
              })),
            ]}
            onChange={(incomeStreams) =>
              setInputs((current) => ({ ...current, incomeStreams }))
            }
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
              <NumberField
                label="GIC / interest income"
                prefix="$"
                tooltip="Guaranteed Investment Certificates, Principal Protected Notes, and similar interest-bearing holdings. Growth is taxed as regular income only when the term below matures (a 1-year term is taxed annually like a T5; a 3-year term compounds tax-deferred for 3 years, then the whole accumulated amount is taxed at once)."
                value={inputs.existingAssets.interestBearingBalance ?? 0}
                onChange={(value) =>
                  setNumber("existingAssets.interestBearingBalance", value)
                }
              />
              <NumberField
                label="GIC term (years)"
                min={1}
                step={1}
                tooltip="How many years the GIC/PPN compounds before it matures and pays out. Withdrawing early still realizes a proportional share of the deferred growth for tax purposes that year."
                value={inputs.existingAssets.interestBearingTermYears ?? 1}
                onChange={(value) =>
                  setNumber("existingAssets.interestBearingTermYears", String(Math.max(1, Math.round(Number(value)))))
                }
              />
              <NumberField
                label="GIC rate"
                suffix="%"
                step={0.1}
                tooltip="The guaranteed rate this GIC/PPN earns, separate from the Return mean/StdDev used for RRSP/TFSA/non-registered accounts. Unlike those, it's a fixed rate every year, not randomized in Monte Carlo."
                value={oneDecimalPercent(inputs.existingAssets.interestBearingRate ?? inputs.assumptions.returnMean)}
                onChange={(value) =>
                  setNumber("existingAssets.interestBearingRate", String(Number(value) / 100))
                }
              />
            </div>
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
                  <NumberField
                    label="GIC / interest income"
                    prefix="$"
                    tooltip="Guaranteed Investment Certificates, Principal Protected Notes, and similar interest-bearing holdings. Growth is taxed as regular income only when the term below matures (a 1-year term is taxed annually like a T5; a 3-year term compounds tax-deferred for 3 years, then the whole accumulated amount is taxed at once)."
                    value={assets.interestBearingBalance ?? 0}
                    onChange={(value) => updateAssets({ interestBearingBalance: Number(value) })}
                  />
                  <NumberField
                    label="GIC term (years)"
                    min={1}
                    step={1}
                    tooltip="How many years this person's GIC/PPN compounds before it matures and pays out. Withdrawing early still realizes a proportional share of the deferred growth for tax purposes that year."
                    value={assets.interestBearingTermYears ?? 1}
                    onChange={(value) => updateAssets({ interestBearingTermYears: Math.max(1, Math.round(Number(value))) })}
                  />
                  <NumberField
                    label="GIC rate"
                    suffix="%"
                    step={0.1}
                    tooltip="The guaranteed rate this person's GIC/PPN earns, separate from the Return mean/StdDev used for RRSP/TFSA/non-registered accounts. It's a fixed rate every year, not randomized in Monte Carlo."
                    value={oneDecimalPercent(assets.interestBearingRate ?? inputs.assumptions.returnMean)}
                    onChange={(value) => updateAssets({ interestBearingRate: Number(value) / 100 })}
                  />
                </div>
              </section>
            );
          })}
          </div>
          <div hidden={activeInputTab !== "Spending"}>
          <SpendingPlanEditor
            spendingPlan={inputs.spendingPlan}
            minimumAge={inputs.personalInfo.currentAge}
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
                  setNumber(
                    "assumptions.returnMean",
                    String(Number(value) / 100),
                  )
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
                  setNumber(
                    "assumptions.returnStdDev",
                    String(Math.max(0, Number(value)) / 100),
                  )
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
                  setInputs((current) => ({
                    ...current,
                    assumptions: {
                      ...current.assumptions,
                      returnFloor: Math.min(
                        Number(value) / 100,
                        current.assumptions.returnCeiling ?? 0.15,
                      ),
                    },
                  }))
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
                  setInputs((current) => ({
                    ...current,
                    assumptions: {
                      ...current.assumptions,
                      returnCeiling: Math.max(
                        Number(value) / 100,
                        current.assumptions.returnFloor ?? -0.08,
                      ),
                    },
                  }))
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

function NumberField({
  label,
  value,
  onChange,
  prefix,
  suffix,
  min,
  step,
  tooltip,
}: {
  label: ReactNode;
  value: number | string;
  onChange: (value: string) => void;
  prefix?: string;
  suffix?: string;
  min?: number;
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
}: {
  label: string;
  value: 60 | 65 | 70;
  onChange: (value: 60 | 65 | 70) => void;
}) {
  return (
    <label className="field-label">
      {label}
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
const monthNames = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
function MonthSelect({
  value,
  onChange,
}: {
  value: number | undefined;
  onChange: (value: number | undefined) => void;
}) {
  return (
    <label className="field-label">
      <span className="field-label-text">
        Birth month
        <FieldHint text="Used to prorate CPP, OAS, and other income streams in the calendar year they start or end, instead of assuming a full year's amount immediately." />
      </span>
      <select
        value={value ?? ""}
        onChange={(event) =>
          onChange(event.target.value === "" ? undefined : Number(event.target.value))
        }
      >
        <option value="">Unknown</option>
        {monthNames.map((name, index) => (
          <option key={name} value={index + 1}>
            {name}
          </option>
        ))}
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
function IncomeStreamsEditor({
  streams,
  minimumAge,
  targetDeathAge,
  people,
  onChange,
}: {
  streams: IncomeStream[];
  minimumAge: number;
  targetDeathAge: number;
  people: Array<{ id: string; label: string }>;
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
        indexationMode: "fullInflation",
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
      {streams.map((stream) => (
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
              value={stream.startAge}
              onChange={(value) =>
                updateStream(stream.id, {
                  startAge: Math.max(minimumAge, Number(value)),
                })
              }
            />
            <NumberField
              label="End age"
              min={minimumAge}
              value={stream.endAge}
              onChange={(value) =>
                updateStream(stream.id, { endAge: Number(value) })
              }
            />
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
          {(stream.taxTreatment === "employment" || stream.taxTreatment === "pension") && (
            <div className="income-contribution-fields">
              <p className="contribution-group-label">Contributions</p>
              <div className="field-grid three-up">
                <NumberField
                  label="RRSP"
                  prefix="$"
                  tooltip="How much of this income gets contributed to RRSP each year. Tax-deductible, reducing taxable income for the year. If left at 0, none of this income is automatically invested — it's assumed spent on living expenses."
                  value={stream.annualRrspContribution ?? 0}
                  onChange={(value) =>
                    updateStream(stream.id, { annualRrspContribution: Number(value) })
                  }
                />
                <NumberField
                  label="TFSA"
                  prefix="$"
                  tooltip="How much of this income (after any RRSP contribution) gets contributed to TFSA each year. After-tax, like non-registered, but all future growth and withdrawals stay completely tax-free."
                  value={stream.annualTfsaContribution ?? 0}
                  onChange={(value) =>
                    updateStream(stream.id, { annualTfsaContribution: Number(value) })
                  }
                />
                <NumberField
                  label="Non-registered"
                  prefix="$"
                  tooltip="How much of this income (after any RRSP/TFSA contribution) gets invested in a non-registered account each year. Comes from after-tax cash, so it's not tax-deductible."
                  value={stream.annualNonRegisteredContribution ?? 0}
                  onChange={(value) =>
                    updateStream(stream.id, { annualNonRegisteredContribution: Number(value) })
                  }
                />
              </div>
            </div>
          )}
        </div>
      ))}
      {streams.length === 0 && (
        <p className="empty-section">No income streams configured.</p>
      )}
    </section>
  );
}
function SpendingPlanEditor({
  spendingPlan,
  minimumAge,
  onChange,
}: {
  spendingPlan: SpendingPlan;
  minimumAge: number;
  onChange: (spendingPlan: SpendingPlan) => void;
}) {
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
          <FieldHint text="Start/end ages here are always based on the primary person's age, even if you've added a second person with a different age. The calendar year shown updates from that." />
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
              value={phase.startAge}
              tooltip={`Age ${phase.startAge} for the primary person = calendar year ${calendarYearForAge(phase.startAge, minimumAge)}`}
              onChange={(value) =>
                updatePhase(phase.id, {
                  startAge: Math.max(minimumAge, Number(value)),
                })
              }
            />
            <NumberField
              label="End age"
              min={minimumAge}
              value={phase.endAge}
              tooltip={`Age ${phase.endAge} for the primary person = calendar year ${calendarYearForAge(phase.endAge, minimumAge)}`}
              onChange={(value) =>
                updatePhase(phase.id, { endAge: Number(value) })
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
function calendarYearForAge(age: number, currentAge: number) {
  return new Date().getFullYear() + (age - currentAge);
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
              return (
                <tr
                  key={year.age}
                  className={
                    phaseIndex >= 0
                      ? `phase-row phase-row-${phaseIndex % 3}`
                      : ""
                  }
                >
                  <td>{year.calendarYear}</td>
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
                  <td>{formatCurrency(year.income.rrspWithdrawal + year.withdrawals.rrsp)}</td>
                  <td>{formatCurrency(year.income.tfsaWithdrawal + year.withdrawals.tfsa)}</td>
                  <td>{formatCurrency(year.income.nonRegisteredWithdrawal + year.withdrawals.nonRegistered)}</td>
                  <td>{formatCurrency(year.income.interest + year.income.interestBearingWithdrawal + year.withdrawals.interestBearing)}</td>
                  <td>{formatCurrency(year.taxes.totalTax)}</td>
                  <td>{formatCurrency(year.openingBalances.rrsp)}</td>
                  <td>{formatCurrency(year.closingBalances.rrsp)}</td>
                  <td>{formatCurrency(year.openingBalances.tfsa)}</td>
                  <td>{formatCurrency(year.closingBalances.tfsa)}</td>
                  <td>{formatCurrency(year.openingBalances.nonRegistered)}</td>
                  <td>{formatCurrency(year.closingBalances.nonRegistered)}</td>
                  <td>{formatCurrency(year.openingBalances.interestBearing)}</td>
                  <td>{formatCurrency(year.closingBalances.interestBearing)}</td>
                  <td>{formatCurrency(year.netSpendableCash)}</td>
                  <td>{formatCurrency(year.estateValue)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
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
  const choices = [
    { id: "draft", name: "Current draft", inputs: draftInputs },
    ...scenarios,
  ];
  const [leftId, setLeftId] = useState("draft");
  const [rightId, setRightId] = useState(scenarios[0]?.id ?? "");
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
          <p>The Dashboard and Ledger show a single "variable-return" projection: one randomized sequence of annual investment returns and inflation (generated from your Assumptions), simulated year by year from your current age to your target death age.</p>
          <p>Monte Carlo re-runs that same year-by-year math hundreds of times, each time with a fresh random sequence of returns/inflation, so you can see the spread of outcomes (best case, worst case, typical case) instead of just one path.</p>
          <p>Every year the engine: adds fixed income (employment, CPP, OAS, pensions), applies mandatory withdrawals (RRIF minimums), draws down accounts in a fixed order to cover any remaining spending need, calculates tax, checks for OAS clawback, and reinvests any leftover cash - then grows all balances by that year's investment return.</p>
        </>
      ),
    },
    {
      title: "People: birth month, province, CPP/OAS payout",
      body: (
        <>
          <p><strong>Birth month</strong> only matters for prorating the first and last year of an age-gated benefit (CPP, OAS, or an income stream with a start/end age). Without it, a benefit starting "at age 65" is assumed to start on your birthday exactly at the start of the simulation year; with it, the tool prorates that first/last year by the fraction of months you actually qualify.</p>
          <p><strong>Province</strong> selects which provincial tax bracket set (and provincial basic personal amount/credit rate) applies on the Tax Info tab. Quebec additionally gets a federal tax abatement, and Ontario gets a provincial surtax on top of its brackets - both are handled automatically once you pick the province.</p>
          <p><strong>CPP/OAS payout %</strong> lets you dial in less than the maximum benefit (e.g. if you didn't contribute the full 39 years, or didn't live in Canada long enough for full OAS).</p>
          <p>Each additional person you add files their <strong>own</strong> tax return with their own brackets, basic personal amount, accounts, and benefits - the household total is just the sum of everyone's numbers, not a joint return.</p>
        </>
      ),
    },
    {
      title: "Income streams",
      body: (
        <>
          <p>Each income stream has a tax treatment (employment, pension, CPP, OAS, RRSP withdrawal, eligible/non-eligible dividend, capital gains, or tax-free) that decides how it's taxed - separate from CPP/OAS calculated automatically from Strategy settings.</p>
          <p>"Indexed to inflation" grows that stream's dollar amount by the simulation's randomized inflation rate every year. Turn it off for something fixed in nominal dollars (e.g. a fixed-payment annuity).</p>
          <p>An income stream can also route part of its amount into RRSP/TFSA/non-registered contributions (e.g. a salary that funds ongoing RRSP contributions) - those land directly in the matching account balance each year.</p>
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
          <p><strong>GIC / interest income</strong>: modeled separately from the market-return accounts because it earns its own fixed rate and is principal-protected (never declines). It compounds tax-deferred for the term you set, then the whole accumulated amount is taxed as ordinary income the year the term matures (like a GIC/PPN, not a T5 issued annually) - unless you withdraw early, which crystallizes a proportional share of the deferred growth immediately.</p>
        </>
      ),
    },
    {
      title: "Spending",
      body: (
        <>
          <p>Spending is defined in phases (e.g. "go-go years" vs. "slow-go years") each with its own annual target and age range. "Indexed to inflation" grows every phase's target by cumulative simulated inflation from today; turned off, spending targets stay fixed in today's dollars.</p>
          <p>Each year, the engine tries to fund that year's target after tax, drawing from accounts in this order: GIC/interest first (no further tax benefit to staying invested), then non-registered, then TFSA, then RRSP. If there isn't enough left in every account, the plan shows a funding shortfall for that year rather than going negative.</p>
        </>
      ),
    },
    {
      title: "Assumptions: what's random and what isn't",
      body: (
        <>
          <p><strong>Return mean/StdDev</strong> and <strong>Inflation mean/StdDev</strong> define a normal-ish (lognormal, bounded) distribution that both the Dashboard/Ledger's single path and every Monte Carlo run draw from independently each year - they're not the same fixed number every year, they're randomized around these values.</p>
          <p><strong>Return floor/ceiling</strong> clip how extreme any single year's randomly drawn return can be, in both the deterministic path and Monte Carlo.</p>
          <p>On the Ledger tab you can manually override specific years' returns (e.g. to model a real historical sequence or stress-test a crash at a specific age) - Monte Carlo ignores these overrides and always randomizes.</p>
          <p>One important simplification: federal/provincial tax brackets, the basic personal amount, TFSA contribution room, and OAS clawback thresholds all inflate forward using the simulation's own inflation rate, but the underlying <em>rates</em> (tax rates, inclusion rate, etc.) never change over the plan - there's no way to model future tax reform.</p>
        </>
      ),
    },
    {
      title: "Strategy",
      body: (
        <>
          <p><strong>CPP/OAS start age</strong> (60/65/70) changes both the monthly benefit amount (early = permanently reduced, late = permanently increased) and how much lifetime benefit you collect.</p>
          <p><strong>Aggressive RRSP meltdown</strong>, once retired, withdraws extra RRSP/RRIF money each year beyond what's needed for spending - just enough to "fill up" your current federal tax bracket without pushing into the next one - to shrink the RRSP before mandatory minimums or death force it out at a worse rate. The "Aggressive RRSP meltdown: impact" charts at the bottom of the Dashboard compare your plan with this toggled on vs. off, holding the randomized return sequence identical so only the withdrawal strategy differs.</p>
        </>
      ),
    },
    {
      title: "Death, estate, and probate",
      body: (
        <>
          <p>When someone reaches their target death age, their accounts either roll over tax-free to a surviving person in the household, or - if no one survives them - are deemed fully disposed: the RRSP/RRIF and any deferred GIC growth become fully taxable ordinary income, and non-registered growth above the ACB becomes a taxable capital gain, all in that final year.</p>
          <p>What's left after that final tax bill is reduced further by the probate fee rate (Assumptions) to produce the final estate value shown on the Dashboard.</p>
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
      title: "Saving, loading, import & export",
      body: (
        <>
          <p><strong>Save</strong> writes your current inputs into your browser's own storage (localStorage, under the key "retirement-planner.scenarios") - nothing is sent to a server. The first time you save a "New Scenario" it creates a new entry; saving again while that scenario is selected overwrites it in place. The scenario picker dropdown and name field let you switch between or rename saved scenarios; renaming (by editing the name field and clicking away) updates the saved copy immediately without needing to press Save.</p>
          <p>Because it's stored in your browser, a saved scenario is only available on that browser/device/profile - clearing site data, using a different browser, or private/incognito mode won't see it. <strong>New</strong> resets the working form back to the defaults without touching anything already saved. <strong>Delete</strong> removes the currently-selected saved scenario (with a confirmation prompt) - it's disabled while you're on "New Scenario" since there's nothing saved to delete yet.</p>
          <p><strong>Export</strong> downloads your current inputs as a standalone <code>.json</code> file (named after the scenario) - use this to back up a scenario outside the browser, or to move it to another device/browser. <strong>Import</strong> reads a previously exported <code>.json</code> file back in as a brand-new saved scenario and switches to it immediately; it validates the file's shape first and silently ignores anything that doesn't look like a valid set of plan inputs.</p>
        </>
      ),
    },
    {
      title: "The other tabs",
      body: (
        <>
          <p><strong>Dashboard</strong>: the single variable-return projection - KPIs, portfolio/spending/tax charts, and the meltdown comparison.</p>
          <p><strong>Ledger</strong>: the same projection as a year-by-year table, where you can override individual years' returns.</p>
          <p><strong>Monte Carlo</strong>: hundreds of randomized runs summarized as percentile bands, plus a failure-rate analysis of how often the plan runs out of money.</p>
          <p><strong>Compare</strong>: run two full scenarios side by side to see how a change in inputs shifts the outcome.</p>
          <p><strong>Tax Info</strong>: the editable federal/provincial bracket tables, basic personal amounts, and credit rates actually used by every calculation in the tool.</p>
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
      Array.isArray(candidate.incomeStreams),
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
