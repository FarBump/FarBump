"use client"

import { PrivyProvider as PrivyProviderBase } from "@privy-io/react-auth"
import { SmartWalletsProvider } from "@privy-io/react-auth/smart-wallets"
import { WagmiProvider } from "@privy-io/wagmi"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { http, createConfig } from "wagmi"
import { base } from "wagmi/chains"
import { ReactNode } from "react"

// 1. Inisialisasi Wagmi Config
const wagmiConfig = createConfig({
  chains: [base],
  transports: {
    [base.id]: http(),
  },
})

// 2. Inisialisasi Query Client
const queryClient = new QueryClient()

interface PrivyProviderProps {
  children: ReactNode
}

export function PrivyProvider({ children }: PrivyProviderProps) {
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID

  if (!appId) {
    throw new Error("NEXT_PUBLIC_PRIVY_APP_ID environment variable is required")
  }

  return (
    <PrivyProviderBase
      appId={appId}
      config={{
        loginMethods: ["farcaster"],
        appearance: {
          theme: "light",
          accentColor: "#676FFF",
          logo: "/farbump-logo.png",
        },
        /**
         * EOA Signer Configuration
         * Kita butuh EOA sebagai 'kunci' untuk mengontrol Smart Wallet.
         */
        embeddedWallets: {
          createOnLogin: "all-users",
          requireUserPasswordOnCreate: false, // Menghindari prompt di dalam Warpcast
        },
        /**
         * Smart Wallets (ERC-4337) Configuration
         * Ini akan membuat 'Smart Wallet' yang bisa menggunakan Paymaster.
         */
        smartWallets: {
          enabled: true,
          createOnLogin: "all-users",
        },
        // Base adalah chain utama untuk Smart Wallets
        defaultChain: base,
        supportedChains: [base],
      }}
    >
      {/** * URUTAN PENTING: 
       * SmartWalletsProvider harus berada di atas Wagmi & QueryClient 
       * agar client smart wallet tersedia di seluruh hook aplikasi.
       */}
      <SmartWalletsProvider>
        <QueryClientProvider client={queryClient}>
          <WagmiProvider config={wagmiConfig}>
            {children}
          </WagmiProvider>
        </QueryClientProvider>
      </SmartWalletsProvider>
    </PrivyProviderBase>
  )
}
