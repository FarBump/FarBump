"use client"

import { PrivyProvider as PrivyProviderBase } from "@privy-io/react-auth"
import { SmartWalletsProvider } from "@privy-io/react-auth/smart-wallets"
import { WagmiProvider } from "@privy-io/wagmi"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { http, createConfig } from "wagmi"
import { base } from "wagmi/chains"
import { ReactNode } from "react"

const wagmiConfig = createConfig({
  chains: [base],
  transports: {
    [base.id]: http(),
  },
})

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
        // Embedded Wallets: CRITICAL - Privy memerlukan embedded wallet sebagai SIGNER untuk Smart Wallet
        // Berdasarkan dokumentasi Privy: "Smart wallets are controlled by embedded signers (EOA) secured by Privy"
        // 
        // IMPORTANT CONFIGURATION:
        // - createOnLogin: 'all-users' - Create embedded wallet for all users as signer for Smart Wallet
        // - requireUserPasswordOnCreate: false - CRITICAL for Farcaster Mini App to avoid password prompt
        //   This ensures Smart Wallet can be deployed seamlessly inside the Farcaster Mini App webview
        embeddedWallets: {
          ethereum: {
            createOnLogin: "all-users" as const,
            requireUserPasswordOnCreate: false, // CRITICAL: No password prompt in Farcaster Mini App
          },
        },
        // Smart Wallets: Enabled untuk Account Abstraction with Paymaster support
        // Configuration:
        // - enabled: true - Enable Smart Wallets
        // - createOnLogin: "all-users" - Create Smart Wallet for all users
        // - provider: 'light-account' or 'kernel' (default is fine, will use dashboard setting)
        // 
        // PAYMASTER CONFIGURATION:
        // Paymaster is configured in Privy Dashboard (Settings → Wallets → Smart Wallets → Paymaster)
        // When using Coinbase CDP Paymaster, Privy automatically handles:
        // - User Operation creation with Paymaster sponsorship
        // - pm_getPaymasterStubData calls to Coinbase CDP API
        // - Gas fee sponsorship for transactions
        // 
        // The Smart Wallet client (from useSmartWallets hook) automatically uses Paymaster
        // for all transactions, allowing users to transact with 0 ETH balance
        smartWallets: {
          enabled: true,
          createOnLogin: "all-users" as const,
          // provider: 'light-account' as const, // Optional: explicitly set provider (default uses dashboard setting)
        },
        // Note: externalWallets.solana removed to avoid errors
        // Solana is not used in this app, so we don't configure it
        // CRITICAL: Base must be set as defaultChain for smart wallets
        defaultChain: base,
      } as any}
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


