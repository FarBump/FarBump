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
        // Smart Wallets: Enabled untuk Account Abstraction
        // NOTE: createOnLogin mungkin TIDAK bekerja dengan whitelabel login (Farcaster Mini App)
        // Berdasarkan dokumentasi Privy: "Automatic wallet creation is currently not supported
        // if your app uses Privy's whitelabel login interfaces."
        // Karena kita menggunakan useLoginToMiniApp (whitelabel), kita perlu manually create
        // Smart Wallet setelah login di page.tsx menggunakan useCreateWallet hook
        smartWallets: {
          enabled: true,
          createOnLogin: "all-users" as const, // Mungkin tidak bekerja, manual creation di page.tsx
        },
        // Note: externalWallets.solana removed to avoid errors
        // Solana is not used in this app, so we don't configure it
        defaultChain: base,
      } as any}
    >
      <QueryClientProvider client={queryClient}>
        <WagmiProvider config={wagmiConfig}>{children}</WagmiProvider>
      </QueryClientProvider>
    </PrivyProviderBase>
  )
}


