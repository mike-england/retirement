# 1.2.0 (September 27, 2026)
- Derived household retirement timing from employment income end ages/months instead of a separate retirement date. Monthly spending and withdrawals begin when the last employment stream ends, while income streams can define their own partial first/final years.
- Income start/end age tooltips now show calendar month/year boundaries using the person's current age and birth month; income starts default to January and ends default to December.
- Separated contributions from income streams with a dedicated Contributions tab for owner, age range, and RRSP/TFSA/non-registered amounts. RRSP contributions reduce taxable income; all contributions reduce available cash.
- Contribution schedules apply across an inclusive calendar-year range; users can create a separate one-year schedule for unusual or partial years.
- Contribution schedules can be annual or monthly; monthly amounts are deposited through sub-period simulations so they participate in returns as they arrive.
- Added multiple GICs per person, including individual rates, terms, start ages, funding sources, auto-renewal, and cash-out maturity behavior. Existing single-GIC scenarios migrate automatically.
- Added a GIC buffer strategy that reserves the GIC near market peaks and draws it first during real drawdowns, with optional refill after recovery.
- Added a return distribution preview and reworked the shared Ledger/Monte Carlo return generator into a properly bounded distribution that tracks the requested mean and updates when assumptions change.
- Added a separate End-of-life tax Dashboard KPI for one-time estate tax.
- Updated default return assumptions to a moderate profile: 6% mean, 11% standard deviation, -25% floor, and +20% ceiling.
- Fixed false portfolio-depleted signals caused by OAS clawback timing and prevented pre-spending income from being silently reinvested as portfolio surplus.

# 1.1.0 (September 10, 2026)
- Added annual, semi-annual, quarterly, and monthly withdrawal schedules with randomized within-year returns that compound to the selected annual return.
- Added expandable Ledger rows showing sub-period returns, withdrawals, and portfolio values, with configurable account withdrawal order.
- Added optional income-stream start/end month overrides, date tooltips, household-lifespan validation, and CPP payout dollar estimates.
- Added the app version to the banner and expanded the Guide with plain-language model, privacy, save/export/import, and limitation explanations.
- Updated GitHub Pages deployment to use Node.js 24-compatible actions and to deploy only from pushed tags.
- Updated the Guide and Ledger presentation to explain and display sub-annual projections more clearly.
- Corrected sub-period cash-flow timing and Ledger double-counting of waterfall withdrawals.
- Corrected RRIF minimum and aggressive RRSP meltdown attribution in sub-period Ledger details, including the artificial December spike.
- Aligned income, CPP, OAS, and death-age proration with birthday and stream-specific month cutoffs.

# 1.0.0 (September 9, 2026)
- Initial retirement planner: simulation engine, Monte Carlo projections, government benefits and tax rules, results charts.
- Multi-person/couple plans: each person has their own age, target death age, CPP/OAS elections, and interest-bearing account, and files their own simulated tax return.
- Government benefits modeling: CPP and OAS annual amounts with early/deferred start-age adjustments, mandatory RRIF minimum withdrawals from age 71, and an approximated OAS clawback based on projected other taxable income.
- Canadian tax rules sourced from `@equisoft/tax-ca`, covering federal and all provincial/territorial brackets, basic personal amounts, and surtaxes for the current tax year.
- Configurable, reorderable withdrawal order across interest-bearing, non-registered, TFSA, and RRSP accounts to control drawdown sequencing.
- Income stream indexation options (none, full inflation, partial inflation, or a fixed rate) applied independently per income source.
- Deterministic single-path projection alongside a Monte Carlo simulation with configurable return mean/std-dev, inflation mean/std-dev, return floor/ceiling clamping, a reproducible random seed, and percentile-based success-rate, final estate, lifetime tax, and portfolio-peak-age summaries.
- Dashboard, Ledger, Monte Carlo, Compare, Tax Info, and Guide views, with charts for portfolio value, spending, cash flow, tax dollars, tax rates, RRIF withdrawal rate vs. the mandatory minimum, and income/drawdown sources by type.
- Deployed as a static export to GitHub Pages via GitHub Actions.
