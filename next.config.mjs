import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const webpack = require('webpack')

/** @type {import('next').NextConfig} */
const nextConfig = {
  // PENTING: Memaksa Next.js untuk memproses library blockchain dengan benar
  transpilePackages: ['viem', 'permissionless', 'ox', '@uniswap/v4-sdk', '@abstract-foundation/agw-client'],
  
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
  async redirects() {
    return [
      {
        source: '/.well-known/farcaster.json',
        destination: 'https://api.farcaster.xyz/miniapps/hosted-manifest/019b6904-aa9c-a5cf-d965-ccddf734f08e',
        permanent: false,
      },
    ]
  },
  webpack: (config, { isServer }) => {
    // Sediakan fallback untuk modul Node.js yang hilang di browser
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        net: false,
        tls: false,
        crypto: require.resolve('crypto-browserify'), // Lebih aman daripada 'false'
        stream: require.resolve('stream-browserify'),
      }
    }

    // Fix untuk "in operator" error dan ESM compatibility
    config.externals = [...(config.externals || [])]
    
    // Matikan warning terkait library yang memiliki dependency opsional
    config.ignoreWarnings = [
      { module: /node_modules\/pino/ },
      { message: /critical dependency/i },
    ]

    return config
  },
}

export default nextConfig
