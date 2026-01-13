"use client"

import { useState, useCallback } from "react"
import { useSmartWallets } from "@privy-io/react-auth/smart-wallets"
import { usePublicClient } from "wagmi"
import { formatEther, getAddress, type Address, type Hex } from "viem"
import { toast } from "sonner"

interface BotWallet {
  smartWalletAddress: string
  ownerAddress?: string
  network?: string
}

interface DistributeCreditsParams {
  userAddress: Address
  botWallets: BotWallet[]
  creditBalanceWei: bigint
}

export function useDistributeCredits() {
  const { client: smartWalletClient } = useSmartWallets()
  const publicClient = usePublicClient()
  
  const privySmartWalletAddress = smartWalletClient?.account?.address as Address | undefined
  
  const [hash, setHash] = useState<`0x${string}` | null>(null)
  const [isPending, setIsPending] = useState(false)
  const [isSuccess, setIsSuccess] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const [status, setStatus] = useState<string | null>(null)

  const reset = useCallback(() => {
    setHash(null)
    setIsPending(false)
    setIsSuccess(false)
    setError(null)
    setStatus(null)
  }, [])

  const distribute = useCallback(async ({ 
    userAddress, 
    botWallets, 
    creditBalanceWei 
  }: DistributeCreditsParams) => {
    reset()
    setIsPending(true)

    try {
      if (!smartWalletClient || !privySmartWalletAddress) {
        throw new Error("Smart Wallet client not found. Please login again.")
      }

      const smartWalletAddress = userAddress.toLowerCase() === privySmartWalletAddress.toLowerCase()
        ? privySmartWalletAddress
        : (userAddress as Address)

      if (!botWallets || botWallets.length !== 5) {
        throw new Error(`Expected 5 bot wallets, but found ${botWallets?.length || 0}`)
      }

      setStatus("Checking balance & status...")
      const walletBalance = await publicClient.getBalance({ address: smartWalletAddress })

      // Fetch Credit from DB
      const creditResponse = await fetch("/api/credit-balance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userAddress }),
      })
      
      const creditData = await creditResponse.json()
      const mainWalletCreditWei = BigInt(creditData.mainWalletCreditWei || "0")

      if (mainWalletCreditWei <= BigInt(0)) {
        throw new Error("No credit available in main wallet.")
      }

      // =============================================
      // Calculate Distribution Amount
      // With Paymaster Proxy, gas is sponsored (gasless)
      // So we can use full wallet balance for distribution
      // =============================================
      setStatus("Calculating distribution amount...")
      
      console.log(`\n📊 Distribution Calculation (Gasless via Paymaster):`)
      console.log(`   → Wallet balance: ${formatEther(walletBalance)} ETH`)
      console.log(`   → Gas cost: 0 ETH (sponsored by Paymaster)`)
      console.log(`   → Available for distribution: ${formatEther(walletBalance)} ETH`)
      console.log(`   → Credit in database: ${formatEther(mainWalletCreditWei)} ETH`)

      // With Paymaster, we don't need to reserve gas
      // Use minimum of wallet balance and credit balance
      const creditToDistribute: bigint = walletBalance < mainWalletCreditWei
        ? walletBalance
        : mainWalletCreditWei

      if (creditToDistribute <= BigInt(0)) {
        throw new Error(
          `Insufficient ETH balance for distribution. ` +
          `Balance: ${formatEther(walletBalance)} ETH, ` +
          `Credit in DB: ${formatEther(mainWalletCreditWei)} ETH. ` +
          `Please add more ETH to your wallet.`
        )
      }

      // Calculate amount per bot
      const amountPerBot: bigint = creditToDistribute / BigInt(5)
      const remainder: bigint = creditToDistribute % BigInt(5)
      const amountForFirstBot: bigint = amountPerBot + remainder

      console.log(`\n📦 Distribution per bot:`)
      console.log(`   → Amount per bot: ${formatEther(amountPerBot)} ETH`)
      if (remainder > BigInt(0)) {
        console.log(`   → First bot gets remainder: +${formatEther(remainder)} ETH`)
      }

      // =============================================
      // Prepare Batch Calls Array
      // =============================================
      setStatus("Preparing batch transaction...")
      
      const calls: Array<{ to: Address; value: bigint; data: Hex }> = botWallets.map((wallet, index) => {
        const amount: bigint = index === 0 ? amountForFirstBot : amountPerBot
        const checksumAddress = getAddress(wallet.smartWalletAddress)
        
        console.log(`   Call #${index + 1}: ${checksumAddress} → ${formatEther(amount)} ETH`)
        
        return {
          to: checksumAddress as Address,
          value: amount,
          data: "0x" as Hex, // Empty data for simple ETH transfer
        }
      })

      // =============================================
      // IMPORTANT: Privy SDK does NOT support custom Paymaster URL
      // Privy always uses Paymaster from Dashboard configuration
      // So we MUST use backend API for distribution
      // =============================================
      setStatus("Distributing via backend API...")
      
      console.log(`\n📤 Using BACKEND API for distribution...`)
      console.log(`   → Reason: Privy SDK doesn't support custom Paymaster URL`)
      console.log(`   → Backend will use Paymaster Proxy: https://farbump.vercel.app/api/paymaster`)
      console.log(`   → Total calls: ${calls.length}`)

      // Call backend API which uses Paymaster Proxy
      const backendResponse = await fetch("/api/bot/distribute-credits", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userAddress: userAddress,
          botWallets: botWallets.map(w => ({ smartWalletAddress: w.smartWalletAddress })),
        }),
      })

      const backendData = await backendResponse.json()

      if (backendResponse.ok && backendData.success) {
        console.log(`✅ Backend distribution successful!`)
        console.log(`   → Transaction hash: ${backendData.txHash}`)
        
        setHash(backendData.txHash as `0x${string}`)
        setIsSuccess(true)
        setStatus("Distribution completed!")
        
        toast.success("Successfully distributed credit to 5 bot wallets!", {
          description: `Total: ${backendData.totalDistributed} ETH`,
          action: backendData.txHash ? {
            label: "View",
            onClick: () => window.open(`https://basescan.org/tx/${backendData.txHash}`, "_blank"),
          } : undefined,
        })

        return {
          success: true,
          txHash: backendData.txHash,
          amountPerBot: backendData.amountPerBot,
          totalDistributed: backendData.totalDistributed,
          method: "backend_api_paymaster_proxy",
          gasless: true,
        }
      }

      // If backend says to fallback, throw error to trigger frontend fallback
      if (backendData.fallback) {
        throw new Error("FALLBACK_TO_FRONTEND")
      }

      // Backend returned an error
      throw new Error(backendData.error || "Backend distribution failed")

    } catch (err: any) {
      console.error("❌ Distribution failed:", err)
      setError(err)
      setStatus(null)

      // User-friendly error messages
      let errorMessage = err.message || "Failed to distribute credits"

      if (errorMessage.includes("insufficient") || errorMessage.includes("Insufficient")) {
        errorMessage = "Insufficient ETH balance for distribution. Please add more ETH to your wallet."
      } else if (errorMessage.includes("rejected") || errorMessage.includes("denied") || errorMessage.includes("User rejected")) {
        errorMessage = "Transaction was rejected by user."
      } else if (errorMessage.includes("Paymaster") || errorMessage.includes("pm_") || errorMessage.includes("allowlist") || errorMessage.includes("not allowlisted")) {
        errorMessage = "Paymaster Proxy error. Please check CDP_PAYMASTER_URL configuration or try again."
      } else if (errorMessage.includes("not configured") || errorMessage.includes("CDP_PAYMASTER_URL")) {
        errorMessage = "Paymaster service not configured. Please contact support."
      }

      toast.error("Distribution failed", { description: errorMessage })
      throw err
    } finally {
      setIsPending(false)
    }
  }, [smartWalletClient, privySmartWalletAddress, publicClient, reset])

  return { distribute, hash, isPending, isSuccess, error, status, reset }
}
