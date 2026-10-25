# Retirement Planner

A Next.js app for projecting retirement finances, including CPP/OAS benefits, Canadian tax rules, withdrawal
strategies, and Monte Carlo simulations.

**Hosted at: https://mike-england.github.io/retirement/**

## Scenario files and passwords

**Export** offers ordinary JSON or an optional password-protected file. Enable **Password protect file**, enter a password, and confirm it. We recommend at least 12 characters, but no minimum length is enforced. Both formats use the scenario name: `My Retirement` becomes `my-retirement.json` or `my-retirement.encrypted.json`. The encrypted file's contents are protected, but its filename reveals the scenario name.

**Import** accepts both existing JSON scenarios and encrypted files. Encrypted files prompt for the password before importing; an incorrect password or damaged file leaves the current scenario unchanged.

If an imported name matches a saved scenario (ignoring capitalization and surrounding whitespace), choose **Keep both**, **Replace existing**, or **Cancel**. **Keep both** is the default and adds `(copy)`, `(copy 2)`, and so on to avoid duplicate names. **Replace existing** updates the saved scenario while keeping its ID. **Cancel** leaves saved scenarios and the current selection unchanged. Encrypted imports check for matching names only after successful decryption.

Encryption runs locally using the browser's Web Crypto API: AES-256-GCM with a fresh 16-byte salt and 12-byte nonce per export, and PBKDF2-HMAC-SHA-256 with 600,000 iterations. Only ciphertext and non-secret format/cryptographic metadata are stored in the encrypted file. HTTPS or localhost is required.

Passwords are not persisted and cannot be recovered. Use a strong, unique passphrase and keep it in a password manager. Encryption protects the exported file only: **Save** and imported scenarios still use unencrypted browser local storage. It does not provide expiration or prevent a recipient from keeping decrypted data.

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

