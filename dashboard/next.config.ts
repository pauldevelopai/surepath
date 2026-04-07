import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: true },
  serverExternalPackages: ["@anthropic-ai/sdk"],
  experimental: {
    serverActionsBodySizeLimit: "20mb",
  },
};

export default nextConfig;
