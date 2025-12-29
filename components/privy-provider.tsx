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
        // Embedded Wallets: IMPORTANT - Privy memerlukan embedded wallet sebagai SIGNER untuk Smart Wallet
        // Berdasarkan dokumentasi Privy: "Smart wallets are controlled by embedded signers (EOA) secured by Privy"
        // Jadi Privy akan membuat embedded wallet sebagai signer untuk mengontrol Smart Wallet.
        // 
        // NOTE: Embedded wallet ini BUKAN wallet yang digunakan untuk transaksi.
        // Smart Wallet yang dikontrol oleh embedded signer ini yang digunakan untuk transaksi.
        // 
        // Untuk whitelabel login (Farcaster Mini App), kita perlu:
        // 1. Membiarkan Privy membuat embedded wallet sebagai signer (createOnLogin: "users-without-wallets" atau "all-users")
        // 2. Privy akan otomatis membuat Smart Wallet yang dikontrol oleh embedded signer tersebut
        // 3. Smart Wallet akan muncul di wallets array dengan walletClientType: 'smart_wallet'
        embeddedWallets: {
          ethereum: {
            createOnLogin: "users-without-wallets" as const, // Create embedded wallet as signer for Smart Wallet
          },
        },
        // Smart Wallets: Enabled untuk Account Abstraction
        // Berdasarkan dokumentasi Privy: Smart wallets dikontrol oleh embedded signers.
        // Privy akan otomatis membuat Smart Wallet yang dikontrol oleh embedded signer.
        // 
        // IMPORTANT: Untuk whitelabel login, automatic creation mungkin tidak bekerja.
        // Kita perlu menggunakan SmartWalletsProvider dan manually trigger creation jika perlu.
        smartWallets: {
          enabled: true,
          createOnLogin: "all-users" as const, // Create Smart Wallet for all users
        },
        // Note: externalWallets.solana removed to avoid errors
        // Solana is not used in this app, so we don't configure it
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


