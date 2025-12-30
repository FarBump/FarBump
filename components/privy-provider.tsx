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
         * CRITICAL: Embedded wallet diperlukan sebagai SIGNER untuk Smart Wallet
         */
        embeddedWallets: {
          ethereum: {
            createOnLogin: "all-users" as const,
            requireUserPasswordOnCreate: false, // CRITICAL: No password prompt in Farcaster Mini App
          },
        },
        /**
         * Smart Wallets (Account Abstraction ERC-4337)
         * Ini yang memungkinkan transaksi gasless via Paymaster Coinbase.
         * 
         * ⚠️ CRITICAL ISSUE: Privy does NOT automatically create Smart Wallets for Farcaster Mini App logins
         * Even with createOnLogin: "all-users", Smart Wallets are NOT created automatically when using loginToMiniApp()
         * 
         * SOLUTION: We need to manually create Smart Wallet after login succeeds
         * This is handled in page.tsx useEffect that watches for authenticated state
         * 
         * PAYMASTER CONFIGURATION:
         * Paymaster is configured in Privy Dashboard (Settings → Wallets → Smart Wallets → Paymaster)
         * When using Coinbase CDP Paymaster, Privy automatically handles:
         * - User Operation creation with Paymaster sponsorship
         * - pm_getPaymasterStubData calls to Coinbase CDP API
         * - Gas fee sponsorship for transactions
         * 
         * The Smart Wallet client (from useSmartWallets hook) automatically uses Paymaster
         * for all transactions, allowing users to transact with 0 ETH balance
         */
        smartWallets: {
          enabled: true,
          createOnLogin: "all-users" as const,
        },
        // Base Mainnet sebagai default
        defaultChain: base,
        supportedChains: [base],
      }}
    >
      <QueryClientProvider client={queryClient}>
        <WagmiProvider config={wagmiConfig}>
          <SmartWalletsProvider>
            {children}
          </SmartWalletsProvider>
        </WagmiProvider>
      </QueryClientProvider>
    </PrivyProviderBase>
  )
}
