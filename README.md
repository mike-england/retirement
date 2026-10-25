# Retirement Planner

A Next.js app for projecting retirement finances, including CPP/OAS benefits, Canadian tax rules, withdrawal
strategies, and Monte Carlo simulations.

**Hosted at: https://mike-england.github.io/retirement/**

## Household withdrawal strategies

Under **Strategy**, **Tax-aware household withdrawals** uses your withdrawal order as the baseline and chooses the more efficient person within the first available account type using estimated income tax plus OAS recovery. When non-registered is the next available account after RRSP, it can supplement from non-registered funds only if that reduces additional OAS recovery and improves after-tax cash. It does not promote TFSA just because withdrawals are tax-free; TFSA's place is determined by your order, with no separate account-protection setting. Mandatory RRIF withdrawals and the GIC buffer rule still apply. Withdrawal order, frequency, tax-aware withdrawals, pension splitting, and aggressive RRSP meltdown are grouped together; CPP/OAS start ages are in a separate Government benefits section.

Tax-aware withdrawals and aggressive RRSP meltdown can both be enabled. Spending is funded first, then meltdown adds registered withdrawals toward the next federal ordinary-income bracket. The final pension allocation, income tax, and OAS recovery are recalculated afterward, and eligible surplus is reinvested. Meltdown deliberately makes extra withdrawals and can increase current tax or OAS recovery; enabling tax-aware funding does not prevent that.

**Eligible pension income splitting** is a separate option that automatically treats the primary person and first additional person as eligible spouses/common-law partners; there is no partner selector. Only enable it when that assumption is true. An annual numerical search compares no split and allocations in either direction up to 50% of one donor's eligible income. Employer pension streams are treated as eligible unless their eligibility checkbox is cleared, and do not require RRSP conversion. Registered-account withdrawals generally qualify only after conversion to a RRIF and from age 65; ordinary RRSP withdrawals, CPP, and OAS do not. CPP pension sharing is a different Service Canada arrangement and is not modeled.

Set an optional **RRIF conversion age** under each person's Accounts section to model whole-account conversion, with minimum withdrawals beginning the following year. **Already converted** models an existing RRIF. Registered GIC holdings are included in the converted balance. The default retains legacy minimums and RRIF eligibility from age 71; it is not a conversion-timing recommendation. Explicit RRIF income streams are independently identified as RRIF income rather than ordinary RRSP withdrawals.

Expand a Ledger year to inspect each person's withdrawals, signed pension-income allocation, income tax, and OAS recovery. The Dashboard and Compare views also show lifetime OAS recovery. Save alternatives as separate scenarios to compare tax, OAS retained, and final estate on the same return assumptions.

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

