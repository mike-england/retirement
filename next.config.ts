import type { NextConfig } from "next";

// GitHub Pages serves this repo under /retirement, so assets/routes must be prefixed to resolve.
const repoBasePath = "/retirement";

const nextConfig: NextConfig = {
  output: "export",
  basePath: repoBasePath,
  assetPrefix: repoBasePath,
  trailingSlash: true,
};

export default nextConfig;