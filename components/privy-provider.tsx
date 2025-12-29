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

  // Disable Embedded Wallets sepenuhnya karena:
  // 1. CSP restrictions di Farcaster Mini App webview
  // 2. User Farcaster sudah punya embed wallet dari Farcaster
  // 3. Hanya Smart Wallets yang digunakan untuk transaksi di app
  // Embedded Wallets tidak diperlukan untuk aplikasi ini

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
        // Disable Embedded Wallets: Tidak diperlukan karena CSP restrictions
        // dan kita hanya menggunakan Smart Wallets untuk transaksi
        embeddedWallets: {
          ethereum: {
            createOnLogin: "off" as const,
          },
        },
        // Smart Wallets: Ini yang akan dibuat untuk setiap user
        // dan digunakan untuk transaksi di app
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
