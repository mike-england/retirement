# 1.0.0 (September 9, 2026)
- Initial retirement planner: simulation engine, Monte Carlo projections, government benefits and tax rules, results charts.
- Multi-person/couple plans: each person has their own age, target death age, CPP/OAS elections, and interest-bearing (GIC/PPN) account, and files their own simulated tax return.
- Government benefits modeling: CPP and OAS annual amounts with early/deferred start-age adjustments, mandatory RRIF minimum withdrawals from age 71, and an approximated OAS clawback based on projected other taxable income.
- Canadian tax rules sourced from `@equisoft/tax-ca`, covering federal and all provincial/territorial brackets, basic personal amounts, and surtaxes for the current tax year.
- Configurable, reorderable withdrawal order across interest-bearing, non-registered, TFSA, and RRSP accounts to control drawdown sequencing.
- Income stream indexation options (none, full inflation, partial inflation, or a fixed rate) applied independently per income source.
- Deterministic single-path projection alongside a Monte Carlo simulation with configurable return mean/std-dev, inflation mean/std-dev, return floor/ceiling clamping, a reproducible random seed, and percentile-based success-rate, final estate, lifetime tax, and portfolio-peak-age summaries.
- Dashboard, Ledger, Monte Carlo, Compare, Tax Info, and Guide views, with charts for portfolio value, spending, cash flow, tax dollars, tax rates, RRIF withdrawal rate vs. the mandatory minimum, and income/drawdown sources by type.
- Deployed as a static export to GitHub Pages via GitHub Actions.
