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

      try {
        const response = await fetch("/api/bot/get-or-create-wallets", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ userAddress }),
        })

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}))
          const errorMessage = errorData.error || `Failed to get bot wallets (${response.status})`
          console.error("❌ Error fetching bot wallets:", errorMessage, errorData)
          throw new Error(errorMessage)
        }

        const data = await response.json()
        return data.wallets as BotWallet[]
      } catch (error: any) {
        console.error("❌ Error in useBotWallets queryFn:", error)
        // Re-throw to let React Query handle it
        throw error
      }
    },
    enabled: enabled && !!userAddress,
    staleTime: 5 * 60 * 1000, // Cache for 5 minutes (wallets are permanent)
    retry: 2, // Retry up to 2 times on failure
    retryDelay: 1000, // Wait 1 second between retries
  })
}

