"use client"

import { useQuery } from "@tanstack/react-query"
import { type Address } from "viem"

interface BotWallet {
  smartWalletAddress: Address
  index: number
}

interface UseBotWalletsOptions {
  userAddress: string | null
  enabled?: boolean
}

/**
 * Hook to get or create bot wallets for user
 */
export function useBotWallets({ userAddress, enabled = true }: UseBotWalletsOptions) {
  return useQuery<BotWallet[]>({
    queryKey: ["bot-wallets", userAddress],
    queryFn: async () => {
      if (!userAddress) {
        throw new Error("User address is required")
      }

      const response = await fetch("/api/bot/get-or-create-wallets", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ userAddress }),
      })

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        throw new Error(errorData.error || "Failed to get bot wallets")
      }

      const data = await response.json()
      return data.wallets as BotWallet[]
    },
    enabled: enabled && !!userAddress,
    staleTime: 5 * 60 * 1000, // Cache for 5 minutes (wallets are permanent)
  })
}

