"use client"

import { PrivyProvider as PrivyProviderBase } from "@privy-io/react-auth"
import { SmartWalletsProvider } from "@privy-io/react-auth/smart-wallets"
import { WagmiProvider } from "@privy-io/wagmi"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { http, createConfig } from "wagmi"
import { base } from "wagmi/chains"
import { ReactNode, useEffect } from "react"

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

  // Suppress SecurityError and showWalletLoginFirst warning for Farcaster Mini App
  // These warnings occur because Privy tries to detect browser wallets in cross-origin iframe
  useEffect(() => {
    if (typeof window !== "undefined") {
      const originalError = window.console.error
      const originalWarn = window.console.warn
      
      // Suppress SecurityError about window.ethereum
      window.console.error = (...args: any[]) => {
        const errorMessage = args[0]?.toString() || ""
        if (
          errorMessage.includes("Failed to read a named property 'ethereum'") ||
          errorMessage.includes("Blocked a frame with origin")
        ) {
          // Silently ignore this error - it's expected in Farcaster Mini App context
          return
        }
        // Log other errors normally
        originalError.apply(console, args)
      }

      // Suppress showWalletLoginFirst warning
      window.console.warn = (...args: any[]) => {
        const warnMessage = args[0]?.toString() || ""
        if (
          warnMessage.includes("showWalletLoginFirst") ||
          warnMessage.includes("wallet logins are also enabled")
        ) {
          // Silently ignore this warning - we only use Farcaster login, not wallet login
          return
        }
        // Log other warnings normally
        originalWarn.apply(console, args)
      }

      return () => {
        window.console.error = originalError
        window.console.warn = originalWarn
      }
    }
  }, [])

  return (
    <PrivyProviderBase
      appId={appId}
      config={{
        loginMethods: ["farcaster"],
        // Explicitly configure to prevent showWalletLoginFirst warning
        // We only use Farcaster login for Mini App, no external wallet connections
        // Setting externalWallets to smartWalletOnly prevents wallet detection
        externalWallets: {
          coinbaseWallet: {
            connectionOptions: "smartWalletOnly" as const,
          },
        },
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
         * 
         * IMPORTANT: "all-users" ensures embedded wallet is created for all users
         * We should NOT call createWallet() manually if embedded wallet already exists
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
