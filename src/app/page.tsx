"use client";

import { BadgeDollarSign, BriefcaseBusiness, Calculator, Check, ChevronDown, Landmark, Menu, Plus, SlidersHorizontal, Trash2, UsersRound, WalletCards, X } from "lucide-react";
import { closestCenter, DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
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
import type { MonteCarloWorkerMessage, WithdrawalOrderWorkerMessage } from "@/lib/monteCarlo.worker";
import { forecastInputsForYear, sampleAnnualReturn } from "@/lib/simulationEngine";
import { hasCompleteFundingSummary, isReturnOverrideUpdate, projectWithVariableReturns } from "@/lib/projectionPath";
import { accountEntriesFor, accountTotal, assetsWithAccounts } from "@/lib/accounts";
import { isActualsTracking, selectedActualsAccounts } from "@/lib/actuals";
import {
  availableTaxYears,
  defaultTaxSettings,
  provinceNames,
} from "@/lib/taxRules";
import { ageYearLabel, maxHouseholdAge, monthYearLabel, parsePlanDate, planDateFor, withPlanDate } from "@/lib/planDates";
import { calculateCppAnnualBenefit, calculateOasAnnualBenefit, cppAnnualMaximum, oasAnnualMaximum } from "@/lib/governmentBenefits";
import { SimulationCharts } from "@/components/SimulationCharts";
import { ActualsView } from "@/components/ActualsView";
import { projectWorkingForecast, workingForecastContext, workingForecastRebaseMarkers, type WithdrawalObjective, type WithdrawalOrderSuggestion } from "@/lib/workingForecast";
import { ScenarioFileDialog, ScenarioImportConflictDialog } from "@/components/ScenarioFileDialog";
import { decryptScenario, encryptScenario, isEncryptedScenario } from "@/lib/scenarioEncryption";
import type {
  ActualsTracking,
  DeterministicProjection,
  ContributionSchedule,
  ExistingAssets,
  GicBufferSettings,
  GicMaturityAction,
  InvestmentAccount,
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

type MonteCarloProgress = { completed: number; total: number };

type ProjectionSnapshot = {
  inputs: RetirementInputs;
  calculator: (inputs: RetirementInputs) => DeterministicProjection;
  result: DeterministicProjection | null;
  error?: string;
};

export default function Home() {
  const [inputs, setInputs] = useState(defaultRetirementInputs);
  const planYear = planDateFor(inputs).getFullYear();
  const [activeView, setActiveView] = useState("Dashboard");
  const [accountsBalanceView, setAccountsBalanceView] = useState<"actuals" | "starting">("actuals");
  const selectedAccounts = selectedActualsAccounts(inputs);
  const [activeInputTab, setActiveInputTab] = useState("People");
  const [projectionSnapshot, setProjectionSnapshot] = useState<ProjectionSnapshot | null>(
    null,
  );
  const projectionCalculator = projectWorkingForecast;
  const workingContext = workingForecastContext(inputs);
  const snapshotIsCurrent = Boolean(projectionSnapshot && projectionSnapshot.calculator === projectionCalculator
    && (projectionSnapshot.inputs === inputs || (workingContext && projectionSnapshot.inputs.actuals === inputs.actuals)));
  const dashboardInputs = useMemo(() => workingContext ? { ...workingContext.baseline.inputs, actuals: inputs.actuals } : inputs,
    [workingContext?.baseline, inputs.actuals, workingContext ? null : inputs]);
  const projection = snapshotIsCurrent && hasCompleteFundingSummary(projectionSnapshot?.result) ? projectionSnapshot?.result ?? null : null;
  const projectionError = snapshotIsCurrent ? projectionSnapshot?.error ?? "" : "";
  const ledgerUpdating = !snapshotIsCurrent && projectionSnapshot?.calculator === projectionCalculator
    && isReturnOverrideUpdate(projectionSnapshot.inputs, inputs) && hasCompleteFundingSummary(projectionSnapshot.result);
  const ledgerProjection = projection ?? (ledgerUpdating ? projectionSnapshot?.result ?? null : null);
  const [monteCarloOutput, setMonteCarloOutput] =
    useState<SimulationOutput | null>(null);
  const [monteCarloProgress, setMonteCarloProgress] = useState<MonteCarloProgress | null>(null);
  const [monteCarloError, setMonteCarloError] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const [scenarios, setScenarios] = useState<SavedScenario[]>([]);
  const [activeScenarioId, setActiveScenarioId] = useState("draft");
  const [isDraftDismissed, setIsDraftDismissed] = useState(false);
  const [scenarioName, setScenarioName] = useState("New Scenario");
  const [justSaved, setJustSaved] = useState(false);
  const [fileDialog, setFileDialog] = useState<
    | { mode: "export"; payload: string; name: string }
    | { mode: "import"; payload: unknown; name: string }
    | null
  >(null);
  const [pendingImport, setPendingImport] = useState<{ scenario: SavedScenario; existingId: string } | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const gicBuffer = inputs.strategy.gicBuffer ?? defaultGicBuffer;
  const updateGicBuffer = (patch: Partial<GicBufferSettings>) =>
    setInputs((current) => ({
      ...current,
      strategy: { ...current.strategy, gicBuffer: { ...(current.strategy.gicBuffer ?? defaultGicBuffer), ...patch } },
    }));
  const startingGicBalance = accountEntriesFor(inputs.existingAssets, inputs.personalInfo.currentAge, inputs.assumptions.returnMean)
    .filter((account) => account.returnType !== "market").reduce((sum, account) => sum + account.balance, 0)
    + (inputs.personalInfo.additionalPeople ?? []).reduce((sum, person) => sum + accountEntriesFor(person.existingAssets, person.currentAge, inputs.assumptions.returnMean)
      .filter((account) => account.returnType !== "market").reduce((total, account) => total + account.balance, 0), 0);
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
  const lifetimeOasRecovery = projection ? projection.years.reduce((sum, year) => sum + year.oasClawback, 0) : 0;
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
        ["OAS recovered", formatCurrency(lifetimeOasRecovery), "Lifetime OAS clawed back by the government"],
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
      const target = next[section];
      if (target && typeof target === "object") Object.assign(target, { [field]: numberValue });
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
    setInputs((current) => {
      const assumptions = { ...current.assumptions, ...patch, annualReturnOverrides: {} };
      assumptions.returnFloor = Math.max(-0.999, assumptions.returnFloor);
      assumptions.returnCeiling = Math.max(assumptions.returnFloor, assumptions.returnCeiling);
      assumptions.returnMean = Math.min(assumptions.returnCeiling, Math.max(assumptions.returnFloor, assumptions.returnMean));
      return { ...current, assumptions };
    });
  }

  function applyReturnSeed(seed: number) {
    // Clearing overrides (rather than freezing every year's value) lets the Ledger keep regenerating live from the
    // seed whenever average/minimum/maximum change, instead of the whole path getting stuck at whatever it was
    // when this seed was picked. Any individual years you've hand-edited via the Ledger's Return cells still stick.
    setInputs((current) => ({
      ...current,
      assumptions: { ...current.assumptions, annualReturnOverrides: {} },
      simulation: { ...current.simulation, randomSeed: seed },
    }));
  }

  function persistScenarios(nextScenarios: SavedScenario[]) {
    window.localStorage.setItem(
      scenarioStorageKey,
      JSON.stringify(nextScenarios),
    );
    setScenarios(nextScenarios);
  }

  function createNewScenario() {
    setIsDraftDismissed(false);
    setActiveScenarioId("draft");
    setScenarioName("New Scenario");
    setInputs(withPlanDate(structuredClone(defaultRetirementInputs)));
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
      inputs: withPlanDate(structuredClone(inputs)),
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

  function saveActuals(actuals: ActualsTracking, rebasedInputs?: RetirementInputs) {
    const nextInputs = { ...(rebasedInputs ?? inputs), actuals };
    const existing = scenarios.find((scenario) => scenario.id === activeScenarioId);
    const scenario: SavedScenario = {
      id: existing?.id ?? `scenario-${crypto.randomUUID()}`,
      name: scenarioName.trim() || existing?.name || "New Scenario",
      inputs: structuredClone(nextInputs),
      updatedAt: new Date().toISOString(),
    };
    persistScenarios(existing ? scenarios.map((entry) => entry.id === scenario.id ? scenario : entry) : [...scenarios, scenario]);
    setInputs(nextInputs);
    setActiveScenarioId(scenario.id);
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
      setInputs(withPlanDate(structuredClone(scenario.inputs), new Date(scenario.updatedAt)));
    } else if (scenario) {
      window.alert(
        `"${scenario.name}" uses an older data format and cannot be loaded. Delete it and create a new scenario.`,
      );
    }
  }

  function deleteScenario() {
    if (activeScenarioId === "draft") {
      const nextScenario = scenarios.find((scenario) => isRetirementInputs(scenario.inputs)) ?? scenarios[0];
      if (!nextScenario || !window.confirm(`Discard New Scenario and load ${nextScenario.name}? Any unsaved draft changes will be lost.`)) return;
      setIsDraftDismissed(true);
      loadScenario(nextScenario.id);
      return;
    }
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
    setFileDialog({ mode: "export", payload, name: activeScenario?.name ?? "retirement-scenario" });
  }

  function importScenarioData(parsed: unknown, fileName: string) {
    if (!parsed || typeof parsed !== "object") throw new Error("This file does not contain a valid scenario.");
    const importedInputs = "inputs" in parsed ? parsed.inputs : parsed;
    if (!isRetirementInputs(importedInputs)) throw new Error("This file does not contain a supported scenario.");
    const importedScenario: SavedScenario = {
      id: `scenario-${Date.now()}`,
      name: "name" in parsed && typeof parsed.name === "string" && parsed.name.trim()
        ? parsed.name.trim() : fileName.replace(/\.(encrypted\.)?json$/i, "").trim() || "Imported Scenario",
      inputs: withPlanDate(importedInputs, "updatedAt" in parsed && typeof parsed.updatedAt === "string" ? new Date(parsed.updatedAt) : new Date()),
      updatedAt: new Date().toISOString(),
    };
    const existingScenario = scenarios.find((scenario) => scenario.name.trim().toLowerCase() === importedScenario.name.toLowerCase());
    if (existingScenario) {
      setPendingImport({ scenario: importedScenario, existingId: existingScenario.id });
      return;
    }
    saveImportedScenario(importedScenario);
  }

  function saveImportedScenario(importedScenario: SavedScenario, replaceId?: string) {
    persistScenarios(replaceId === undefined
      ? [...scenarios, importedScenario]
      : scenarios.map((scenario) => scenario.id === replaceId ? importedScenario : scenario));
    setActiveScenarioId(importedScenario.id);
    setScenarioName(importedScenario.name);
    setInputs(structuredClone(importedScenario.inputs));
  }

  function resolveImportConflict(choice: "copy" | "replace") {
    if (!pendingImport) return;
    const { scenario, existingId } = pendingImport;
    if (choice === "replace") {
      saveImportedScenario({ ...scenario, id: existingId }, existingId);
    } else {
      const existingNames = new Set(scenarios.map((saved) => saved.name.trim().toLowerCase()));
      let copyNumber = 1;
      let name = `${scenario.name} (copy)`;
      while (existingNames.has(name.toLowerCase())) {
        copyNumber += 1;
        name = `${scenario.name} (copy ${copyNumber})`;
      }
      saveImportedScenario({ ...scenario, name });
    }
    setPendingImport(null);
  }

  async function submitScenarioFile(password?: string) {
    if (!fileDialog) return;
    if (fileDialog.mode === "import") {
      const plaintext = await decryptScenario(fileDialog.payload, password ?? "");
      importScenarioData(JSON.parse(plaintext), fileDialog.name);
      return;
    }
    const payload = password === undefined ? fileDialog.payload : await encryptScenario(fileDialog.payload, password);
    const downloadUrl = URL.createObjectURL(new Blob([payload], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = downloadUrl;
    const fileName = fileDialog.name.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "retirement-scenario";
    link.download = `${fileName}${password === undefined ? ".json" : ".encrypted.json"}`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
  }

  async function importScenario(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const parsed: unknown = JSON.parse(await file.text());
      if (isEncryptedScenario(parsed)) {
        setFileDialog({ mode: "import", payload: parsed, name: file.name });
      } else {
        importScenarioData(parsed, file.name);
      }
    } catch (cause) {
      window.alert(cause instanceof SyntaxError ? "This file is not valid scenario JSON." : cause instanceof Error ? cause.message : "Unable to import this scenario.");
    }
  }

  useEffect(() => {
    setInputs((current) => withPlanDate(current));
    try {
      const savedScenarios = JSON.parse(
        window.localStorage.getItem(scenarioStorageKey) ?? "[]",
      ) as SavedScenario[];
      if (Array.isArray(savedScenarios)) {
        const datedScenarios = savedScenarios.map((scenario) => isRetirementInputs(scenario.inputs)
          ? { ...scenario, inputs: withPlanDate(scenario.inputs, new Date(scenario.updatedAt)) }
          : scenario);
        setScenarios(datedScenarios);
        if (datedScenarios.some((scenario, index) => scenario.inputs !== savedScenarios[index].inputs)) {
          window.localStorage.setItem(scenarioStorageKey, JSON.stringify(datedScenarios));
        }
      }
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
    if (snapshotIsCurrent) return;
    setIsRunning(true);
    const debounceTimer = window.setTimeout(() => {
      try {
        const nextProjection = projectionCalculator(inputs);
        if (!hasCompleteFundingSummary(nextProjection)) throw new Error("Incomplete funding summary");
        startTransition(() => {
          setProjectionSnapshot({ inputs, calculator: projectionCalculator, result: nextProjection });
          setIsRunning(false);
        });
      } catch (failure) {
        setProjectionSnapshot({ inputs, calculator: projectionCalculator, result: null, error: `${failure instanceof Error ? failure.message : "Unable to calculate a complete funding breakdown."} Your inputs have been kept.` });
        setIsRunning(false);
      }
    }, 400);

    return () => window.clearTimeout(debounceTimer);
  }, [inputs, projectionCalculator, snapshotIsCurrent]);

  useEffect(() => {
    if (activeView !== "Monte Carlo") return;
    let worker: Worker | null = null;
    let cancelled = false;
    function fail(message: string) {
      if (cancelled) return;
      setMonteCarloError(message);
      setMonteCarloProgress(null);
      worker?.terminate();
    }
    const simulationTimer = window.setTimeout(() => {
      setMonteCarloOutput(null);
      setMonteCarloError("");
      setMonteCarloProgress({ completed: 0, total: inputs.simulation.iterations });
      try {
        worker = new Worker(new URL("../lib/monteCarlo.worker.ts", import.meta.url), { type: "module" });
        worker.onmessage = (event: MessageEvent<MonteCarloWorkerMessage>) => {
          if (cancelled) return;
          const message = event.data;
          if (message.type === "progress") {
            setMonteCarloProgress({ completed: message.completed, total: message.total });
          } else if (message.type === "complete") {
            setMonteCarloOutput(message.output);
            setMonteCarloProgress(null);
            worker?.terminate();
          } else {
            fail(message.message);
          }
        };
        worker.onerror = (event) => {
          event.preventDefault();
          fail("Unable to run the Monte Carlo simulation. Please try again.");
        };
        worker.onmessageerror = () => fail("Unable to read the simulation results. Please try again.");
        worker.postMessage(inputs);
      } catch {
        fail("Unable to start the Monte Carlo simulation. Please try again.");
      }
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(simulationTimer);
      worker?.terminate();
    };
  }, [activeView, inputs]);

  return (
    <main className={`planner-shell${activeView === "Accounts" ? " planner-shell--accounts" : ""}${activeView === "Actuals" ? " planner-shell--actuals" : ""}`}>
      {fileDialog && <ScenarioFileDialog mode={fileDialog.mode} onSubmit={submitScenarioFile} onClose={() => setFileDialog(null)} />}
      {pendingImport && <ScenarioImportConflictDialog name={pendingImport.scenario.name} onResolve={resolveImportConflict} onClose={() => setPendingImport(null)} />}
      <header className="topbar">
        <div className="brand-mark" aria-hidden="true">
          RP
        </div>
        <strong>Retirement Planner <span className="app-version">v{(process.env.NEXT_PUBLIC_APP_VERSION || packageJson.version).replace(/^v/, "")}</span></strong>
        <div className="scenario-actions">
          <select
            aria-label="Scenario"
            value={activeScenarioId}
            onChange={(event) => loadScenario(event.target.value)}
          >
            {!isDraftDismissed && <option value="draft">New Scenario</option>}
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
            disabled={activeScenarioId === "draft" && scenarios.length === 0}
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
      <div className={`planner-layout${activeView === "Accounts" ? " planner-layout--accounts" : ""}`}>
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
                          oasPayoutRate: 1,
                        },
                      ],
                    },
                  }))
                }
              >
                Add person
              </button>
            </div>
            <label className="field-label">
              Plan date
              <input
                type="date"
                value={inputs.planDate ?? ""}
                title="Reference date for all starting ages and account balances. Saved with the scenario and never advanced automatically."
                onChange={(event) => {
                  const planDate = event.target.value;
                  if (parsePlanDate(planDate)) setInputs((current) => ({ ...current, planDate }));
                }}
              />
            </label>
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
                            cppPayoutRate: nextPrimary.cppPayoutRate,
                            cppAnnualEstimates: nextPrimary.cppAnnualEstimates,
                            receivesOas: nextPrimary.receivesOas,
                            oasPayoutRate: nextPrimary.oasPayoutRate,
                            oasResidency: nextPrimary.oasResidency,
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
                  label="Age at plan date"
                  value={inputs.personalInfo.currentAge}
                  onChange={(value) =>
                    setNumber("personalInfo.currentAge", value)
                  }
                />
                <NumberField
                  label="Death age"
                  value={inputs.personalInfo.targetDeathAge}
                  tooltip={`Dies ${monthYearLabel(inputs.personalInfo, inputs.personalInfo.targetDeathAge, planYear)}`}
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
                  label="CPP at 65 (% of maximum)"
                  min={0}
                  step={1}
                  suffix="%"
                  tooltip={`At ${inputs.strategy.cppStartAge}, ${formatCurrency(calculateCppAnnualBenefit(cppAnnualMaximum * (inputs.personalInfo.cppPayoutRate ?? 0.6), inputs.strategy.cppStartAge, inputs.personalInfo.cppAnnualEstimates))} per year before tax. This percentage is the age-65 baseline, not the age-60 reduction. A custom start-age estimate in Strategy Lab overrides the percentage for that age.`}
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
                    label="Age at plan date"
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
                    tooltip={`Dies ${monthYearLabel(person, person.targetDeathAge, planYear)}`}
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
                    label="CPP at 65 (% of maximum)"
                    min={0}
                    step={1}
                    suffix="%"
                      tooltip={`At ${inputs.strategy.cppStartAge}, ${formatCurrency(calculateCppAnnualBenefit(cppAnnualMaximum * (person.cppPayoutRate ?? 0.6), inputs.strategy.cppStartAge, person.cppAnnualEstimates))} per year before tax. A custom start-age estimate in Strategy Lab overrides this age-65 baseline percentage for that age.`}
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
            planYear={planYear}
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
            planYear={planYear}
            schedules={inputs.contributionSchedules}
            people={[
              { id: "primary", label: inputs.personalInfo.label ?? "Primary person", currentAge: inputs.personalInfo.currentAge },
              ...(inputs.personalInfo.additionalPeople ?? []).map((person) => ({ id: person.id, label: person.label, currentAge: person.currentAge })),
            ]}
            onChange={(contributionSchedules) => setInputs((current) => ({ ...current, contributionSchedules }))}
          />
          </div>
          <div hidden={activeInputTab !== "Spending"}>
          <SpendingPlanEditor
            planYear={planYear}
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
                label="Average annual return"
                min={Number(oneDecimalPercent(inputs.assumptions.returnFloor))}
                max={Number(oneDecimalPercent(inputs.assumptions.returnCeiling))}
                step={0.1}
                suffix="%"
                value={oneDecimalPercent(inputs.assumptions.returnMean)}
                tooltip="Expected arithmetic average of annual investment returns, before inflation. The distribution is weighted across the minimum and maximum to target this average. Individual retirement paths can average more or less; this is not a guaranteed compounded growth rate."
                onChange={(value) =>
                  setReturnAssumption({ returnMean: Number(value) / 100 })
                }
              />
              <NumberField
                label="Minimum annual return"
                min={-99.9}
                step={0.1}
                suffix="%"
                value={oneDecimalPercent(
                  inputs.assumptions.returnFloor ?? -0.08,
                )}
                tooltip="Hard lower bound for generated annual returns. Values near this bound are possible, but exact endpoints are not forced. No simulated annual return will be worse; real markets can be. Widening the range changes the distribution and retirement risk."
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
                label="Maximum annual return"
                step={0.1}
                suffix="%"
                value={oneDecimalPercent(
                  inputs.assumptions.returnCeiling ?? 0.15,
                )}
                tooltip="Hard upper bound for generated annual returns. The full range is smoothly weighted to target the requested average, not concentrated around a bell curve. Exact endpoints are not forced. If the average equals a bound, all annual draws equal that bound."
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
                floor={inputs.assumptions.returnFloor ?? -0.08}
                ceiling={inputs.assumptions.returnCeiling ?? 0.15}
              />
            )}
            <p className="section-note">
              Annual return assumptions apply to both the Dashboard and Monte Carlo. The average is an arithmetic expectation, not guaranteed compounded growth; minimum and maximum are simulation limits, not market guarantees.
            </p>
          </section>
          </div>
          <div className="strategy-inputs" hidden={activeInputTab !== "Strategy"}>
          <section className="input-section">
            <h2>Withdrawal strategy</h2>
            <div className="field-label-text strategy-field-label">
              <span>Withdrawal order</span>
              <FieldHint text="Your preferred account order for funding spending after income and mandatory RRIF withdrawals. Tax-aware mode preserves this order and optimizes between people; it may use the next non-registered account ahead of RRSPs only to reduce OAS recovery and improve after-tax cash. TFSA is not promoted for tax savings. The GIC buffer rule still applies." />
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
                value={inputs.strategy.withdrawalFrequency ?? "monthly"}
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
              <input type="checkbox" checked={inputs.strategy.taxAwareWithdrawals ?? false} onChange={(event) => setInputs((current) => ({
                ...current, strategy: { ...current.strategy, taxAwareWithdrawals: event.target.checked },
              }))} />
              Tax-aware household withdrawals
              <FieldHint text="Uses your withdrawal order as the baseline and chooses the more tax-efficient person within the first available account type. When non-registered is the next available account after RRSP, it may supplement from non-registered funds only if that reduces additional OAS recovery and improves after-tax cash. It does not jump to TFSA for lower tax. Mandatory RRIF withdrawals and the GIC buffer rule still apply. Includes CPP income and eligible pension splitting when enabled. Can be combined with aggressive RRSP meltdown, which runs after spending is funded and can increase current tax or OAS recovery. This is a current-cash-flow heuristic, not a lifetime optimum." />
            </label>
            <label className="check-row emphasis">
              <input type="checkbox" checked={inputs.strategy.pensionIncomeSplitting?.enabled ?? false}
                disabled={(inputs.personalInfo.additionalPeople ?? []).length === 0}
                onChange={(event) => setInputs((current) => ({ ...current, strategy: { ...current.strategy,
                  pensionIncomeSplitting: { enabled: event.target.checked },
                } }))} />
              Eligible pension income splitting
              <FieldHint text="Assumes the primary person and first additional person are eligible spouses or common-law partners meeting CRA residency and relationship requirements. Searches an annual allocation of up to 50% of one partner's eligible pension income to reduce combined income tax and OAS recovery. Eligible employer pensions do not require RRSP conversion. To split registered-account withdrawals, the RRSP must be converted to a RRIF and the donor must generally be at least 65; set the RRIF conversion age in Accounts. Ordinary RRSP withdrawals, CPP and OAS are not eligible. CPP pension sharing is separate. The split changes taxable income, not cash ownership, and does not model withholding or refund timing." />
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
              <FieldHint text="Withdraws additional RRSP/RRIF funds after spending is funded, aiming to fill the next federal ordinary-income bracket. Can be combined with tax-aware household withdrawals and eligible pension splitting. Final income tax and OAS recovery are recalculated afterward; the extra withdrawal can increase current tax or reduce OAS. Eligible surplus is reinvested under the model's existing rules." />
            </label>
          </section>
          <section className="input-section">
            <div className="field-label-text strategy-section-heading">
              <h2>GIC / HISA buffer strategy</h2>
              <FieldHint text="Applies to all GIC / interest-bearing holdings, including PPNs and HISAs. Instead of always drawing these holdings in a fixed order position, hold them in reserve while the market's own return (isolated from your withdrawals) is near its peak, and draw them first once the market is down significantly from that peak - so you're not selling depressed investments to fund spending. Once the market recovers, the buffer is reserved again and (optionally) topped up from leftover cash. HISAs use the Interest-bearing savings return treatment and an assumed constant annual rate." />
            </div>
            <label className="check-row emphasis">
              <input
                type="checkbox"
                checked={gicBuffer.enabled}
                onChange={(event) => updateGicBuffer({ enabled: event.target.checked })}
              />{" "}
              Reserve the buffer for down markets
            </label>
            {gicBuffer.enabled && (
              <>
                <div className="field-grid two-up">
                  <NumberField
                    label="Draw trigger"
                    suffix="%"
                    step={1}
                    tooltip="How far the market portfolio (RRSP+TFSA+non-registered) has to fall from its highest-ever value before the GIC / HISA buffer starts being drawn first. A single bad year rarely justifies this; 10-15% (a real correction, not just noise) is a reasonable starting point."
                    value={oneDecimalPercent(gicBuffer.triggerDrawdown)}
                    onChange={(value) => updateGicBuffer({ triggerDrawdown: Number(value) / 100 })}
                  />
                  <NumberField
                    label="Recovery threshold"
                    suffix="%"
                    step={1}
                    tooltip="Once drawing the GIC / HISA buffer, the market has to recover back to within this % of its old peak before the buffer reverts to being reserved (and refilled, if enabled). Keep this lower than the draw trigger, or it'll flip back and forth every year."
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
                  Refill the buffer from leftover cash once the market recovers
                </label>
                {gicBuffer.refillFromSurplus && (
                  <NumberField
                    label="Refill target balance"
                    prefix="$"
                    tooltip="Balance to top the GIC / HISA buffer back up toward using leftover cash (e.g. RRIF minimums exceeding spending need) while reserved. Defaults to the household's combined starting interest-bearing balance if left blank."
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
            {["Dashboard", "Accounts", "Ledger", "Actuals", "Monte Carlo", "Strategy Lab", "Compare", "Tax Info", "Guide"].map(
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
                  : activeView === "Accounts"
                    ? "Accounts & holdings"
                  : activeView === "Actuals"
                    ? "Plan vs. actuals"
                  : activeView === "Ledger"
                    ? "Year-by-year ledger"
                    : activeView === "Monte Carlo"
                      ? "Monte Carlo simulation"
                      : activeView === "Strategy Lab"
                        ? "Withdrawal strategy & spending"
                      : activeView === "Compare"
                        ? "Scenario comparison"
                        : activeView === "Guide"
                          ? "How this tool works"
                          : "Tax information"}
              </h2>
              <p>
                {activeView === "Tax Info"
                  ? `Editable ${inputs.taxSettings.taxYear} tax rules from ${inputs.taxSettings.source}.`
                  : activeView === "Accounts"
                    ? selectedAccounts && accountsBalanceView === "actuals" ? `As of ${selectedAccounts.date} · ${selectedAccounts.baseline.name}` : `Plan starting balances · ${inputs.planDate ?? planYear}`
                  : activeView === "Actuals"
                    ? `${inputs.actuals?.baselines.length ?? 0} frozen ${inputs.actuals?.baselines.length === 1 ? "baseline" : "baselines"} · ${inputs.actuals?.observations.length ?? 0} balance ${inputs.actuals?.observations.length === 1 ? "entry" : "entries"}`
                  : activeView === "Guide"
                    ? "Plain-language notes on every input and assumption in the planner."
                    : activeView === "Monte Carlo"
                      ? "Randomized outcomes for risk testing."
                      : activeView === "Strategy Lab"
                        ? workingContext ? `Working forecast · ${workingContext.asOf}` : `Ledger path · seed ${inputs.simulation.randomSeed ?? 42}`
                      : isRunning
                        ? "Updating projection..."
                        : projection
                          ? "Variable-return projection is ready for review."
                          : "Projection will run automatically."}
              </p>
            </div>
          </div>
          {activeView === "Accounts" && <AccountsView inputs={inputs} onChange={setInputs} snapshot={selectedAccounts} balanceView={accountsBalanceView} onBalanceViewChange={setAccountsBalanceView} />}
          {activeView === "Actuals" && <ActualsView key={activeScenarioId} inputs={inputs} projection={projection} onChange={saveActuals} onOpenAccounts={() => setActiveView("Accounts")} />}
          <div className="strategy-workspace" hidden={activeView !== "Strategy Lab"} key={`strategy-${activeScenarioId}`}>
            <section className="strategy-comparison-section">
              <h2>Compare withdrawal & spending strategies</h2>
              <WithdrawalOrderAdvisor inputs={inputs} onApply={(result) => setInputs((current) => ({
                ...current, strategy: { ...current.strategy, withdrawalOrder: [...result.suggested.order] },
                simulation: { ...current.simulation, randomSeed: result.randomSeed },
              }))} onApplySpending={(result, choice) => {
                const candidate = result[choice];
                const maximum = candidate.maximumSpending;
                if (!maximum) return;
                setInputs((current) => ({
                  ...current, spendingPlan: maximum.spendingPlan,
                  strategy: { ...current.strategy, withdrawalOrder: [...candidate.order] },
                  simulation: { ...current.simulation, randomSeed: result.randomSeed },
                }));
              }} />
            </section>
            <GovernmentBenefitsStrategy inputs={inputs} onChange={setInputs} visible={activeView === "Strategy Lab"} />
          </div>
          {activeView === "Dashboard" && (
            <DashboardView
              kpis={kpis}
              inputs={dashboardInputs}
              projection={projection}
            />
          )}
          {activeView === "Ledger" && (
            <LedgerView
              inputs={inputs}
              projection={ledgerProjection}
              updating={ledgerUpdating}
              error={projectionError}
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
            <MonteCarloView simulationOutput={monteCarloOutput} progress={monteCarloProgress} error={monteCarloError} />
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

function SortableAccountRows({ id, children }: {
  id: string;
  children: (handle: Pick<ReturnType<typeof useSortable>, "attributes" | "listeners" | "setActivatorNodeRef">) => ReactNode;
}) {
  const { attributes, listeners, setActivatorNodeRef, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  return (
    <tbody ref={setNodeRef} className={isDragging ? "accounts-dragging" : undefined} style={{ transform: CSS.Transform.toString(transform ? { ...transform, x: 0 } : null), transition }}>
      {children({ attributes, listeners, setActivatorNodeRef })}
    </tbody>
  );
}

function AccountsView({ inputs, onChange, snapshot, balanceView, onBalanceViewChange }: {
  inputs: RetirementInputs;
  onChange: (inputs: RetirementInputs) => void;
  snapshot: ReturnType<typeof selectedActualsAccounts>;
  balanceView: "actuals" | "starting";
  onBalanceViewChange: (view: "actuals" | "starting") => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const people = [
    { ...inputs.personalInfo, id: "primary", existingAssets: inputs.existingAssets },
    ...(inputs.personalInfo.additionalPeople ?? []),
  ].map((person) => ({ ...person, accounts: accountEntriesFor(person.existingAssets, person.currentAge, inputs.assumptions.returnMean) }));
  const householdTotal = people.reduce((total, person) => total + accountTotal(person.accounts), 0);
  const updatePerson = (id: string, assets: ExistingAssets | undefined, rrifConversionAge: number | undefined) => onChange(id === "primary"
    ? { ...inputs, existingAssets: assets ?? inputs.existingAssets, personalInfo: { ...inputs.personalInfo, rrifConversionAge } }
    : { ...inputs, personalInfo: { ...inputs.personalInfo, additionalPeople: inputs.personalInfo.additionalPeople.map((person) => person.id === id
      ? { ...person, existingAssets: assets, rrifConversionAge } : person) } });
  const toggleDetails = (key: string) => setExpanded((current) => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });
  const balanceControls = snapshot && <div className="accounts-balance-modes" role="group" aria-label="Account balance view">
    <button type="button" aria-pressed={balanceView === "actuals"} onClick={() => onBalanceViewChange("actuals")}>Selected baseline</button>
    <button type="button" aria-pressed={balanceView === "starting"} onClick={() => onBalanceViewChange("starting")}>Plan starting balances</button>
    <span>{balanceView === "actuals" ? `${snapshot.isActuals ? "Recorded balances" : "Baseline starting balances"} · ${snapshot.date}` : `Editable inputs · ${inputs.planDate ?? "Plan date"}`}</span>
  </div>;
  if (snapshot && balanceView === "actuals") return <div className="accounts-view">
    {balanceControls}
    <div className="accounts-total-band"><div><span>Household total</span><output aria-label="Household account total">{formatCurrency(snapshot.total)}</output></div><span>{snapshot.baseline.name} · {snapshot.accounts.length} {snapshot.accounts.length === 1 ? "account" : "accounts"} · Read-only</span></div>
    {snapshot.baseline.people.map((person) => {
      const accounts = snapshot.accounts.filter((account) => account.ownerId === person.id);
      const total = accounts.reduce((sum, account) => sum + account.balance, 0);
      return <section className="accounts-person" key={person.id} aria-label={`${person.label} accounts`}>
        <div className="accounts-person-heading"><div><h2>{person.label}</h2><span>{accounts.length} {accounts.length === 1 ? "account" : "accounts"}</span></div><output aria-label={`${person.label} account subtotal`}>{formatCurrency(total)}</output></div>
        <div className="accounts-table-wrap"><table className="accounts-table accounts-snapshot-table"><thead><tr><th scope="col">Account name</th><th scope="col">Balance</th><th scope="col">Account type</th><th scope="col">Return treatment</th></tr></thead><tbody>
          {accounts.map((account) => <tr key={account.key}><th scope="row">{account.name}</th><td>{formatCurrency(account.balance)}</td><td>{account.type === "rrsp" ? "RRSP / RRIF" : account.type === "tfsa" ? "TFSA" : "Non-registered"}</td><td>{account.returnType === "market" ? "Market-linked" : account.returnType === "savings" ? "Interest-bearing savings" : "Fixed-rate GIC / PPN"}</td></tr>)}
          {accounts.length === 0 && <tr><td colSpan={4} className="accounts-empty">No active accounts</td></tr>}
        </tbody><tfoot><tr><th scope="row">{person.label} total</th><td>{formatCurrency(total)}</td><td colSpan={2} /></tr></tfoot></table></div>
      </section>;
    })}
  </div>;
  return (
    <div className="accounts-view">
      {balanceControls}
      <div className="accounts-total-band">
        <div><span>Household total</span><output aria-label="Household account total">{formatCurrency(householdTotal)}</output></div>
        <span>{people.length} {people.length === 1 ? "person" : "people"} · {people.reduce((count, person) => count + person.accounts.length, 0)} accounts</span>
      </div>
      {people.map((person) => {
        const saveAccounts = (accounts: InvestmentAccount[]) => updatePerson(person.id, assetsWithAccounts(person.existingAssets, accounts, person.currentAge), person.rrifConversionAge);
        const updateAccount = (id: string, patch: Partial<InvestmentAccount>) => saveAccounts(person.accounts.map((account) => account.id === id ? { ...account, ...patch } : account));
        return (
          <section className="accounts-person" key={person.id} aria-label={`${person.label || "Person"} accounts`}>
            <div className="accounts-person-heading">
              <div><h2>{person.label || "Person"}</h2><span>{person.accounts.length} {person.accounts.length === 1 ? "account" : "accounts"}</span></div>
              <output aria-label={`${person.label || "Person"} account subtotal`}>{formatCurrency(accountTotal(person.accounts))}</output>
              <button type="button" className="button button-quiet accounts-add" onClick={() => saveAccounts([...person.accounts, {
                id: `account-${crypto.randomUUID()}`, name: "New account", balance: 0, type: "rrsp", returnType: "market",
              }])}><Plus size={15} />Add account</button>
            </div>
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={({ active, over }) => {
              if (!over || active.id === over.id) return;
              const fromIndex = person.accounts.findIndex((account) => account.id === active.id);
              const toIndex = person.accounts.findIndex((account) => account.id === over.id);
              if (fromIndex >= 0 && toIndex >= 0) saveAccounts(arrayMove(person.accounts, fromIndex, toIndex));
            }}>
            <SortableContext items={person.accounts.map((account) => account.id)} strategy={verticalListSortingStrategy}>
            <div className="accounts-table-wrap">
              <table className="accounts-table">
                <thead><tr><th scope="col">Account name</th><th scope="col">Balance</th><th scope="col">Account type</th><th scope="col">Return treatment</th><th scope="col"><span className="accounts-sr-only">Actions</span></th></tr></thead>
                  {person.accounts.length === 0 && <tbody><tr><td colSpan={5} className="accounts-empty">No accounts</td></tr></tbody>}
                  {person.accounts.map((account) => {
                    const key = `${person.id}-${account.id}`;
                    const hasDetails = account.returnType !== "market" || account.type === "nonRegistered";
                    const isExpanded = hasDetails && expanded.has(key);
                    return (
                      <SortableAccountRows key={account.id} id={account.id}>
                        {({ attributes, listeners, setActivatorNodeRef }) => <Fragment>
                        <tr>
                          <td><div className="accounts-name-cell">
                            <button ref={setActivatorNodeRef} type="button" className="accounts-drag-handle" {...attributes} {...listeners} title="Drag to reorder account" aria-label={`Reorder ${account.name}`}><Menu size={17} /></button>
                            <input aria-label="Account name" value={account.name} onChange={(event) => updateAccount(account.id, { name: event.target.value })} />
                          </div></td>
                          <td><NumberField label={<span className="accounts-sr-only">{account.name} balance</span>} prefix="$" min={0} value={account.balance} onChange={(value) => updateAccount(account.id, { balance: Math.max(0, Number(value)) })} /></td>
                          <td><select aria-label={`${account.name} account type`} value={account.type} onChange={(event) => {
                            updateAccount(account.id, { type: event.target.value as InvestmentAccount["type"] });
                            if (event.target.value === "nonRegistered") setExpanded((current) => new Set(current).add(key));
                          }}><option value="rrsp">RRSP / RRIF</option><option value="tfsa">TFSA</option><option value="nonRegistered">Non-registered</option></select></td>
                          <td><select aria-label={`${account.name} return treatment`} value={account.returnType} onChange={(event) => {
                            const returnType = event.target.value as InvestmentAccount["returnType"];
                            updateAccount(account.id, { returnType, ...(returnType === "savings" ? { startAge: person.currentAge } : {}) });
                            if (returnType !== "market") setExpanded((current) => new Set(current).add(key));
                          }}><option value="market">Market-linked</option><option value="gic">Fixed-rate GIC / PPN</option><option value="savings">Interest-bearing savings</option></select></td>
                          <td><div className="accounts-row-actions">
                            <button type="button" className="button button-quiet accounts-icon" disabled={!hasDetails} title={isExpanded ? "Hide account details" : "Account details"} aria-label={`${isExpanded ? "Hide" : "Show"} ${account.name} details`} aria-expanded={isExpanded} aria-controls={`${key}-details`} onClick={() => toggleDetails(key)}><ChevronDown size={16} className={isExpanded ? "accounts-chevron-open" : ""} /></button>
                            <button type="button" className="button button-quiet accounts-icon" title="Delete account" aria-label={`Delete ${account.name}`} onClick={() => saveAccounts(person.accounts.filter((candidate) => candidate.id !== account.id))}><Trash2 size={15} /></button>
                          </div></td>
                        </tr>
                        {isExpanded && <tr id={`${key}-details`} className="accounts-details-row"><td colSpan={5}><div className="accounts-details">
                          {account.returnType === "market" && account.type === "nonRegistered" && <NumberField label="Adjusted cost base" prefix="$" min={0} value={account.bookValue ?? account.balance} tooltip="Original cost of these investments, including eligible purchase costs. Only the gain above this amount is taxable." onChange={(value) => updateAccount(account.id, { bookValue: Math.max(0, Number(value)) })} />}
                          {account.returnType !== "market" && <NumberField label="Annual interest rate" suffix="%" min={0} step={0.1} value={roundedPercent(account.annualRate ?? 0.05)} tooltip="Effective annual rate, compounded annually. This fixed assumption is not randomized with market returns." onChange={(value) => updateAccount(account.id, { annualRate: Math.max(0, Number(value)) / 100 })} />}
                          {account.returnType === "gic" && <>
                            <NumberField label="Term (years)" min={1} step={1} value={account.termYears ?? 1} onChange={(value) => updateAccount(account.id, { termYears: Math.max(1, Math.round(Number(value))) })} />
                            <NumberField label="Start age" min={person.currentAge} step={1} value={account.startAge ?? person.currentAge} onChange={(value) => updateAccount(account.id, { startAge: Math.max(person.currentAge, Math.round(Number(value))) })} />
                            <label className="field-label">At maturity<select value={account.maturityAction ?? "renew"} onChange={(event) => updateAccount(account.id, { maturityAction: event.target.value as GicMaturityAction })}><option value="renew">Auto-renew</option><option value="cashOut">Move to market-linked balance</option></select></label>
                          </>}
                        </div></td></tr>}
                        </Fragment>}
                      </SortableAccountRows>
                    );
                  })}
                <tfoot><tr><th scope="row" colSpan={5}><div className="accounts-person-total"><span>{person.label || "Person"} total</span><output>{formatCurrency(accountTotal(person.accounts))}</output></div></th></tr></tfoot>
              </table>
            </div>
            </SortableContext>
            </DndContext>
            <div className="accounts-person-settings"><RrifConversionSelect currentAge={person.currentAge} value={person.rrifConversionAge} onChange={(rrifConversionAge) => updatePerson(person.id, person.existingAssets, rrifConversionAge)} /></div>
          </section>
        );
      })}
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
function RrifConversionSelect({ currentAge, value, onChange }: { currentAge: number; value: number | undefined; onChange: (value: number | undefined) => void }) {
  const firstAge = Math.max(1, Math.ceil(currentAge));
  const conversionAge = value ?? 71;
  const selectedValue = conversionAge < firstAge ? 0 : conversionAge;
  return (
    <label className="field-label">
      <span className="field-label-text">RRIF conversion age
        <FieldHint text="Whole-account conversion of the RRSP/RRIF balance and registered GIC holdings, no later than age 71. Plans without a saved conversion age use 71, with minimum withdrawals starting at 72. RRIF withdrawals become eligible for pension splitting from age 65; minimum withdrawals start the year after conversion. Choose Already converted for an existing RRIF. This does not optimize conversion timing or model partial conversions." />
      </span>
      <select value={selectedValue} onChange={(event) => onChange(Number(event.target.value))}>
        <option value={0}>Already converted</option>
        {Array.from({ length: Math.max(0, 72 - firstAge) }, (_, index) => firstAge + index).map((age) => <option key={age} value={age}>Age {age}</option>)}
      </select>
    </label>
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
  planYear,
  people,
  onChange,
}: {
  schedules: ContributionSchedule[];
  planYear: number;
  people: Array<{ id: string; label: string; currentAge: number }>;
  onChange: (schedules: ContributionSchedule[]) => void;
}) {
  const updateSchedule = (id: string, changes: Partial<ContributionSchedule>) =>
    onChange(schedules.map((schedule) => schedule.id === id ? { ...schedule, ...changes } : schedule));
  const addSchedule = () => onChange([...schedules, {
    id: `contribution-${Date.now()}`,
    ownerId: "primary",
    label: "New contribution plan",
    year: planYear,
    endYear: planYear + Math.max(0, 65 - (people.find((person) => person.id === "primary")?.currentAge ?? 0)),
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
            const startYear = Number.isFinite(schedule.year) ? schedule.year : planYear;
            const endYear = Number.isFinite(schedule.endYear) ? schedule.endYear : startYear;
            return (
              <>
          <div className="field-grid three-up">
            <label className="field-label">Owner<select value={schedule.ownerId} onChange={(event) => { const owner = people.find((person) => person.id === event.target.value) ?? people[0]; updateSchedule(schedule.id, { ownerId: event.target.value, endYear: Math.max(startYear, planYear + Math.max(0, 65 - owner.currentAge)) }); }}>{people.map((person) => <option key={person.id} value={person.id}>{person.label}</option>)}</select></label>
            <label className="field-label">Label<input value={schedule.label} onChange={(event) => updateSchedule(schedule.id, { label: event.target.value })} /></label>
          </div>
          <div className="field-grid two-up income-amount-fields">
            <NumberField label="Start year" min={planYear} value={startYear} tooltip="First calendar year when this contribution applies." onChange={(value) => updateSchedule(schedule.id, { year: Math.min(endYear, Math.round(Number(value))) })} />
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
  planYear,
  minimumAge,
  targetDeathAge,
  personalInfo,
  people,
  onChange,
}: {
  streams: IncomeStream[];
  planYear: number;
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
                <option value="rrspWithdrawal">RRSP withdrawal</option>
                <option value="rrifWithdrawal">RRIF income</option>
                <option value="eligibleDividend">Eligible dividend</option>
                <option value="nonEligibleDividend">
                  Non-eligible dividend
                </option>
                <option value="capitalGains">Capital gains</option>
                <option value="taxFree">Tax-free</option>
              </select>
            </label>
          </div>
          {stream.taxTreatment === "pension" && (
            <label className="check-row">
              <input type="checkbox" checked={stream.pensionEligibleForSplitting ?? true}
                onChange={(event) => updateStream(stream.id, { pensionEligibleForSplitting: event.target.checked })} />
              Eligible employer pension for splitting
            </label>
          )}
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
              tooltip={`Starts ${monthYearLabel(owner, stream.startAge, planYear, stream.startMonth ?? 1)}`}
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
              tooltip={`Ends ${monthYearLabel(owner, stream.endAge, planYear, stream.endMonth ?? 12)}`}
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
  planYear,
  minimumAge,
  personalInfo,
  onChange,
}: {
  spendingPlan: SpendingPlan;
  planYear: number;
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
              tooltip={`Applies for the full calendar year ${ageYearLabel(personalInfo, phase.startAge, planYear)}.`}
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
              tooltip={`Applies through the full calendar year ${ageYearLabel(personalInfo, phase.endAge, planYear)}.`}
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
              tooltip={!spendingPlan.indexedToInflation ? "Annual spending without inflation increases." : spendingPlan.indexFromFirstPhase
                ? "Amount in the first phase's starting-year dollars. Inflation increases begin after that year and continue across later phases."
                : "Amount in plan-start dollars. Inflation increases apply from the plan start, including years before the first phase."}
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
      <label className="check-row">
        <input
          type="checkbox"
          checked={spendingPlan.indexFromFirstPhase ?? false}
          disabled={!spendingPlan.indexedToInflation}
          onChange={(event) => onChange({ ...spendingPlan, indexFromFirstPhase: event.target.checked })}
        />{" "}
        <span className="field-label-text">
          Start indexing at first phase
          <FieldHint text="Use the earliest phase's start year instead of the plan start as the inflation anchor. That year's annual target equals the entered amount; inflation increases begin the following year. All phases use this same anchor, without restarting at each phase. Partial-year spending rules still apply. If the first phase predates the plan start, indexing starts at the plan start." />
        </span>
      </label>
    </section>
  );
}
function GovernmentBenefitsStrategy({ inputs, onChange, visible }: { inputs: RetirementInputs; onChange: (inputs: RetirementInputs) => void; visible: boolean }) {
  const [selectedId, setSelectedId] = useState("primary");
  const people = [{ ...inputs.personalInfo, id: "primary" }, ...(inputs.personalInfo.additionalPeople ?? [])];
  const person = people.find((person) => person.id === selectedId) ?? people[0];
  const planYear = planDateFor(inputs).getFullYear();
  const startAges = [60, 65, 70] as const;
  const usesLegacyOas = person.oasPayoutRate === undefined && Boolean(person.oasResidency);
  const oasPayoutRate = person.oasPayoutRate ?? (person.oasResidency
    ? Math.min(1, Math.max(0, calculateOasAnnualBenefit(oasAnnualMaximum, 65, person.oasResidency) / oasAnnualMaximum)) : 1);
  function updatePerson(patch: Partial<Pick<RetirementInputs["personalInfo"], "cppAnnualEstimates" | "cppPayoutRate" | "receivesCpp" | "receivesOas" | "oasPayoutRate" | "oasResidency">>) {
    onChange({ ...inputs, personalInfo: person.id === "primary" ? { ...inputs.personalInfo, ...patch }
      : { ...inputs.personalInfo, additionalPeople: inputs.personalInfo.additionalPeople.map((entry) => entry.id === person.id ? { ...entry, ...patch } : entry) } });
  }
  function useOasPercentage(rate: number) {
    updatePerson({ oasPayoutRate: Math.min(1, Math.max(0, rate)), oasResidency: undefined });
  }
  const cppChoices = startAges.map((age) => ({
    age,
    annualAmount: (person.receivesCpp ?? true) ? calculateCppAnnualBenefit(cppAnnualMaximum * (person.cppPayoutRate ?? 0.6), age, person.cppAnnualEstimates) : 0,
    source: !(person.receivesCpp ?? true) ? "CPP disabled" : person.cppAnnualEstimates?.[age] !== undefined ? "Custom estimate" : "Percentage-based estimate",
  }));
  const oasChoices = ([65, 70] as const).map((age) => {
    const annualAmount = (person.receivesOas ?? true) ? calculateOasAnnualBenefit(oasAnnualMaximum, age, person.oasResidency, person.oasPayoutRate) : 0;
    return { age, annualAmount,
      source: !(person.receivesOas ?? true) ? "OAS disabled" : usesLegacyOas ? "Saved detailed OAS settings"
        : `${oneDecimalPercent(person.oasPayoutRate ?? 1)}% of full OAS`,
    };
  });
  return (
    <section className="government-benefits-strategy">
      <h2>Government benefits</h2>
      <div className="benefit-settings-grid benefit-primary-settings">
        <AgeSelect label="CPP start age" value={inputs.strategy.cppStartAge}
          tooltip={`Shared election, applied at each person's own age. For the primary person: ${monthYearLabel(inputs.personalInfo, inputs.strategy.cppStartAge, planYear)}.`}
          onChange={(cppStartAge) => onChange({ ...inputs, strategy: { ...inputs.strategy, cppStartAge } })} />
        <label className="field-label"><span className="field-label-text">OAS start age<FieldHint text="OAS cannot start before 65. The selected age applies to each person at their own age." /></span>
          <select value={Math.max(65, inputs.strategy.oasStartAge)} onChange={(event) => onChange({ ...inputs, strategy: { ...inputs.strategy, oasStartAge: Number(event.target.value) as 65 | 70 } })}>
            <option value={65}>65</option><option value={70}>70</option>
          </select>
        </label>
        <label className="field-label">Person<select value={person.id} onChange={(event) => setSelectedId(event.target.value)}>
          {people.map((entry) => <option key={entry.id} value={entry.id}>{entry.label || "Primary person"}</option>)}
        </select></label>
        <NumberField label="CPP at 65 (% maximum)" min={0} step={1} suffix="%" value={oneDecimalPercent(person.cppPayoutRate ?? 0.6)}
          tooltip="Fallback age-65 entitlement. Before 65, CPP reduces it by 0.6% per month; after 65, it increases by 0.7% per month. This does not calculate contribution history, dropout provisions, or zero-earning years."
          onChange={(value) => updatePerson({ cppPayoutRate: Math.max(0, Number(value) / 100) })} />
        <NumberField label="OAS at 65 (% maximum)" min={0} max={100} step={0.1} suffix="%" value={oneDecimalPercent(oasPayoutRate)}
          tooltip="Full OAS at 65 generally requires 40 years of Canadian residence after age 18. Use years / 40 × 100: 20 years = 50%, 30 years = 75%, 40 or more = 100%. The deferral increase is added separately. Verify eligibility and exceptions with Service Canada."
          onChange={(value) => {
            const rate = Math.min(1, Math.max(0, Number(value) / 100));
            if (!usesLegacyOas || oneDecimalPercent(rate) !== oneDecimalPercent(oasPayoutRate)) useOasPercentage(rate);
          }} />
      </div>
      <div className="benefit-person-settings">
        <label className="check-row"><input type="checkbox" checked={person.receivesCpp ?? true} onChange={(event) => updatePerson({ receivesCpp: event.target.checked })} />CPP eligible</label>
        <label className="check-row"><input type="checkbox" checked={person.receivesOas ?? true} onChange={(event) => updatePerson({ receivesOas: event.target.checked })} />OAS eligible</label>
      </div>
      {usesLegacyOas && <p className="benefit-model-note">Saved detailed OAS settings remain active. <button type="button" className="text-button" onClick={() => useOasPercentage(oasPayoutRate)}>Use displayed percentage instead</button></p>}
      <details className="benefit-estimate-details">
        <summary>CPP estimates by start age (optional)</summary>
        <p>Annual amounts in plan-date dollars, already adjusted for the chosen start age and your expected contribution history. A custom estimate replaces the percentage-based calculation for that age; clear it to restore the fallback.</p>
        <div className="benefit-settings-grid">
          {startAges.map((age) => <label className="field-label" key={age}>Annual CPP at {age}
            <span className="number-input"><span>$</span><input type="number" inputMode="decimal" min={0} step={1}
              value={person.cppAnnualEstimates?.[age] ?? ""} placeholder="Use percentage estimate"
              onChange={(event) => {
                const estimates = { ...person.cppAnnualEstimates };
                if (event.target.value === "") delete estimates[age];
                else {
                  const amount = Number(event.target.value);
                  if (!Number.isFinite(amount) || amount < 0) return;
                  estimates[age] = amount;
                }
                updatePerson({ cppAnnualEstimates: estimates });
              }} /></span>
          </label>)}
        </div>
      </details>
      <p className="benefit-model-note">Gross benefits in plan-date dollars, before tax and OAS recovery.<FieldHint text="CPP does not automatically adjust for additional years without contributions. OAS uses your entered age-65 percentage, plus the separate deferral increase. Eligibility checkboxes remain manual: residence and legal-status requirements must be verified." /></p>
      <div className="benefit-timing-grid">
        <BenefitTimingChart label="CPP" choices={cppChoices} endAge={person.targetDeathAge} visible={visible} />
        <BenefitTimingChart label="OAS" choices={oasChoices} endAge={person.targetDeathAge} visible={visible} />
      </div>
      <details className="benefit-model-details">
        <summary>Assumptions & benefit rules</summary>
        <p className="benefit-model-note">Without custom estimates, CPP uses a fixed entitlement plus the age adjustment; stopping work does not automatically reduce it. Low-earning dropouts and post-65 protections require contribution-history information. Check estimates against your planned work-stop date. <a href="https://www.canada.ca/en/services/benefits/publicpensions/cpp/amount.html" target="_blank" rel="noreferrer">CPP calculation rules</a> · <a href="https://www.canada.ca/en/services/benefits/publicpensions/cpp/when-start.html" target="_blank" rel="noreferrer">Start-age adjustments</a></p>
        <p className="benefit-model-note">Hypothetical lifetime gross payments in plan-date dollars, not after-tax or investment returns. The charts assume full annual payments between birthdays; Ledger uses calendar-year proration and simulated inflation. OAS recovery can change the net crossover. The age-75 OAS increase is not modeled.</p>
        <p className="benefit-model-note">OAS uses your entered percentage of the full age-65 pension, before inflation, tax, recovery, and the separate start-age deferral increase. The usual residence-based estimate is qualifying Canadian residence years after age 18 / 40 × 100, capped at 100%. The planner does not verify eligibility, add future residence years, or infer agreement-specific entitlements. Confirm the percentage for your circumstances. Previously saved detailed OAS settings are preserved until you change the percentage or explicitly switch. <a href="https://www.canada.ca/en/services/benefits/publicpensions/old-age-security/eligibility.html" target="_blank" rel="noreferrer">OAS eligibility</a></p>
        {workingForecastContext(inputs) && <p className="benefit-model-note">The charts preview editable inputs, not frozen Actuals history. Start-age changes use Rebase from actuals for future settings. Per-person entitlement estimates and eligibility are structural inputs; use a new editable-plan baseline to change them without rewriting the existing baseline.</p>}
      </details>
      {workingForecastContext(inputs) && <p className="benefit-model-note">Editable benefit preview; saved Actuals assumptions stay unchanged until rebasing or creating a new baseline.</p>}
    </section>
  );
}

function BenefitTimingChart({ label, choices, endAge, visible }: { label: string; choices: { age: number; annualAmount: number; source: string }[]; endAge: number; visible: boolean }) {
  const firstAge = choices[0].age;
  const lastAge = Math.max(firstAge, Math.floor(endAge));
  const ages = Array.from({ length: lastAge - firstAge + 1 }, (_, index) => firstAge + index);
  const crossovers = choices.flatMap((earlier, index) => choices.slice(index + 1).map((later) => {
    const crossover = later.annualAmount > earlier.annualAmount
      ? later.age + earlier.annualAmount * (later.age - earlier.age) / (later.annualAmount - earlier.annualAmount) : null;
    return { earlier: earlier.age, later: later.age, crossover };
  }));
  const option: EChartsOption = {
    animationDuration: 200,
    color: ["#2563eb", "#b45309", "#059669"],
    grid: { top: 20, right: 20, bottom: 60, left: 80 },
    legend: { bottom: 0, textStyle: { fontSize: 11 } },
    tooltip: { trigger: "axis", confine: true, valueFormatter: (value) => formatCurrency(Number(value)) },
    xAxis: { type: "value", min: firstAge, max: Math.max(firstAge + 1, lastAge), minInterval: 1, name: "Age", nameLocation: "middle", nameGap: 28 },
    yAxis: { type: "value", axisLabel: { formatter: (value: number) => formatCurrency(value), fontSize: 10 } },
    series: choices.map((choice) => ({ name: `Start at ${choice.age}`, type: "line", symbol: "none",
      data: ages.map((age) => [age, Math.max(0, age - choice.age) * choice.annualAmount]),
      lineStyle: { width: 2 },
    })),
  };
  return (
    <section className="benefit-timing-chart">
      <h3>{label} cumulative benefits<FieldHint text="Total gross payments by birthday. Crossover ages show when the later start catches up with the earlier start; these are not after-tax or investment-return comparisons." /></h3>
      {visible && <ReactECharts option={option} style={{ height: 220, width: "100%" }} notMerge lazyUpdate />}
      <ul className="benefit-crossovers" aria-label={`${label} crossover ages`}>{crossovers.map(({ earlier, later, crossover }) => <li key={`${earlier}-${later}`}>
        {later} vs. {earlier}: <strong>{crossover !== null && crossover <= endAge ? `age ${crossover.toFixed(1)}` : `none by ${endAge}`}</strong>
      </li>)}</ul>
      <details className="benefit-payment-details">
        <summary>Annual amounts & estimate basis</summary>
      <div className="table-wrap"><table className="benefit-comparison-table">
        <thead><tr><th scope="col">Start age</th><th scope="col">Annual benefit</th><th scope="col">Basis</th></tr></thead>
        <tbody>{choices.map((choice) => <tr key={choice.age}><th scope="row">{choice.age}</th><td>{formatCurrency(choice.annualAmount, 2)}</td><td>{choice.source}</td></tr>)}</tbody>
      </table></div>
      </details>
    </section>
  );
}

function WithdrawalOrderAdvisor({ inputs, onApply, onApplySpending }: {
  inputs: RetirementInputs;
  onApply: (result: WithdrawalOrderSuggestion) => void;
  onApplySpending: (result: WithdrawalOrderSuggestion, choice: "current" | "suggested") => void;
}) {
  const [objective, setObjective] = useState<WithdrawalObjective>("spending");
  const [request, setRequest] = useState<{ inputs: RetirementInputs; objective: WithdrawalObjective } | null>(null);
  const [snapshot, setSnapshot] = useState<{ inputs: RetirementInputs; objective: WithdrawalObjective; output: WithdrawalOrderSuggestion } | null>(null);
  const [failure, setFailure] = useState<{ inputs: RetirementInputs; objective: WithdrawalObjective; message: string } | null>(null);
  const [progress, setProgress] = useState({ completed: 0, total: 24, evaluations: 0 });
  const running = request?.inputs === inputs && request.objective === objective;
  const result = snapshot?.inputs === inputs && snapshot.objective === objective ? snapshot.output : null;
  const error = failure?.inputs === inputs && failure.objective === objective ? failure.message : "";
  const unchanged = result ? result.suggested.order.every((account, index) => account === result.current.order[index]) : false;
  const currentMaximum = result?.current.maximumSpending;
  const suggestedMaximum = result?.suggested.maximumSpending;
  useEffect(() => {
    if (!request || request.inputs !== inputs || request.objective !== objective) return;
    let worker: Worker | null = null;
    let cancelled = false;
    const fail = (message: string) => {
      if (cancelled) return;
      setFailure({ ...request, message });
      setRequest(null);
      worker?.terminate();
    };
    try {
      worker = new Worker(new URL("../lib/monteCarlo.worker.ts", import.meta.url), { type: "module" });
      worker.onmessage = (event: MessageEvent<WithdrawalOrderWorkerMessage>) => {
        if (cancelled) return;
        const message = event.data;
        if (message.type === "order-progress") setProgress({ completed: message.completed, total: message.total, evaluations: message.evaluations });
        else if (message.type === "order-complete") {
          setSnapshot({ ...request, output: message.output });
          setRequest(null);
          worker?.terminate();
        } else fail(message.message);
      };
      worker.onerror = (event) => {
        event.preventDefault();
        fail("Unable to compare withdrawal orders. Please try again.");
      };
      worker.onmessageerror = () => fail("Unable to read the withdrawal-order comparison. Please try again.");
      worker.postMessage({ type: "suggest-withdrawal-order", ...request });
    } catch {
      fail("Unable to start the withdrawal-order comparison. Please try again.");
    }
    return () => {
      cancelled = true;
      worker?.terminate();
    };
  }, [inputs, objective, request]);
  return (
    <div className="withdrawal-order-advisor">
      <div className="strategy-comparison-toolbar">
      <label className="field-label">
        <span className="field-label-text">Objective<FieldHint text="Compare all 24 account orders on the same Ledger path. Spend more ranks estimated proportional spending capacity. Preserve estate and Reduce lifetime tax prioritize funding the requested spending; if none can, the smallest funding gap comes first. Other strategy settings stay fixed. Ties favor your current order. Mandatory RRIFs, tax-aware rules, and the GIC buffer can override the preferred order, so several orders may be equivalent." /></span>
        <select value={objective} onChange={(event) => setObjective(event.target.value as WithdrawalObjective)}>
          <option value="spending">Spend more / maximize spending</option>
          <option value="estate">Preserve estate</option>
          <option value="tax">Reduce lifetime tax</option>
        </select>
      </label>
      <div className="maximum-spending-actions">
        <button type="button" className="button button-quiet" disabled={running} onClick={() => {
          setSnapshot(null);
          setFailure(null);
          setProgress({ completed: 0, total: 24, evaluations: 0 });
          setRequest({ inputs, objective });
        }}><Calculator size={14} aria-hidden="true" />{objective === "spending" ? "Find maximum spending" : "Compare orders"}</button>
        {running && <button type="button" className="button button-quiet" onClick={() => setRequest(null)}><X size={14} aria-hidden="true" />Cancel</button>}
      </div>
      </div>
      {running && <p role="status">{progress.completed} of {progress.total} orders compared; {progress.evaluations.toLocaleString("en-CA")} projections evaluated.</p>}
      {error && <p role="alert">{error}</p>}
      {result && <div className="withdrawal-order-result">
        <h3>{unchanged ? "Your current order performs as well as the alternatives" : "A different order ranks higher for this objective"}</h3>
        <div className="withdrawal-order-options">
          <section><h4>Current order</h4><ol className="withdrawal-suggested-order">{result.current.order.map((account) => <li key={account}>{withdrawalAccountLabels[account]}</li>)}</ol></section>
          <section><h4>Suggested order</h4><ol className="withdrawal-suggested-order">{result.suggested.order.map((account) => <li key={account}>{withdrawalAccountLabels[account]}</li>)}</ol></section>
        </div>
        {objective !== "spending" && <div className="table-wrap">
          <table className="maximum-spending-table">
            <thead><tr><th scope="col">Comparison</th><th scope="col">Current</th><th scope="col">Suggested</th></tr></thead>
            <tbody>
              <tr><th scope="row">Requested spending</th><td>{result.current.funded ? "Funded" : `${formatCurrency(result.current.fundingGap)} gap`}</td><td>{result.suggested.funded ? "Funded" : `${formatCurrency(result.suggested.fundingGap)} gap`}</td></tr>
              <tr><th scope="row">After-tax estate</th><td>{formatCurrency(result.current.finalEstate)}</td><td>{formatCurrency(result.suggested.finalEstate)}</td></tr>
              <tr><th scope="row">Income + estate tax</th><td>{formatCurrency(result.current.lifetimeTax)}</td><td>{formatCurrency(result.suggested.lifetimeTax)}</td></tr>
              <tr><th scope="row">OAS recovery</th><td>{formatCurrency(result.current.oasRecovery)}</td><td>{formatCurrency(result.suggested.oasRecovery)}</td></tr>
            </tbody>
          </table>
        </div>}
        {objective === "spending" && suggestedMaximum && <section className="strategy-spending-preview">
          <h3>Maximum phase spending</h3>
          <div className="table-wrap">
            <table className="maximum-spending-table">
              <thead><tr><th scope="col">Phase</th><th scope="col">Entered</th><th scope="col">Max with current order</th><th scope="col">Max with suggested order</th></tr></thead>
              <tbody>{inputs.spendingPlan.phases.map((phase, index) => <tr key={phase.id}>
                <th scope="row">{phase.label}</th><td>{formatCurrency(phase.annualSpending)}</td>
                <td>{currentMaximum ? formatCurrency(currentMaximum.spendingPlan.phases[index].annualSpending) : "Unavailable"}</td>
                <td>{formatCurrency(suggestedMaximum.spendingPlan.phases[index].annualSpending)}</td>
              </tr>)}</tbody>
            </table>
          </div>
          <dl className="maximum-spending-totals">
            <div><dt>Suggested spending level</dt><dd>{formatPercent(suggestedMaximum.multiplier)} of entered phases</dd></div>
            <div><dt>Final portfolio at suggested maximum</dt><dd>{formatCurrency(suggestedMaximum.finalPortfolio, 2)}</dd></div>
            <div><dt>After-tax estate at suggested maximum</dt><dd>{formatCurrency(suggestedMaximum.finalEstate, 2)}</dd></div>
            <div><dt>Funding limit at age</dt><dd>{suggestedMaximum.limitingAge}</dd></div>
          </dl>
          {suggestedMaximum.finalPortfolio > 1 && <p className="maximum-spending-note">The fixed phase proportions reach a funding constraint or leave funds that cannot be spent under the selected rules, so a final balance remains.</p>}
          <div className="maximum-spending-actions">
            {currentMaximum && !unchanged && <button type="button" className="button button-quiet" onClick={() => onApplySpending(result, "current")}><Check size={14} aria-hidden="true" />Apply maximum with current order</button>}
            <button type="button" className="button button-primary" onClick={() => onApplySpending(result, "suggested")}><Check size={14} aria-hidden="true" />{unchanged ? "Apply maximum spending" : "Apply suggested order & spending"}</button>
          </div>
          <p className="maximum-spending-note">Phase dates, proportions, and inflation settings are retained. The final balances above use the suggested maximum spending, not your entered spending. A near-zero balance leaves no reserve for worse markets or a longer life.</p>
        </section>}
        {result.equivalentOrders > 1 && <p className="maximum-spending-note">{result.equivalentOrders} orders tie within the comparison tolerance. Your current order is retained when it ties for best.</p>}
        {!result.suggested.funded && <p className="maximum-spending-note">{objective === "spending"
          ? "Your entered phase amounts are not fully funded under the suggested order; the maximum-spending preview shows the supported proportional level instead."
          : "No compared order fully funds the requested spending; the smallest funding gap was prioritized."}</p>}
        <button type="button" className={`button ${objective === "spending" ? "button-quiet" : "button-primary"}`} disabled={unchanged} onClick={() => onApply(result)}><Check size={14} aria-hidden="true" />{objective === "spending" ? "Apply suggested order only" : "Apply suggested order"}</button>
        {result.workingForecast && <p className="maximum-spending-note">Uses saved forecast settings from the next full year, excludes fixed history and other pending edits, and preserves scheduled later revisions. Applied order and spending changes remain pending until Rebase from actuals.</p>}
      </div>}
      <p className="maximum-spending-note">A Ledger-path comparison, not a Monte Carlo safety guarantee. Manual order controls remain available.</p>
    </div>
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
    const on = projectWorkingForecast(inputs, { aggressiveRrspMeltdown: true });
    const off = projectWorkingForecast(inputs, { aggressiveRrspMeltdown: false });
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
  updating,
  error,
  onGenerateReturns,
  onReturnChange,
}: {
  inputs: typeof defaultRetirementInputs;
  projection: DeterministicProjection | null;
  updating: boolean;
  error: string;
  onGenerateReturns: () => void;
  onReturnChange: (age: number, rate: number) => void;
}) {
  const [expandedAges, setExpandedAges] = useState<Set<number>>(new Set());
  const working = workingForecastContext(inputs);
  const rebaseDatesByYear = new Map(workingForecastRebaseMarkers(inputs).map((marker) => [marker.calendarYear, marker.dates]));
  const firstEditableYear = working ? Number(working.asOf.slice(0, 4)) + 1 : -Infinity;
  if (!projection || !hasCompleteFundingSummary(projection))
    return (
      <section className="ledger-panel ledger-panel--dense">
        <div className="panel-heading">
          <div>
            <h2>Variable-return projection</h2>
            <p>Annual balances, tax, and spendable cash</p>
          </div>
        </div>
        <div className="ledger-empty" role={error ? "alert" : "status"}>
          {error || "Updating variable-return projection."}
        </div>
      </section>
    );
  const years = projection.years;
  const projectionStartDate = planDateFor(working?.baseline.inputs ?? inputs);
  const hasPartialFirstYear = projectionStartDate.getMonth() !== 0 || projectionStartDate.getDate() !== 1;
  const plannedSpend = years.reduce(
    (sum, year) => sum + year.spendingTarget,
    0,
  );
  const averageInvestmentReturn =
    years.reduce((sum, year) => sum + year.portfolioReturn, 0) / years.length;
  return (
    <section className="ledger-panel ledger-panel--dense" aria-busy={updating}>
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
          <p role="status">{updating ? "Updating amounts for the edited returns..." : "Edit a yearly return to override the seeded path for that age."}</p>
        </div>
        <div className="ledger-actions">
        <button
          className="button button-primary"
          type="button"
          onClick={onGenerateReturns}
        >
          Generate returns
        </button>
        </div>
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
              const yearInputs = working ? forecastInputsForYear(working.baseline.inputs, working.revisions, year.calendarYear) : inputs;
              const phaseIndex = yearInputs.spendingPlan.phases.findIndex(
                (phase) =>
                  year.age >= phase.startAge && year.age <= phase.endAge,
              );
              const phase = yearInputs.spendingPlan.phases[phaseIndex];
              const hasSubPeriods = (year.subPeriods?.length ?? 0) > 0;
              const hasTaxAllocation = year.taxesByPerson.length > 0;
              const canExpand = hasSubPeriods || hasTaxAllocation;
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
                    {canExpand && (
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
                    {rebaseDatesByYear.get(year.calendarYear)?.map((date) => <span key={date} className="ledger-actuals-marker" title={`Rebased from balances recorded ${date}. Amounts remain full-year estimates.`}>Rebased {date}</span>)}
                    {working && year.calendarYear === Number(working.asOf.slice(0, 4)) && !rebaseDatesByYear.get(year.calendarYear)?.includes(working.asOf) && <span className="ledger-actuals-marker" title="Dated actual balances are applied within this year; amounts remain full-year estimates.">Actuals {working.asOf}</span>}
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
                        aria-label={`Annual return for ${year.calendarYear}`}
                        disabled={year.calendarYear < firstEditableYear}
                        title={working ? year.calendarYear < firstEditableYear ? "Recorded/past return path is fixed in the working forecast." : `Future return edits are applied automatically when rebasing from Actuals. Currently modeled: ${oneDecimalPercent(year.portfolioReturn)}%.` : "Annualized return. First-year growth applies only from the saved plan date; earlier sub-periods have zero modeled growth."}
                        value={oneDecimalPercent(year.calendarYear < firstEditableYear ? year.portfolioReturn : inputs.assumptions.annualReturnOverrides[year.age] ?? year.portfolioReturn)}
                        onChange={(event) =>
                          onReturnChange(
                            year.age,
                            Number(event.target.value) / 100,
                          )
                        }
                      />
                      %
                    </span>
                    {hasPartialFirstYear && year.calendarYear === years[0].calendarYear && (
                      <span className="ledger-applied-return" title="Compounded market return applied from the plan date through year-end, before cash flows. Fixed-rate holdings use their own rates.">
                        Applied: {updating ? "updating" : formatPercent(year.appliedPortfolioReturn)}
                      </span>
                    )}
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
                {canExpand && isExpanded && (
                  <tr className="ledger-subperiod-row">
                    <td colSpan={ledgerLeadColumns.length + ledgerIncomeColumns.length + ledgerTailColumns.length}>
                      <div className="ledger-subperiod-sticky">
                        {hasTaxAllocation && <table className="ledger-subperiod-table ledger-funding-table">
                          <thead>
                            <tr><th rowSpan={2}>Person</th><th colSpan={8}>Funding sources</th><th colSpan={4}>Cash flow</th></tr>
                            <tr><th>Employment / pension</th><th>RRSP/RRIF drawn</th><th>TFSA drawn</th><th>Non-registered</th><th title="Cash drawn from GICs and interest-bearing savings. Interest retained in the holding is not cash funding.">GIC / savings drawn</th><th title="OAS retained after modeled clawback.">OAS amount</th><th>CPP amount</th><th>Total funding</th><th>Less contributions</th><th title="Reference only: income used to calculate tax, not cash received or another deduction from funding.">Taxable income</th><th>Less income tax</th><th title="After-tax cash available: total funding minus contributions and income tax.">Net cash</th></tr>
                          </thead>
                          <tbody>{year.taxesByPerson.map((person) => <tr key={person.id}>
                            <td>{person.label}</td><td>{formatCurrency(person.employmentIncome, 2)}</td><td>{formatCurrency(person.rrspWithdrawals ?? 0, 2)}</td>
                            <td>{formatCurrency(person.tfsaWithdrawals, 2)}</td><td>{formatCurrency(person.nonRegisteredWithdrawals, 2)}</td><td>{formatCurrency(person.interestBearingWithdrawals, 2)}</td>
                            <td>{formatCurrency(person.oasIncome, 2)}</td><td>{formatCurrency(person.cppIncome, 2)}</td><td><strong>{formatCurrency(person.totalFunding, 2)}</strong></td>
                            <td>{formatCurrency(person.contributions, 2)}</td><td>{formatCurrency(person.taxableIncome, 2)}</td><td>{formatCurrency(person.totalTax, 2)}</td><td><strong>{formatCurrency(person.netCash, 2)}</strong></td>
                          </tr>)}</tbody>
                          <tfoot><tr><th>Household total</th>{([
                            "employmentIncome", "rrspWithdrawals", "tfsaWithdrawals", "nonRegisteredWithdrawals", "interestBearingWithdrawals", "oasIncome", "cppIncome", "totalFunding", "contributions", "taxableIncome", "totalTax", "netCash",
                          ] as const).map((field) => <td key={field}>{formatCurrency(year.taxesByPerson.reduce((total, person) => total + (person[field] ?? 0), 0), 2)}</td>)}</tr></tfoot>
                        </table>}
                        {hasSubPeriods && <SubPeriodTable subPeriods={year.subPeriods!} income={year.income} withdrawals={year.withdrawals} />}
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
  progress,
  error,
}: {
  simulationOutput: SimulationOutput | null;
  progress: MonteCarloProgress | null;
  error: string;
}) {
  if (error) return <section className="ledger-panel"><h2>Simulation could not finish</h2><p role="alert">{error}</p></section>;
  if (progress || !simulationOutput) {
    const percent = progress ? Math.round(progress.completed / Math.max(1, progress.total) * 100) : 0;
    const preparingResults = progress !== null && progress.completed >= progress.total;
    return (
      <section className="monte-carlo-progress" aria-busy="true">
        <div className="monte-carlo-spinner" aria-hidden="true">
          <span className="monte-carlo-spinner-arc" />
          <span className="monte-carlo-spinner-arc" />
          <span className="monte-carlo-spinner-arc" />
          <strong>{progress ? `${percent}%` : "..."}</strong>
        </div>
        <div className="monte-carlo-progress-copy">
          <h2>{preparingResults ? "Preparing results" : "Simulating your retirement"}</h2>
          <p role="status">
            {progress ? `${progress.completed.toLocaleString("en-CA")} of ${progress.total.toLocaleString("en-CA")} simulations complete` : "Starting simulation..."}
          </p>
        </div>
        <progress className="monte-carlo-progress-accessible" max={100} value={progress ? percent : undefined} aria-label="Monte Carlo simulation progress" />
      </section>
    );
  }
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
      <MonteCarloReturnDiagnostics diagnostics={simulationOutput.returnDiagnostics} />
      <FailureAnalysisView failureAnalysis={simulationOutput.failureAnalysis} />
      <div className="table-wrap">
        <table className="monte-carlo-results-table monte-carlo-portfolio-table">
          <thead>
            <tr>
              <th scope="col">Age</th>
              <th scope="col">{worstSurvivingLabel(simulationOutput)}</th>
              <th scope="col">Median</th>
              <th scope="col">90th percentile</th>
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

function MonteCarloReturnDiagnostics({ diagnostics }: { diagnostics: SimulationOutput["returnDiagnostics"] }) {
  if (!diagnostics.annualDrawCount) return null;
  const { earlySequence } = diagnostics;
  const formatSequenceReturn = (totalReturn: number) => <><strong>{formatPercent(totalReturn)} total</strong><span>{formatPercent((1 + totalReturn) ** (1 / earlySequence.years) - 1)} per year</span></>;
  const option: EChartsOption = {
    animationDuration: 200,
    grid: { top: 16, right: 16, bottom: 80, left: 60 },
    tooltip: { trigger: "axis", confine: true, valueFormatter: (value) => formatPercent(Number(value)) },
    xAxis: {
      type: "category",
      data: diagnostics.histogram.map((bucket) => `${(bucket.minimum * 100).toFixed(1)}% to ${(bucket.maximum * 100).toFixed(1)}%`),
      axisLabel: { fontSize: 10, rotate: 35, interval: "auto" },
    },
    yAxis: { type: "value", axisLabel: { formatter: (value: number) => formatPercent(value), fontSize: 10 } },
    series: [{
      name: "Share of annual draws",
      type: "bar",
      data: diagnostics.histogram.map((bucket) => ({
        value: bucket.count / diagnostics.annualDrawCount,
        itemStyle: { color: bucket.maximum <= 0 ? "#b45309" : "#2563eb" },
      })),
      barWidth: "85%",
    }],
  };
  return (
    <div className="monte-carlo-return-diagnostics">
      <div className="panel-heading">
        <h2>Simulated annual returns</h2>
        <span>{diagnostics.annualDrawCount.toLocaleString("en-CA")} future annual draws</span>
      </div>
      <div className="table-wrap">
        <table className="monte-carlo-summary-table">
          <thead><tr><th scope="col">Annual return</th><th scope="col">Requested</th><th scope="col">Simulated</th></tr></thead>
          <tbody>
            <tr><th scope="row">Average</th><td>{formatPercent(diagnostics.requestedMean)}</td><td>{formatPercent(diagnostics.realizedMean)}</td></tr>
            <tr><th scope="row">Minimum</th><td>{formatPercent(diagnostics.requestedMinimum)}</td><td>{formatPercent(diagnostics.minimum)}</td></tr>
            <tr><th scope="row">Maximum</th><td>{formatPercent(diagnostics.requestedMaximum)}</td><td>{formatPercent(diagnostics.maximum)}</td></tr>
          </tbody>
          <tbody>
            <tr><th className="loss-group-heading" colSpan={3} scope="rowgroup">How often did bad years occur?</th></tr>
            <tr><th scope="row">Years with any loss</th><td aria-label="Not applicable">-</td><td>{formatPercent(diagnostics.negativeShare)} of years</td></tr>
            <tr><th scope="row">Years losing more than 10%</th><td aria-label="Not applicable">-</td><td>{formatPercent(diagnostics.belowMinus10Share)} of years</td></tr>
            <tr><th scope="row">Years losing more than 20%</th><td aria-label="Not applicable">-</td><td>{formatPercent(diagnostics.belowMinus20Share)} of years</td></tr>
          </tbody>
        </table>
      </div>
      <p className="monte-carlo-loss-note">Loss frequencies count simulated future years across all runs, not failed retirement plans. Categories overlap: a year losing more than 20% counts in all three loss rows.</p>
      <ReactECharts option={option} style={{ height: 260, width: "100%" }} notMerge lazyUpdate />
      <h3>
        First {earlySequence.years} simulated {earlySequence.years === 1 ? "year" : "years"}: compounded return
        <FieldHint text="Total is cumulative growth over these years; per year is the equivalent compounded annual rate, not each year's actual return. Before cash flows, inflation, tax, and partial-year adjustments; fixed Actuals history is excluded." />
      </h3>
      <div className="table-wrap">
        <table className="monte-carlo-results-table monte-carlo-sequence-table">
          <thead><tr><th scope="col">Worst</th><th scope="col">10th percentile</th><th scope="col">Median</th><th scope="col">90th percentile</th><th scope="col">Best</th></tr></thead>
          <tbody><tr>
            <td>{formatSequenceReturn(earlySequence.worst)}</td><td>{formatSequenceReturn(earlySequence.p10)}</td><td>{formatSequenceReturn(earlySequence.p50)}</td>
            <td>{formatSequenceReturn(earlySequence.p90)}</td><td>{formatSequenceReturn(earlySequence.best)}</td>
          </tr></tbody>
        </table>
      </div>
    </div>
  );
}

function worstSurvivingLabel(simulationOutput: SimulationOutput) {
  const rank = Math.round(simulationOutput.kpis.worstSurvivingPercentileRank * 100);
  return `${rank}th percentile (worst surviving)`;
}

function ReturnDistributionPreview({
  mean,
  floor,
  ceiling,
}: {
  mean: number;
  floor: number;
  ceiling: number;
}) {
  const stats = useMemo(() => {
    // A fixed seed keeps the preview stable while you tweak other inputs, independent of the scenario's own random seed.
    const random = createPreviewRandom(20260907);
    const sampleCount = 4000;
    const samples = Array.from({ length: sampleCount }, () => sampleAnnualReturn(random, mean, floor, ceiling));
    const bucketCount = ceiling > floor ? 20 : 1;
    const bucketWidth = (ceiling - floor) / bucketCount || 1;
    const counts = new Array(bucketCount).fill(0);
    for (const sample of samples) {
      const bucketIndex = Math.min(bucketCount - 1, Math.max(0, Math.floor((sample - floor) / bucketWidth)));
      counts[bucketIndex] += 1;
    }
    const labels = Array.from({ length: bucketCount }, (_, index) => ceiling <= floor ? `${(floor * 100).toFixed(1)}%`
      : `${((floor + index * bucketWidth) * 100).toFixed(1)}% to ${((floor + (index + 1) * bucketWidth) * 100).toFixed(1)}%`);
    const realizedMean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
    const negativeShare = samples.filter((value) => value < 0).length / samples.length;
    return {
      labels,
      frequencies: counts.map((count) => count / samples.length),
      realizedMean,
      negativeShare,
      worst: Math.min(...samples),
      best: Math.max(...samples),
    };
  }, [mean, floor, ceiling]);

  const option: EChartsOption = {
    animationDuration: 200,
    grid: { top: 12, right: 12, bottom: 80, left: 46 },
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
        <FieldHint text="A fixed sample of 4,000 annual draws. A maximum-entropy bounded distribution spreads probability across the full range, weighting one side as needed to target the requested arithmetic average. At the midpoint it is uniform. Bounds remain possible limits, not guaranteed observations, and individual paths can average above or below the target. An average equal to either bound produces constant annual draws. This is an assumption-driven model, not a historically calibrated forecast." />
      </div>
      <ReactECharts option={option} style={{ height: 210, width: "100%" }} notMerge lazyUpdate />
      <p className="return-distribution-stats">
        Generated: {formatPercent(stats.realizedMean)} average, {formatPercent(stats.negativeShare)} negative years, minimum {formatPercent(stats.worst)}, maximum {formatPercent(stats.best)}.
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
          : projectWorkingForecast(left.inputs);
      const rightOutput =
        right.id === "draft" && draftProjection
          ? draftProjection
          : projectWorkingForecast(right.inputs);
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
            <ComparisonRow label="Lifetime OAS recovered" left={comparison.left.years.reduce((sum, year) => sum + year.oasClawback, 0)} right={comparison.right.years.reduce((sum, year) => sum + year.oasClawback, 0)} format={formatCurrency} />
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
    ["Minimum annual return", formatPercent(left.assumptions.returnFloor), formatPercent(right.assumptions.returnFloor)],
    ["Maximum annual return", formatPercent(left.assumptions.returnCeiling), formatPercent(right.assumptions.returnCeiling)],
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
      title: "What the planner does",
      body: (
        <>
          <p>Retirement Planner helps you explore how your household's income, savings, spending, taxes, and withdrawal choices might work together over retirement. It models Canadian accounts and tax rules, CPP and OAS, and the estate remaining at the end of the plan.</p>
          <p>The Dashboard and Ledger show one possible path based on your assumptions. Monte Carlo runs many different return and inflation paths to show a range of outcomes. You can save alternative scenarios and compare them, or record actual balances as your plan progresses.</p>
          <p>Results are estimates, not predictions or financial advice. They depend on your inputs and simplify some tax and benefit rules. Review important decisions with a qualified professional.</p>
        </>
      ),
    },
    {
      title: "Your data and backups",
      body: (
        <>
          <p>Your scenarios and calculations stay in your browser on this device. <strong>Save</strong> stores the current scenario in browser storage, not in an online account; it will not automatically appear on another device. Saved scenarios are not encrypted in browser storage. Clearing browser data, using private browsing, or losing the device can remove them.</p>
          <p>Use <strong>New</strong> to start another scenario without deleting your saved ones. Select a saved scenario to reopen it, and use <strong>Delete</strong> to remove one you no longer need.</p>
          <p>Use <strong>Export</strong> regularly to keep a separate backup. An ordinary JSON file is readable by anyone who opens it. For a protected backup, select <strong>Password protect file</strong> and choose a strong, unique password; at least 12 characters are recommended. The file is encrypted on your device with AES-256-GCM, a widely used encryption standard. Its filename still reveals the scenario name.</p>
          <p>Keep the password somewhere safe: it is not saved by the app and cannot be recovered. Encryption protects the exported file, not the copy saved in your browser. <strong>Import</strong> restores either format and asks for the password when needed; the imported scenario is saved unencrypted in your browser.</p>
          <p>Backups include saved baselines, actual balances, notes, and forecast revisions. Unsaved Actuals form entries are not included. If an imported scenario has the same name as a saved one, choose <strong>Keep both</strong> to retain both histories or <strong>Replace existing</strong> to replace the saved scenario and its history.</p>
          <p>The site counts page visits without cookies or click tracking. Scenario names, financial information, passwords, and file contents are not included in those counts.</p>
        </>
      ),
    },
    {
      title: "Start a plan",
      body: (
        <>
          <p><strong>1. People:</strong> Set the Plan date, province, ages, birth months, and planned lifespans. Add the other people in your household and review each person's CPP and OAS eligibility and entitlements. Ages and starting account balances must describe the same Plan date.</p>
          <p><strong>2. Income:</strong> Add employment, pensions, and other income for each person. Set the amounts, start and end ages or months, tax treatment, and any increases over time.</p>
          <p><strong>3. Contributions:</strong> Add any planned RRSP, TFSA, and non-registered contributions, including who makes them and when. Contributions reduce available cash; RRSP contributions also reduce modeled taxable income.</p>
          <p><strong>4. Spending:</strong> Enter the annual spending you want in each phase of retirement and choose whether it increases with inflation. Spending and withdrawals begin when the household's last employment income stream ends.</p>
          <p><strong>5. Accounts:</strong> Open the main Accounts tab and enter each person's balances as of the Plan date. Include every account once, including GICs held inside registered accounts.</p>
          <p><strong>6. Assumptions and Strategy:</strong> Review the return, inflation, tax, and withdrawal settings in the sidebar. Then check the Dashboard and Ledger, run Monte Carlo, and save and export your scenario. Adjust the inputs as you learn more; projections update automatically.</p>
        </>
      ),
    },
    {
      title: "Sidebar: people, income, and contributions",
      body: (
        <>
          <p><strong>People</strong> defines the household, the Plan date, and individual benefit eligibility. The Plan date anchors starting ages and balances and does not advance when you reopen the app. The projection continues through the longest household lifespan, with income and benefits assigned to their owners. Birth months help determine partial-year amounts.</p>
          <p>CPP at 65 is a fallback percentage of the maximum benefit; the app applies the start-age adjustment but does not calculate your contribution history. OAS at 65 is a percentage you provide, commonly estimated from qualifying Canadian residence years after age 18 divided by 40, up to 100%. This is not an eligibility determination. Strategy Lab offers more benefit settings and comparisons.</p>
          <p><strong>Income</strong> holds streams such as employment and pensions. Set an owner, amount, timing, tax treatment, and indexation for each stream. Employment end dates determine when household retirement spending begins. Use separate streams for amounts or schedules that change.</p>
          <p><strong>Contributions</strong> sets deposits by person, account type, and age range. Schedules can be annual or monthly. For an unusual or partial year, use a separate one-year schedule with the intended amount.</p>
        </>
      ),
    },
    {
      title: "Sidebar: spending, assumptions, and strategy",
      body: (
        <>
          <p><strong>Spending</strong> uses annual targets for one or more age-based phases. With inflation indexing enabled, amounts normally use Plan date dollars. <strong>Start indexing at first phase</strong> instead uses the first phase's starting year as the common anchor for all phases. Without indexing, amounts stay fixed in nominal dollars.</p>
          <p><strong>Assumptions</strong> includes inflation and the average, minimum, and maximum annual market returns. These are inputs to the model, not guarantees about markets. Returns vary within the selected bounds; individual paths need not achieve the requested average. Inflation is sampled separately, and prolonged market regimes are not explicitly modeled. First-year investment growth is prorated from the Plan date; spending, income, contributions, and taxes retain their calendar-year rules.</p>
          <p><strong>Strategy</strong> controls withdrawal frequency and account order, along with optional tax-aware withdrawals, eligible pension splitting, RRSP meltdown, and a GIC / HISA buffer. Mandatory RRIF withdrawals still apply. Tax-aware withdrawals seek more efficient current household cash flow within the chosen order; they do not guarantee the best lifetime outcome. RRSP meltdown deliberately adds withdrawals and can increase current tax or OAS recovery.</p>
          <p>Pension splitting assumes the primary person and first additional person are eligible spouses or common-law partners. The GIC / HISA buffer can reserve fixed-rate holdings until the modeled market falls from its peak, then reserve them again after recovery. Review these settings against your own circumstances rather than optimizing for a single return path.</p>
        </>
      ),
    },
    {
      title: "Dashboard",
      body: (
        <>
          <p>The Dashboard summarizes one projected path with funding, balances, taxes, benefits, estate results, and charts. Start by checking whether the intended spending is funded and when any gap appears. Then use the Ledger to understand the yearly details and Monte Carlo to see how the plan behaves under different conditions.</p>
          <p><strong>OAS recovered</strong> is the amount of OAS the government takes back because income exceeds the recovery threshold. <strong>Lifetime OAS</strong> is the total benefit kept after that recovery. End-of-life tax is the modeled tax on the final estate and is also included in lifetime tax. Estate results are estimates after modeled tax and probate fees.</p>
        </>
      ),
    },
    {
      title: "Accounts",
      body: (
        <>
          <p>Enter accounts separately under their owners, with a name, starting balance, account type, and return treatment. Person subtotals and the household total help you check that everything is included once. Expand a row for details such as adjusted cost base or a fixed rate; use the handle to reorder accounts. Reordering does not change the withdrawal strategy.</p>
          <p><strong>RRSP / RRIF</strong> withdrawals are taxable; set each person's RRIF conversion age here, or choose Already converted. Minimum withdrawals begin the year after conversion. <strong>TFSA</strong> withdrawals are tax-free. For <strong>non-registered</strong> accounts, the adjusted cost base helps determine the taxable gain when investments are sold or deemed disposed at death.</p>
          <p>Choose <strong>Market-linked</strong> for investments following simulated market returns, <strong>Fixed-rate GIC / PPN</strong> for a holding with a rate and term, or <strong>Interest-bearing savings</strong> for an assumed savings rate without a term. Fixed rates are not randomized; actual savings rates can change. A GIC can renew or move to market-linked investments in the same tax wrapper at maturity. Do not include the same GIC balance in another account row.</p>
          <p>Named accounts help organize balances, but the model pools market-linked investments by person and tax type when calculating withdrawals. It does not choose which named account to sell.</p>
        </>
      ),
    },
    {
      title: "Ledger",
      body: (
        <>
          <p>The Ledger shows the Dashboard projection year by year. Expand a year to inspect returns, balances, funding, taxes, and withdrawals by person and account type. With more frequent withdrawals, the expanded view also shows the modeled periods within the year.</p>
          <p>The Return input is a full-year market assumption. If the Plan date is after January 1, the first year also shows <strong>Applied</strong>: the compounded market return modeled from the Plan date to year-end. Fixed-rate holdings use their own rates, and account balances also reflect cash flows.</p>
          <p>You can edit annual returns for this path or use <strong>Generate returns</strong> to produce a new path. Monte Carlo generates its own paths and does not use these yearly overrides. When a working forecast is active, past and current-year returns stay fixed; future edits are applied through a rebase.</p>
          <p>Current-year amounts are full-year estimates, not a list of what remains to withdraw. Recorded balances do not tell the model what income, withdrawals, taxes, or contributions have already occurred.</p>
        </>
      ),
    },
    {
      title: "Using your results in retirement",
      body: (
        <>
          <p>Start on the <strong>Dashboard</strong> by checking whether your planned spending is funded and whether any funding gap appears. Then open the <strong>Ledger</strong>, find the year you want to review, and select the <strong>+</strong> beside it to see the details.</p>
          <p>The expanded funding table shows each person's modeled annual withdrawals under <strong>RRSP/RRIF drawn</strong>, <strong>TFSA drawn</strong>, <strong>Non-registered</strong>, and <strong>GIC / savings drawn</strong>. It also shows employment or pension income, CPP, and OAS. These amounts reflect your chosen strategy, scheduled withdrawals, and any required RRIF minimums. The model groups market-linked accounts by person and tax type; it does not select a particular named account to withdraw from.</p>
          <p><strong>Less income tax</strong> shows the estimated annual income tax for each person. <strong>Net cash</strong> is funding after modeled contributions and income tax; the household total can be compared with the year's spending target. OAS is shown after modeled recovery. These are annual estimates, not a withholding schedule or a tax bill.</p>
          <p>For monthly, quarterly, or semi-annual withdrawals, the expanded period table shows modeled withdrawals by account type for each period. Use it to understand the planned timing, but check your actual transactions and tax obligations before deciding what to withdraw. In particular, a current-year estimate covers the whole year, not just what remains after withdrawals or taxes already paid.</p>
          <p>If retirement income and withdrawals leave more after-tax cash than the spending target, the projection assumes the surplus is reinvested. When the GIC / HISA buffer is set to refill and is eligible for a top-up, the model fills that first. It then uses each living adult's TFSA in the order listed under People, up to a modeled annual limit after scheduled TFSA contributions. Any money left over goes into non-registered investments belonging to the first living adult listed under People, or the first living person if there are no adults. These are assumptions in the forecast, not actual deposits or a personalized recommendation, and the Ledger does not separately list those surplus deposits.</p>
          <p>The annual TFSA limit comes from the planner's bundled tax data and future limits are estimated using modeled inflation. It is not a live CRA lookup and does not determine residency eligibility or track unused room or withdrawals. Before contributing, verify each account holder's eligibility and actual available room, including previous contributions and withdrawals. Review investment choices, withholding, and taxes with a qualified professional as needed. Update balances through Actuals and revisit the plan as circumstances change.</p>
          <p>Older frozen Actuals baselines retain their original surplus calculation to preserve historical comparisons. Rebase an older baseline to use the household TFSA rule from the following January 1; the earlier history stays unchanged.</p>
        </>
      ),
    },
    {
      title: "Actuals: compare your plan with real balances",
      body: (
        <>
          <p>Over time, your real account balances will differ from the amounts your plan projected. Actuals lets you enter those balances during regular reviews, so your future forecast reflects where you are now instead of continuing from an increasingly outdated estimate. You can also see how your progress compares with the plan you started with.</p>
          <p>The preserved plan used for comparison is called a <strong>baseline</strong>. Before starting, check that the Plan date, ages, starting accounts, and assumptions describe the same starting point. If you have no reliable older plan, use today's date and current values; the app cannot reconstruct a lost historical forecast.</p>
          <p>Initially, Actuals shows the live editable plan. Enter a balance date and the household's account balances. Your first <strong>Apply actuals</strong> or <strong>Save incomplete entry</strong> automatically saves the scenario and freezes its starting plan as <strong>Original plan</strong>. You do not need to freeze it first. Opening the view or typing without saving does not create a baseline.</p>
          <p>For each review, use one date for all tracked accounts. Enter <strong>0</strong> for a real zero and leave an unknown amount blank. <strong>Copy last actuals</strong> fills from the latest earlier entry; when none exists, <strong>Use starting balances</strong> fills from the baseline. Check copied amounts against your statements. Selecting an existing date loads it for editing.</p>
          <p><strong>Apply actuals</strong> saves a complete entry and makes it drive the working forecast in Dashboard, Ledger, Compare, and Monte Carlo. Routine entries do not require a rebase. <strong>Save incomplete entry</strong> preserves partial work without applying it to the forecast. A complete unsaved entry previews the result but is not recorded.</p>
          <p>Once you have a baseline, the Accounts tab opens with a read-only view of its latest complete saved balances. If there are no complete entries, it shows the baseline's starting balances instead. Incomplete entries do not change these totals. To edit your accounts, select <strong>Plan starting balances</strong> in Accounts. Choosing a different baseline in Actuals changes the snapshot shown there, but does not change your editable plan or working forecast.</p>
          <p>The dashed blue line is the selected baseline; the green rolling reforecast incorporates applied balances and saved assumptions. Dots mark recorded balances, while future lines are estimates. Compare the household or an individual person. A difference from the baseline reflects all changes, including deposits, withdrawals, and spending, not just investment performance.</p>
          <p>Do not advance the Plan date, ages, or starting balances for routine reviews. Actuals records balances, not transactions: income, tax paid, withdrawals, contributions, cost bases, and fixed-holding details remain modeled assumptions. Review your actual transactions before acting on the forecast.</p>
        </>
      ),
    },
    {
      title: "Actuals: rebase and history",
      body: (
        <>
          <p>Regularly applying actual balances updates your forecast without changing the original comparison. Use <strong>Rebase from actuals</strong> when you want a new dated reference point or need to apply edited future assumptions to an active working forecast. Choose a complete saved entry, review the new name, date, ages, and balances, then confirm. The app updates the editable Plan date, ages, and account balances, saves the new baseline, and keeps earlier history. Cancel makes no changes.</p>
          <p>Balance updates take effect on their recorded date. Changed future income, spending, contributions, returns, taxes, withdrawal settings, and RRIF conversion settings take effect on January 1 after the selected balance date. Saving the scenario alone does not apply those edits to an active working forecast. If no full future year remains, a rebase cannot apply changed future assumptions.</p>
          <p>Changes to people or account structure require a separate baseline: use <strong>Freeze editable plan</strong> under More baseline options, then apply a complete entry against it to make it the working source. <strong>Use editable plan</strong> returns the main views to the editable projection without deleting history. Browsing a different baseline does not switch the working source.</p>
          <p><strong>History</strong> contains entries, notes, and saved forecast revisions. Earlier entries carried through a rebase are marked Archived; edit them under their source baseline. Deleting an entry or baseline saves immediately and cannot be undone. The confirmation explains affected history; dependent baselines can restrict deletion. Export a backup before removing records.</p>
        </>
      ),
    },
    {
      title: "Monte Carlo",
      body: (
        <>
          <p>Monte Carlo runs your plan many times using different market returns and inflation. It keeps your household and strategy settings fixed, so the results show how this plan responds to different modeled futures, not which strategy is best.</p>
          <p>The <strong>success rate</strong> is the share of runs in which the modeled portfolio did not run out over the evaluated horizon. Percentile bands show the range of balances at each age, and failure analysis shows when failed runs first depleted their portfolios. A percentile line is not necessarily one complete simulated path. Review poor outcomes as well as the median and success rate.</p>
          <p>Simulated annual returns summarize the generated returns and losses, including compounded returns over the first five future simulated years when available. They describe market assumptions before cash flows and taxes, not your actual account performance. With applied actuals, history through the latest actuals year remains fixed and future full years are randomized.</p>
          <p>Results depend on your assumptions and are not guarantees. More runs reduce sampling noise, not the uncertainty in those assumptions. For speed, Monte Carlo uses simplified pension-splitting and withdrawal calculations, so individual results can differ slightly from the detailed Ledger.</p>
        </>
      ),
    },
    {
      title: "Strategy Lab",
      body: (
        <>
          <p>Choose an objective to compare withdrawal orders for spending capacity, final estate, or lifetime tax. The comparison evaluates all 24 account-type orders on the same Ledger path and shows the current and suggested results. You remain in control of whether to apply the suggested order.</p>
          <p><strong>Spend more / maximize spending</strong> estimates a common adjustment to all spending phases while preserving their relative amounts. You can apply the current order's maximum, the suggested order alone, or the suggested order and its matching spending amounts. This is an estimate on one path, not a Monte Carlo safety target; review the Ledger and Monte Carlo before relying on it.</p>
          <p><strong>Government benefits</strong> lets you choose household CPP and OAS start ages and compare cumulative gross payments for a selected person. The charts use full years in Plan date dollars and exclude tax, OAS recovery, and investment returns, so crossover ages are not after-tax break-even predictions. Optional per-person CPP estimates at 60, 65, and 70 replace the fallback for the ages entered; use annual, already age-adjusted estimates.</p>
          <p>OAS eligibility and residence must be assessed separately; the planner does not automatically add residence years or model the age-75 OAS increase. Benefit entitlements are structural Actuals settings; create a new editable-plan baseline to change them. With an active working forecast, future strategy and spending changes remain pending until rebase.</p>
        </>
      ),
    },
    {
      title: "Compare",
      body: (
        <>
          <p>Compare saved scenarios or the current draft side by side to see how different assumptions or strategies affect funding, taxes, benefits, and estate results. Save alternatives as separate scenarios to keep them for later. To make a comparison meaningful, keep unrelated inputs and the random seed the same.</p>
          <p>Look at funding gaps first, then assess resilience in Monte Carlo and compare estate and tax outcomes. A favorable estate on one path does not guarantee that spending will be funded under other conditions.</p>
        </>
      ),
    },
    {
      title: "Tax Info",
      body: (
        <>
          <p>Tax Info shows the federal and provincial rules used by the projection, including editable brackets and rates. The province comes from People. Review changes carefully: the model projects certain thresholds with inflation but does not predict future legislation.</p>
          <p>The planner simplifies tax and benefit rules. For example, it does not model every credit or eligibility exception, GIS, CPP pension sharing, or the age-75 OAS increase. Pension splitting assumes an eligible relationship. Verify the rules and amounts that matter to your household.</p>
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
  if (candidate.actuals !== undefined && !isActualsTracking(candidate.actuals)) return false;
  if (candidate.planDate !== undefined && (typeof candidate.planDate !== "string" || !parsePlanDate(candidate.planDate))) return false;
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

function formatCurrency(value: number | null | undefined, fractionDigits = 0) {
  const amount = typeof value === "number" && Number.isFinite(value) ? value : 0;
  return new Intl.NumberFormat("en-CA", {
    style: "currency",
    currency: "CAD",
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(amount);
}
function shortCurrency(value: number) {
  if (!Number.isFinite(value)) return "$0";
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
