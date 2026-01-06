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
 * 
 * IMPORTANT: This is NOT the $BUMP token balance!
 * - Credit Balance = ETH value from converting $BUMP to ETH (stored in Supabase)
 * - Used for paying for bump bot services in the future
 * - For $BUMP token balance, use useBumpBalance() instead
 * 
 * This hook is completely independent from withdraw operations.
 * Withdraw uses useBumpBalance() which reads directly from blockchain.
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

      // Handle errors gracefully
      if (error) {
        // PGRST116 = no rows returned, which is OK for new users
        if (error.code === "PGRST116") {
          // New user, no credits yet - return default
          return {
            balanceWei: "0",
            balanceEth: "0",
            balanceUsd: 0,
            lastUpdated: null,
          }
        }
        
        // Error 406 (Not Acceptable) = RLS policy issue - return default instead of throwing
        // Check error code and message
        // Note: Browser console will still show the 406 network error, but we handle it gracefully
        // Supabase PostgrestError doesn't have status property, so we check code and message
        const is406Error = 
          error.code === "406" ||
          error.message?.includes("406") || 
          error.message?.includes("Not Acceptable") ||
          error.details?.includes("406") ||
          String(error).includes("406")
        
        if (is406Error) {
          // Only log warning once per session to avoid console spam
          // This error does NOT affect withdraw operations (which use useBumpBalance)
          if (!sessionStorage.getItem("credit_406_warned")) {
            console.warn("⚠️ Credit balance fetch failed (RLS policy issue). Returning default values.")
            console.warn("💡 This does NOT affect withdraw - withdraw uses $BUMP token balance from blockchain.")
            console.warn("💡 Please update RLS policy in Supabase. See FIX-RLS-POLICY.md for instructions.")
            sessionStorage.setItem("credit_406_warned", "true")
          }
          return {
            balanceWei: "0",
            balanceEth: "0",
            balanceUsd: 0,
            lastUpdated: null,
          }
        }
        
        // For other errors, still throw to maintain error visibility
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
    retry: (failureCount, error: any) => {
      // Don't retry on 406 errors (RLS policy issue)
      const is406Error = 
        error?.code === "406" ||
        error?.message?.includes("406") || 
        error?.message?.includes("Not Acceptable") ||
        error?.details?.includes("406") ||
        String(error).includes("406")
      
      if (is406Error) {
        return false
      }
      // Retry up to 2 times for other errors
      return failureCount < 2
    },
    retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 30000),
  })
}


