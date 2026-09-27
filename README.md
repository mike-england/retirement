# Retirement Planner

A Next.js app for projecting retirement finances, including CPP/OAS benefits, Canadian tax rules, withdrawal
strategies, and Monte Carlo simulations.

**Hosted at: https://mike-england.github.io/retirement/**

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

