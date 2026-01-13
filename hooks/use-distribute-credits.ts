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

      console.log("=====================================")
      console.log("💰 DISTRIBUTE CREDITS - USER SMART WALLET")
      console.log("=====================================")
      console.log(`📊 Smart Wallet: ${smartWalletAddress}`)
      console.log(`📊 Bot Wallets: ${botWallets.length}`)

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
      // Try Paymaster first (gasless), fallback to user pays gas
      // =============================================
      setStatus("Calculating distribution amount...")
      
      console.log(`\n📊 Distribution Calculation:`)
      console.log(`   → Wallet balance: ${formatEther(walletBalance)} ETH`)
      console.log(`   → Credit in database: ${formatEther(mainWalletCreditWei)} ETH`)

      // For Paymaster (gasless), we can use full balance
      // For normal transaction, we need to reserve gas
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

      console.log(`   → Credit to distribute: ${formatEther(creditToDistribute)} ETH`)

      // Calculate amount per bot (for Paymaster/gasless)
      const amountPerBot: bigint = creditToDistribute / BigInt(5)
      const remainder: bigint = creditToDistribute % BigInt(5)
      const amountForFirstBot: bigint = amountPerBot + remainder

      console.log(`\n📦 Distribution per bot:`)
      console.log(`   → Amount per bot: ${formatEther(amountPerBot)} ETH`)
      if (remainder > BigInt(0)) {
        console.log(`   → First bot gets remainder: +${formatEther(remainder)} ETH`)
      }

      // Variables for fallback (normal transaction with gas)
      let amountPerBotAfterGas: bigint = amountPerBot
      let amountForFirstBotAfterGas: bigint = amountForFirstBot

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
      // STEP 10: Execute Batch Transaction using User's Smart Wallet
      // WITH PAYMASTER PROXY - Gasless transaction via server-side proxy
      // =============================================
      setStatus("Awaiting signature... (1 approval for 5 transfers)")
      
      console.log(`\n📤 Sending BATCH transaction with Paymaster Proxy...`)
      console.log(`   → Smart Wallet: ${smartWalletAddress}`)
      console.log(`   → Total calls: ${calls.length}`)
      console.log(`   → Paymaster Proxy: /api/paymaster`)
      console.log(`   → User pays gas: NO (Gasless via Paymaster Proxy)`)

      let txHash: `0x${string}` | null = null
      let gasless = false
      let paymasterProxyError: Error | null = null

      try {
        // Execute batch transaction with Paymaster Proxy
        // Using capabilities.paymasterService.url to route through our proxy
        // This bypasses client-side allowlist restrictions
        txHash = await smartWalletClient.sendTransaction(
          {
            calls: calls, // Array of 5 calls - batched into single tx
          },
          {
            // Use Paymaster Proxy to bypass allowlist restrictions
            // Paymaster Proxy URL is relative to current origin
            capabilities: {
              paymasterService: {
                url: "/api/paymaster",
              },
            },
          }
        ) as `0x${string}`

        gasless = true
        console.log(`✅ Transaction submitted via Paymaster Proxy!`)
        console.log(`   → Hash: ${txHash}`)
        console.log(`   → Gasless: YES`)
      } catch (paymasterErr: any) {
        paymasterProxyError = paymasterErr
        console.error(`❌ Paymaster Proxy transaction failed:`)
        console.error(`   → Error: ${paymasterErr.message}`)
        
        // Check if it's a Paymaster Proxy error (non-200 response from /api/paymaster)
        const errorMessage = paymasterErr.message || ""
        const errorString = JSON.stringify(paymasterErr)
        const isPaymasterProxyError = 
          errorMessage.includes("/api/paymaster") ||
          errorMessage.includes("Paymaster") ||
          errorMessage.includes("paymasterService") ||
          errorMessage.includes("not configured") ||
          errorString.includes("CDP_PAYMASTER_URL") ||
          (paymasterErr.response && paymasterErr.response.status !== 200) ||
          (paymasterErr.status && paymasterErr.status !== 200)

        if (isPaymasterProxyError) {
          console.error(`   → Paymaster Proxy error detected`)
          console.error(`   → Possible causes:`)
          console.error(`      - CDP_PAYMASTER_URL not configured in environment`)
          console.error(`      - Paymaster Proxy endpoint returned non-200 status`)
          console.error(`      - Allowlist restriction still applies`)
        }
      }

      // =============================================
      // METHOD 2: Fallback to Normal Transaction (User Pays Gas)
      // If Paymaster Proxy fails, fallback to normal transaction
      // =============================================
      if (!txHash && paymasterProxyError) {
        setStatus("Paymaster Proxy unavailable. Using normal transaction (user pays gas)...")
        
        console.log(`\n📤 METHOD 2: Normal Transaction (User Pays Gas)...`)
        console.log(`   → Smart Wallet: ${smartWalletAddress}`)
        console.log(`   → Total calls: ${calls.length}`)
        console.log(`   → User pays gas: YES`)
        console.log(`   → Reason: Paymaster Proxy failed or not configured`)

        // Estimate gas cost for batch transaction
        const estimatedGasUnits = BigInt(150000) // ~30k per transfer + overhead
        const gasPrice = await publicClient.getGasPrice()
        const estimatedGasCost = (estimatedGasUnits * gasPrice * BigInt(120)) / BigInt(100) // 20% buffer

        console.log(`   → Estimated gas cost: ${formatEther(estimatedGasCost)} ETH`)

        // Reserve gas cost from wallet balance
        const availableForDistribution = walletBalance > estimatedGasCost
          ? walletBalance - estimatedGasCost
          : BigInt(0)

        if (availableForDistribution <= BigInt(0)) {
          throw new Error(
            `Insufficient ETH balance for gas and distribution. ` +
            `Balance: ${formatEther(walletBalance)} ETH, ` +
            `Required for gas: ~${formatEther(estimatedGasCost)} ETH. ` +
            `Please add more ETH to your wallet.`
          )
        }

        // Recalculate distribution amount (after gas reservation)
        const creditToDistributeAfterGas = availableForDistribution < mainWalletCreditWei
          ? availableForDistribution
          : mainWalletCreditWei

        if (creditToDistributeAfterGas <= BigInt(0)) {
          throw new Error(
            `Insufficient ETH balance for distribution after gas reservation. ` +
            `Available: ${formatEther(availableForDistribution)} ETH, ` +
            `Gas cost: ~${formatEther(estimatedGasCost)} ETH.`
          )
        }

        // Recalculate amounts per bot
        amountPerBotAfterGas = creditToDistributeAfterGas / BigInt(5)
        const remainderAfterGas: bigint = creditToDistributeAfterGas % BigInt(5)
        amountForFirstBotAfterGas = amountPerBotAfterGas + remainderAfterGas

        // Update calls with new amounts
        const callsAfterGas = botWallets.map((wallet, index) => {
          const amount: bigint = index === 0 ? amountForFirstBotAfterGas : amountPerBotAfterGas
          const checksumAddress = getAddress(wallet.smartWalletAddress)
          return {
            to: checksumAddress as Address,
            value: amount,
            data: "0x" as Hex,
          }
        })

        console.log(`   → Credit to distribute (after gas): ${formatEther(creditToDistributeAfterGas)} ETH`)

        // Execute normal transaction (user pays gas)
        txHash = await smartWalletClient.sendTransaction(
          {
            calls: callsAfterGas,
          },
          {
            // Disable Paymaster - user pays gas
            isSponsored: false,
          }
        ) as `0x${string}`

        gasless = false
        console.log(`✅ Normal transaction submitted!`)
        console.log(`   → Hash: ${txHash}`)
        console.log(`   → Gasless: NO (user pays gas)`)
      }

      if (!txHash) {
        throw new Error("Failed to submit transaction via both Paymaster and normal methods")
      }

      setHash(txHash)
      setStatus("Confirming on blockchain...")

      // Wait for transaction confirmation
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: txHash,
        confirmations: 1,
      })

      if (receipt.status !== "success") {
        throw new Error("Transaction failed on-chain")
      }

      console.log(`✅ Transaction confirmed!`)
      console.log(`   → Block: ${receipt.blockNumber}`)
      console.log(`   → Gas used: ${receipt.gasUsed.toString()}`)
      console.log(`   → Gasless: ${gasless ? "YES" : "NO"}`)

      // Record distribution in database
      setStatus("Recording distribution...")
      
      // Determine final amounts based on whether gasless or not
      let finalAmountPerBot: bigint
      let finalAmountForFirstBot: bigint
      
      if (gasless) {
        // Use original amounts (full credit distributed)
        finalAmountPerBot = amountPerBot
        finalAmountForFirstBot = amountForFirstBot
      } else {
        // Use adjusted amounts (after gas reservation)
        finalAmountPerBot = amountPerBotAfterGas
        finalAmountForFirstBot = amountForFirstBotAfterGas
      }
      
      const distributions = botWallets.map((wallet, index) => {
        const distAmount: bigint = index === 0 ? finalAmountForFirstBot : finalAmountPerBot
        return {
          botWalletAddress: wallet.smartWalletAddress,
          amountWei: distAmount.toString(),
        }
      })

      try {
        await fetch("/api/bot/record-distribution", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            userAddress: userAddress,
            distributions: distributions,
            txHash: txHash,
          }),
        })
        console.log("✅ Distribution recorded in database")
      } catch (recordError) {
        console.warn("⚠️ Failed to record distribution in database:", recordError)
      }

      setIsSuccess(true)
      setStatus("Distribution completed!")
      
      // Determine final total for display
      const finalTotalForDisplay = gasless 
        ? creditToDistribute 
        : (amountPerBotAfterGas * BigInt(5) + (amountForFirstBotAfterGas - amountPerBotAfterGas))
      
      toast.success("Successfully distributed credit to 5 bot wallets!", {
        description: `Total: ${formatEther(finalTotalForDisplay)} ETH${gasless ? " (Gasless)" : " (User paid gas)"}`,
        action: {
          label: "View",
          onClick: () => window.open(`https://basescan.org/tx/${txHash}`, "_blank"),
        },
      })

      // Determine final total distributed
      const finalTotalDistributed = gasless 
        ? creditToDistribute 
        : (amountPerBotAfterGas * BigInt(5) + (amountForFirstBotAfterGas - amountPerBotAfterGas))

      return {
        success: true,
        txHash: txHash,
        amountPerBot: formatEther(gasless ? amountPerBot : amountPerBotAfterGas),
        totalDistributed: formatEther(finalTotalDistributed),
        gasUsed: receipt.gasUsed.toString(),
        method: gasless ? "user_smart_wallet_batch_paymaster" : "user_smart_wallet_batch",
        gasless: gasless,
      }

    } catch (err: any) {
      console.error("❌ Distribution failed:", err)
      setError(err)
      setStatus(null)

      // User-friendly error messages
      let errorMessage = err.message || "Failed to distribute credits"
      const errorString = JSON.stringify(err)

      // Check if it's a Paymaster Proxy error (non-200 response from /api/paymaster)
      const isPaymasterProxyError = 
        errorMessage.includes("/api/paymaster") ||
        errorMessage.includes("Paymaster") ||
        errorMessage.includes("paymasterService") ||
        errorMessage.includes("not configured") ||
        errorString.includes("CDP_PAYMASTER_URL") ||
        (err.response && err.response.status !== 200) ||
        (err.status && err.status !== 200)

      if (isPaymasterProxyError) {
        errorMessage = "Paymaster Proxy error: The server-side Paymaster service is not configured or returned an error. " +
          "Please check that CDP_PAYMASTER_URL is set in environment variables. " +
          "Falling back to normal transaction (user pays gas)."
        console.error("   → Paymaster Proxy specific error detected")
        console.error("   → This indicates: CDP_PAYMASTER_URL missing, Paymaster Proxy endpoint error, or allowlist issue")
      } else if (errorMessage.includes("insufficient") || errorMessage.includes("Insufficient")) {
        errorMessage = "Insufficient ETH balance for gas and distribution. Please add more ETH to your wallet."
      } else if (errorMessage.includes("rejected") || errorMessage.includes("denied") || errorMessage.includes("User rejected")) {
        errorMessage = "Transaction was rejected by user."
      } else if (errorMessage.includes("FALLBACK_TO_FRONTEND")) {
        errorMessage = "Using Smart Wallet directly (user pays gas)."
      }

      toast.error("Distribution failed", { 
        description: errorMessage,
        duration: 8000, // Longer duration for Paymaster Proxy errors
      })
      throw err
    } finally {
      setIsPending(false)
    }
  }, [smartWalletClient, privySmartWalletAddress, publicClient, reset])

  return { distribute, hash, isPending, isSuccess, error, status, reset }
}
