"use client"

import { useQuery } from "@tanstack/react-query"
import { createSupabaseClient } from "@/lib/supabase"
import { formatUnits } from "viem"

interface CreditBalance {
  balanceWei: string
  balanceEth: string
  balanceUsd: number | null
  lastUpdated: string | null
}

/**
 * Fetches user credit balance from database and converts to USD
 * Uses real-time ETH price from CoinGecko API
 */
export function useCreditBalance(userAddress: string | null) {
  const supabase = createSupabaseClient()

  return useQuery<CreditBalance>({
    queryKey: ["credit-balance", userAddress],
    queryFn: async () => {
      if (!userAddress) {
        throw new Error("User address is required")
      }

      // Fetch balance from database
      const { data, error } = await supabase
        .from("user_credits")
        .select("balance_wei, last_updated")
        .eq("user_address", userAddress.toLowerCase())
        .single()

      if (error && error.code !== "PGRST116") {
        // PGRST116 = no rows returned, which is OK for new users
        throw error
      }

      const balanceWei = data?.balance_wei || "0"
      const balanceEth = formatUnits(BigInt(balanceWei), 18)

      // Fetch ETH price in USD from CoinGecko
      let balanceUsd: number | null = null
      try {
        const priceResponse = await fetch(
          "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd",
          {
            headers: {
              Accept: "application/json",
            },
          }
        )

        if (priceResponse.ok) {
          const priceData = await priceResponse.json()
          const ethPriceUsd = priceData.ethereum?.usd
          if (ethPriceUsd) {
            balanceUsd = parseFloat(balanceEth) * ethPriceUsd
          }
        }
      } catch (priceError) {
        console.warn("⚠️ Failed to fetch ETH price:", priceError)
        // Don't throw - USD conversion is optional
      }

      return {
        balanceWei,
        balanceEth,
        balanceUsd,
        lastUpdated: data?.last_updated || null,
      }
    },
    enabled: !!userAddress,
    refetchInterval: 30000, // Refetch every 30 seconds
    staleTime: 10000, // Consider data stale after 10 seconds
  })
}

