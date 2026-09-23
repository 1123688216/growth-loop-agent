/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ["pdf-parse", "@napi-rs/canvas", "mammoth"],
};

export default nextConfig;
