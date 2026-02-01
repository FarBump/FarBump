"use client"

import { useEffect, useState } from "react"
import { usePrivy } from "@privy-io/react-auth"

/**
 * Hook to automatically pair Telegram ID with Privy user after Telegram login
 * 
 * This hook:
 * 1. Detects when user logs in via Telegram through Privy
 * 2. Extracts Telegram ID from Privy user.linkedAccounts
 * 3. Calls /api/v1/auth/telegram/pair to store mapping in database
 * 4. Bot Telegram (ClawdBumpbot) can then check if user has logged in
 * 
 * Usage:
 * ```tsx
 * const { isPaired, isPairing, error } = useTelegramPair()
 * ```
 */
export function useTelegramPair() {
  const { ready, authenticated, user } = usePrivy()
  const [isPaired, setIsPaired] = useState(false)
  const [isPairing, setIsPairing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hasAttemptedPair, setHasAttemptedPair] = useState(false)

  useEffect(() => {
    // Only attempt pairing once when user is authenticated
    if (!ready || !authenticated || !user || hasAttemptedPair) {
      return
    }

    // Check if user has Telegram linked account
    const telegramAccount = user.linkedAccounts?.find(
      (account: any) => account.type === "telegram"
    )

    if (!telegramAccount) {
      // User didn't login via Telegram, skip pairing
      setHasAttemptedPair(true)
      return
    }

    // Extract Telegram data from linked account
    const telegramId = telegramAccount.subject // Telegram user ID
    const telegramUsername = telegramAccount.username || null
    const firstName = telegramAccount.name?.split(" ")[0] || null
    const lastName = telegramAccount.name?.split(" ").slice(1).join(" ") || null
    const photoUrl = telegramAccount.picture || null

    // Get wallet address (Smart Wallet)
    const smartWallet = user.linkedAccounts?.find(
      (account: any) => account.type === "wallet" && account.walletClientType === "smart_wallet"
    )
    const walletAddress = smartWallet?.address || user.wallet?.address

    if (!walletAddress) {
      console.warn("⚠️ No wallet address found, skipping Telegram pairing")
      setHasAttemptedPair(true)
      return
    }

    // Pair Telegram ID with Privy user
    const pairTelegram = async () => {
      setIsPairing(true)
      setError(null)

      try {
        const response = await fetch("/api/v1/auth/telegram/pair", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            telegram_id: telegramId,
            telegram_username: telegramUsername,
            wallet_address: walletAddress,
            privy_user_id: user.id,
            first_name: firstName,
            last_name: lastName,
            photo_url: photoUrl,
          }),
        })

        if (!response.ok) {
          const errorData = await response.json()
          throw new Error(errorData.message || "Failed to pair Telegram ID")
        }

        const data = await response.json()
        console.log("✅ Telegram ID paired successfully:", data)
        setIsPaired(true)
        setHasAttemptedPair(true)
      } catch (err: any) {
        console.error("❌ Error pairing Telegram ID:", err)
        setError(err.message || "Failed to pair Telegram ID")
      } finally {
        setIsPairing(false)
      }
    }

    pairTelegram()
  }, [ready, authenticated, user, hasAttemptedPair])

  return {
    isPaired,
    isPairing,
    error,
  }
}

