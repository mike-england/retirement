# Unreleased
- Made complete applied actuals drive the main Ledger, Dashboard, scenario comparisons, and Monte Carlo working forecast. Added an as-of/source banner, explicit modeled-YTD labels, and an editable-plan fallback that preserves history.
- Added immutable forecast revisions effective from a chosen future January 1, with saved settings, exact return paths, and recorded-balance snapshots. Future assumption edits stay drafts until saved; earlier years and the original baseline remain unchanged. Actuals charts and risk/strategy views use the same applied settings.
- Added original-plan comparisons at every actuals date, including monthly and irregular entries. History, cards, and chart now use balances captured by replaying the frozen ledger rules rather than leaving gaps between annual checkpoints or interpolating annual totals. Capturing comparisons does not change the original projection.
- Simplified Actuals entry to a balance date and Copy last actuals, falling back to starting balances when no earlier record exists. Removed cadence, next-period, and forecast-checkpoint selectors; existing dated entries still load automatically for editing.
- Replaced the Actuals observation-only line with a full rolling reforecast. Apply actuals resets complete household balances on their recorded dates and projects the remaining horizon with frozen ledger inputs and exact return paths, without restarting ages or repeating earlier modeled withdrawals. Added background-worker previews, incomplete-entry protection, and reproducibility checks for older baselines.
- Added a live amber Unsaved preview point to the Actuals chart for complete balance entries, matching the cards before saving. Saving commits the entry to green history; incomplete balances are not plotted as complete actuals.
- Made Actuals chart markers explicit so a single saved observation remains visible even when it overlaps the plan. Added saved/incomplete/unsaved chart status, and kept observations beyond the original forecast horizon in the Full plan view.
- Added Actuals: frozen plan baselines and revisions, dated per-account balance observations, household/per-person comparison metrics and charts, monthly/quarterly/annual entry navigation, and editable history. Missing balances remain incomplete rather than zero. Exact numeric comparisons use plan-date/year-end checkpoints; arbitrary monthly forecast values are not interpolated.
- Actuals actions save the current scenario automatically, and tracking history is included in existing scenario exports/imports. Per-person year-end portfolio checkpoints are now included in projection results without changing withdrawal timing.
- Kept the Ledger table mounted while debouncing yearly return edits, preserving input focus, expanded rows, and scroll position. Edited rates update immediately; validated amounts update in place with a pending status, without reusing stale data after scenario or other input changes.
- Prevented outdated or incomplete Ledger funding fields from appearing as real zeros. Displayed projections are tied to their inputs and calculator, funding/net-cash identities are validated, and Ledger includes Recalculate plus explicit retry errors without changing plan inputs.
- Added a per-person Ledger funding reconciliation with all cash sources, total funding, contributions, income tax, net cash, and a household total row. Scheduled registered withdrawals are included; taxable income is separated from cash-flow totals, and the breakdown displays cents.
- Replaced the expanded Ledger's tax-only Pension allocation column with actual Employment / pension income, keeping pension splitting in tax calculations without presenting it as a cash funding source.
- Replaced the expanded Ledger's OAS income-basis and OAS recovered columns with per-person OAS retained, CPP amount, and actual taxable income used for income tax. OAS clawback calculations are unchanged; taxable-income totals include income even when no tax is payable.
- Removed the legacy RRIF conversion Default option. Unset conversion ages now mean conversion at 71, with minimum withdrawals from 72, consistently including registered GIC holdings. Age choices run from each person's age at the plan date through 71, plus Already converted.
- Added three-line drag handles to reorder accounts within each person's list, with mouse, touch, and keyboard support. Saved scenarios retain the account order; balances and withdrawal strategy are unchanged.
- Moved account entry into a full-width Accounts workspace with individually named balances, account-type and return-treatment selectors, expandable details, per-person subtotals, and a household total. Existing balances and GIC rates migrate without requiring re-entry.
- Separated fixed-rate GICs and interest-bearing savings from tax wrappers, including RRSP/RRIF and TFSA holdings. Fixed rates are entered annually, savings need no term, and maturity transfers retain the tax wrapper. Registered fixed-holding withdrawals and estate balances are taxable; TFSA growth remains tax-free.
- Added a saved, editable Plan date to anchor starting ages, balances, calendar labels, and contribution-year defaults. Reopening a scenario no longer shifts its projections with the current month/year. Older saved scenarios migrate once using their last-saved date when available; exports/imports preserve the plan date.
- Prorate first-year investment gains/losses and GIC/HISA growth from the saved plan date in Ledger and Monte Carlo projections, including partial-month growth. Later years retain full-year growth; annual cash-flow and maturity assumptions are unchanged.

# 1.3.0 (October 25, 2026)
- Added optional password-protected scenario exports using browser-local PBKDF2 and AES-256-GCM encryption, with password confirmation and automatic encrypted-file detection on import. Existing JSON imports and exports remain supported; browser-saved scenarios remain unencrypted.
- Added a duplicate-name import prompt with Keep both (the default), Replace existing, and Cancel. Name matching ignores capitalization and surrounding whitespace; copies receive unique names and replacements preserve the saved scenario ID.
- Moved Monte Carlo simulations into a background worker with an animated concentric-arc loader, live completed-run counts and percentage.
- Enabled Delete for the New Scenario draft when saved scenarios exist; discarding the draft switches to a saved scenario and hides the draft entry until New is clicked or the page is reloaded.
- Added cookie-free GoatCounter page-visit analytics with automatic filtering of localhost and local-network visits, a fixed page path and title, no referrer reporting or click tracking, and no scenario data included in analytics.
- Allowed tax-aware withdrawals and aggressive RRSP meltdown to be enabled together, and grouped them with withdrawal order, frequency, and pension splitting. Separated CPP/OAS start ages into Government benefits and clarified that meltdown runs after spending is funded and can increase tax or OAS recovery.
- Made tax-aware withdrawals prioritize the user's account order, with only a limited OAS-reducing exception for the next non-registered account ahead of RRSP withdrawals. Removed the pension-splitting partner selector; enabling splitting assumes the primary and first additional person are eligible spouses/common-law partners.
- Added optional tax-aware household withdrawals and eligible spouse/common-law pension splitting, including employer pensions, RRIF income from age 65, CPP income in the tax assessment, and OAS recovery. Added per-person RRIF conversion ages, registered-GIC minimum withdrawals, and expandable Ledger tax-allocation reporting.
- Added lifetime OAS recovery to Dashboard and Compare, and corrected the OAS recovery income basis to include OAS itself, taxable capital gains, and dividend gross-ups. Strategies target current after-tax cash flow, not a guaranteed lifetime optimum; CPP pension sharing and tax-refund timing are not modeled.

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
