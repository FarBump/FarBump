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
      // Try Backend API First (if relayer is configured)
      // =============================================
      setStatus("Distributing via backend API...")
      
      console.log(`\n📤 Attempting BACKEND API for distribution...`)
      console.log(`   → Backend uses relayer wallet (bypasses Paymaster allowlist)`)

      let useBackend = false
      try {
        // Call backend API which uses relayer wallet
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
            method: "backend_api_relayer",
            gasless: true,
          }
        }

        // If backend says to fallback, continue to frontend
        if (backendData.fallback) {
          console.log(`⚠️ Backend API not available: ${backendData.error || "Relayer not configured"}`)
          console.log(`🔄 Falling back to frontend Smart Wallet (user pays gas)...`)
          useBackend = false
        } else {
          // Backend returned an error (not a fallback request)
          throw new Error(backendData.error || "Backend distribution failed")
        }
      } catch (backendError: any) {
        console.warn(`⚠️ Backend API failed: ${backendError.message}`)
        console.log(`🔄 Falling back to frontend Smart Wallet (user pays gas)...`)
        useBackend = false
      }

    // =============================================
    // FALLBACK: Use Frontend Smart Wallet
    // User pays gas (isSponsored: false)
    // Only executed if backend API is not available
    // =============================================
    if (!useBackend) {
      console.log(`\n💰 FALLBACK: Using frontend Smart Wallet (user pays gas)...`)
      
      if (!smartWalletClient || !privySmartWalletAddress) {
        throw new Error("Smart Wallet client not found and backend API unavailable. Please login again.")
      }

    setStatus("Preparing batch transaction (user pays gas)...")
    
    // Prepare batch calls array
    const calls: Array<{ to: Address; value: bigint; data: Hex }> = botWallets.map((wallet, index) => {
      const amount: bigint = index === 0 ? amountForFirstBot : amountPerBot
      const checksumAddress = getAddress(wallet.smartWalletAddress)
      
      console.log(`   Call #${index + 1}: ${checksumAddress} → ${formatEther(amount)} ETH`)
      
      return {
        to: checksumAddress as Address,
        value: amount,
        data: "0x" as Hex,
      }
    })

    console.log(`\n📤 Sending BATCH transaction (USER PAYS GAS - NO PAYMASTER)...`)
    console.log(`   → Total calls: ${calls.length}`)
    console.log(`   → User pays gas: YES`)
    console.log(`   → Paymaster: DISABLED`)

    // Execute batch transaction WITHOUT Paymaster
    // User pays gas from their own ETH balance
    const txHash = await smartWalletClient.sendTransaction(
      {
        calls: calls,
      },
      {
        // CRITICAL: Disable Paymaster - user pays gas
        isSponsored: false,
        // DO NOT include paymasterService or capabilities
        // This forces the transaction to use native ETH for gas
      }
    ) as `0x${string}`

    console.log(`\n✅ Transaction submitted!`)
    console.log(`   → Hash: ${txHash}`)

    setHash(txHash)
    setStatus("Confirming on blockchain...")

    const receipt = await publicClient.waitForTransactionReceipt({
      hash: txHash,
      confirmations: 1,
    })

    if (receipt.status !== "success") {
      throw new Error("Transaction failed on-chain")
    }

    // Record to DB
    setStatus("Recording distribution...")
    const distributions = botWallets.map((wallet, index) => {
      const distAmount: bigint = index === 0 ? amountForFirstBot : amountPerBot
      return {
        botWalletAddress: wallet.smartWalletAddress,
        amountWei: distAmount.toString(),
      }
    })

    await fetch("/api/bot/record-distribution", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userAddress,
        distributions,
        txHash,
      }),
    })

    setIsSuccess(true)
    setStatus("Success!")
    
    toast.success("Successfully distributed credit to 5 bot wallets!", {
      description: `Total: ${formatEther(creditToDistribute)} ETH (user paid gas)`,
      action: {
        label: "View",
        onClick: () => window.open(`https://basescan.org/tx/${txHash}`, "_blank"),
      },
    })

      return {
        success: true,
        txHash: txHash,
        amountPerBot: formatEther(amountPerBot),
        totalDistributed: formatEther(creditToDistribute),
        gasUsed: receipt.gasUsed.toString(),
        method: "frontend_smart_wallet_user_pays_gas",
        gasless: false,
      }
    }

    } catch (err: any) {
      console.error("❌ Distribution failed:", err)
      setError(err)
      setStatus(null)

      // User-friendly error messages
      let errorMessage = err.message || "Failed to distribute credits"

      if (errorMessage.includes("insufficient") || errorMessage.includes("Insufficient")) {
        errorMessage = "Insufficient ETH balance for distribution and gas. Please add more ETH to your wallet."
      } else if (errorMessage.includes("rejected") || errorMessage.includes("denied") || errorMessage.includes("User rejected")) {
        errorMessage = "Transaction was rejected by user."
      } else if (errorMessage.includes("Paymaster") || errorMessage.includes("pm_") || errorMessage.includes("allowlist") || errorMessage.includes("not allowlisted")) {
        errorMessage = "Paymaster error. Using fallback method (user pays gas)."
      } else if (errorMessage.includes("FALLBACK_TO_FRONTEND")) {
        errorMessage = "Backend not available. Please ensure you have enough ETH for gas fees."
      }

      toast.error("Distribution failed", { description: errorMessage })
      throw err
    } finally {
      setIsPending(false)
    }
  }, [smartWalletClient, privySmartWalletAddress, publicClient, reset])

  return { distribute, hash, isPending, isSuccess, error, status, reset }
}
