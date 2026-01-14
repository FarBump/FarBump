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
      // STEP 10: Execute Individual Transactions (Like Withdraw Function)
      // WITH PAYMASTER PROXY - Gasless transaction via server-side proxy
      // CRITICAL: Use individual transactions to avoid batch allowlist restrictions
      // =============================================
      setStatus("Preparing individual transactions...")
      
      // Build absolute Paymaster Proxy URL to ensure Viem doesn't do local validation
      // Use current origin to build absolute URL
      const paymasterProxyUrl = typeof window !== "undefined"
        ? `${window.location.origin}/api/paymaster`
        : "/api/paymaster"
      
      console.log(`\n📤 Sending INDIVIDUAL transactions with Paymaster Proxy...`)
      console.log(`   → Smart Wallet: ${smartWalletAddress}`)
      console.log(`   → Total transfers: ${botWallets.length}`)
      console.log(`   → Paymaster Proxy URL: ${paymasterProxyUrl}`)
      console.log(`   → User pays gas: NO (Gasless via Paymaster Proxy)`)
      console.log(`   → Strategy: Individual transactions (like Withdraw) to avoid batch allowlist restrictions`)
      console.log(`   → CRITICAL: No Coinbase URLs in frontend - all requests go through proxy`)

      // Transaction options - same as Withdraw function
      // Using Paymaster Proxy via capabilities (exactly like Withdraw would use)
      const transactionOptions = {
        // CRITICAL: Only use Paymaster Proxy - no Coinbase URLs
        // This ensures all Paymaster requests go through our server-side proxy
        capabilities: {
          paymasterService: {
            url: paymasterProxyUrl, // Absolute URL: https://farbump.vercel.app/api/paymaster
          },
        },
        // DO NOT include:
        // - isSponsored (let capabilities handle it)
        // - Any Coinbase CDP URLs
        // - Any API keys
      }

      let txHashes: `0x${string}`[] = []
      let gasless = false
      let paymasterProxyError: Error | null = null

      try {
        // Execute individual transactions sequentially (like Withdraw function)
        // This avoids batch allowlist restrictions that Coinbase Paymaster may have
        for (let i = 0; i < botWallets.length; i++) {
          const wallet = botWallets[i]
          const amount: bigint = i === 0 ? amountForFirstBot : amountPerBot
          const checksumAddress = getAddress(wallet.smartWalletAddress)
          
          setStatus(`Sending transfer ${i + 1}/${botWallets.length}...`)
          
          console.log(`\n   📤 Transfer ${i + 1}/${botWallets.length}:`)
          console.log(`      → To: ${checksumAddress}`)
          console.log(`      → Amount: ${formatEther(amount)} ETH`)
          console.log(`      → Paymaster Proxy: ${paymasterProxyUrl}`)

          try {
            // Execute individual transaction (same format as Withdraw)
            // Using Paymaster Proxy via capabilities
            const txHash = await smartWalletClient.sendTransaction(
              {
                to: checksumAddress as Address,
                value: amount,
                data: "0x" as Hex, // Empty data for simple ETH transfer
              },
              transactionOptions
            ) as `0x${string}`

            txHashes.push(txHash)
            gasless = true
            console.log(`      ✅ Transaction ${i + 1} submitted: ${txHash}`)
            console.log(`      → Gasless: YES (via Paymaster Proxy)`)

            // Wait between transactions to avoid nonce conflicts
            // Same delay as Withdraw function uses
            if (i < botWallets.length - 1) {
              const delay = 2000 // 2 seconds between transactions
              console.log(`      → Waiting ${delay}ms before next transaction...`)
              await new Promise(resolve => setTimeout(resolve, delay))
            }
          } catch (transferError: any) {
            console.error(`      ❌ Transfer ${i + 1} failed:`, transferError.message)
            
            // Check if it's a Paymaster Proxy error
            const errorMessage = transferError.message || ""
            const errorString = JSON.stringify(transferError)
            const isPaymasterProxyError = 
              errorMessage.includes("/api/paymaster") ||
              errorMessage.includes("Paymaster") ||
              errorMessage.includes("paymasterService") ||
              errorMessage.includes("not configured") ||
              errorMessage.includes("not in allowlist") ||
              errorMessage.includes("allowlist") ||
              errorString.includes("CDP_PAYMASTER_URL") ||
              errorString.includes("coinbase.com") ||
              errorString.includes("developer.coinbase.com") ||
              (transferError.response && transferError.response.status !== 200) ||
              (transferError.status && transferError.status !== 200)

            if (isPaymasterProxyError) {
              console.error(`      → Paymaster Proxy error detected for transfer ${i + 1}`)
              paymasterProxyError = transferError
              
              // If first transfer fails with allowlist, all will likely fail
              // Stop and fallback to normal transaction
              if (i === 0) {
                console.error(`      → First transfer failed - stopping and falling back to normal transaction`)
                break
              }
            }
            
            // Continue with other transfers even if one fails
            console.warn(`      → Continuing with remaining transfers...`)
          }
        }

        // Use first transaction hash as primary
        const txHash = txHashes.length > 0 ? txHashes[0] : null

        if (txHashes.length === 0) {
          throw new Error("All individual transactions failed")
        }

        if (txHashes.length < botWallets.length) {
          console.warn(`⚠️ Only ${txHashes.length}/${botWallets.length} transfers succeeded`)
        } else {
          console.log(`✅ All ${txHashes.length} individual transactions submitted successfully!`)
        }
      } catch (paymasterErr: any) {
        paymasterProxyError = paymasterErr
        console.error(`❌ Paymaster Proxy transactions failed:`)
        console.error(`   → Error: ${paymasterErr.message}`)
        
        // Check if it's a Paymaster Proxy error
        const errorMessage = paymasterErr.message || ""
        const errorString = JSON.stringify(paymasterErr)
        const isPaymasterProxyError = 
          errorMessage.includes("/api/paymaster") ||
          errorMessage.includes("Paymaster") ||
          errorMessage.includes("paymasterService") ||
          errorMessage.includes("not configured") ||
          errorMessage.includes("not in allowlist") ||
          errorMessage.includes("allowlist") ||
          errorString.includes("CDP_PAYMASTER_URL") ||
          errorString.includes("coinbase.com") ||
          errorString.includes("developer.coinbase.com") ||
          (paymasterErr.response && paymasterErr.response.status !== 200) ||
          (paymasterErr.status && paymasterErr.status !== 200)

        if (isPaymasterProxyError) {
          console.error(`   → Paymaster Proxy error detected`)
          console.error(`   → Possible causes:`)
          console.error(`      - CDP_PAYMASTER_URL not configured in environment`)
          console.error(`      - Paymaster Proxy endpoint returned non-200 status`)
          console.error(`      - Allowlist restriction still applies (even for individual transactions)`)
          
          // Check if Viem tried to use Coinbase URL directly
          if (errorString.includes("coinbase.com") || errorString.includes("developer.coinbase.com")) {
            console.error(`   → ⚠️ WARNING: Viem may have attempted to use Coinbase URL directly!`)
            console.error(`   → This should not happen - all requests must go through /api/paymaster`)
          }
        }
      }

      // Use first transaction hash as primary (for UI display)
      let txHash: `0x${string}` | null = txHashes.length > 0 ? txHashes[0] : null

      // =============================================
      // METHOD 2: Fallback to Normal Transaction (User Pays Gas)
      // If Paymaster Proxy fails, fallback to normal individual transactions
      // =============================================
      if (!txHash && paymasterProxyError) {
        setStatus("Paymaster Proxy unavailable. Using normal transactions (user pays gas)...")
        
        console.log(`\n📤 METHOD 2: Normal Individual Transactions (User Pays Gas)...`)
        console.log(`   → Smart Wallet: ${smartWalletAddress}`)
        console.log(`   → Total transfers: ${botWallets.length}`)
        console.log(`   → User pays gas: YES`)
        console.log(`   → Reason: Paymaster Proxy failed or not configured`)

        // Estimate gas cost per individual transaction
        const estimatedGasUnitsPerTx = BigInt(30000) // ~30k per individual transfer
        const gasPrice = await publicClient.getGasPrice()
        const estimatedGasCostPerTx = (estimatedGasUnitsPerTx * gasPrice * BigInt(120)) / BigInt(100) // 20% buffer
        const totalEstimatedGasCost = estimatedGasCostPerTx * BigInt(botWallets.length)

        console.log(`   → Estimated gas cost per tx: ${formatEther(estimatedGasCostPerTx)} ETH`)
        console.log(`   → Total estimated gas cost: ${formatEther(totalEstimatedGasCost)} ETH`)

        // Reserve gas cost from wallet balance
        const availableForDistribution = walletBalance > totalEstimatedGasCost
          ? walletBalance - totalEstimatedGasCost
          : BigInt(0)

        if (availableForDistribution <= BigInt(0)) {
          throw new Error(
            `Insufficient ETH balance for gas and distribution. ` +
            `Balance: ${formatEther(walletBalance)} ETH, ` +
            `Required for gas: ~${formatEther(totalEstimatedGasCost)} ETH. ` +
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
            `Gas cost: ~${formatEther(totalEstimatedGasCost)} ETH.`
          )
        }

        // Recalculate amounts per bot
        amountPerBotAfterGas = creditToDistributeAfterGas / BigInt(5)
        const remainderAfterGas: bigint = creditToDistributeAfterGas % BigInt(5)
        amountForFirstBotAfterGas = amountPerBotAfterGas + remainderAfterGas

        console.log(`   → Credit to distribute (after gas): ${formatEther(creditToDistributeAfterGas)} ETH`)

        // Execute individual normal transactions (user pays gas)
        const fallbackTxHashes: `0x${string}`[] = []
        
        for (let i = 0; i < botWallets.length; i++) {
          const wallet = botWallets[i]
          const amount: bigint = i === 0 ? amountForFirstBotAfterGas : amountPerBotAfterGas
          const checksumAddress = getAddress(wallet.smartWalletAddress)
          
          setStatus(`Sending normal transaction ${i + 1}/${botWallets.length}...`)
          
          console.log(`\n   📤 Normal Transfer ${i + 1}/${botWallets.length}:`)
          console.log(`      → To: ${checksumAddress}`)
          console.log(`      → Amount: ${formatEther(amount)} ETH`)

          try {
            // Execute individual normal transaction (user pays gas)
            const fallbackTxHash = await smartWalletClient.sendTransaction(
              {
                to: checksumAddress as Address,
                value: amount,
                data: "0x" as Hex,
              },
              {
                // Disable Paymaster - user pays gas
                isSponsored: false,
              }
            ) as `0x${string}`

            fallbackTxHashes.push(fallbackTxHash)
            console.log(`      ✅ Transaction ${i + 1} submitted: ${fallbackTxHash}`)
            console.log(`      → Gasless: NO (User pays gas)`)

            // Wait between transactions to avoid nonce conflicts
            if (i < botWallets.length - 1) {
              const delay = 2000 // 2 seconds between transactions
              console.log(`      → Waiting ${delay}ms before next transaction...`)
              await new Promise(resolve => setTimeout(resolve, delay))
            }
          } catch (transferError: any) {
            console.error(`      ❌ Transfer ${i + 1} failed:`, transferError.message)
            console.warn(`      → Continuing with remaining transfers...`)
          }
        }

        // Use first transaction hash as primary
        txHash = fallbackTxHashes.length > 0 ? fallbackTxHashes[0] : null
        gasless = false

        if (fallbackTxHashes.length === 0) {
          throw new Error("All fallback normal transactions failed")
        }

        if (fallbackTxHashes.length < botWallets.length) {
          console.warn(`⚠️ Only ${fallbackTxHashes.length}/${botWallets.length} fallback transfers succeeded`)
        } else {
          console.log(`✅ All ${fallbackTxHashes.length} normal transactions submitted successfully!`)
        }
        console.log(`   → Hash: ${txHash}`)
        console.log(`   → Gasless: NO (User pays gas)`)
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
