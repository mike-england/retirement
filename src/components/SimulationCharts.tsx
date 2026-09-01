"use client";

import ReactECharts from "echarts-for-react";
import type { EChartsOption } from "echarts";
import type { DeterministicProjection, RetirementInputs } from "@/types/retirement";

type ChartKind = "portfolio" | "spending" | "cashFlow" | "taxDollars" | "taxRates" | "withdrawalRate" | "income";

type ChartDefinition = {
  title: string;
  description: string;
  kind: ChartKind;
};

const charts: ChartDefinition[] = [
  { title: "Portfolio balance over time", description: "TFSA, RRSP, and non-registered balances", kind: "portfolio" },
  { title: "Annual spending target", description: "After-tax target across spending phases", kind: "spending" },
  { title: "Annual cash surplus / shortfall", description: "All post-tax income and drawdowns compared with spending target", kind: "cashFlow" },
  { title: "Tax paid over time", description: "Federal and provincial tax in dollars", kind: "taxDollars" },
  { title: "Tax rates over time", description: "Marginal and average tax rates", kind: "taxRates" },
  { title: "RRIF withdrawal rate over time", description: "Actual RRSP/RRIF withdrawal rate vs. the mandatory minimum", kind: "withdrawalRate" },
  { title: "Income & Drawdown Sources", description: "Employment, government benefits, and account withdrawals", kind: "income" },
];

const phaseColors = ["rgba(37, 99, 235, 0.08)", "rgba(5, 150, 105, 0.08)", "rgba(234, 88, 12, 0.08)"];

export function SimulationCharts({
  inputs,
  projection,
}: {
  inputs: RetirementInputs;
  projection: DeterministicProjection | null;
}) {
  return <div className="chart-grid">{charts.map((chart, index) => <SimulationChart key={chart.kind} chart={chart} inputs={inputs} projection={projection} spanFullWidth={charts.length % 2 === 1 && index === charts.length - 1} />)}</div>;
}

function SimulationChart({
  chart,
  inputs,
  projection,
  spanFullWidth,
}: {
  chart: ChartDefinition;
  inputs: RetirementInputs;
  projection: DeterministicProjection | null;
  spanFullWidth: boolean;
}) {
  return <article className={`chart-panel chart-panel--${chart.kind}`} style={spanFullWidth ? { gridColumn: "1 / -1" } : undefined}><div className="panel-heading"><div><h2>{chart.title}</h2><p>{chart.description}</p></div></div>{projection ? <ReactECharts option={chartOption(chart.kind, inputs, projection)} style={{ height: 310, width: "100%" }} notMerge lazyUpdate /> : <div className="chart-placeholder" aria-label={`${chart.title} placeholder`}><div className="grid-lines" /></div>}</article>;
}

function chartOption(kind: ChartKind, inputs: RetirementInputs, projection: DeterministicProjection): EChartsOption {
  const medianYears = projection.years;
  const ages = medianYears.map((year) => year.age);
  const base = {
    animationDuration: 300,
    grid: { top: 36, right: 18, bottom: 80, left: 66 },
    legend: { type: "scroll", left: 42, right: 12, bottom: 4, itemGap: 10, textStyle: { fontSize: 10 } },
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "line", snap: true },
      confine: true,
      position: tooltipPosition,
      valueFormatter: (value: any) => formatCurrency(Number(value)),
    },
    xAxis: { type: "category", data: ages, axisLabel: { fontSize: 10, margin: 14 } },
    yAxis: { type: "value", axisLabel: { formatter: (value: number) => shortCurrency(value), fontSize: 10 }, splitLine: { lineStyle: { color: "#e8edf4" } } },
  };

  if (kind === "portfolio") {
    return {
      ...base,
      tooltip: {
        ...base.tooltip,
        formatter: (parameters: any) => {
          const rows = parameters
            .map((parameter: any) => `${parameter.marker} ${parameter.seriesName}<span style="float:right;margin-left:18px;font-weight:600">${formatCurrency(Number(parameter.value || 0))}</span>`)
            .join("<br/>");
          const total = parameters.reduce((sum: number, parameter: any) => sum + Number(parameter.value || 0), 0);
          return `<strong>Age ${parameters[0]?.axisValue ?? ""}</strong><br/>${rows}<hr style="margin:6px 0;border:0;border-top:1px solid #e2e8f0"/><span style="color:#64748b">Total</span><span style="float:right;margin-left:18px;font-weight:700">${formatCurrency(total)}</span>`;
        },
      },
      series: [
        areaSeries("Non-registered", medianYears.map((year) => year.closingBalances.nonRegistered), "#f59e0b", inputs, ages, true),
        areaSeries("RRSP", medianYears.map((year) => year.closingBalances.rrsp), "#2563eb", inputs, ages),
        areaSeries("TFSA", medianYears.map((year) => year.closingBalances.tfsa), "#10b981", inputs, ages),
        areaSeries("GIC / interest income", medianYears.map((year) => year.closingBalances.interestBearing), "#8b5cf6", inputs, ages),
      ],
    } as EChartsOption;
  }

  if (kind === "spending") {
    const actualFundedSpending = medianYears.map((year) => Math.min(year.spendingTarget, year.netSpendableCash));
    return {
      ...base,
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "line", snap: true },
        confine: true,
        position: tooltipPosition,
        formatter: (parameters: any) => {
          const year = medianYears.find((candidate) => candidate.age === Number(parameters[0]?.axisValue));
          if (!year) return "";
          const funded = Math.min(year.spendingTarget, year.netSpendableCash);
          const shortfall = Math.max(0, year.spendingTarget - funded);
          return `<strong>Age ${year.age}</strong><br/><span style="color:#64748b">Requested spending</span><span style="float:right;margin-left:18px;font-weight:600">${formatCurrency(year.spendingTarget)}</span><br/><span style="color:#64748b">Actual funded spending</span><span style="float:right;margin-left:18px;font-weight:600">${formatCurrency(funded)}</span>${shortfall > 0 ? `<br/><span style="color:#dc2626">Unmet spending</span><span style="float:right;margin-left:18px;font-weight:700">${formatCurrency(shortfall)}</span>` : ""}`;
        },
      },
      series: [
        areaSeries("Requested spending", medianYears.map((year) => year.spendingTarget), "#f59e0b", inputs, ages, true),
        lineSeries("Actual funded spending", actualFundedSpending, "#2563eb", inputs, ages),
      ],
    } as EChartsOption;
  }

  if (kind === "cashFlow") {
    const differences = medianYears.map((year) => year.netSpendableCash - year.spendingTarget);
    return {
      ...base,
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "shadow" },
        confine: true,
        position: tooltipPosition,
        formatter: (parameters: any) => {
          const year = medianYears.find((candidate) => candidate.age === Number(parameters[0]?.axisValue));
          if (!year) return "";
          const fundedCash = year.netSpendableCash;
          const gap = Math.max(0, year.spendingTarget - fundedCash);
          const surplus = Math.max(0, fundedCash - year.spendingTarget);
          const drawdowns = year.withdrawals.rrsp + year.withdrawals.tfsa + year.withdrawals.nonRegistered + year.withdrawals.interestBearing;
          return `<strong>Age ${year.age}</strong><br/><span style="color:#64748b">Requested spending</span><span style="float:right;margin-left:18px;font-weight:600">${formatCurrency(year.spendingTarget)}</span><br/><span style="color:#64748b">Recurring income after tax</span><span style="float:right;margin-left:18px;font-weight:600">${formatCurrency(year.recurringNetIncome)}</span><br/><span style="color:#64748b">Investment drawdowns</span><span style="float:right;margin-left:18px;font-weight:600">${formatCurrency(drawdowns)}</span><br/><span style="color:#64748b">Total funded cash</span><span style="float:right;margin-left:18px;font-weight:600">${formatCurrency(fundedCash)}</span><hr style="margin:6px 0;border:0;border-top:1px solid #e2e8f0"/><span style="color:${gap > 0 ? "#dc2626" : "#059669"}">${gap > 0 ? "Unmet spending" : "Cash surplus"}</span><span style="float:right;margin-left:18px;font-weight:700">${formatCurrency(gap || surplus)}</span>`;
        },
      },
      yAxis: { ...base.yAxis, axisLabel: { formatter: (value: number) => shortCurrency(value), fontSize: 10 }, splitLine: { lineStyle: { color: "#e8edf4" } } },
      series: [
        {
          name: "Surplus / shortfall",
          type: "bar",
          data: differences.map((value) => ({
            value,
            itemStyle: { color: value >= 0 ? "#10b981" : "#ef4444" },
          })),
          ...phaseAnnotations(inputs, ages),
          markLine: {
            ...phaseMarkLines(inputs, ages),
            lineStyle: { color: "#64748b" },
            data: [{ yAxis: 0 }, ...phaseMarkLines(inputs, ages).data],
          },
        },
      ],
    } as EChartsOption;
  }

  if (kind === "taxDollars") {
    return {
      ...base,
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "shadow" },
        confine: true,
        position: tooltipPosition,
        formatter: (parameters: any) => {
          const rows = parameters
            .map((parameter: any) => `${parameter.marker} ${parameter.seriesName}<span style="float:right;margin-left:18px;font-weight:600">${formatCurrency(Number(parameter.value || 0))}</span>`)
            .join("<br/>");
          const total = parameters.reduce((sum: number, parameter: any) => sum + Number(parameter.value || 0), 0);
          const year = medianYears.find((candidate) => candidate.age === Number(parameters[0]?.axisValue));
          const byPersonRows = year && year.taxesByPerson.length > 1
            ? `<hr style="margin:6px 0;border:0;border-top:1px solid #e2e8f0"/><strong style="font-size:11px">By person</strong><br/>${year.taxesByPerson.map((person) => `<span style="color:#64748b">${person.label}</span><span style="float:right;margin-left:18px;font-weight:600">${formatCurrency(person.totalTax)}</span>`).join("<br/>")}`
            : "";
          return `<strong>Age ${parameters[0]?.axisValue ?? ""}</strong><br/>${rows}<hr style="margin:6px 0;border:0;border-top:1px solid #e2e8f0"/><span style="color:#64748b">Total tax</span><span style="float:right;margin-left:18px;font-weight:700">${formatCurrency(total)}</span>${byPersonRows}`;
        },
      },
      series: [
        barSeries("Federal tax", medianYears.map((year) => year.taxes.federalTax), "#ef4444", inputs, ages, true),
        barSeries("Provincial tax", medianYears.map((year) => year.taxes.provincialTax), "#f97316", inputs, ages),
      ],
    } as EChartsOption;
  }

  if (kind === "taxRates") {
    return {
      ...base,
      tooltip: { ...base.tooltip, valueFormatter: (value: any) => `${(Number(value) * 100).toFixed(1)}%` },
      yAxis: { ...base.yAxis, axisLabel: { formatter: (value: number) => `${Math.round(value * 100)}%`, fontSize: 10 } },
      series: [
        lineSeries("Marginal tax rate", medianYears.map((year) => year.taxes.marginalRate), "#ef4444", inputs, ages, true),
        lineSeries("Average tax rate", medianYears.map((year) => year.taxes.averageRate), "#2563eb", inputs, ages),
      ],
    } as EChartsOption;
  }

  if (kind === "withdrawalRate") {
    const rrifWithdrawalRates = medianYears.map((year) => (year.openingBalances.rrsp === 0 ? 0 : year.withdrawals.rrsp / year.openingBalances.rrsp));
    const rrifMinimumRates = medianYears.map((year) => (year.openingBalances.rrsp === 0 ? 0 : (year.rrifMinimumWithdrawal ?? 0) / year.openingBalances.rrsp));
    return {
      ...base,
      tooltip: { ...base.tooltip, valueFormatter: (value: any) => `${(Number(value) * 100).toFixed(1)}%` },
      yAxis: { ...base.yAxis, axisLabel: { formatter: (value: number) => `${Math.round(value * 100)}%`, fontSize: 10 } },
      series: [
        lineSeries("RRIF withdrawal rate", rrifWithdrawalRates, "#2563eb", inputs, ages, true),
        lineSeries("Required minimum rate", rrifMinimumRates, "#ef4444", inputs, ages),
      ],
    } as EChartsOption;
  }

  return {
    ...base,
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "shadow" },
      confine: true,
      position: tooltipPosition,
      formatter: (parameters: any) => {
        const year = medianYears.find((candidate) => candidate.age === Number(parameters[0]?.axisValue));
        const total = parameters.reduce((sum: number, parameter: any) => sum + Number(parameter.value || 0), 0);
        const incomeRows = parameters
          .slice(0, 4)
          .filter((parameter: any) => Number(parameter.value || 0) !== 0)
          .map((parameter: any) => `${parameter.marker} ${parameter.seriesName}<span style="float:right;margin-left:18px;font-weight:600">${formatCurrency(Number(parameter.value))}</span>`)
          .join("<br/>");
        const drawdownRows = parameters
          .slice(4)
          .filter((parameter: any) => Number(parameter.value || 0) !== 0)
          .map((parameter: any) => `${parameter.marker} ${parameter.seriesName}<span style="float:right;margin-left:18px;font-weight:600">${formatCurrency(Number(parameter.value))}</span>`)
          .join("<br/>");
        const openingPortfolio = year ? year.openingBalances.rrsp + year.openingBalances.tfsa + year.openingBalances.nonRegistered + year.openingBalances.interestBearing : 0;
        const withdrawals = year ? year.withdrawals.rrsp + year.withdrawals.tfsa + year.withdrawals.nonRegistered + year.withdrawals.interestBearing : 0;
        const withdrawalRate = openingPortfolio === 0 ? 0 : withdrawals / openingPortfolio;
        const rrifMinimumRate = year && year.openingBalances.rrsp > 0 ? (year.rrifMinimumWithdrawal ?? 0) / year.openingBalances.rrsp : 0;
        const details = year ? `<hr style="margin:6px 0;border:0;border-top:1px solid #e2e8f0"/><span style="color:#64748b">Gross needed (pre-tax)</span><span style="float:right;margin-left:18px;font-weight:600">${formatCurrency(year.spendingTarget + year.taxes.totalTax)}</span><br/><span style="color:#64748b">Tax</span><span style="float:right;margin-left:18px;font-weight:600">${formatCurrency(year.taxes.totalTax)}</span><br/><span style="color:#64748b">Monthly spend</span><span style="float:right;margin-left:18px;font-weight:600">${formatCurrency(year.spendingTarget / 12)}</span><br/><span style="color:#64748b">Withdrawal rate</span><span style="float:right;margin-left:18px;font-weight:600">${formatPercent(withdrawalRate)}</span>${(year.rrifMinimumWithdrawal ?? 0) > 0 ? `<br/><span style="color:#64748b">RRIF minimum rate</span><span style="float:right;margin-left:18px;font-weight:600">${formatPercent(rrifMinimumRate)}</span>` : ""}${year.oasClawback > 0 ? `<br/><span style="color:#dc2626">OAS clawback</span><span style="float:right;margin-left:18px;font-weight:700;color:#dc2626">-${formatCurrency(year.oasClawback)}</span>` : ""}` : "";
        const drawdownSection = drawdownRows ? `<hr style="margin:6px 0;border:0;border-top:1px solid #e2e8f0"/><strong style="font-size:11px">Investment drawdown</strong><br/>${drawdownRows}<br/><span style="color:#64748b">Total drawdown</span><span style="float:right;margin-left:18px;font-weight:700">${formatCurrency(withdrawals)}</span>` : "";
        return `<strong>Age ${parameters[0]?.axisValue ?? ""}</strong><br/><span style="color:#64748b">Total sources</span><span style="float:right;margin-left:18px;font-weight:700">${formatCurrency(total)}</span><hr style="margin:6px 0;border:0;border-top:1px solid #e2e8f0"/><strong style="font-size:11px">Income</strong><br/>${incomeRows || "No income sources"}${drawdownSection}${details}`;
      },
    },
    series: [
      barSeries("Employment & pensions", medianYears.map((year) => year.income.employment), "#ec4899", inputs, ages, true),
      { ...barSeries("CPP", medianYears.map((year) => year.income.cpp), "#7c3aed", inputs, ages) },
      { ...barSeries("OAS", medianYears.map((year) => year.income.oas), "#0ea5e9", inputs, ages), markPoint: oasClawbackMarkPoint(medianYears) },
      barSeries("Interest income (taxable)", medianYears.map((year) => year.income.interest), "#a855f7", inputs, ages),
      barSeries("RRSP / RRIF drawdown", medianYears.map((year) => year.withdrawals.rrsp), "#2563eb", inputs, ages),
      barSeries("TFSA drawdown", medianYears.map((year) => year.withdrawals.tfsa), "#10b981", inputs, ages),
      barSeries("Non-registered drawdown", medianYears.map((year) => year.withdrawals.nonRegistered), "#f59e0b", inputs, ages),
      barSeries("GIC / interest income drawdown", medianYears.map((year) => year.withdrawals.interestBearing), "#8b5cf6", inputs, ages),
    ],
  } as EChartsOption;
}

function areaSeries(name: string, data: number[], color: string, inputs: RetirementInputs, ages: number[], annotate = false) {
  return { name, type: "line", stack: "balance", data, symbol: "none", itemStyle: { color }, lineStyle: { color }, areaStyle: { color }, ...(annotate ? phaseAnnotations(inputs, ages) : {}) };
}

function lineSeries(name: string, data: number[], color: string, inputs: RetirementInputs, ages: number[], annotate = false) {
  return { name, type: "line", data, symbol: "none", itemStyle: { color }, lineStyle: { color, width: 2 }, ...(annotate ? phaseAnnotations(inputs, ages) : {}) };
}

function barSeries(name: string, data: number[], color: string, inputs: RetirementInputs, ages: number[], annotate = false) {
  return { name, type: "bar", stack: "income", data, itemStyle: { color }, ...(annotate ? phaseAnnotations(inputs, ages) : {}) };
}

// Flags years where the OAS recovery tax reduced the benefit; omitted entirely when the plan never gets close to the threshold.
function oasClawbackMarkPoint(medianYears: DeterministicProjection["years"]) {
  const flaggedYears = medianYears.filter((year) => year.oasClawback > 0);
  if (flaggedYears.length === 0) return undefined;
  return {
    symbol: "pin",
    symbolSize: 22,
    itemStyle: { color: "#dc2626" },
    label: { formatter: "!", color: "#fff", fontWeight: 700, fontSize: 10 },
    data: flaggedYears.map((year) => ({
      name: "OAS clawback",
      coord: [year.age, year.income.oas + year.oasClawback],
      value: formatCurrency(year.oasClawback),
    })),
  };
}

function phaseAnnotations(inputs: RetirementInputs, ages: number[]) {
  return { markArea: phaseMarkAreas(inputs, ages), markLine: phaseMarkLines(inputs, ages) };
}

function phaseMarkAreas(inputs: RetirementInputs, ages: number[]) {
  if (ages.length === 0) return { data: [] };
  const minAge = ages[0];
  const maxAge = ages[ages.length - 1];
  return {
    silent: true,
    label: { show: true, position: "insideTop", fontSize: 10, color: "#475569" },
    // Clamp to the chart's actual age range so ECharts never gets asked for a category that doesn't exist.
    data: inputs.spendingPlan.phases
      .filter((phase) => phase.endAge >= minAge && phase.startAge <= maxAge)
      .map((phase, index) => [
        { name: `${phase.label} (${phase.startAge}-${phase.endAge})`, xAxis: Math.max(phase.startAge, minAge), itemStyle: { color: phaseColors[index % phaseColors.length] } },
        { xAxis: Math.min(phase.endAge, maxAge) },
      ]),
  };
}

function phaseMarkLines(inputs: RetirementInputs, ages: number[]) {
  if (ages.length === 0) return { data: [] };
  const minAge = ages[0];
  const maxAge = ages[ages.length - 1];
  return {
    silent: true,
    symbol: "none",
    lineStyle: { type: "dashed", color: "#94a3b8", width: 1 },
    label: { show: true, position: "insideEndTop", color: "#475569", fontSize: 9 },
    data: inputs.spendingPlan.phases
      .filter((phase) => phase.startAge >= minAge && phase.startAge <= maxAge)
      .map((phase) => ({
        name: phase.label,
        xAxis: phase.startAge,
      })),
  };
}

function formatCurrency(value: number) {
  return new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD", maximumFractionDigits: 0 }).format(value);
}


function tooltipPosition(point: number[], _parameters: unknown, _dom: HTMLElement, _rect: unknown, size: { contentSize: number[]; viewSize: number[] }) {
  const [x, y] = point;
  const [tooltipWidth, tooltipHeight] = size.contentSize;
  const [viewWidth, viewHeight] = size.viewSize;
  const left = x > viewWidth / 2 ? x - tooltipWidth - 14 : x + 14;
  return [
    Math.max(8, Math.min(left, viewWidth - tooltipWidth - 8)),
    Math.max(8, Math.min(y - tooltipHeight / 2, viewHeight - tooltipHeight - 8)),
  ];
}

function formatPercent(value: number) {
  return new Intl.NumberFormat("en-CA", { style: "percent", maximumFractionDigits: 1 }).format(value);
}

function shortCurrency(value: number) {
  if (Math.abs(value) >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (Math.abs(value) >= 1_000) return `$${Math.round(value / 1_000)}K`;
  return `$${Math.round(value)}`;
}
