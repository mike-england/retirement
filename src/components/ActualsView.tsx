"use client";

import { CalendarDays, Copy, Pencil, Save, Snowflake, Trash2 } from "lucide-react";
import ReactECharts from "echarts-for-react";
import type { EChartsOption } from "echarts";
import { Fragment, useEffect, useMemo, useState } from "react";
import { accountEntriesFor } from "@/lib/accounts";
import { compareActuals, createActualsBaseline, localDateValue, saveBalanceObservation, type RollingReforecast } from "@/lib/actuals";
import type { ActualsWorkerMessage } from "@/lib/actuals.worker";
import { parsePlanDate } from "@/lib/planDates";
import { projectWithVariableReturns } from "@/lib/projectionPath";
import { workingForecastContext } from "@/lib/workingForecast";
import type { ActualsBaseline, ActualsTracking, BalanceObservation, DeterministicProjection, RetirementInputs } from "@/types/retirement";

const money = (value: number | null) => value === null ? "—" : new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD", maximumFractionDigits: 0 }).format(value);
const dateLabel = (value: string) => parsePlanDate(value)?.toLocaleDateString("en-CA", { year: "numeric", month: "short", day: "numeric" }) ?? value;
const percentLabel = (value: number | null) => value === null ? "—" : new Intl.NumberFormat("en-CA", { style: "percent", maximumFractionDigits: 1, signDisplay: "exceptZero" }).format(value);
const emptyTracking: ActualsTracking = { baselines: [], observations: [] };

export function ActualsView({ inputs, projection, onChange, onOpenAccounts }: {
  inputs: RetirementInputs;
  projection: DeterministicProjection | null;
  onChange: (tracking: ActualsTracking) => void;
  onOpenAccounts: () => void;
}) {
  const tracking = inputs.actuals ?? emptyTracking;
  const baseline = tracking.baselines.find((entry) => entry.id === tracking.activeBaselineId) ?? tracking.baselines.at(-1);
  const [name, setName] = useState(tracking.baselines.length ? `Revision ${tracking.baselines.length}` : "Original plan");
  const [error, setError] = useState("");
  const accountCount = accountEntriesFor(inputs.existingAssets, inputs.personalInfo.currentAge).length
    + inputs.personalInfo.additionalPeople.reduce((total, person) => total + accountEntriesFor(person.existingAssets, person.currentAge).length, 0);
  function freezeBaseline() {
    if (!projection) return;
    try {
      const frozen = createActualsBaseline(inputs, workingForecastContext(inputs) ? projectWithVariableReturns(inputs) : projection, name);
      onChange({ ...tracking, baselines: [...tracking.baselines, frozen], activeBaselineId: frozen.id });
      setName(`Revision ${tracking.baselines.length + 1}`);
      setError("");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Unable to save this baseline.");
    }
  }
  return (
    <div className="actuals-view">
      <div className="actuals-baseline-bar">
        {baseline && <label className="field-label">Frozen baseline<select value={baseline.id} onChange={(event) => onChange({ ...tracking, activeBaselineId: event.target.value })}>
          {tracking.baselines.map((entry) => <option key={entry.id} value={entry.id}>{entry.name} · {dateLabel(entry.planDate)}</option>)}
        </select></label>}
        <label className="field-label">{baseline ? "New baseline name" : "Baseline name"}<input value={name} onChange={(event) => setName(event.target.value)} /></label>
        <button type="button" className="button button-primary actuals-command" disabled={!projection || accountCount === 0 || !name.trim()} onClick={freezeBaseline} title={baseline ? "Freeze the current plan as a new baseline; keep earlier baselines and entries." : "Save a frozen copy of the current plan and its forecast."}>
          <Snowflake size={15} />{baseline ? "New baseline" : "Freeze baseline"}
        </button>
        {baseline && <div className="actuals-baseline-stamp"><Snowflake size={14} /><span>Frozen {dateLabel(localDateValue(new Date(baseline.createdAt)))}<small>Plan date {dateLabel(baseline.planDate)} · Year-end checkpoints</small></span></div>}
      </div>
      {error && <p className="actuals-error" role="alert">{error}</p>}
      {!baseline ? <div className="actuals-empty-state">
        <CalendarDays size={30} strokeWidth={1.4} />
        <h2>{accountCount === 0 ? "No accounts in this plan" : "No frozen baseline"}</h2>
        <p>{accountCount === 0 ? "Account balances are needed before tracking can begin." : projection ? "The current plan is ready to freeze." : "Waiting for the current projection."}</p>
        {accountCount === 0 && <button type="button" className="button button-quiet" onClick={onOpenAccounts}>Open Accounts</button>}
      </div> : <BaselineActuals key={baseline.id} baseline={baseline} tracking={tracking} onChange={onChange} />}
    </div>
  );
}

function BaselineActuals({ baseline, tracking, onChange }: { baseline: ActualsBaseline; tracking: ActualsTracking; onChange: (tracking: ActualsTracking) => void }) {
  const observations = useMemo(() => tracking.observations.filter((entry) => entry.baselineId === baseline.id).sort((first, second) => first.date.localeCompare(second.date)), [tracking.observations, baseline.id]);
  const revisions = useMemo(() => (tracking.forecastRevisions ?? []).filter((entry) => entry.baselineId === baseline.id), [tracking.forecastRevisions, baseline.id]);
  const revisionKey = revisions.map((revision) => revision.id).join("|");
  const [scope, setScope] = useState("household");
  const [range, setRange] = useState("2");
  const [tab, setTab] = useState("balances");
  const [date, setDate] = useState(observations.at(-1)?.date ?? (localDateValue() < baseline.planDate ? baseline.planDate : localDateValue()));
  const initial = observations.find((entry) => entry.date === date);
  const [balances, setBalances] = useState<Record<string, number | null>>(initial?.balances ?? {});
  const [note, setNote] = useState(initial?.note ?? "");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const existing = observations.find((entry) => entry.date === date);
  const previousObservation = observations.filter((entry) => entry.date < date).at(-1);
  const draft: BalanceObservation = { id: existing?.id ?? "draft", baselineId: baseline.id, date, balances, note };
  const enteredComparison = compareActuals(baseline, draft, scope);
  const household = compareActuals(baseline, draft);
  const activeAccounts = baseline.accounts.filter((account) => account.activeDate <= date);
  const validDate = Boolean(parsePlanDate(date)) && date >= baseline.planDate && date <= baseline.points.at(-1)!.date;
  const chartObservations = useMemo(() => observations.map((entry) => ({ date: entry.date, actual: compareActuals(baseline, entry).actual === null ? null : compareActuals(baseline, entry, scope).actual })), [baseline, observations, scope]);
  const completeObservationCount = chartObservations.filter((entry) => entry.actual !== null).length;
  const unsavedBalances = activeAccounts.some((account) => (balances[account.key] ?? null) !== (existing?.balances[account.key] ?? null));
  const scopeHasUnsavedBalances = activeAccounts.some((account) => (scope === "household" || account.ownerId === scope)
    && (balances[account.key] ?? null) !== (existing?.balances[account.key] ?? null));
  const previewReforecast = validDate && unsavedBalances && household.actual !== null && household.expected > 0;
  const previewBalance = previewReforecast && scopeHasUnsavedBalances ? enteredComparison.actual : null;
  const reforecastEntries = useMemo(() => previewReforecast
    ? [...observations.filter((entry) => entry.date !== date), { id: "preview", baselineId: baseline.id, date, balances, note: "" }].sort((first, second) => first.date.localeCompare(second.date))
    : observations, [previewReforecast, observations, baseline.id, date, balances]);
  const comparisonDate = validDate ? date : baseline.planDate;
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
  const firstYear = parsePlanDate(baseline.planDate)!.getFullYear();
  const latestDate = [baseline.planDate, observations.at(-1)?.date ?? baseline.planDate, previewBalance !== null ? date : baseline.planDate].sort().at(-1)!;
  const latestYear = parsePlanDate(latestDate)!.getFullYear();
  const endDate = range === "full" ? [baseline.points.at(-1)!.date, latestDate].sort().at(-1)!
    : `${Math.max(firstYear + Number(range) - 1, latestYear + 1)}-12-31`;
  return {
    animationDuration: 250,
    color: ["#2563eb", "#059669"],
    tooltip: { trigger: "axis", valueFormatter: (value) => typeof value === "number" ? money(value) : "Not entered" },
    legend: { data: ["Frozen plan", "Rolling reforecast", ...(previewBalance !== null ? ["Unsaved actuals"] : [])], top: 0, right: 12, textStyle: { fontSize: 11 } },
    grid: { top: 38, right: 20, bottom: 34, left: 80 },
    xAxis: { type: "time", axisLabel: { fontSize: 10, hideOverlap: true } },
    yAxis: { type: "value", scale: true, axisLabel: { fontSize: 10, formatter: (value: number) => value >= 1_000_000 ? `$${(value / 1_000_000).toFixed(1)}m` : `$${Math.round(value / 1_000)}k` }, splitLine: { lineStyle: { color: "#e5eaf0" } } },
    dataZoom: [{ type: "inside", filterMode: "filter", startValue: parsePlanDate(baseline.planDate)!.getTime(), endValue: parsePlanDate(endDate)!.getTime() }],
    series: [
      { name: "Frozen plan", type: "line", data: plannedSeries, showSymbol: false, lineStyle: { width: 3, type: "dashed" } },
      { name: "Rolling reforecast", type: "line", data: reforecastSeries, showSymbol: false, lineStyle: { width: 2, color: "#059669" }, z: 4 },
      { name: "Recorded balances", type: "scatter", data: actualSeries, symbol: "circle", symbolSize: 10,
        itemStyle: { color: "#059669", borderColor: "#ffffff", borderWidth: 2 }, clip: false, z: 5 },
      { name: "Unsaved actuals", type: "scatter", data: previewBalance !== null ? [[parsePlanDate(date)!.getTime(), previewBalance]] : [], symbol: "diamond", symbolSize: 13,
        itemStyle: { color: "#d97706", borderColor: "#ffffff", borderWidth: 2, opacity: 1 }, clip: false, z: 6 },
    ],
  };
  }, [baseline, observations, chartObservations, scope, range, date, previewBalance, reforecast.output]);
  return (
    <>
      <div className="actuals-overview-heading">
        <h2>Portfolio balance</h2>
        <label className="actuals-scope actuals-range">Range<select aria-label="Chart range" value={range} onChange={(event) => setRange(event.target.value)}><option value="2">2 years</option><option value="5">5 years</option><option value="full">Full plan</option></select></label>
        <label className="actuals-scope">Compare<select aria-label="Comparison scope" value={scope} onChange={(event) => setScope(event.target.value)}>
          <option value="household">Household</option>{baseline.people.map((person) => <option key={person.id} value={person.id}>{person.label}</option>)}
        </select></label>
      </div>
      <div className="actuals-metrics" aria-live="polite">
        <div><span>Frozen plan · {dateLabel(date)}</span><strong>{money(comparison.planned)}</strong><small>{comparison.planned === null ? reforecastUpdating ? "Calculating original plan for this date..." : "Original-plan comparison unavailable" : "Original plan balance on this date"}</small></div>
        <div><span>Entered balance</span><strong>{comparison.actual === null ? comparison.entered === 0 ? "Not entered" : "Incomplete" : money(comparison.actual)}</strong><small>{comparison.entered} of {comparison.expected} accounts entered</small></div>
        <div><span>Difference from plan</span><strong className={comparison.difference === null ? "" : comparison.difference >= 0 ? "positive" : "negative"}>{money(comparison.difference)}</strong><small>{comparison.difference === 0 ? "On plan" : `${percentLabel(comparison.percent)}${comparison.difference !== null ? comparison.difference > 0 ? " ahead of plan" : " behind plan" : ""}`}</small></div>
      </div>
      <div className="actuals-chart"><ReactECharts option={chart} style={{ height: 260, width: "100%" }} notMerge lazyUpdate /></div>
      <div className="actuals-chart-status" role="status">
        <span>{reforecastUpdating ? "Updating rolling reforecast..." : reforecastError ? "Reforecast unavailable" : reforecast.output.appliedDates.length === 0 ? "No applied actuals · reforecast follows the frozen plan" : `${reforecast.output.appliedDates.length} ${reforecast.output.appliedDates.length === 1 ? "balance reset" : "balance resets"} · same frozen return path`}</span>
        <span>{completeObservationCount} saved {completeObservationCount === 1 ? "observation" : "observations"}</span>
        {revisions.length > 0 && <span>{revisions.length} saved forecast {revisions.length === 1 ? "revision" : "revisions"}</span>}
        {observations.length > completeObservationCount && completeObservationCount > 0 && <span>{observations.length - completeObservationCount} incomplete</span>}
        {unsavedBalances && <span>{previewReforecast ? "Unsaved reforecast preview" : "Incomplete household entry · not applied"}</span>}
      </div>
      {reforecastError && <p className="actuals-error" role="alert">{reforecastError}</p>}
      <div className="actuals-section-tabs" role="tablist" aria-label="Actuals views">
        <button type="button" role="tab" aria-selected={tab === "balances"} aria-controls="actuals-balances" onClick={() => setTab("balances")}>Balances</button>
        <button type="button" role="tab" aria-selected={tab === "history"} aria-controls="actuals-history" onClick={() => setTab("history")}>History <span>{observations.length}</span></button>
      </div>
      {tab === "balances" ? <section id="actuals-balances" role="tabpanel" aria-label="Balance entry">
        <div className="actuals-entry-toolbar">
          <label className="field-label">Balance date<input type="date" min={baseline.planDate} max={baseline.points.at(-1)!.date} value={date} onChange={(event) => selectDate(event.target.value)} /></label>
          <button type="button" className="button button-quiet actuals-command" disabled={!validDate} title={previousObservation ? `Copy actual balances recorded on ${dateLabel(previousObservation.date)}. Missing balances stay blank.` : "Copy the frozen plan's starting account balances."} onClick={() => {
            setBalances(previousObservation ? { ...previousObservation.balances } : Object.fromEntries(activeAccounts.map((account) => [account.key, account.startingBalance])));
            setSaved(false);
          }}><Copy size={14} />{previousObservation ? "Copy last actuals" : "Use starting balances"}</button>
        </div>
        {!validDate && <p className="actuals-error" role="alert">Choose a date between {dateLabel(baseline.planDate)} and {dateLabel(baseline.points.at(-1)!.date)}.</p>}
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
        <div className="actuals-table-wrap"><table className="actuals-history-table">
          <thead><tr><th>Date</th><th>Frozen plan</th><th>Actual balance</th><th>Difference</th><th>Difference %</th><th>Entry</th><th>Note</th><th><span className="accounts-sr-only">Actions</span></th></tr></thead>
          <tbody>{[...observations].reverse().map((entry) => {
            const result = compareActuals(baseline, entry, scope, reforecast.output.originalPoints);
            return <tr key={entry.id}><td>{dateLabel(entry.date)}</td><td title={result.planned === null ? reforecastUpdating ? "Calculating original plan for this date" : "Original-plan comparison unavailable" : undefined}>{money(result.planned)}</td><td>{result.actual === null ? "Incomplete" : money(result.actual)}</td><td className={result.difference === null ? "" : result.difference >= 0 ? "positive" : "negative"}>{money(result.difference)}</td><td>{percentLabel(result.percent)}</td><td>{result.entered}/{result.expected}</td><td className="actuals-history-note">{entry.note || "—"}</td><td><div className="actuals-history-actions">
              <button type="button" className="button button-quiet" title="Edit entry" aria-label={`Edit balances for ${entry.date}`} onClick={() => { selectDate(entry.date); setTab("balances"); }}><Pencil size={14} /></button>
              <button type="button" className="button button-quiet" title="Delete entry" aria-label={`Delete balances for ${entry.date}`} onClick={() => {
                if (!window.confirm(`Delete the balance entry for ${dateLabel(entry.date)}?`)) return;
                onChange({ ...tracking, observations: tracking.observations.filter((observation) => observation.id !== entry.id) });
                if (date === entry.date) { setBalances({}); setNote(""); setSaved(false); }
              }}><Trash2 size={14} /></button>
            </div></td></tr>;
          })}{observations.length === 0 && <tr><td colSpan={8} className="actuals-empty-cell">No recorded balances</td></tr>}</tbody>
        </table></div>
      </section>}
    </>
  );
}