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
 * - Credit Balance = ETH value from converting $BUMP to ETH (stored in Supabase as wei)
 * - Database stores: balance_wei (90% of ETH from each convert transaction)
 * - Display: Converts wei → ETH → USD using real-time ETH price
 * - Used for paying for bump bot services in the future
 * - For $BUMP token balance, use useBumpBalance() instead
 * 
 * Credit Calculation:
 * - Each convert transaction: 90% of ETH result is stored in database (in wei)
 * - Total credit = Sum of all 90% portions from all convert transactions
 * - USD value = Total ETH credit × Current ETH price (refreshed every 15 seconds)
 * 
 * This ensures:
 * 1. Credit amount in ETH matches the actual ETH in Smart Wallet (90% of swap results)
 * 2. Credit value in USD follows ETH price fluctuations in real-time
 * 
 * This hook is completely independent from withdraw operations.
 * Withdraw uses useBumpBalance() which reads directly from blockchain.
 */
export function useCreditBalance(userAddress: string | null, options?: { enabled?: boolean }) {
  const supabase = createSupabaseClient()
  
  // Track if 406 error occurred - disable query if RLS policy not fixed
  const has406Error = typeof window !== "undefined" && sessionStorage.getItem("credit_406_error") === "true"
  const enabled = options?.enabled !== false && !!userAddress && !has406Error

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
          // Mark 406 error occurred - disable future queries to prevent console spam
          if (typeof window !== "undefined") {
            sessionStorage.setItem("credit_406_error", "true")
            
            // Only log warning once per session to avoid console spam
            if (!sessionStorage.getItem("credit_406_warned")) {
              console.warn("⚠️ Credit balance fetch failed (RLS policy issue). Disabling auto-refetch.")
              console.warn("💡 This does NOT affect withdraw - withdraw uses $BUMP token balance from blockchain.")
              console.warn("💡 Please update RLS policy in Supabase. See FIX-RLS-POLICY.md for instructions.")
              console.warn("💡 After fixing RLS policy, refresh the page to re-enable credit balance fetch.")
              sessionStorage.setItem("credit_406_warned", "true")
            }
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

      // Fetch ETH price in USD from CoinGecko (real-time)
      // IMPORTANT: ETH price is fetched fresh every time to reflect current market price
      // This ensures credit value in USD follows ETH price fluctuations
      let balanceUsd: number | null = null
      try {
        // Add cache-busting parameter to ensure fresh price data
        const cacheBuster = Date.now()
        const priceResponse = await fetch(
          `https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd&_=${cacheBuster}`,
          {
            headers: {
              Accept: "application/json",
            },
            // Don't cache ETH price - we want real-time updates
            cache: "no-store",
          }
        )

        if (priceResponse.ok) {
          const priceData = await priceResponse.json()
          const ethPriceUsd = priceData.ethereum?.usd
          if (ethPriceUsd && typeof ethPriceUsd === "number") {
            // Calculate USD value: ETH amount * current ETH price
            balanceUsd = parseFloat(balanceEth) * ethPriceUsd
            console.log(`💰 Credit conversion: ${balanceEth} ETH × $${ethPriceUsd.toFixed(2)} = $${balanceUsd.toFixed(2)}`)
          }
        } else {
          console.warn(`⚠️ Failed to fetch ETH price: ${priceResponse.status} ${priceResponse.statusText}`)
        }
      } catch (priceError) {
        console.warn("⚠️ Failed to fetch ETH price:", priceError)
        // Don't throw - USD conversion is optional, but log for debugging
      }

      return {
        balanceWei,
        balanceEth,
        balanceUsd,
        lastUpdated: data?.last_updated || null,
      }
    },
    enabled: enabled,
    // Refetch every 15 seconds to keep ETH price and credit value up-to-date
    // This ensures credit value in USD follows ETH price fluctuations in real-time
    refetchInterval: enabled ? 15000 : false, // Refresh every 15 seconds
    staleTime: 5000, // Consider data stale after 5 seconds (for faster price updates)
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
