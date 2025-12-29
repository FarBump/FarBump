"use client"

import { PrivyProvider as PrivyProviderBase } from "@privy-io/react-auth"
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
        // Embedded Wallets: Disable karena:
        // 1. User Farcaster sudah punya embed wallet dari Farcaster (custody address)
        // 2. CSP restrictions di Farcaster Mini App webview
        // 3. Hanya Smart Wallets yang digunakan untuk transaksi di app
        // createOnLogin: "off" berarti tidak membuat embedded wallet saat login
        embeddedWallets: {
          ethereum: {
            createOnLogin: "off" as const,
          },
        },
        // Smart Wallets: Akan otomatis dibuat saat user login dengan Farcaster auth
        // Smart Wallet ini yang digunakan untuk transaksi di app
        // enabled: true berarti Smart Wallet akan dibuat otomatis saat login
        smartWallets: {
          enabled: true,
        },
        // Disable Solana completely untuk menghilangkan warning
        externalWallets: {
          solana: {
            connectors: [],
          },
        },
        defaultChain: base,
      } as any}
    >
      <QueryClientProvider client={queryClient}>
        <WagmiProvider config={wagmiConfig}>{children}</WagmiProvider>
      </QueryClientProvider>
    </PrivyProviderBase>
  )
}
