# Retirement Planner

A Next.js app for projecting retirement finances, including CPP/OAS benefits, Canadian tax rules, withdrawal
strategies, and Monte Carlo simulations.

**Hosted at: https://mike-england.github.io/retirement/**

## Current balances and first-year returns

Each scenario has a saved **Plan date** under People. Starting ages and account balances refer to that date, not the date when you reopen the app. New scenarios start with today's date; changing the date is explicit and does not automatically advance ages or balances. The date is included in ordinary and encrypted exports/imports. Older locally saved scenarios use their last-saved date when available, or today's date otherwise, and the migration is persisted once. Older imported files without a plan date use their last-saved date if included, otherwise the import date; review the Plan date after importing.

In the first calendar year, market gains/losses and GIC/HISA growth apply only from the saved plan date through year-end, including the remaining fraction of that month. Later years receive full-year growth. This applies to both the Ledger and Monte Carlo simulations. Ledger yearly return inputs remain annualized; expanded sub-period returns show the applied returns, with zero growth before the plan date. Calendar labels and contribution-year defaults also use the saved plan year.

This is a growth-timing adjustment, not a reconstruction of year-to-date cash flows or taxes. Spending, income, contributions, RRIF minimums, and GIC maturity scheduling retain their existing calendar-year rules. Interest already earned, withdrawals already taken, and taxes already paid are not inferred from current balances. Adjust partial-year spending and contribution amounts separately as appropriate.

## Accounts and holdings

When Actuals baselines exist, Accounts defaults to **Selected baseline**, following the baseline selected in Actuals. Its account catalog, per-person subtotals, household total, and as-of date use that baseline's latest complete saved balance entry, including a rebase snapshot when needed. Later incomplete entries do not replace the displayed totals, and zero remains a real zero. If the selected baseline has no complete entry, its frozen starting balances are shown instead. Holdings not yet active on the displayed date are excluded. This view is read-only; selecting a baseline changes the displayed snapshot without overwriting editable inputs or switching the working projection source.

Choose **Plan starting balances** to add/edit/reorder accounts or change their starting values and holding details. With no saved baseline, Accounts opens this editor directly. New actuals update the selected-baseline display automatically after they are saved as a complete entry; only a confirmed rebase changes the editable plan's starting Accounts and Plan date.

The main **Accounts** view uses the full workspace width. Add each account separately under its owner, with a name, balance, account type (RRSP/RRIF, TFSA, or non-registered), and return treatment. Each person has a subtotal, and the household total combines all entered account balances once. A fixed-rate holding inside an RRSP or TFSA is entered as its own row; do not also include that balance in another row. Totals include any holdings with a future start age, although the simulation activates those holdings only at that age.

Choose **Market-linked** for investments following the simulated market return, **Fixed-rate GIC / PPN** for a guaranteed annual rate with a term, or **Interest-bearing savings** for an assumed annual savings rate without a term to enter. Expand a row for its adjusted cost base or fixed-rate details. The fixed annual rate is not randomized in Monte Carlo. GIC maturity can renew the holding or move it into the market-linked balance within the same tax wrapper; TFSA growth remains tax-free, RRSP/RRIF withdrawals are taxable, and non-registered interest follows the modeled realization schedule.

Existing aggregate balances appear as named account rows. Legacy GIC total-term rates are converted into equivalent annual rates, preserving their compounded return. Editing an account saves the individual rows and recomputes the underlying totals automatically. Drag the three-line handle to reorder accounts within a person's list; keyboard users can focus the handle, press Space, use the arrow keys, and press Space again to drop or Escape to cancel. Saving the scenario preserves the order. Reordering does not change the withdrawal strategy: simulations still pool market-linked balances by person and tax type rather than selecting specific named accounts for withdrawals. RRIF conversion remains a per-person setting in the Accounts view.

## Actuals against a frozen plan

### Starting without a frozen baseline

When a scenario has no saved baseline, **Actuals** uses a live **Editable plan** reference from its saved Plan date, account balances, assumptions, and current forecast. You can compare and enter dated balances immediately; no initial Freeze baseline action is needed. Opening Actuals or editing the balance form does not save a scenario or freeze the reference. Dashboard, Ledger, and Monte Carlo continue using the editable plan until complete actuals are applied.

Before saving the first entry, review **People → Plan date**, ages, **Accounts** balances, and the income, spending, tax, and strategy assumptions. Starting ages and balances must describe the same plan date. If you are starting tracking today without a reliable older plan, use today's date and current ages and balances. Creating the reference now cannot reconstruct a lost historical forecast or earlier actual balances. To retain an older reference, use its original dated inputs or import a backup that already contains the baseline instead of replacing its starting balances with today's values.

With at least one account and a completed projection, enter a balance date and recorded balances. The first **Apply actuals** automatically freezes the current editable reference as **Original plan**, records the entry, and saves the scenario in one operation. **Save incomplete entry** also creates Original plan and saves the partial entry, but does not activate a working forecast until a complete entry is applied. The frozen reference uses the editable plan's starting balances, not the entered actual balances. Subsequent plan edits do not rewrite it.

Imported scenarios without tracking use the same live preview and automatic first-entry save. Routine balance updates and **Rebase from actuals** do not require another editable-plan freeze. After setup, **Freeze editable plan** is available under **More baseline options** only when you need a separate reference for changed editable inputs or account structure.

### Recording and comparing balances

Saving the first Actuals entry automatically preserves the current inputs, account identities, starting balances, exact return/inflation paths, and per-person year-end portfolio checkpoints. The dashed blue **Frozen plan** stays unchanged. The solid green **Rolling reforecast** uses dated actual balances and saved future forecast revisions over the same horizon. **Rebase from actuals** creates a dated reference from recorded balances. **Freeze editable plan** is the separate action for freezing the editable inputs, including structural changes to people or accounts, from their saved Plan date. Its confirmation states that date explicitly; it does not use actuals or advance to today. Ordinary future spending, income, return, tax, and withdrawal changes use a forecast revision instead. Earlier baselines and observations are retained. Balances are portfolio values before final estate settlement, not the after-tax estate KPI.

Choose a balance date, enter every tracked household account, then **Apply actuals**. **Copy last actuals** fills the form from the latest recorded entry strictly before that date, not from a forecast. When no earlier entry exists, **Use starting balances** copies the frozen baseline's account balances instead. Missing values in copied records stay blank, and selecting a date already recorded automatically loads that entry for editing. There are no cadence or forecast-checkpoint selectors: any date within the plan's lifespan can be entered directly.

Each complete entry resets balances on that date and changes the future reforecast; later observations supersede earlier projections without rewriting the frozen line. Blank means unknown and zero means an actual zero balance. **Save incomplete entry** retains partial work but does not apply it to the reforecast. Copying is an explicit convenience, not an assumption that balances stayed unchanged. **History** supports editing/deleting entries; applying the same baseline/date updates the existing observation. Existing complete observations are included automatically.

Complete unsaved household entries preview the entire adjusted forecast after a short debounce, with an amber **Unsaved actuals** marker. **Apply actuals** saves the reset and marks it as recorded history. Reforecasting runs in a worker to keep entry responsive, and the previous complete forecast remains visible with an updating status while the next result is calculated. Partial entries do not generate a full-household forecast preview. Saved actuals have green markers; the green line beyond those observations represents calculated forecasts, not observed balances.

The engine replays from the original plan date rather than restarting ages or replaying a fresh year's income at each observation. Starting-date actuals replace opening balances; later dates are end-of-day resets within the model's calendar-month convention. Period-end observations apply after that period's modeled withdrawal, and year-end observations become the closing balances for future years. Annual cash-flow timing, year-to-date modeled taxable income, and RRIF opening-balance rules remain those of the ledger. Balance observations do not supply actual income, taxes paid, realized gains, or deposits: modeled non-registered cost bases and fixed-holding term/accrual state remain assumptions, not facts inferred from the new balances.

Compare the household or an individual person. Each recorded date and the current balance date are compared with the original plan's modeled balance on that date, not just its starting date or year ends. The worker replays the frozen returns and cash-flow rules to capture those dated balances without changing the saved baseline or its annual results. History and the comparison cards show actual minus original-plan balance and that difference divided by the original-plan balance; a zero original-plan balance has no meaningful percentage. Incomplete actuals have no variance. Annual withdrawals remain at their modeled annual timing rather than being spread across months merely for comparisons.

Forecast lines connect year-end checkpoints, dated original-plan comparisons, and actual reset dates; they are not daily observed history. Named-account forecasts are not shown because the simulator pools accounts by person and tax type. The tracked account catalog is frozen with the baseline; create a new baseline when changing which accounts are tracked. Older baselines without stored return paths are compared/reforecast only when their seed reproduces the frozen checkpoints; otherwise the view asks for a new baseline instead of guessing or moving the original line.

Freezing, recording, and updating Actuals automatically save the current scenario, including its current plan inputs. A draft becomes a saved scenario under its current name. Actual balances remain separate from starting balances and never rebase the original plan automatically. Baselines and observations travel with ordinary and password-protected scenario exports/imports and remain browser-local when saved. A variance means ahead of or behind the frozen plan, not investment performance: extra deposits, withdrawals, and spending changes also affect it.

## The working forecast

**Apply actuals** makes that baseline and its complete observations drive the main **Ledger**, **Dashboard**, and saved-scenario comparisons, not just the Actuals chart. The working forecast recalculates future account withdrawals, taxes, income, balances, and estate results. Actuals keeps dated balance entries and forecast revisions in **History**, without a separate working-forecast banner. Existing complete observations from older scenarios are adopted automatically, using the baseline with the latest complete dated entry. Browsing another baseline in Actuals does not switch the working source; applying an entry does. **Use editable plan**, under **More baseline options**, explicitly returns to the editable-input projection without deleting actuals, baselines, or revisions; applying actuals again restores working-forecast mode.

While a working forecast is active, edits to future assumptions stay pending until you **Rebase from actuals**. Edit income, contributions, spending, returns, taxes, strategy, or RRIF-conversion settings, then confirm a rebase from a complete saved balance entry. Rebase automatically archives and applies changed settings from January 1 of the following year; no separate Save forecast revision action is required on Dashboard or Ledger. Applied balances take effect on their recorded date, while the balance year and earlier modeled cash flow remain unchanged. The automatic revision is immutable and saves its settings, exact return path, and recorded-balance snapshot with the new baseline. Unchanged settings do not create a redundant revision. Older revisions remain archived; an automatic revision supersedes an older revision for the same effective date, and revisions scheduled for later dates remain scheduled. Ages, benefit entitlements, province, plan date and starting-account structure remain structural settings rather than future-assumption edits. Monetary assumptions retain the original replay anchor's inflation basis.

Ledger past/current-year returns are fixed to the saved working path. Future Ledger return edits are applied automatically on the next rebase, and current-year Ledger amounts are full-year estimates rather than instructions to withdraw those amounts again. Year-to-date income, withdrawals, taxes paid, contribution history, and non-registered cost bases remain modeled: balance observations alone do not supply those transactions, and manual year-to-date transaction correction is not implemented. Assumption revisions start at calendar-year boundaries so they cannot silently rewrite the earlier portion of the current tax year. If no full future year remains, a rebase with edited assumptions is blocked rather than silently ignoring them; extend the editable plan and freeze a separate baseline if a longer horizon is needed.

Working-forecast Monte Carlo uses the applied balances and dated settings. The modeled path through the latest actuals year stays fixed; subsequent full calendar years are randomized using the applicable saved assumptions, and success/failure statistics evaluate those future full years. If no full future years remain, it reports that rather than a misleading success rate. The Dashboard's strategy comparison uses applied balances too and changes the compared strategy only from the next full calendar year.

### Checking recalculated balances and withdrawals

Dashboard and Ledger both use the same working-forecast projection after applying actuals or confirming a rebase. Check recorded balances, notes, archived entries, and forecast revision dates in Actuals **History**. Ledger marks every rebase date and the latest actuals year directly in its year column. Plan overview charts mark rebases with green vertical dashed lines, following the active working baseline's source history rather than unrelated saved baselines. The annual age axis places each line in its rebase year; labels show the date, or a date count when multiple rebases share a year. Merely browsing a different baseline does not change the working source or these markers.

Use the Dashboard's spending/funding-gap KPI and the Ledger's year-by-year figures to review funding. Expand a Ledger year for RRSP/RRIF, TFSA, non-registered, and GIC/savings withdrawals by person. These values come from the recalculated working projection, not stale starting-account balances. Market-linked accounts remain pooled by person and tax type: the model does not choose between individual named accounts of the same type.

Lifetime Dashboard KPIs include modeled history. Current-year Ledger amounts remain full-year estimates; balance entries alone cannot determine what is still left to withdraw after actual year-to-date withdrawals, contributions, realized gains, and taxes. The displayed withdrawal schedule includes modeled scheduled withdrawals and RRIF minimums where applicable, and a funded forecast is conditional on its saved assumptions rather than guaranteed. Review actual transactions and tax obligations before acting on a withdrawal amount.

### Ongoing plan reviews and backups

At each review (for example monthly, quarterly, or year-end), select the existing baseline and enter all household account balances for one common date. Enter zero for an empty account and leave unavailable balances blank; incomplete entries can be saved but do not update the household forecast. Apply the complete entry, then review the variance, working Ledger, Dashboard, and Monte Carlo. Do not advance the plan date, ages, or starting balances just because time has passed: actuals carry the dated balance updates without erasing the original reference.

For future assumption changes, edit the settings and **Rebase from actuals** to save and apply them automatically from the next January 1 after the selected balance date. Saving the scenario alone retains the edits but does not apply them to an active working forecast; the rebase review confirms their effective year. For structural changes, review the editable plan's dated inputs and use **Freeze editable plan**; old observations remain attached to their original baseline and are not moved to the new account catalog. Apply a complete entry against that baseline to make it the working source.

### Rebasing from recorded actuals

Select the source baseline and choose **Rebase from actuals**. In **Review new baseline**, enter a name and choose the saved balance date; the latest complete household entry is selected initially. You can choose an earlier complete saved entry, but not an arbitrary unrecorded date or an incomplete entry. Review the date and age changes, balances grouped by account owner, and household total, then **Confirm rebase**. Cancel makes no changes. The action is unavailable until a complete entry exists. Technical continuity details are under **Forecast assumptions carried forward**.

Confirmation updates the editable **Plan date**, **Accounts** balances, and calendar-year ages to the selected date, saves the new baseline, and switches the working forecast to it. This is not a new tax-year simulation: the baseline internally retains its original replay anchor, modeled cost bases, fixed-holding state, earlier balance resets, and saved revisions. Earlier frozen projection checkpoints remain before the transition; the selected actual balances anchor the new reference at the transition and its adjusted forecast afterward. Comparing the transition entry against its new reference therefore shows zero difference. The old baseline remains available for comparison with the original plan.

Old baselines, original entries, and forecast revisions are not modified or deleted. Entries later than the selected date stay with their original baseline rather than silently advancing the new one. The new baseline includes an immutable snapshot of the replay history through the selected date and scheduled saved revisions, so later edits to the source do not change it. Further observations belong to the new baseline on or after its rebase date; it can itself be rebased again. Saved revisions continue to apply at their scheduled dates, and new revisions use an eligible January 1 after the latest applied actuals year.

The rebased **History** tab and chart also include earlier archived balance entries, including incomplete entries and their notes, across successive rebases. The transition date appears only once. Earlier rows are marked **Archived**; edit their originals under the source baseline, or use the trash button directly on an archived row for dependency-aware deletion. Existing saved rebases show this history automatically, including after export/import.

Use the trash button on any **History** entry, including an archived entry, to remove that record and its linked copies without discarding later history. A middle entry that does not anchor a rebase is removed from affected snapshots, and their reference checkpoints and forecasts are rebuilt. If the entry anchors a rebase, only baselines anchored on that entry are removed; their other saved records and future assumptions move to the preceding valid baseline. Later rebases keep their recorded balance dates, are reconnected to a surviving source, and are rebuilt from the corrected replay history. Forecast revisions keep their settings and effective dates, with the deleted record removed from their archived observation lists. Later recorded balances are unchanged, though calculated amounts between observations can change.

Confirmation names removed anchor baselines and rebuilt later baselines before anything is saved. The working forecast keeps its surviving source or returns to a valid source/ editable plan; an explicit editable-plan choice stays unchanged. Current Accounts balances, Plan date, edited assumptions, and other scenarios are not changed. If preserving records would merge different balances or notes for the same baseline/date, deletion stops without changing history instead of silently choosing a version. Cancel makes no changes. Confirmation saves immediately and cannot be undone; export a backup first. Corrected snapshots are included in ordinary/encrypted export/import, so deleted entries do not reappear. There is no separate Clear all actuals history action.

To remove a mistaken baseline, select it and use the trash button beside the baseline selector. The confirmation identifies the baseline, the balance entries and saved forecast revisions to remove, and any working-forecast change. Other baselines and their history remain saved. A baseline used as the source of a newer rebase cannot be deleted until those dependent baselines are deleted first. Deleting the working baseline switches to a remaining baseline with applied actuals, or the editable plan if none qualifies; an explicit editable-plan choice stays unchanged. Deleting the final baseline returns Actuals to its live editable-plan preview. Deletion saves immediately and cannot be undone; it does not reset editable account balances or the Plan date. Export a backup first when keeping a recoverable copy matters.

Before the rebase date, the blue frozen reference and green rolling reforecast remain separate: the green line retains earlier balance resets and the forecasts between them, rather than reverting to the blue line with only historical dots. The new reference takes effect at the rebase date. This also applies to existing rebased scenarios and successive rebases.

Rebasing automatically saves edited future assumptions and applies them from the next full calendar year; the review names that year before confirmation. Balances still apply immediately on the chosen recorded date. Unsaved structural edits to people or tracked accounts are not carried into the rebased account snapshot; use **Freeze editable plan** for a changed structure. Ages use the model's calendar-year convention, not a reconstruction of birthdays between observations. Account cost bases and holding terms are not verified by a balance statement: continuity of their modeled state is preserved in the working replay, not inferred as actual transactions. **Use editable plan** explicitly leaves that replay and uses the dated editable inputs instead.

**Save**, ordinary **Export**, and password-protected **Export** retain all baselines (including frozen inputs, checkpoints, and return paths), dated balances and notes (including incomplete entries), the selected comparison baseline, working-forecast source or explicit editable-plan choice, and saved forecast revisions with their archived settings and balance snapshots. **Import** restores that state, rather than freezing a replacement baseline or turning archived actuals into starting balances. Unsaved balance-form edits and preview markers are not part of a scenario: apply or save the entry before exporting. Export a backup after important reviews; browser storage is not a separate backup. Replacing a same-named scenario on import replaces its tracking history too; use **Keep both** to preserve both versions rather than merge histories.

Rebased scenarios also save/export the selected transition date, source-baseline identity, dated editable snapshot, and immutable replay observations/revisions. Import validates and restores those snapshots for both ordinary and password-protected files.

## Household withdrawal strategies

Under **Strategy**, **Tax-aware household withdrawals** uses your withdrawal order as the baseline and chooses the more efficient person within the first available account type using estimated income tax plus OAS recovery. When non-registered is the next available account after RRSP, it can supplement from non-registered funds only if that reduces additional OAS recovery and improves after-tax cash. It does not promote TFSA just because withdrawals are tax-free; TFSA's place is determined by your order, with no separate account-protection setting. Mandatory RRIF withdrawals and the GIC buffer rule still apply. Withdrawal order, frequency, tax-aware withdrawals, pension splitting, and aggressive RRSP meltdown are grouped together; CPP/OAS start ages are in a separate Government benefits section.

Tax-aware withdrawals and aggressive RRSP meltdown can both be enabled. Spending is funded first, then meltdown adds registered withdrawals toward the next federal ordinary-income bracket. The final pension allocation, income tax, and OAS recovery are recalculated afterward, and eligible surplus is reinvested. Meltdown deliberately makes extra withdrawals and can increase current tax or OAS recovery; enabling tax-aware funding does not prevent that.

**Eligible pension income splitting** is a separate option that automatically treats the primary person and first additional person as eligible spouses/common-law partners; there is no partner selector. Only enable it when that assumption is true. An annual numerical search compares no split and allocations in either direction up to 50% of one donor's eligible income. Employer pension streams are treated as eligible unless their eligibility checkbox is cleared, and do not require RRSP conversion. Registered-account withdrawals generally qualify only after conversion to a RRIF and from age 65; ordinary RRSP withdrawals, CPP, and OAS do not. CPP pension sharing is a different Service Canada arrangement and is not modeled.

Set a **RRIF conversion age** under each person's Accounts section to model whole-account conversion, with minimum withdrawals beginning the following year. **Already converted** models an existing RRIF. Registered GIC holdings are included in the converted balance. Plans without a saved conversion age use age 71, with minimums starting at 72; there is no separate legacy Default option. This changes projections that previously used the old age-71 minimum fallback. Explicit RRIF income streams are independently identified as RRIF income rather than ordinary RRSP withdrawals.

Expand a Ledger year for a per-person funding reconciliation: employment/pension income, RRSP/RRIF draws (including scheduled streams), TFSA draws, non-registered funding, GIC/savings draws, OAS retained after clawback, and CPP add to **Total funding**. Subtract contributions and income tax to get **Net cash**. The summary shows cents and includes a household total row. Interest retained inside a GIC/savings holding is investment growth, not additional cash funding. Negative per-person net cash indicates that the person's funding is insufficient to cover their modeled tax and contributions; household funding can offset it.

**Taxable income** is shown separately from cash flow: pension splitting, tax-free withdrawals, return of cost basis, and modeled deductions can make it differ from funding received. The summary does not show tax-only pension allocations as funding, and no longer includes separate OAS income-basis or recovery columns. Clawback and pension splitting remain part of the calculations, and Dashboard and Compare still show lifetime OAS recovery. Save alternatives as separate scenarios to compare tax, OAS retained, and final estate on the same return assumptions.

Only complete, reconciled funding results are displayed. Projections are tied to the inputs and calculator that produced them, so changing inputs or updating the calculation code invalidates old results and triggers recalculation. For yearly return edits only, the Ledger retains the last complete table while displaying an updating status; the edited rates respond immediately, and amounts update in place after the debounce. This preserves focus, expanded rows, and scroll position when using the return arrows. Scenario switches and other input changes do not reuse the previous table. Missing reporting fields are not treated as actual zero funding. Calculations update automatically after input changes, applied actuals, and rebases; there is no manual Recalculate action. **Generate returns** changes the return path instead. If a fresh funding breakdown cannot be calculated, the Ledger shows an error rather than an incomplete table.

These options improve estimated current spendable cash within the withdrawal preferences, not lifetime wealth or estate tax. Pension splitting models the annual joint tax election, not monthly withholding or refund timing. CPP/OAS start ages remain user-selected. The model does not calculate pension-income or age credits, GIS, separate Quebec splitting rules, partial RRIF conversions, the spouse-age election for minimums, or all eligibility exceptions. Enabling splitting assumes the primary and first additional person meet CRA relationship and residency requirements. OAS recovery is based on each person's net income for tax purposes, not household after-tax spending: a $152,189 household spending target cannot simply be divided by two and compared with the recovery threshold. See [CRA pension income splitting](https://www.canada.ca/en/revenue-agency/services/tax/individuals/topics/pension-income-splitting.html).

OAS recovery now uses net income before the recovery deduction, including OAS itself, taxable gains, and dividend gross-ups. This corrects the earlier ordinary-income-only approximation and can change existing projections even with the new strategies disabled.

Focused regression tests can be run manually with `node --test tests/household-strategy.test.mjs`; they use Node's test runner and the existing TypeScript dependency.

## Monte Carlo simulations

Monte Carlo asks: **how does this retirement plan hold up across many different market and inflation histories?** A run simulates the entire household retirement horizon. With 1,000 runs, the app evaluates 1,000 possible sequences of returns and inflation, not 1,000 different sets of strategy settings.

Each run draws annual investment returns from the configured return distribution using its mean, standard deviation, floor, and cap. It also draws annual inflation using the inflation mean and standard deviation, with negative inflation set to zero. Monthly, quarterly, or semi-annual withdrawals include within-year return variation. Manual yearly return overrides from the Ledger are not used in Monte Carlo.

The order of returns matters, not just their average. Large losses early in retirement can force withdrawals from a depleted portfolio and leave less money to participate in a later recovery. Monte Carlo explores this sequence-of-returns risk as well as differences in overall market performance and inflation.

Your people, starting balances, income schedules, spending plan, benefit start ages, and strategy settings remain the same across runs. The model applies the selected withdrawal, tax, CPP/OAS, and eligible pension-splitting rules to each run's changing circumstances. It does not search for the best retirement date or strategy configuration, or predict which future will occur.

- **Success rate** is the share of simulated runs in which the modeled portfolio did not run out of money over the selected lifespan. It is conditional on your assumptions, not a guaranteed real-world probability. More runs reduce sampling noise but cannot fix unrealistic assumptions or missing model behavior.
- **Percentile bands** show the spread of portfolio balances at each age. Each age is summarized separately, so a percentile curve is not necessarily one actual simulated path. The worst-surviving percentile label uses the failure share to select a percentile; it is not a guarantee that the whole curve belongs to a surviving run.
- **Failure analysis** shows when failed runs first depleted their portfolios. Compare this alongside spending gaps, downside balances, and estate outcomes rather than choosing solely on a high median estate.

To compare strategies fairly, keep spending, lifespan, return/inflation assumptions, and the random seed unchanged. A fixed seed makes a calculation reproducible; it does not make the assumptions more accurate. The Dashboard and Ledger show one path, while Monte Carlo summarizes a range of paths, so their numbers need not match.

For speed, Monte Carlo uses a simpler pension-splitting policy that compares no split, eligible 50% splits in either direction, and an income-balancing split. Withdrawal sizing also uses a faster calculation with the existing solver as a fallback. Tax and OAS rules, account preferences, and simulation counts still apply. Dashboard, Ledger, and Compare retain the detailed searches. These approximations can cause small differences in individual projections; similar results in benchmark scenarios are not a guarantee for every plan.

## Scenario files and passwords

**Export** offers ordinary JSON or an optional password-protected file. Enable **Password protect file**, enter a password, and confirm it. We recommend at least 12 characters, but no minimum length is enforced. Both formats use the scenario name: `My Retirement` becomes `my-retirement.json` or `my-retirement.encrypted.json`. The encrypted file's contents are protected, but its filename reveals the scenario name.

**Import** accepts both existing JSON scenarios and encrypted files. Encrypted files prompt for the password before importing; an incorrect password or damaged file leaves the current scenario unchanged.

If an imported name matches a saved scenario (ignoring capitalization and surrounding whitespace), choose **Keep both**, **Replace existing**, or **Cancel**. **Keep both** is the default and adds `(copy)`, `(copy 2)`, and so on to avoid duplicate names. **Replace existing** updates the saved scenario while keeping its ID. **Cancel** leaves saved scenarios and the current selection unchanged. Encrypted imports check for matching names only after successful decryption.

Encryption runs locally using the browser's Web Crypto API: AES-256-GCM with a fresh 16-byte salt and 12-byte nonce per export, and PBKDF2-HMAC-SHA-256 with 600,000 iterations. Only ciphertext and non-secret format/cryptographic metadata are stored in the encrypted file. HTTPS or localhost is required.

Passwords are not persisted and cannot be recovered. Use a strong, unique passphrase and keep it in a password manager. Encryption protects the exported file only: **Save** and imported scenarios still use unencrypted browser local storage. It does not provide expiration or prevent a recipient from keeping decrypted data.

## Page-visit analytics

The site loads GoatCounter for cookie-free page-visit counts at https://retirement-planner.goatcounter.com, with no analytics build flag required. The script loads locally too, but its default hostname filtering skips counting visits from localhost and local-network addresses. Analytics uses a fixed `/retirement/` path and `Retirement Planner` title, with referrer reporting and click tracking disabled. Scenario names, financial inputs, passwords, and file contents are not included in analytics. Ad blockers and browser privacy settings may prevent visits from being counted.

## Running locally

### Option 1: Node.js dev server

Install [Node.js](https://nodejs.org/en/download), then from the repo root:

```
npm install
npm run dev
```

This starts a dev server at http://localhost:3000 with hot reload.

### Option 2: Static build + local HTTP server

This produces the same kind of static export deployed to GitHub Pages, with no Node.js server needed to serve it. The default local build uses root paths; the Pages build adds the `/retirement` base path.

```
npm install
npm run build
npx serve out
```

`npm run build` writes the static site to `out/`. Any static file server works in place of `serve`,
e.g. `python3 -m http.server 8000 --directory out`.

## Releasing

GitHub Pages deploys run automatically when a tag is pushed (from any branch), and can also be started manually from the Actions tab. To cut a release:

1. Bump the `version` in [package.json](package.json).
2. Add a new section at the top of [CHANGELOG.md](CHANGELOG.md): `# X.Y.Z (Month D, Year)` with bullet points.
3. Commit those changes.
4. `git tag vX.Y.Z`
5. `git push origin <branch> && git push origin vX.Y.Z`

To run any past release locally: `git checkout vX.Y.Z && npm ci && npm run dev` (or `npm run build`).

