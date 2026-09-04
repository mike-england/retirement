import type { NextConfig } from "next";

// GitHub Pages serves this repo under /retirement, so assets/routes must be prefixed to resolve.
// Only apply during production builds so local `next dev` still serves at /.
const isGithubPagesBuild = process.env.GITHUB_PAGES_BUILD === "true";
const repoBasePath = "/retirement";

const nextConfig: NextConfig = {
  output: "export",
  ...(isGithubPagesBuild && {
    basePath: repoBasePath,
    assetPrefix: repoBasePath,
  }),
  trailingSlash: true,
};

export default nextConfig;