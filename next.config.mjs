import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const webpack = require('webpack')

/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
  // Add empty turbopack config to silence the error
  // We're using webpack config instead
  turbopack: {},
  webpack: (config, { isServer }) => {
    // Exclude problematic modules from client bundle
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        net: false,
        tls: false,
        crypto: false,
      }
      
      // Exclude specific problematic packages from bundling
      config.externals = config.externals || []
      config.externals.push({
        'thread-stream': 'commonjs thread-stream',
        'pino-elasticsearch': 'commonjs pino-elasticsearch',
        'why-is-node-running': 'commonjs why-is-node-running',
        'tap': 'commonjs tap',
        'tape': 'commonjs tape',
        'fastbench': 'commonjs fastbench',
        'desm': 'commonjs desm',
      })
      
      // Use webpack's IgnorePlugin to ignore test files
      config.plugins.push(
        new webpack.IgnorePlugin({
          resourceRegExp: /\.(test|spec)\.(js|ts|mjs|cjs)$/,
        })
      )
      
      config.plugins.push(
        new webpack.IgnorePlugin({
          resourceRegExp: /\.(md|txt|log|map|snap)$/,
        })
      )
    }
    
    return config
  },
}

export default nextConfig
