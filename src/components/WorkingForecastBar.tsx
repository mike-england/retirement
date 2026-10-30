"use client";

import { CheckCircle2, History, LoaderCircle, TriangleAlert } from "lucide-react";
import { hasForecastAssumptionChanges } from "@/lib/actuals";
import { forecastInputsForYear } from "@/lib/simulationEngine";
import { workingForecastContext, workingForecastSummary } from "@/lib/workingForecast";
import type { ActualsTracking, DeterministicProjection, RetirementInputs } from "@/types/retirement";

const money = (value: number | null) => value === null ? "Not available" : new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD", maximumFractionDigits: 0 }).format(value);

export function WorkingForecastBar({ inputs, projection, projectionError, onChange }: { inputs: RetirementInputs; projection: DeterministicProjection | null; projectionError: string; onChange: (tracking: ActualsTracking) => void }) {
  const context = workingForecastContext(inputs);
  const audit = workingForecastSummary(inputs, projection);
  if (!context || !inputs.actuals) return null;
  const tracking = inputs.actuals;
  const revisions = [...context.revisions].sort((first, second) => first.createdAt.localeCompare(second.createdAt));
  const futureYear = Number(context.asOf.slice(0, 4)) + 1;
  const hasDraftChanges = hasForecastAssumptionChanges(inputs, forecastInputsForYear(context.baseline.inputs, context.revisions, futureYear));
  return (
    <section className="working-forecast-bar" aria-label="Working forecast">
      <div className="working-forecast-status"><strong>Working forecast as of {context.asOf}</strong><span>Actual balances applied · {context.baseline.name}</span>
        {context.baseline.rebase && <small>Rebased from {context.baseline.rebase.date} balances · saved {new Date(context.baseline.createdAt).toLocaleString("en-CA")}</small>}
        <small>Year-to-date income, withdrawals, and taxes are modeled, not recorded transactions.</small>
        <small>Current-year Ledger figures are full-year estimates, not additional amounts still to withdraw.</small>
      </div>
      <div className={`working-forecast-calculation${projectionError ? " working-forecast-calculation--error" : ""}`} role="status" aria-live="polite">
        {projectionError ? <TriangleAlert size={14} /> : projection ? <CheckCircle2 size={14} /> : <LoaderCircle size={14} className="working-forecast-spinner" />}
        <span>{projectionError ? "Calculation failed · updated withdrawal and funding amounts are unavailable" : projection ? "Dashboard & Ledger recalculated from applied balances" : "Recalculating Dashboard & Ledger from applied balances..."}</span>
      </div>
      {projection && audit?.nextYear && <p className={`working-forecast-funding ${audit.totalGap > 0 ? "working-forecast-funding-gap" : "working-forecast-funded"}`} role="status">{audit.totalGap > 0 ? `${money(audit.totalGap)} modeled funding gap from ${audit.nextYear.calendarYear} onward · first gap in ${audit.firstGapYear}` : `Modeled spending funded from ${audit.nextYear.calendarYear} through ${projection.years.at(-1)!.calendarYear}`}</p>}
      {audit && <details className="working-forecast-audit"><summary>Applied balances: {money(audit.totalBalance)} · {audit.asOf}</summary>
        <div className="working-forecast-audit-scroll"><table className="working-forecast-audit-table"><caption>Balances driving the working forecast</caption><thead><tr><th>Person / account</th><th>Account type</th><th>Applied balance</th></tr></thead><tbody>
          {audit.accounts.map((account) => <tr key={account.key}><th scope="row">{account.owner} / {account.name}</th><td>{account.type === "rrsp" ? "RRSP / RRIF" : account.type === "tfsa" ? "TFSA" : "Non-registered"}{account.returnType !== "market" ? account.returnType === "savings" ? " · Savings" : " · Fixed-rate" : ""}</td><td>{money(account.balance)}</td></tr>)}
        </tbody><tfoot><tr><th scope="row" colSpan={2}>Household total</th><td>{money(audit.totalBalance)}</td></tr></tfoot></table></div>
        {projection && audit.nextYear ? <>
          <div className="working-forecast-audit-scroll"><table className="working-forecast-audit-table"><caption>{audit.nextYear.calendarYear} projected withdrawals · next full calendar year</caption><thead><tr><th>Person</th><th>RRSP / RRIF</th><th>TFSA</th><th>Non-registered</th><th>GIC / savings</th></tr></thead><tbody>
            {audit.nextYear.taxesByPerson.map((person) => <tr key={person.id}><th scope="row">{person.label}</th><td>{money(person.rrspWithdrawals ?? null)}</td><td>{money(person.tfsaWithdrawals)}</td><td>{money(person.nonRegisteredWithdrawals)}</td><td>{money(person.interestBearingWithdrawals)}</td></tr>)}
          </tbody></table></div>
          <p>Annual modeled amounts, including scheduled withdrawals and RRIF minimums where applicable. Market-linked accounts are pooled by person and tax type; these are not instructions for individual named accounts. Funding is conditional on the saved assumptions, not guaranteed.</p>
        </> : projection ? <p>No full future calendar years remain after the applied balance date.</p> : <p>{projectionError ? "Resolve the calculation error before using withdrawal amounts." : "Withdrawal amounts and funding status will appear after recalculation."}</p>}
      </details>}
      {hasDraftChanges && <p className="working-forecast-funding" role="status">{futureYear <= Number(context.baseline.points.at(-1)!.date.slice(0, 4)) ? `Edited future assumptions are not applied yet. Rebase from Actuals to apply them automatically from January 1, ${futureYear}.` : "No full future calendar years remain for edited assumptions. Extend the editable plan and freeze a separate baseline to apply them."}</p>}
      {revisions.length > 0 && <details className="working-forecast-history"><summary><History size={13} />Forecast revisions ({revisions.length})</summary><ul>{revisions.map((revision) => <li key={revision.id}><strong>{revision.name}</strong><span>From {revision.effectiveDate}</span><small>Saved {new Date(revision.createdAt).toLocaleDateString("en-CA")}</small></li>)}</ul></details>}
      <button type="button" className="text-button working-forecast-source" onClick={() => {
        if (window.confirm("Use the editable plan instead? Actuals and revisions remain saved, but will not drive Ledger or Dashboard until actuals are applied again.")) onChange({ ...tracking, workingBaselineId: null });
      }}>Use editable plan</button>
    </section>
  );
}