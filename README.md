# Retirement Planner

A Next.js app for projecting retirement finances, including CPP/OAS benefits, Canadian tax rules, withdrawal
strategies, and Monte Carlo simulations.

**Hosted at: https://mike-england.github.io/retirement/**

## Current balances and first-year returns

Each scenario has a saved **Plan date** under People. Starting ages and account balances refer to that date, not the date when you reopen the app. New scenarios start with today's date; changing the date is explicit and does not automatically advance ages or balances. The date is included in ordinary and encrypted exports/imports. Older locally saved scenarios use their last-saved date when available, or today's date otherwise, and the migration is persisted once. Older imported files without a plan date use their last-saved date if included, otherwise the import date; review the Plan date after importing.

In the first calendar year, market gains/losses and GIC/HISA growth apply only from the saved plan date through year-end, including the remaining fraction of that month. Later years receive full-year growth. This applies to both the Ledger and Monte Carlo simulations. Ledger yearly return inputs remain annualized; expanded sub-period returns show the applied returns, with zero growth before the plan date. Calendar labels and contribution-year defaults also use the saved plan year.

This is a growth-timing adjustment, not a reconstruction of year-to-date cash flows or taxes. Spending, income, contributions, RRIF minimums, and GIC maturity scheduling retain their existing calendar-year rules. Interest already earned, withdrawals already taken, and taxes already paid are not inferred from current balances. Adjust partial-year spending and contribution amounts separately as appropriate.

## Accounts and holdings

The main **Accounts** view uses the full workspace width. Add each account separately under its owner, with a name, balance, account type (RRSP/RRIF, TFSA, or non-registered), and return treatment. Each person has a subtotal, and the household total combines all entered account balances once. A fixed-rate holding inside an RRSP or TFSA is entered as its own row; do not also include that balance in another row. Totals include any holdings with a future start age, although the simulation activates those holdings only at that age.

Choose **Market-linked** for investments following the simulated market return, **Fixed-rate GIC / PPN** for a guaranteed annual rate with a term, or **Interest-bearing savings** for an assumed annual savings rate without a term to enter. Expand a row for its adjusted cost base or fixed-rate details. The fixed annual rate is not randomized in Monte Carlo. GIC maturity can renew the holding or move it into the market-linked balance within the same tax wrapper; TFSA growth remains tax-free, RRSP/RRIF withdrawals are taxable, and non-registered interest follows the modeled realization schedule.

Existing aggregate balances appear as named account rows. Legacy GIC total-term rates are converted into equivalent annual rates, preserving their compounded return. Editing an account saves the individual rows and recomputes the underlying totals automatically. Drag the three-line handle to reorder accounts within a person's list; keyboard users can focus the handle, press Space, use the arrow keys, and press Space again to drop or Escape to cancel. Saving the scenario preserves the order. Reordering does not change the withdrawal strategy: simulations still pool market-linked balances by person and tax type rather than selecting specific named accounts for withdrawals. RRIF conversion remains a per-person setting in the Accounts view.

## Actuals against a frozen plan

Open **Actuals** and **Freeze baseline** to save the current inputs, account identities, starting balances, exact return/inflation paths, and per-person year-end portfolio checkpoints. The dashed blue **Frozen plan** stays unchanged. The solid green **Rolling reforecast** uses dated actual balances and saved future forecast revisions over the same horizon. **New baseline** is for structural changes such as the plan date, people, or tracked accounts; ordinary future spending, income, return, tax, and withdrawal changes use a forecast revision instead. Earlier baselines and observations are retained. Balances are portfolio values before final estate settlement, not the after-tax estate KPI.

Choose a balance date, enter every tracked household account, then **Apply actuals**. **Copy last actuals** fills the form from the latest recorded entry strictly before that date, not from a forecast. When no earlier entry exists, **Use starting balances** copies the frozen baseline's account balances instead. Missing values in copied records stay blank, and selecting a date already recorded automatically loads that entry for editing. There are no cadence or forecast-checkpoint selectors: any date within the plan's lifespan can be entered directly.

Each complete entry resets balances on that date and changes the future reforecast; later observations supersede earlier projections without rewriting the frozen line. Blank means unknown and zero means an actual zero balance. **Save incomplete entry** retains partial work but does not apply it to the reforecast. Copying is an explicit convenience, not an assumption that balances stayed unchanged. **History** supports editing/deleting entries; applying the same baseline/date updates the existing observation. Existing complete observations are included automatically.

Complete unsaved household entries preview the entire adjusted forecast after a short debounce, with an amber **Unsaved actuals** marker. **Apply actuals** saves the reset and marks it as recorded history. Reforecasting runs in a worker to keep entry responsive, and the previous complete forecast remains visible with an updating status while the next result is calculated. Partial entries do not generate a full-household forecast preview. Saved actuals have green markers; the green line beyond those observations represents calculated forecasts, not observed balances.

The engine replays from the original plan date rather than restarting ages or replaying a fresh year's income at each observation. Starting-date actuals replace opening balances; later dates are end-of-day resets within the model's calendar-month convention. Period-end observations apply after that period's modeled withdrawal, and year-end observations become the closing balances for future years. Annual cash-flow timing, year-to-date modeled taxable income, and RRIF opening-balance rules remain those of the ledger. Balance observations do not supply actual income, taxes paid, realized gains, or deposits: modeled non-registered cost bases and fixed-holding term/accrual state remain assumptions, not facts inferred from the new balances.

Compare the household or an individual person. Each recorded date and the current balance date are compared with the original plan's modeled balance on that date, not just its starting date or year ends. The worker replays the frozen returns and cash-flow rules to capture those dated balances without changing the saved baseline or its annual results. History and the comparison cards show actual minus original-plan balance and that difference divided by the original-plan balance; a zero original-plan balance has no meaningful percentage. Incomplete actuals have no variance. Annual withdrawals remain at their modeled annual timing rather than being spread across months merely for comparisons.

Forecast lines connect year-end checkpoints, dated original-plan comparisons, and actual reset dates; they are not daily observed history. Named-account forecasts are not shown because the simulator pools accounts by person and tax type. The tracked account catalog is frozen with the baseline; create a revision when changing which accounts are tracked. Older baselines without stored return paths are compared/reforecast only when their seed reproduces the frozen checkpoints; otherwise the view asks for a new baseline instead of guessing or moving the original line.

Freezing, recording, and updating Actuals automatically save the current scenario, including its current plan inputs. A draft becomes a saved scenario under its current name. Actual balances remain separate from starting balances and never rebase the original plan automatically. Baselines and observations travel with ordinary and password-protected scenario exports/imports and remain browser-local when saved. A variance means ahead of or behind the frozen plan, not investment performance: extra deposits, withdrawals, and spending changes also affect it.

## The working forecast

**Apply actuals** makes that baseline and its complete observations drive the main **Ledger**, **Dashboard**, and saved-scenario comparisons, not just the Actuals chart. The working forecast recalculates future account withdrawals, taxes, income, balances, and estate results. Its banner shows the latest actuals date and source baseline. Existing complete observations from older scenarios are adopted automatically, using the baseline with the latest complete dated entry. Browsing another baseline in Actuals does not switch the working source; applying an entry does. **Use editable plan** explicitly returns to the editable-input projection without deleting actuals, baselines, or revisions; applying actuals again restores working-forecast mode.

While a working forecast is active, edits to future assumptions are drafts. Edit the existing income, contribution, spending, return, tax, strategy, or RRIF-conversion settings, expand **Revise future assumptions**, choose an effective January 1 after the latest actuals year, and **Save forecast revision**. The revision is immutable and saves both its settings and a snapshot of recorded balances; previous revisions remain in the revision history and exported scenario. Past years stay unchanged, and the original frozen plan remains the comparison reference. A later revision for the same effective date supersedes the earlier one in the working forecast without deleting its archive. Future revisions at later dates remain scheduled. Ages, benefit entitlements, province, plan date and starting-account structure need a new baseline rather than a future-settings revision. Monetary assumptions retain the original plan date's inflation basis.

Ledger past/current-year returns are fixed to the saved working path. Future Ledger return edits are drafts until saved in a revision, and current-year Ledger amounts are full-year estimates rather than instructions to withdraw those amounts again. Year-to-date income, withdrawals, taxes paid, contribution history, and non-registered cost bases remain modeled: balance observations alone do not supply those transactions, and manual year-to-date transaction correction is not implemented. Revisions start at calendar-year boundaries so they cannot silently rewrite the earlier portion of the current tax year.

Working-forecast Monte Carlo uses the applied balances and dated settings. The modeled path through the latest actuals year stays fixed; subsequent full calendar years are randomized using the applicable saved assumptions, and success/failure statistics evaluate those future full years. If no full future years remain, it reports that rather than a misleading success rate. The Dashboard's strategy comparison uses applied balances too and changes the compared strategy only from the next full calendar year.

## Household withdrawal strategies

Under **Strategy**, **Tax-aware household withdrawals** uses your withdrawal order as the baseline and chooses the more efficient person within the first available account type using estimated income tax plus OAS recovery. When non-registered is the next available account after RRSP, it can supplement from non-registered funds only if that reduces additional OAS recovery and improves after-tax cash. It does not promote TFSA just because withdrawals are tax-free; TFSA's place is determined by your order, with no separate account-protection setting. Mandatory RRIF withdrawals and the GIC buffer rule still apply. Withdrawal order, frequency, tax-aware withdrawals, pension splitting, and aggressive RRSP meltdown are grouped together; CPP/OAS start ages are in a separate Government benefits section.

Tax-aware withdrawals and aggressive RRSP meltdown can both be enabled. Spending is funded first, then meltdown adds registered withdrawals toward the next federal ordinary-income bracket. The final pension allocation, income tax, and OAS recovery are recalculated afterward, and eligible surplus is reinvested. Meltdown deliberately makes extra withdrawals and can increase current tax or OAS recovery; enabling tax-aware funding does not prevent that.

**Eligible pension income splitting** is a separate option that automatically treats the primary person and first additional person as eligible spouses/common-law partners; there is no partner selector. Only enable it when that assumption is true. An annual numerical search compares no split and allocations in either direction up to 50% of one donor's eligible income. Employer pension streams are treated as eligible unless their eligibility checkbox is cleared, and do not require RRSP conversion. Registered-account withdrawals generally qualify only after conversion to a RRIF and from age 65; ordinary RRSP withdrawals, CPP, and OAS do not. CPP pension sharing is a different Service Canada arrangement and is not modeled.

Set a **RRIF conversion age** under each person's Accounts section to model whole-account conversion, with minimum withdrawals beginning the following year. **Already converted** models an existing RRIF. Registered GIC holdings are included in the converted balance. Plans without a saved conversion age use age 71, with minimums starting at 72; there is no separate legacy Default option. This changes projections that previously used the old age-71 minimum fallback. Explicit RRIF income streams are independently identified as RRIF income rather than ordinary RRSP withdrawals.

Expand a Ledger year for a per-person funding reconciliation: employment/pension income, RRSP/RRIF draws (including scheduled streams), TFSA draws, non-registered funding, GIC/savings draws, OAS retained after clawback, and CPP add to **Total funding**. Subtract contributions and income tax to get **Net cash**. The summary shows cents and includes a household total row. Interest retained inside a GIC/savings holding is investment growth, not additional cash funding. Negative per-person net cash indicates that the person's funding is insufficient to cover their modeled tax and contributions; household funding can offset it.

**Taxable income** is shown separately from cash flow: pension splitting, tax-free withdrawals, return of cost basis, and modeled deductions can make it differ from funding received. The summary does not show tax-only pension allocations as funding, and no longer includes separate OAS income-basis or recovery columns. Clawback and pension splitting remain part of the calculations, and Dashboard and Compare still show lifetime OAS recovery. Save alternatives as separate scenarios to compare tax, OAS retained, and final estate on the same return assumptions.

Only complete, reconciled funding results are displayed. Projections are tied to the inputs and calculator that produced them, so changing inputs or updating the calculation code invalidates old results and triggers recalculation. For yearly return edits only, the Ledger retains the last complete table while displaying an updating status; the edited rates respond immediately, and amounts update in place after the debounce. This preserves focus, expanded rows, and scroll position when using the return arrows. Scenario switches and other input changes do not reuse the previous table. Missing reporting fields are not treated as actual zero funding. **Recalculate** reruns the current plan without changing its inputs or yearly return overrides; **Generate returns** changes the return path instead. If a fresh funding breakdown cannot be calculated, the Ledger shows an error with a retry button rather than an incomplete table.

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

