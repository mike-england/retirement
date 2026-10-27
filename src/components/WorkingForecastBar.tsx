"use client";

import { History, Save } from "lucide-react";
import { useState } from "react";
import { createForecastRevision } from "@/lib/actuals";
import { workingForecastContext } from "@/lib/workingForecast";
import type { ActualsTracking, RetirementInputs } from "@/types/retirement";

export function WorkingForecastBar({ inputs, onChange }: { inputs: RetirementInputs; onChange: (tracking: ActualsTracking) => void }) {
  const context = workingForecastContext(inputs);
  const [year, setYear] = useState(context ? String(Number(context.asOf.slice(0, 4)) + 1) : "");
  const [name, setName] = useState("Updated forecast");
  const [error, setError] = useState("");
  if (!context || !inputs.actuals) return null;
  const tracking = inputs.actuals;
  const firstYear = Number(context.asOf.slice(0, 4)) + 1;
  const lastYear = Number(context.baseline.points.at(-1)!.date.slice(0, 4));
  const revisions = [...context.revisions].sort((first, second) => first.createdAt.localeCompare(second.createdAt));
  const lastSaved = revisions.at(-1)?.settings ?? context.baseline.inputs;
  const fields = ["incomeStreams", "contributionSchedules", "spendingPlan", "assumptions", "taxSettings", "strategy", "simulation"] as const;
  const hasDraftChanges = fields.some((field) => field === "simulation"
    ? ["randomSeed", "capitalGainsInclusionRate", "probateFeeRate"].some((key) => inputs.simulation[key as keyof typeof inputs.simulation] !== lastSaved.simulation[key as keyof typeof inputs.simulation])
    : JSON.stringify(inputs[field]) !== JSON.stringify(lastSaved[field]))
    || [{ ...inputs.personalInfo, id: "primary" }, ...inputs.personalInfo.additionalPeople].some((person) => {
      const savedAge = revisions.at(-1)?.rrifConversionAges ? revisions.at(-1)!.rrifConversionAges![person.id]
        : person.id === "primary" ? context.baseline.inputs.personalInfo.rrifConversionAge : context.baseline.inputs.personalInfo.additionalPeople.find((entry) => entry.id === person.id)?.rrifConversionAge;
      return (person.rrifConversionAge ?? 71) !== (savedAge ?? 71);
    });
  function saveRevision() {
    try {
      const revision = createForecastRevision(context!.baseline, inputs, `${year}-01-01`, name);
      onChange({ ...tracking, workingBaselineId: context!.baseline.id, forecastRevisions: [...(tracking.forecastRevisions ?? []), revision] });
      setError("");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Unable to save the forecast revision.");
    }
  }
  return (
    <section className="working-forecast-bar" aria-label="Working forecast">
      <div className="working-forecast-status"><strong>Working forecast as of {context.asOf}</strong><span>Actual balances applied · {context.baseline.name}</span>
        <small>Year-to-date income, withdrawals, and taxes are modeled, not recorded transactions.</small>
        <small>Current-year Ledger figures are full-year estimates, not additional amounts still to withdraw.</small>
      </div>
      <details className="working-forecast-revision">
        <summary>{hasDraftChanges ? "Future changes not applied · Save forecast revision" : "Revise future assumptions"}</summary>
        <div className="working-forecast-fields">
          <label className="field-label">Revision name<input value={name} onChange={(event) => setName(event.target.value)} /></label>
          <label className="field-label">Effective January 1<select aria-label="Forecast revision year" value={year} onChange={(event) => setYear(event.target.value)}>{Array.from({ length: Math.max(0, lastYear - firstYear + 1) }, (_, index) => firstYear + index).map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
          <button type="button" className="button button-primary working-forecast-command" disabled={lastYear < firstYear || !name.trim()} onClick={saveRevision}><Save size={14} />Save forecast revision</button>
        </div>
        <p>Uses the currently edited income, spending, contribution, return, tax, and withdrawal settings from the chosen year. Earlier years and recorded balances stay unchanged. Amounts retain the plan date's inflation basis.</p>
        {error && <p className="actuals-error" role="alert">{error}</p>}
      </details>
      {revisions.length > 0 && <details className="working-forecast-history"><summary><History size={13} />Forecast revisions ({revisions.length})</summary><ul>{revisions.map((revision) => <li key={revision.id}><strong>{revision.name}</strong><span>From {revision.effectiveDate}</span><small>Saved {new Date(revision.createdAt).toLocaleDateString("en-CA")}</small></li>)}</ul></details>}
      <button type="button" className="text-button working-forecast-source" onClick={() => {
        if (window.confirm("Use the editable plan instead? Actuals and revisions remain saved, but will not drive Ledger or Dashboard until actuals are applied again.")) onChange({ ...tracking, workingBaselineId: null });
      }}>Use editable plan</button>
    </section>
  );
}