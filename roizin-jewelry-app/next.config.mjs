/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
  async rewrites() {
    return {
      // Serve the static PWA shell at the root. The app uses hash routing
      // (#/dashboard, #/new, ...) so every screen lives inside index.html.
      beforeFiles: [{ source: "/", destination: "/index.html" }],
    }
  },
}

export default nextConfig
