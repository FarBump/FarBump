“use client”

import { PrivyProvider as PrivyProviderBase } from “@privy-io/react-auth”
import { SmartWalletsProvider } from “@privy-io/react-auth/smart-wallets”
import { WagmiProvider } from “@privy-io/wagmi”
import { QueryClient, QueryClientProvider } from “@tanstack/react-query”
import { http, createConfig } from “wagmi”
import { base } from “wagmi/chains”
import { ReactNode } from “react”

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
throw new Error(“NEXT_PUBLIC_PRIVY_APP_ID environment variable is required”)
}

return (
<PrivyProviderBase
appId={appId}
config={{
loginMethods: [“farcaster”],
appearance: {
theme: “light”,
accentColor: “#676FFF”,
logo: “/farbump-logo.png”,
},
embeddedWallets: {
ethereum: {
createOnLogin: “all-users” as const,
requireUserPasswordOnCreate: false,
},
},
smartWallets: {
enabled: true,
createOnLogin: “all-users” as const,
},
// IMPORTANT: Disable external wallets for miniapp
externalWallets: {
coinbaseWallet: {
connectionOptions: “eoaOnly”,
},
},
defaultChain: base,
supportedChains: [base],
// CRITICAL FOR MINIAPP: Add legal config
legal: {
termsAndConditionsUrl: “https://farbump.vercel.app/terms”,
privacyPolicyUrl: “https://farbump.vercel.app/privacy”,
},
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
