"use client"

import { useEffect, useState, useCallback } from "react"
import { usePrivy } from "@privy-io/react-auth"

/**
 * Hook untuk handle Telegram Mini App authentication
 * 
 * Flow:
 * 1. Detect Telegram Mini App environment
 * 2. Get initData from window.Telegram.WebApp.initData
 * 3. Verify initData dengan backend
 * 4. Jika user sudah login (ada di database), initialize Privy dengan privy_did
 * 5. Jika user baru, tunggu Privy login, lalu update wallet ke database
 * 
 * Usage:
 * ```tsx
 * const { isVerified, telegramId, walletAddress, isLoading, error } = useTelegramMiniAppAuth()
 * ```
 */
export function useTelegramMiniAppAuth() {
  const { ready, authenticated, user, createWallet } = usePrivy()
  const [isVerified, setIsVerified] = useState(false)
  const [telegramId, setTelegramId] = useState<string | null>(null)
  const [walletAddress, setWalletAddress] = useState<string | null>(null)
  const [privyUserId, setPrivyUserId] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [initData, setInitData] = useState<string | null>(null)

  // Check if we're in Telegram Mini App
  const isTelegramWebApp = typeof window !== "undefined" && (window as any).Telegram?.WebApp

  // Get initData from Telegram WebApp
  useEffect(() => {
    if (!isTelegramWebApp) {
      setIsLoading(false)
      return
    }

    try {
      const tg = (window as any).Telegram.WebApp
      const rawInitData = tg.initData

      if (!rawInitData) {
        console.warn("⚠️ Telegram WebApp initData not available")
        setIsLoading(false)
        return
      }

      setInitData(rawInitData)
    } catch (err: any) {
      console.error("❌ Error getting Telegram initData:", err)
      setError(err.message || "Failed to get Telegram initData")
      setIsLoading(false)
    }
  }, [isTelegramWebApp])

  // Verify initData with backend
  const verifyInitData = useCallback(async (rawInitData: string) => {
    console.log("🔍 [FRONTEND] Starting initData verification...")
    setIsLoading(true)
    setError(null)

    try {
      console.log("🔍 [FRONTEND] Sending request to /api/v1/auth/telegram/verify...")
      const response = await fetch(
        `/api/v1/auth/telegram/verify?initData=${encodeURIComponent(rawInitData)}`
      )

      if (!response.ok) {
        const errorData = await response.json()
        console.error("❌ [FRONTEND] Verify request failed:", errorData)
        throw new Error(errorData.message || "Failed to verify initData")
      }

      const data = await response.json()
      console.log("✅ [FRONTEND] Verify response received:", data)

      if (data.is_valid && data.smart_account_address) {
        // User sudah login - ada di database
        console.log("✅ [FRONTEND] User is verified and logged in")
        setIsVerified(true)
        setTelegramId(data.telegram_id)
        setWalletAddress(data.smart_account_address)
        setPrivyUserId(data.privy_user_id)
        console.log("✅ [FRONTEND] Telegram user verified:", {
          telegram_id: data.telegram_id,
          wallet_address: data.smart_account_address,
          privy_user_id: data.privy_user_id,
        })
      } else {
        // User belum login - belum ada di database
        console.log("ℹ️ [FRONTEND] User not logged in yet, waiting for Privy login...")
        setIsVerified(false)
        setTelegramId(data.telegram_id)
        console.log("ℹ️ [FRONTEND] Telegram user not logged in yet:", {
          telegram_id: data.telegram_id,
        })
      }
    } catch (err: any) {
      console.error("❌ [FRONTEND] Error verifying initData:", err)
      setError(err.message || "Failed to verify Telegram initData")
      setIsVerified(false)
    } finally {
      setIsLoading(false)
    }
  }, [])

  // Verify initData when available
  useEffect(() => {
    if (initData) {
      verifyInitData(initData)
    }
  }, [initData, verifyInitData])

  // Update wallet address to database after Privy creates wallet
  const updateWalletToDatabase = useCallback(
    async (walletAddr: string, privyId: string) => {
      console.log("🔍 [FRONTEND] updateWalletToDatabase called:", {
        wallet_address: walletAddr,
        privy_user_id: privyId,
        has_initData: !!initData,
      })

      if (!initData) {
        console.warn("⚠️ [FRONTEND] Cannot update wallet: initData not available")
        return
      }

      try {
        console.log("🔍 [FRONTEND] Sending request to /api/v1/auth/telegram/update-wallet...")
        const response = await fetch("/api/v1/auth/telegram/update-wallet", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            initData,
            wallet_address: walletAddr,
            privy_user_id: privyId,
          }),
        })

        if (!response.ok) {
          const errorData = await response.json()
          console.error("❌ [FRONTEND] Update wallet request failed:", errorData)
          throw new Error(errorData.message || "Failed to update wallet")
        }

        const data = await response.json()
        console.log("✅ [FRONTEND] Wallet address updated to database:", {
          telegram_id: data.data?.telegram_id,
          wallet_address: data.data?.wallet_address,
          privy_user_id: data.data?.privy_user_id,
        })

        // Update local state
        setWalletAddress(walletAddr)
        setPrivyUserId(privyId)
        setIsVerified(true)
        console.log("✅ [FRONTEND] Local state updated")
      } catch (err: any) {
        console.error("❌ [FRONTEND] Error updating wallet to database:", err)
        setError(err.message || "Failed to update wallet address")
      }
    },
    [initData]
  )

  // Watch for Privy wallet creation and update database
  useEffect(() => {
    console.log("🔍 [FRONTEND] Watching for Privy wallet creation...", {
      ready,
      authenticated,
      has_user: !!user,
      has_initData: !!initData,
      current_walletAddress: walletAddress,
      isVerified,
    })

    if (!ready || !authenticated || !user || !initData) {
      console.log("⏸️ [FRONTEND] Waiting for Privy to be ready/authenticated...")
      return
    }

    // Get Smart Wallet address
    const smartWallet = user.linkedAccounts?.find(
      (account: any) => account.type === "wallet" && account.walletClientType === "smart_wallet"
    )
    const currentWalletAddress = smartWallet?.address || user.wallet?.address

    console.log("🔍 [FRONTEND] Privy wallet check:", {
      smartWallet_address: smartWallet?.address,
      user_wallet_address: user.wallet?.address,
      currentWalletAddress,
      user_id: user.id,
    })

    if (!currentWalletAddress) {
      console.log("⏸️ [FRONTEND] Wallet address not available yet, waiting...")
      return
    }

    // Check if wallet already updated
    if (walletAddress === currentWalletAddress && isVerified) {
      console.log("✅ [FRONTEND] Wallet already updated, skipping...")
      return
    }

    console.log("🚀 [FRONTEND] Calling updateWalletToDatabase...")
    // Update wallet to database
    updateWalletToDatabase(currentWalletAddress, user.id)
  }, [ready, authenticated, user, initData, walletAddress, isVerified, updateWalletToDatabase])

  return {
    isTelegramWebApp,
    isVerified,
    telegramId,
    walletAddress,
    privyUserId,
    isLoading,
    error,
    initData,
    verifyInitData,
    updateWalletToDatabase,
  }
}

