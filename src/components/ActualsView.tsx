"use client";

import { CalendarDays, Copy, Pencil, RotateCcw, Save, Snowflake, Trash2 } from "lucide-react";
import ReactECharts from "echarts-for-react";
import type { EChartsOption } from "echarts";
import { Fragment, useEffect, useMemo, useState } from "react";
import { accountEntriesFor } from "@/lib/accounts";
import { actualsHistory, compareActuals, createActualsBaseline, deleteActualsBaseline, deleteActualsEntry, hasForecastAssumptionChanges, localDateValue, rebaseFromActuals, saveBalanceObservation, saveInitialBalanceObservation, type RollingReforecast } from "@/lib/actuals";
import type { ActualsWorkerMessage } from "@/lib/actuals.worker";
import { parsePlanDate } from "@/lib/planDates";
import { projectWithVariableReturns } from "@/lib/projectionPath";
import { forecastInputsForYear } from "@/lib/simulationEngine";
import { workingForecastContext } from "@/lib/workingForecast";
import type { ActualsBaseline, ActualsTracking, BalanceObservation, DeterministicProjection, RetirementInputs } from "@/types/retirement";

const money = (value: number | null) => value === null ? "—" : new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD", maximumFractionDigits: 0 }).format(value);
const dateLabel = (value: string) => parsePlanDate(value)?.toLocaleDateString("en-CA", { year: "numeric", month: "short", day: "numeric" }) ?? value;
const percentLabel = (value: number | null) => value === null ? "—" : new Intl.NumberFormat("en-CA", { style: "percent", maximumFractionDigits: 1, signDisplay: "exceptZero" }).format(value);
const emptyTracking: ActualsTracking = { baselines: [], observations: [] };

export function ActualsView({ inputs, projection, onChange, onOpenAccounts }: {
  inputs: RetirementInputs;
  projection: DeterministicProjection | null;
  onChange: (tracking: ActualsTracking, rebasedInputs?: RetirementInputs) => void;
  onOpenAccounts: () => void;
}) {
  const tracking = inputs.actuals ?? emptyTracking;
  const baseline = tracking.baselines.find((entry) => entry.id === tracking.activeBaselineId) ?? tracking.baselines.at(-1);
  const [name, setName] = useState(`Baseline ${Math.max(2, tracking.baselines.length + 1)}`);
  const [error, setError] = useState("");
  const [showRebase, setShowRebase] = useState(false);
  const [rebaseDate, setRebaseDate] = useState("");
  const completeEntries = baseline ? tracking.observations.filter((entry) => entry.baselineId === baseline.id
    && entry.date >= (baseline.rebase?.date ?? baseline.planDate) && entry.date <= baseline.points.at(-1)!.date
    && compareActuals(baseline, entry).actual !== null && compareActuals(baseline, entry).expected > 0).sort((first, second) => first.date.localeCompare(second.date)) : [];
  const selectedEntry = completeEntries.find((entry) => entry.date === rebaseDate) ?? completeEntries.at(-1);
  const futureYear = selectedEntry ? Number(selectedEntry.date.slice(0, 4)) + 1 : null;
  const changedFutureAssumptions = Boolean(baseline && futureYear && hasForecastAssumptionChanges(inputs, forecastInputsForYear(baseline.inputs,
    [...(baseline.rebase?.revisions ?? []), ...(tracking.forecastRevisions ?? []).filter((revision) => revision.baselineId === baseline.id)], futureYear)));
  const noFutureYear = Boolean(baseline && futureYear && futureYear > Number(baseline.points.at(-1)!.date.slice(0, 4)));
  const hasDependentBaselines = Boolean(baseline && tracking.baselines.some((entry) => entry.rebase?.sourceBaselineId === baseline.id));
  const accountCount = accountEntriesFor(inputs.existingAssets, inputs.personalInfo.currentAge).length
    + inputs.personalInfo.additionalPeople.reduce((total, person) => total + accountEntriesFor(person.existingAssets, person.currentAge).length, 0);
  const preview = useMemo(() => {
    if (baseline || !projection || accountCount === 0) return { baseline: null, error: "" };
    try { return { baseline: createActualsBaseline(inputs, projection, "Editable plan", "editable-plan-preview"), error: "" }; }
    catch (failure) { return { baseline: null, error: failure instanceof Error ? failure.message : "Unable to preview the current plan." }; }
  }, [baseline, inputs, projection, accountCount]);
  function freezeBaseline() {
    if (!projection) return;
    if (baseline && !window.confirm(`Freeze the editable plan from ${dateLabel(inputs.planDate ?? localDateValue())} using its Accounts balances? This does not use recorded actuals or advance the plan date.`)) return;
    try {
      const frozen = createActualsBaseline(inputs, workingForecastContext(inputs) ? projectWithVariableReturns(inputs) : projection, name);
      onChange({ ...tracking, baselines: [...tracking.baselines, frozen], activeBaselineId: frozen.id });
      setName(`Baseline ${tracking.baselines.length + 2}`);
      setError("");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Unable to save this baseline.");
    }
  }
  function deleteBaseline() {
    if (!baseline) return;
    try {
      const next = deleteActualsBaseline(tracking, baseline.id);
      const entries = tracking.observations.filter((entry) => entry.baselineId === baseline.id).length;
      const revisions = (tracking.forecastRevisions ?? []).filter((entry) => entry.baselineId === baseline.id).length;
      const currentWorking = workingForecastContext(inputs);
      const replacement = next.baselines.find((entry) => entry.id === next.workingBaselineId);
      const forecastMessage = currentWorking?.baseline.id === baseline.id
        ? replacement ? `The working forecast will use "${replacement.name}".` : "The working forecast will return to the editable plan."
        : "The working forecast source will not change.";
      if (!window.confirm(`Delete "${baseline.name}" and its ${entries} balance entries and ${revisions} saved forecast revisions? Other baselines and their history are kept. ${forecastMessage} Editable account balances and Plan date will not change. This cannot be undone.`)) return;
      onChange(next);
      setShowRebase(false);
      setRebaseDate("");
      setError("");
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Unable to delete this baseline."); }
  }
  return (
    <div className="actuals-view">
      {baseline && <div className="actuals-baseline-bar">
        {baseline && <label className="field-label">Frozen baseline<select value={baseline.id} onChange={(event) => { setShowRebase(false); setRebaseDate(""); onChange({ ...tracking, activeBaselineId: event.target.value }); }}>
          {tracking.baselines.map((entry) => <option key={entry.id} value={entry.id}>{entry.name} · {dateLabel(entry.rebase?.date ?? entry.planDate)}</option>)}
        </select></label>}
        <button type="button" className="button button-quiet actuals-command actuals-baseline-delete" disabled={hasDependentBaselines} title={hasDependentBaselines ? "Delete newer baselines based on this one first." : "Delete the selected baseline and its entries and revisions."} aria-label="Delete selected baseline" onClick={deleteBaseline}><Trash2 size={15} /></button>
        {baseline && <button type="button" className="button button-primary actuals-command" disabled={!completeEntries.length} title={completeEntries.length ? "Review a new baseline using complete saved actual balances." : "Apply a complete household balance entry before rebasing."} onClick={() => { setRebaseDate(completeEntries.at(-1)!.date); setShowRebase(true); }}><RotateCcw size={15} />Rebase from actuals</button>}
        {baseline && <div className="actuals-baseline-stamp"><Snowflake size={14} /><span>Frozen {dateLabel(localDateValue(new Date(baseline.createdAt)))}<small>{baseline.rebase ? "Rebased" : "Plan date"} {dateLabel(baseline.rebase?.date ?? baseline.planDate)} · Year-end checkpoints</small></span></div>}
      </div>}
      {!baseline && preview.baseline && <div className="actuals-baseline-bar"><span className="actuals-preview-reference">Editable plan · {dateLabel(preview.baseline.planDate)}<small>Original plan is saved automatically with your first balance entry.</small></span></div>}
      {baseline && <details className="actuals-baseline-options"><summary>More baseline options</summary>
        <p>Separate reference for changed people or accounts. Not needed for routine balance updates or rebasing.</p>
        <div className="actuals-entry-toolbar"><label className="field-label">Baseline name<input value={name} onChange={(event) => setName(event.target.value)} /></label>
          <button type="button" className="button button-quiet actuals-command" disabled={!projection || accountCount === 0 || !name.trim()} onClick={freezeBaseline} title="Use the editable Plan date and Accounts balances, not recorded actuals."><Snowflake size={15} />Freeze editable plan</button>
          {workingForecastContext(inputs) && <button type="button" className="button button-quiet actuals-command" onClick={() => {
            if (window.confirm("Use the editable plan instead? Actuals and revisions remain saved, but will not drive Ledger or Dashboard until actuals are applied again.")) onChange({ ...tracking, workingBaselineId: null });
          }}>Use editable plan</button>}
        </div>
      </details>}
      {showRebase && baseline && selectedEntry && <section className="actuals-rebase-preview" aria-label="Rebase preview">
        <h2>Review new baseline</h2>
        <div className="actuals-rebase-fields"><label className="field-label">New baseline name<input value={name} onChange={(event) => setName(event.target.value)} /></label>
          <label className="field-label">Use balances recorded on<select value={selectedEntry.date} onChange={(event) => setRebaseDate(event.target.value)}>{[...completeEntries].reverse().map((entry) => <option key={entry.id} value={entry.date}>{dateLabel(entry.date)}</option>)}</select></label>
        </div>
        <div className="actuals-rebase-summary"><p><strong>Plan date:</strong> {dateLabel(inputs.planDate ?? baseline.planDate)} → {dateLabel(selectedEntry.date)}</p>
        <ul>{[{ ...baseline.inputs.personalInfo, id: "primary" }, ...baseline.inputs.personalInfo.additionalPeople].map((person) => {
          const current = person.id === "primary" ? inputs.personalInfo : inputs.personalInfo.additionalPeople.find((entry) => entry.id === person.id);
          const age = person.currentAge + Number(selectedEntry.date.slice(0, 4)) - Number(baseline.planDate.slice(0, 4));
          return <li key={person.id}>{person.label}: age {current?.currentAge ?? person.currentAge} → {age}</li>;
        })}</ul></div>
        <table className="actuals-rebase-table"><caption>Balances to carry forward</caption><colgroup><col /><col className="actuals-rebase-amount-column" /></colgroup><thead><tr><th scope="col">Account</th><th scope="col">Balance</th></tr></thead><tbody>
          {baseline.people.map((person) => {
            const accounts = baseline.accounts.filter((account) => account.ownerId === person.id && account.activeDate <= selectedEntry.date);
            return accounts.length ? <Fragment key={person.id}><tr className="actuals-rebase-owner"><th scope="rowgroup" colSpan={2}>{person.label}</th></tr>
              {accounts.map((account) => <tr key={account.key}><th scope="row">{account.name}</th><td>{money(selectedEntry.balances[account.key])}</td></tr>)}</Fragment> : null;
          })}
        </tbody><tfoot><tr><th scope="row">Household total</th><td>{money(compareActuals(baseline, selectedEntry).actual)}</td></tr></tfoot></table>
        <div className="actuals-rebase-outcome"><p><strong>On confirmation:</strong> Accounts will use these balances and this baseline will drive the working forecast.</p>
          <p>{changedFutureAssumptions ? noFutureYear ? "No full future calendar years remain for your edited assumptions." : `Your edited future assumptions will be saved and applied automatically from January 1, ${futureYear}. No separate revision save is needed.` : "Saved future assumptions continue from these balances. No separate revision save is needed."}</p>
          <p>Your existing history and blue/green forecast lines are preserved. Unsaved changes to people or accounts are not included.</p>
        </div>
        <details className="actuals-rebase-details"><summary>Forecast assumptions carried forward</summary><p>Rebasing automatically saves edited income, spending, contribution, return, tax, withdrawal, and RRIF-conversion assumptions for the next full calendar year. Earlier years and recorded balances stay unchanged; later scheduled revisions remain scheduled. Modeled tax-year history, cost bases, and fixed-holding state carry forward. Recorded balances do not supply actual transactions or taxes paid.</p></details>
        <div className="actuals-save-bar"><button type="button" className="button button-quiet" onClick={() => setShowRebase(false)}>Cancel</button><button type="button" className="button button-primary actuals-command" disabled={!name.trim() || (changedFutureAssumptions && noFutureYear)} onClick={() => {
          try {
            const rebased = rebaseFromActuals(inputs, baseline, selectedEntry.date, name);
            onChange(rebased.actuals!, rebased);
            setShowRebase(false);
            setName(`Baseline ${tracking.baselines.length + 2}`);
            setError("");
          } catch (failure) { setError(failure instanceof Error ? failure.message : "Unable to rebase from these actuals."); }
        }}><RotateCcw size={15} />Confirm rebase</button></div>
      </section>}
      {(error || preview.error) && <p className="actuals-error" role="alert">{error || preview.error}</p>}
      {!baseline && !preview.baseline ? <div className="actuals-empty-state">
        <CalendarDays size={30} strokeWidth={1.4} />
        <h2>{accountCount === 0 ? "No accounts in this plan" : "Preparing editable plan"}</h2>
        <p>{accountCount === 0 ? "Account balances are needed before tracking can begin." : preview.error ? "The editable plan could not be prepared." : "Waiting for the current projection."}</p>
        {accountCount === 0 && <button type="button" className="button button-quiet" onClick={onOpenAccounts}>Open Accounts</button>}
      </div> : baseline ? <BaselineActuals key={baseline.id} baseline={baseline} tracking={tracking} onChange={onChange} />
        : preview.baseline && <BaselineActuals key={JSON.stringify([preview.baseline.id, preview.baseline.planDate, preview.baseline.accounts])} baseline={preview.baseline} tracking={{ ...tracking, baselines: [preview.baseline] }} isEditablePreview onChange={(next) => {
          const entry = next.observations.find((observation) => observation.baselineId === preview.baseline!.id);
          if (!entry || !projection) throw new Error("The plan is updating. Try saving again when it is ready.");
          onChange(saveInitialBalanceObservation(inputs, projection, entry));
        }} />}
    </div>
  );
}

function BaselineActuals({ baseline, tracking, onChange, isEditablePreview = false }: { baseline: ActualsBaseline; tracking: ActualsTracking; onChange: (tracking: ActualsTracking) => void; isEditablePreview?: boolean }) {
  const observations = useMemo(() => tracking.observations.filter((entry) => entry.baselineId === baseline.id).sort((first, second) => first.date.localeCompare(second.date)), [tracking.observations, baseline.id]);
  const history = useMemo(() => actualsHistory(baseline, tracking), [baseline, tracking]);
  const revisions = useMemo(() => (tracking.forecastRevisions ?? []).filter((entry) => entry.baselineId === baseline.id), [tracking.forecastRevisions, baseline.id]);
  const historyRevisions = useMemo(() => [...new Map([...(baseline.rebase?.revisions ?? []), ...revisions].map((revision) => [revision.id, revision])).values()]
    .sort((first, second) => first.effectiveDate.localeCompare(second.effectiveDate) || first.createdAt.localeCompare(second.createdAt)), [baseline, revisions]);
  const revisionKey = revisions.map((revision) => revision.id).join("|");
  const [scope, setScope] = useState("household");
  const [tab, setTab] = useState("balances");
  const [date, setDate] = useState(observations.at(-1)?.date ?? (localDateValue() < baseline.planDate ? baseline.planDate : localDateValue()));
  const initial = observations.find((entry) => entry.date === date);
  const [balances, setBalances] = useState<Record<string, number | null>>(initial?.balances ?? {});
  const [note, setNote] = useState(initial?.note ?? "");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const existing = observations.find((entry) => entry.date === date);
  const previousObservation = history.filter((entry) => entry.date < date).at(-1);
  const draft: BalanceObservation = { id: existing?.id ?? "draft", baselineId: baseline.id, date, balances, note };
  const enteredComparison = compareActuals(baseline, draft, scope);
  const household = compareActuals(baseline, draft);
  const activeAccounts = baseline.accounts.filter((account) => account.activeDate <= date);
  const firstBalanceDate = baseline.rebase?.date ?? baseline.planDate;
  const validDate = Boolean(parsePlanDate(date)) && date >= firstBalanceDate && date <= baseline.points.at(-1)!.date;
  const chartObservations = useMemo(() => history.map((entry) => ({ date: entry.date, actual: compareActuals(baseline, entry).actual === null ? null : compareActuals(baseline, entry, scope).actual })), [baseline, history, scope]);
  const completeObservationCount = chartObservations.filter((entry) => entry.actual !== null).length;
  const unsavedBalances = activeAccounts.some((account) => (balances[account.key] ?? null) !== (existing?.balances[account.key] ?? null));
  const scopeHasUnsavedBalances = activeAccounts.some((account) => (scope === "household" || account.ownerId === scope)
    && (balances[account.key] ?? null) !== (existing?.balances[account.key] ?? null));
  const previewReforecast = validDate && unsavedBalances && household.actual !== null && household.expected > 0;
  const previewBalance = previewReforecast && scopeHasUnsavedBalances ? enteredComparison.actual : null;
  const reforecastEntries = useMemo(() => previewReforecast
    ? [...observations.filter((entry) => entry.date !== date), { id: "preview", baselineId: baseline.id, date, balances, note: "" }].sort((first, second) => first.date.localeCompare(second.date))
    : observations, [previewReforecast, observations, baseline.id, date, balances]);
  const comparisonDate = validDate ? date : firstBalanceDate;
  const [reforecast, setReforecast] = useState<{ request: BalanceObservation[] | null; comparisonDate: string; revisionKey: string; output: RollingReforecast; error: string }>({
    request: null, comparisonDate: "", revisionKey: "", output: { points: baseline.points, originalPoints: baseline.points, appliedDates: [], skippedDates: [] }, error: "",
  });
  const comparison = compareActuals(baseline, draft, scope, reforecast.output.originalPoints);
  const reforecastUpdating = reforecast.request !== reforecastEntries || reforecast.comparisonDate !== comparisonDate || reforecast.revisionKey !== revisionKey;
  const reforecastError = reforecastUpdating ? "" : reforecast.error;
  useEffect(() => {
    if (!reforecastEntries.some((entry) => { const result = compareActuals(baseline, entry); return result.actual !== null && result.expected > 0; })
      && revisions.length === 0 && [comparisonDate, ...reforecastEntries.map((entry) => entry.date)].every((date) => baseline.points.some((point) => point.date === date))) {
      setReforecast({ request: reforecastEntries, comparisonDate, revisionKey, output: { points: baseline.points, originalPoints: baseline.points, appliedDates: [], skippedDates: reforecastEntries.map((entry) => entry.date) }, error: "" });
      return;
    }
    let worker: Worker | null = null;
    let cancelled = false;
    const fail = (message: string) => {
      if (cancelled) return;
      setReforecast({ request: reforecastEntries, comparisonDate, revisionKey, output: { points: [], originalPoints: baseline.points, appliedDates: [], skippedDates: [] }, error: message });
      worker?.terminate();
    };
    const timer = window.setTimeout(() => {
      try {
        worker = new Worker(new URL("../lib/actuals.worker.ts", import.meta.url), { type: "module" });
        worker.onmessage = (event: MessageEvent<ActualsWorkerMessage>) => {
          if (cancelled) return;
          if (event.data.type === "complete") {
            setReforecast({ request: reforecastEntries, comparisonDate, revisionKey, output: event.data.output, error: "" });
            worker?.terminate();
          } else fail(event.data.message);
        };
        worker.onerror = (event) => { event.preventDefault(); fail("Unable to calculate the rolling reforecast. Try applying the balances again."); };
        worker.onmessageerror = () => fail("Unable to read the rolling reforecast.");
        worker.postMessage({ baseline, observations: reforecastEntries, comparisonDates: [comparisonDate], revisions });
      } catch {
        fail("Unable to start the rolling reforecast. Try applying the balances again.");
      }
    }, 350);
    return () => { cancelled = true; window.clearTimeout(timer); worker?.terminate(); };
  }, [baseline, reforecastEntries, comparisonDate, revisions, revisionKey]);
  function selectDate(nextDate: string) {
    const observation = observations.find((entry) => entry.date === nextDate);
    setDate(nextDate);
    setBalances(observation ? { ...observation.balances } : {});
    setNote(observation?.note ?? "");
    setSaved(false);
    setError("");
  }
  function saveEntry() {
    try {
      onChange(saveBalanceObservation(tracking, { ...draft, id: existing?.id ?? crypto.randomUUID() }));
      setSaved(true);
      setError("");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Unable to save these balances.");
    }
  }
  const chart = useMemo<EChartsOption>(() => {
  const plannedSeries = reforecast.output.originalPoints.map((point) => [parsePlanDate(point.date)!.getTime(), scope === "household"
    ? Object.values(point.portfolioByPerson).reduce((total, balance) => total + balance, 0) : point.portfolioByPerson[scope] ?? 0]);
  const actualSeries = chartObservations.map((entry) => [parsePlanDate(entry.date)!.getTime(), entry.actual]);
  const reforecastSeries = reforecast.output.points.map((point) => [parsePlanDate(point.date)!.getTime(), scope === "household"
    ? Object.values(point.portfolioByPerson).reduce((total, balance) => total + balance, 0) : point.portfolioByPerson[scope] ?? 0]);
  return {
    animationDuration: 250,
    color: ["#2563eb", "#059669"],
    tooltip: { trigger: "axis", valueFormatter: (value) => typeof value === "number" ? money(value) : "Not entered" },
    legend: { data: [isEditablePreview ? "Editable plan" : "Frozen plan", "Rolling reforecast", ...(previewBalance !== null ? ["Unsaved actuals"] : [])], top: 0, right: 12, textStyle: { fontSize: 11 } },
    grid: { top: 38, right: 20, bottom: 34, left: 80 },
    xAxis: { type: "time", axisLabel: { fontSize: 10, hideOverlap: true } },
    yAxis: { type: "value", scale: true, axisLabel: { fontSize: 10, formatter: (value: number) => value >= 1_000_000 ? `$${(value / 1_000_000).toFixed(1)}m` : `$${Math.round(value / 1_000)}k` }, splitLine: { lineStyle: { color: "#e5eaf0" } } },
    series: [
      { name: isEditablePreview ? "Editable plan" : "Frozen plan", type: "line", data: plannedSeries, showSymbol: false, lineStyle: { width: 3, type: "dashed" } },
      { name: "Rolling reforecast", type: "line", data: reforecastSeries, showSymbol: false, lineStyle: { width: 2, color: "#059669" }, z: 4 },
      { name: "Recorded balances", type: "scatter", data: actualSeries, symbol: "circle", symbolSize: 10,
        itemStyle: { color: "#059669", borderColor: "#ffffff", borderWidth: 2 }, clip: true, z: 5 },
      { name: "Unsaved actuals", type: "scatter", data: previewBalance !== null ? [[parsePlanDate(date)!.getTime(), previewBalance]] : [], symbol: "diamond", symbolSize: 13,
        itemStyle: { color: "#d97706", borderColor: "#ffffff", borderWidth: 2, opacity: 1 }, clip: true, z: 6 },
    ],
  };
  }, [baseline, observations, chartObservations, scope, date, previewBalance, reforecast.output, isEditablePreview]);
  return (
    <>
      <div className="actuals-overview-heading">
        <h2>Portfolio balance</h2>
        <label className="actuals-scope">Compare<select aria-label="Comparison scope" value={scope} onChange={(event) => setScope(event.target.value)}>
          <option value="household">Household</option>{baseline.people.map((person) => <option key={person.id} value={person.id}>{person.label}</option>)}
        </select></label>
      </div>
      <div className="actuals-metrics" aria-live="polite">
        <div><span>{isEditablePreview ? "Editable plan" : "Frozen plan"} · {dateLabel(date)}</span><strong>{money(comparison.planned)}</strong><small>{comparison.planned === null ? reforecastUpdating ? "Calculating original plan for this date..." : "Original-plan comparison unavailable" : isEditablePreview ? "Current editable-plan balance on this date" : "Original plan balance on this date"}</small></div>
        <div><span>Entered balance</span><strong>{comparison.actual === null ? comparison.entered === 0 ? "Not entered" : "Incomplete" : money(comparison.actual)}</strong><small>{comparison.entered} of {comparison.expected} accounts entered</small></div>
        <div><span>Difference from plan</span><strong className={comparison.difference === null ? "" : comparison.difference >= 0 ? "positive" : "negative"}>{money(comparison.difference)}</strong><small>{comparison.difference === 0 ? "On plan" : `${percentLabel(comparison.percent)}${comparison.difference !== null ? comparison.difference > 0 ? " ahead of plan" : " behind plan" : ""}`}</small></div>
      </div>
      <div className="actuals-chart"><ReactECharts option={chart} style={{ height: 260, width: "100%" }} notMerge lazyUpdate /></div>
      <div className="actuals-chart-status" role="status">
        <span>{reforecastUpdating ? "Updating rolling reforecast..." : reforecastError ? "Reforecast unavailable" : reforecast.output.appliedDates.length === 0 ? `No applied actuals · reforecast follows the ${isEditablePreview ? "editable" : "frozen"} plan` : `${reforecast.output.appliedDates.length} ${reforecast.output.appliedDates.length === 1 ? "balance reset" : "balance resets"} · same ${isEditablePreview ? "editable" : "frozen"} return path`}</span>
        <span>{completeObservationCount} saved {completeObservationCount === 1 ? "observation" : "observations"}</span>
        {revisions.length > 0 && <span>{revisions.length} saved forecast {revisions.length === 1 ? "revision" : "revisions"}</span>}
        {history.length > observations.length && <span>{history.length - observations.length} archived before rebase</span>}
        {history.length > completeObservationCount && completeObservationCount > 0 && <span>{history.length - completeObservationCount} incomplete</span>}
        {unsavedBalances && <span>{previewReforecast ? "Unsaved reforecast preview" : "Incomplete household entry · not applied"}</span>}
      </div>
      {reforecastError && <p className="actuals-error" role="alert">{reforecastError}</p>}
      <div className="actuals-section-tabs" role="tablist" aria-label="Actuals views">
        <button type="button" role="tab" aria-selected={tab === "balances"} aria-controls="actuals-balances" onClick={() => setTab("balances")}>Balances</button>
        <button type="button" role="tab" aria-selected={tab === "history"} aria-controls="actuals-history" onClick={() => setTab("history")}>History <span>{history.length}</span></button>
      </div>
      {tab === "balances" ? <section id="actuals-balances" role="tabpanel" aria-label="Balance entry">
        <div className="actuals-entry-toolbar">
          <label className="field-label">Balance date<input type="date" min={firstBalanceDate} max={baseline.points.at(-1)!.date} value={date} onChange={(event) => selectDate(event.target.value)} /></label>
          <button type="button" className="button button-quiet actuals-command" disabled={!validDate} title={previousObservation ? `Copy actual balances recorded on ${dateLabel(previousObservation.date)}. Missing balances stay blank.` : "Copy the frozen plan's starting account balances."} onClick={() => {
            setBalances(previousObservation ? { ...previousObservation.balances } : Object.fromEntries(activeAccounts.map((account) => [account.key, account.startingBalance])));
            setSaved(false);
          }}><Copy size={14} />{previousObservation ? "Copy last actuals" : "Use starting balances"}</button>
        </div>
        {!validDate && <p className="actuals-error" role="alert">Choose a date between {dateLabel(firstBalanceDate)} and {dateLabel(baseline.points.at(-1)!.date)}.</p>}
        <div className="actuals-table-wrap"><table className="actuals-balance-table">
          <thead><tr><th>Person / account</th><th>Account type</th><th>Holding</th><th>Actual balance</th></tr></thead>
          <tbody>{baseline.people.map((person) => {
            const accounts = activeAccounts.filter((account) => account.ownerId === person.id);
            const personComparison = compareActuals(baseline, draft, person.id);
            return <Fragment key={person.id}>
              <tr className="actuals-person-row"><th colSpan={3}>{person.label}<span>{personComparison.entered}/{accounts.length} entered</span></th><td>{personComparison.actual === null ? "Incomplete" : money(personComparison.actual)}</td></tr>
              {accounts.map((account) => <tr key={account.key}><td>{account.name}</td><td>{account.type === "rrsp" ? "RRSP / RRIF" : account.type === "tfsa" ? "TFSA" : "Non-registered"}</td><td>{account.returnType === "market" ? "Market-linked" : account.returnType === "savings" ? "Savings" : "Fixed-rate"}</td><td><span className="actuals-amount-input"><span>$</span><input type="number" min={0} step="1" inputMode="decimal" aria-label={`${person.label} ${account.name} actual balance`} placeholder="Not entered" value={balances[account.key] ?? ""} onChange={(event) => {
                const raw = event.target.value;
                setBalances((current) => ({ ...current, [account.key]: raw === "" ? null : Number(raw) }));
                setSaved(false);
              }} /></span></td></tr>)}
            </Fragment>;
          })}</tbody>
          <tfoot><tr><th colSpan={3}>{household.actual === null ? "Recorded so far" : "Household total"}<span>{household.entered}/{household.expected} entered</span></th><td>{money(household.recorded)}</td></tr></tfoot>
        </table></div>
        <div className="actuals-save-bar">
          <label className="field-label actuals-note">Note<input value={note} onChange={(event) => { setNote(event.target.value); setSaved(false); }} placeholder="Optional" /></label>
          <span className="actuals-entry-status" role="status">{saved ? household.actual === null ? "Saved · incomplete, not applied" : "Actuals saved to scenario" : household.entered < household.expected ? "Incomplete entry · not applied" : existing ? "Existing actuals" : "New actuals"}</span>
          <button type="button" className="button button-primary actuals-command" disabled={!validDate || household.entered === 0} onClick={saveEntry}><Save size={15} />{household.actual === null ? "Save incomplete entry" : "Apply actuals"}</button>
        </div>
        {error && <p className="actuals-error" role="alert">{error}</p>}
      </section> : <section id="actuals-history" role="tabpanel" aria-label="Balance history">
        {baseline.rebase && <p className="actuals-history-explanation">You can delete any entry, including an archived copy. Later balances and saved assumptions are kept, and affected forecasts are rebuilt. If the entry anchors a rebase, only that rebase is removed and later ones are reconnected.</p>}
        {error && <p className="actuals-error" role="alert">{error}</p>}
        <div className="actuals-table-wrap"><table className="actuals-history-table">
          <thead><tr><th>Date</th><th>{isEditablePreview ? "Editable plan" : "Frozen plan"}</th><th>Actual balance</th><th>Difference</th><th>Difference %</th><th>Entry</th><th>Note</th><th><span className="accounts-sr-only">Actions</span></th></tr></thead>
          <tbody>{[...history].reverse().map((entry) => {
            const result = compareActuals(baseline, entry, scope, reforecast.output.originalPoints);
            const archived = Boolean(baseline.rebase && entry.date < baseline.rebase.date);
            return <tr key={entry.id}><td>{dateLabel(entry.date)}</td><td title={result.planned === null ? reforecastUpdating ? "Calculating original plan for this date" : "Original-plan comparison unavailable" : undefined}>{money(result.planned)}</td><td>{result.actual === null ? "Incomplete" : money(result.actual)}</td><td className={result.difference === null ? "" : result.difference >= 0 ? "positive" : "negative"}>{money(result.difference)}</td><td>{percentLabel(result.percent)}</td><td>{result.entered}/{result.expected}</td><td className="actuals-history-note">{entry.note || "—"}</td><td><div className="actuals-history-actions">
              {archived ? <span title="Copy saved when rebasing. Deletion rebuilds later forecasts without removing their recorded balances.">Archived</span> :
              <button type="button" className="button button-quiet" title="Edit entry" aria-label={`Edit balances for ${entry.date}`} onClick={() => { selectDate(entry.date); setTab("balances"); }}><Pencil size={14} /></button>
              }
              <button type="button" className="button button-quiet" title="Delete entry and rebuild affected forecasts" aria-label={`Delete balances for ${entry.date}`} onClick={() => {
                try {
                  const deletion = deleteActualsEntry(tracking, baseline.id, entry.id);
                  const names = deletion.removedBaselines.map((entry) => `"${entry.name}"`).join(", ");
                  const rebuilt = deletion.rebuiltBaselines.map((entry) => `"${entry.name}"`).join(", ");
                  const impact = deletion.removedBaselines.length ? ` Rebase ${names} is anchored on this entry and will be removed. Its other entries and saved assumptions will be kept with the preceding valid baseline.` : " Existing baselines will be kept.";
                  const recalculation = rebuilt ? ` Later baselines ${rebuilt} will be rebuilt and reconnected as needed.` : " Remaining forecasts will recalculate automatically.";
                  const source = deletion.tracking.baselines.find((entry) => entry.id === deletion.tracking.workingBaselineId);
                  const forecast = source ? `The working forecast will use "${source.name}".` : "Projections will use the editable plan.";
                  if (!window.confirm(`Delete the balance entry for ${dateLabel(deletion.date)} and its copied versions?${impact}${recalculation} Later recorded balances and saved future assumptions will not be deleted, but calculated amounts between entries may change. ${forecast} Current Accounts balances, Plan date, and edited assumptions will not change. This saves immediately and cannot be undone. Export a backup first if needed.`)) return;
                  onChange(deletion.tracking);
                  if (date === entry.date) { setBalances({}); setNote(""); setSaved(false); }
                  setError("");
                } catch (failure) { setError(failure instanceof Error ? failure.message : "Unable to delete this entry."); }
              }}><Trash2 size={14} /></button>
            </div></td></tr>;
          })}{history.length === 0 && <tr><td colSpan={8} className="actuals-empty-cell">No recorded balances</td></tr>}</tbody>
        </table></div>
        {historyRevisions.length > 0 && <div className="working-forecast-history actuals-history-revisions"><h3>Forecast revisions</h3><ul>{historyRevisions.map((revision) => <li key={revision.id}><strong>{revision.name}</strong><span>From {dateLabel(revision.effectiveDate)}</span><small>Saved {new Date(revision.createdAt).toLocaleDateString("en-CA")}</small></li>)}</ul></div>}
      </section>}
    </>
  );
}