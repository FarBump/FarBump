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
         * Menggunakan ethereum.createOnLogin untuk memastikan 
         * signer (kunci) dibuat otomatis untuk user Farcaster.
         */
        embeddedWallets: {
          createOnLogin: "users-without-wallets",
          requireUserPasswordOnCreate: false, // Penting agar tidak ada popup password di Farcaster
        },
        /**
         * Smart Wallets (Account Abstraction ERC-4337)
         * Ini yang memungkinkan transaksi gasless via Paymaster Coinbase.
         */
        smartWallets: {
          enabled: true,
          createOnLogin: "users-without-wallets",
        },
        // Base Mainnet sebagai default
        defaultChain: base,
        supportedChains: [base],
      }}
    >
      {/** * URUTAN PENTING: SmartWalletsProvider membungkus provider data lainnya 
       * agar transaksi via Wagmi/SmartWalletClient tersinkronisasi dengan baik.
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
