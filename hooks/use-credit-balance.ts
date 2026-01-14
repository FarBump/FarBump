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
 * - Credit Balance = Total ETH value from:
 *   1. Main Smart Wallet: ETH obtained through "Convert $BUMP to credit" function
 *   2. Bot Smart Wallets: Accumulated balance from 5 bot wallets obtained through "distribute" function
 * - Database stores:
 *   - user_credits.balance_wei: Main wallet credit (90% of ETH from each convert transaction)
 *   - bot_wallet_credits.distributed_amount_wei: Bot wallet credits (from distribute function)
 * - Display: Converts wei → ETH → USD using real-time ETH price
 * - Used for paying for bump bot services in the future
 * - For $BUMP token balance, use useBumpBalance() instead
 * 
 * Credit Calculation:
 * - Main wallet credit: Sum of all 90% portions from all convert transactions (stored in user_credits)
 * - Bot wallet credits: Sum of all distributed amounts to bot wallets (stored in bot_wallet_credits)
 * - Total credit = Main wallet credit + Bot wallet credits
 * - USD value = Total ETH credit × Current ETH price (refreshed every 15 seconds)
 * 
 * Security:
 * - Only credits from valid convert transactions and distribute operations are counted
 * - Direct ETH transfers to smart wallets are NOT counted (prevents bypass)
 * 
 * This ensures:
 * 1. Credit amount in ETH matches the actual ETH in Smart Wallets (from valid operations only)
 * 2. Credit value in USD follows ETH price fluctuations in real-time
 * 3. Users cannot bypass the system by directly transferring ETH to their wallets
 * 
 * This hook is completely independent from withdraw operations.
 * Withdraw uses useBumpBalance() which reads directly from blockchain.
 */
export function useCreditBalance(userAddress: string | null, options?: { enabled?: boolean }) {
  // CRITICAL: Initialize Supabase client inside hook (not at module level)
  // This ensures environment variables are available when hook is called
  // Using lazy initialization to prevent "Cannot access before initialization" errors
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

      // Fetch main wallet credit from database
      const { data: mainCreditData, error: mainCreditError } = await supabase
        .from("user_credits")
        .select("balance_wei, last_updated")
        .eq("user_address", userAddress.toLowerCase())
        .single()

      // Fetch bot wallet credits from database
      // IMPORTANT: Only 1 row per bot_wallet_address, only weth_balance_wei is used
      // Total Credit = Native ETH (main wallet) + WETH (bot wallets)
      const { data: botCreditsData, error: botCreditsError } = await supabase
        .from("bot_wallet_credits")
        .select("weth_balance_wei")
        .eq("user_address", userAddress.toLowerCase())

      // Handle errors gracefully
      if (mainCreditError && mainCreditError.code !== "PGRST116") {
        // PGRST116 = no rows returned, which is OK for new users
        // Error 406 (Not Acceptable) = RLS policy issue - return default instead of throwing
        const is406Error = 
          mainCreditError.code === "406" ||
          mainCreditError.message?.includes("406") || 
          mainCreditError.message?.includes("Not Acceptable") ||
          mainCreditError.details?.includes("406") ||
          String(mainCreditError).includes("406")
        
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
        throw mainCreditError
      }

      // Calculate main wallet credit
      const mainWalletCreditWei = mainCreditData?.balance_wei || "0"
      
      // Calculate bot wallet credits
      // IMPORTANT: Only weth_balance_wei is used (distributed_amount_wei removed)
      // Only 1 row per bot_wallet_address (unique constraint), so no grouping needed
      const botWalletCreditsWei = botCreditsData?.reduce((sum, record) => {
        // Only use weth_balance_wei (distributed_amount_wei removed)
        const amountWei = BigInt(record.weth_balance_wei || "0")
        return sum + amountWei
      }, BigInt(0)) || BigInt(0)
      
      // Total credit = Main wallet credit + Bot wallet credits (ETH + WETH)
      const totalCreditWei = BigInt(mainWalletCreditWei) + botWalletCreditsWei
      const balanceWei = totalCreditWei.toString()
      const balanceEth = formatUnits(BigInt(balanceWei), 18)

      // Fetch ETH price in USD from CoinGecko (real-time)
      // IMPORTANT: ETH price is fetched fresh every time to reflect current market price
      // This ensures credit value in USD follows ETH price fluctuations
      // Use server-side API route to avoid CORS and rate limiting
      let balanceUsd: number | null = null
      try {
        const priceResponse = await fetch("/api/eth-price", {
          headers: {
            Accept: "application/json",
          },
          // Cache for 30 seconds (matches server-side cache)
          next: { revalidate: 30 },
        })

        if (priceResponse.ok) {
          const priceData = await priceResponse.json()
          if (priceData.success && typeof priceData.price === "number") {
            const ethPriceUsd = priceData.price
            // Calculate USD value: ETH amount * current ETH price
            balanceUsd = parseFloat(balanceEth) * ethPriceUsd
            console.log(
              `💰 Credit conversion: ${balanceEth} ETH × $${ethPriceUsd.toFixed(2)} = $${balanceUsd.toFixed(2)}${priceData.cached ? " (cached)" : ""}`
            )
          }
        } else {
          const errorData = await priceResponse.json().catch(() => ({}))
          console.warn(
            `⚠️ Failed to fetch ETH price: ${priceResponse.status} ${errorData.error || priceResponse.statusText}`
          )
        }
      } catch (priceError: any) {
        console.warn("⚠️ Failed to fetch ETH price:", priceError.message || priceError)
        // Don't throw - USD conversion is optional, but log for debugging
      }

      return {
        balanceWei,
        balanceEth,
        balanceUsd,
        lastUpdated: mainCreditData?.last_updated || null,
      }
    },
    enabled: enabled,
    // Fetch strategy: Only fetch when user opens/app opens the app (on mount)
    // Not using constant polling to save API quota
    // - Fetch once when component mounts (app opens)
    // - Refetch when window regains focus (user returns to tab)
    // - Server-side cache (5 minutes) reduces API calls
    refetchInterval: false, // No constant polling - fetch on demand only
    refetchOnMount: true, // Fetch when component mounts (app opens)
    refetchOnWindowFocus: true, // Refetch when user returns to tab
    refetchOnReconnect: true, // Refetch when internet reconnects
    staleTime: 5 * 60 * 1000, // Consider data stale after 5 minutes (matches server cache)
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
