"use client"

import { useState } from "react"
import { useSmartWallets } from "@privy-io/react-auth/smart-wallets"
import { usePublicClient } from "wagmi"
import { formatEther, parseEther, createWalletClient, custom, getAddress, type Address, type Hex } from "viem"
import { base } from "viem/chains"
import { toast } from "sonner"

interface BotWallet {
  smartWalletAddress: string
  ownerAddress?: string
  network?: string
}

interface DistributeCreditsParams {
  userAddress: Address
  botWallets: BotWallet[]
  creditBalanceWei: bigint // Total credit from database
}

export function useDistributeCredits() {
  const { client: smartWalletClient } = useSmartWallets()
  const publicClient = usePublicClient()
  
  // Get Privy Smart Wallet address from smartWalletClient
  // CRITICAL: smartWalletClient.account.address is the Smart Wallet contract address
  // This is different from Embedded Wallet address (which is EOA)
  const privySmartWalletAddress = smartWalletClient?.account?.address as Address | undefined
  
  const [hash, setHash] = useState<`0x${string}` | null>(null)
  const [isPending, setIsPending] = useState(false)
  const [isSuccess, setIsSuccess] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const [status, setStatus] = useState<string | null>(null)

  const reset = () => {
    setHash(null)
    setIsPending(false)
    setIsSuccess(false)
    setError(null)
    setStatus(null)
  }

  const distribute = async ({ userAddress, botWallets, creditBalanceWei }: DistributeCreditsParams) => {
    reset()
    setIsPending(true)

    try {
      // Validate Privy Smart Wallet
      if (!smartWalletClient) {
        throw new Error("Privy Smart Wallet client not found. Please login again.")
      }

      if (!privySmartWalletAddress) {
        throw new Error("Privy Smart Wallet address not found. Please login again.")
      }

      // CRITICAL: Use userAddress parameter as the source of truth for Smart Wallet address
      // This ensures we're using the correct Smart Wallet address passed from the parent component
      // userAddress should be the Smart Wallet contract address (not EOA)
      const smartWalletAddress = userAddress.toLowerCase() === privySmartWalletAddress.toLowerCase()
        ? privySmartWalletAddress
        : (userAddress as Address)

      console.log(`✅ Privy Smart Wallet connected: ${smartWalletAddress}`)
      console.log(`   Chain: Base Mainnet (${base.id})`)
      console.log(`   Using Smart Wallet address from parameter: ${userAddress}`)

      // Use Privy Smart Wallet client directly for transactions
      // Privy Smart Wallet client already has the correct provider and account configured
      // We'll use smartWalletClient.sendTransaction which supports batch calls

      if (!botWallets || botWallets.length !== 5) {
        throw new Error(`Expected 5 bot wallets, but found ${botWallets?.length || 0}`)
      }

      if (!creditBalanceWei || creditBalanceWei <= BigInt(0)) {
        throw new Error("No credit balance available for distribution")
      }

      console.log("💰 Starting Gasless Credit Distribution...")
      console.log(`   → Distributing ALL credit from main wallet to 5 bot wallets`)
      
      setStatus("Checking credit balance...")
      // CRITICAL: Use credit balance from database, not ETH balance from blockchain
      // Credit balance = Main wallet credit (from Convert $BUMP) + Bot wallet credits (from Distribute)
      // ETH balance on blockchain may be different because:
      // 1. Bot wallets may have consumed some credit (ETH spent on swaps)
      // 2. Credit balance is tracked in database, not blockchain
      // 3. We only count valid credits from Convert and Distribute functions
      
      // Fetch current credit balance from database
      const creditResponse = await fetch("/api/credit-balance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userAddress }),
      })
      
      if (!creditResponse.ok) {
        const errorData = await creditResponse.json().catch(() => ({}))
        throw new Error(
          `Failed to fetch credit balance from database: ${errorData.error || creditResponse.statusText}. Please try again.`
        )
      }
      
      const creditData = await creditResponse.json()
      if (!creditData.success || !creditData.balanceWei) {
        throw new Error("Invalid credit balance response from database")
      }
      
      const dbCreditBalanceWei = BigInt(creditData.balanceWei)
      console.log(`   → Database credit balance: ${formatEther(dbCreditBalanceWei)} ETH`)
      console.log(`   → Main wallet credit: ${formatEther(BigInt(creditData.mainWalletCreditWei || "0"))} ETH`)
      console.log(`   → Bot wallet credits: ${formatEther(BigInt(creditData.botWalletCreditsWei || "0"))} ETH`)
      
      // CRITICAL: Use ALL main wallet credit for distribution
      // Distribute ALL credit from main wallet (ETH hasil Convert $BUMP to credit) to bot wallets
      // We can only distribute from main wallet credit, not from bot wallet credits
      const mainWalletCreditWei = BigInt(creditData.mainWalletCreditWei || "0")
      
      if (mainWalletCreditWei <= BigInt(0)) {
        throw new Error(
          `No credit available in main wallet. Please convert $BUMP to credit first.`
        )
      }

      // Validate ETH balance in Privy Smart Wallet
      // CRITICAL: Gas will be sponsored by CDP Paymaster (100% gasless)
      // We only need to check if balance is sufficient for the transfer amount itself
      // No need to reserve gas - Paymaster will cover all gas costs
      const walletBalance = await publicClient.getBalance({
        address: smartWalletAddress,
      })
      
      console.log(`   → Wallet balance: ${formatEther(walletBalance)} ETH`)
      console.log(`   → Main wallet credit (from DB): ${formatEther(mainWalletCreditWei)} ETH`)
      console.log(`   → Gas: Sponsored by CDP Paymaster (100% gasless)`)
      
      // CRITICAL: Use credit from database as source of truth
      // Only check if blockchain balance is sufficient for the credit amount
      // Since gas is sponsored, we don't need to subtract gas from balance
      // However, we should use the minimum of (walletBalance, mainWalletCreditWei) to avoid over-distribution
      const availableCreditWei = walletBalance < mainWalletCreditWei ? walletBalance : mainWalletCreditWei
      
      if (availableCreditWei <= BigInt(0)) {
        throw new Error(
          `No credit available for distribution. Wallet balance: ${formatEther(walletBalance)} ETH, Credit in DB: ${formatEther(mainWalletCreditWei)} ETH. Please ensure your wallet has ETH from Convert $BUMP to credit.`
        )
      }
      
      // Use available credit (minimum of balance and credit in DB)
      // This ensures we don't try to send more than what's actually available
      const creditToDistribute = availableCreditWei
      console.log(`   → Credit to distribute: ${formatEther(creditToDistribute)} ETH`)

      // Calculate amount per bot: Distribute ALL available credit equally to 5 bot wallets
      // CRITICAL: Use creditToDistribute (not mainWalletCreditWei) to ensure we don't over-distribute
      const amountPerBot = creditToDistribute / BigInt(5)
      const remainder = creditToDistribute % BigInt(5)
      const amountForFirstBot = amountPerBot + remainder
      
      console.log(`   → Distributing ALL available credit: ${formatEther(creditToDistribute)} ETH`)
      console.log(`   → Amount per bot: ${formatEther(amountPerBot)} ETH`)
      if (remainder > BigInt(0)) {
        console.log(`   → First bot gets extra: ${formatEther(remainder)} ETH (total: ${formatEther(amountForFirstBot)} ETH)`)
      }

      setStatus("Preparing batch transaction...")
      
      // CRITICAL: Use batch transaction with EIP-5792 Paymaster capabilities
      // This approach:
      // 1. Collects all transfers into a single array of calls
      // 2. Sends ONE batch transaction (not multiple individual transactions)
      // 3. Uses EIP-5792 capabilities with explicit paymasterService URL
      // 4. Uses checksum addresses to ensure correct format
      // 5. Avoids allowlist issues by using direct CDP Paymaster URL
      
      console.log(`📤 Preparing batch transaction for ${botWallets.length} bot wallets...`)
      
      // Get CDP API Key from environment (client-side accessible)
      // Try NEXT_PUBLIC_CDP_API_KEY first, then extract from NEXT_PUBLIC_COINBASE_CDP_BUNDLER_URL
      const cdpApiKey = process.env.NEXT_PUBLIC_CDP_API_KEY || 
        (process.env.NEXT_PUBLIC_COINBASE_CDP_BUNDLER_URL?.split('/').pop())
      
      if (!cdpApiKey) {
        throw new Error("CDP API Key not found. Please set NEXT_PUBLIC_CDP_API_KEY or NEXT_PUBLIC_COINBASE_CDP_BUNDLER_URL environment variable.")
      }
      
      const paymasterServiceUrl = `https://api.developer.coinbase.com/rpc/v1/base/${cdpApiKey}`
      
      // Prepare batch calls array with checksum addresses
      const calls = botWallets.map((wallet, index) => {
        const amount = index === 0 ? amountForFirstBot : amountPerBot
        const checksumAddress = getAddress(wallet.smartWalletAddress) // Ensure checksum format
        
        console.log(`   Bot #${index + 1}: ${checksumAddress} - ${formatEther(amount)} ETH`)
        
        return {
          to: checksumAddress as Address,
          value: amount,
          data: "0x" as Hex,
        }
      })

      setStatus("Distributing credits (gasless via CDP Paymaster with EIP-5792)...")

      let primaryTxHash: `0x${string}`
      let isGasless = true
      
      // First, try gasless transaction with CDP Paymaster
      try {
        console.log(`📤 Attempting GASLESS batch transaction via Privy Smart Wallet with EIP-5792 Paymaster...`)
        console.log(`   Using Smart Wallet address: ${smartWalletAddress}`)
        console.log(`   Paymaster Service URL: ${paymasterServiceUrl}`)
        console.log(`   Strategy: Batch transaction with EIP-5792 capabilities`)
        console.log(`   Total calls: ${calls.length}`)
        
        // Send batch transaction with EIP-5792 Paymaster capabilities
        // This uses explicit paymasterService URL to avoid allowlist restrictions
        primaryTxHash = await smartWalletClient.sendTransaction(
          {
            calls: calls, // Batch all transfers in one transaction
          },
          {
            isSponsored: true, // Enable gas sponsorship
            // EIP-5792 Capabilities: Explicit paymasterService URL
            capabilities: {
              paymasterService: {
                url: paymasterServiceUrl,
              },
            },
          }
        ) as `0x${string}`
        
        console.log(`✅ GASLESS batch transaction sent successfully!`)
        console.log(`   Transaction hash: ${primaryTxHash}`)
        console.log(`   Total transfers: ${calls.length}`)
      } catch (gaslessError: any) {
        const gaslessErrorMessage = gaslessError.message || String(gaslessError)
        
        // Check if it's an allowlist or Paymaster error - fallback to normal transaction
        const isPaymasterError = 
          gaslessErrorMessage.includes("address not in allowlist") ||
          gaslessErrorMessage.includes("not in allowlist") ||
          gaslessErrorMessage.includes("allowlist") ||
          gaslessErrorMessage.includes("Paymaster") ||
          gaslessErrorMessage.includes("paymaster") ||
          gaslessErrorMessage.includes("not available") ||
          gaslessErrorMessage.includes("pm_getPaymasterStubData")
        
        if (isPaymasterError) {
          console.warn(`⚠️ Gasless transaction failed (Paymaster error): ${gaslessErrorMessage}`)
          console.log(`🔄 Falling back to NORMAL (non-gasless) transaction...`)
          
          setStatus("Gasless failed. Sending normal transaction...")
          isGasless = false
          
          // Fallback: Send normal transaction WITHOUT Paymaster (user pays gas)
          try {
            console.log(`📤 Sending NORMAL batch transaction (user pays gas)...`)
            console.log(`   Using Smart Wallet address: ${smartWalletAddress}`)
            console.log(`   Total calls: ${calls.length}`)
            
            primaryTxHash = await smartWalletClient.sendTransaction({
              calls: calls, // Batch all transfers in one transaction
            }) as `0x${string}`
            
            console.log(`✅ NORMAL batch transaction sent successfully!`)
            console.log(`   Transaction hash: ${primaryTxHash}`)
            console.log(`   Total transfers: ${calls.length}`)
            console.log(`   Note: User paid gas fees for this transaction`)
          } catch (normalTxError: any) {
            const normalErrorMessage = normalTxError.message || String(normalTxError)
            console.error("❌ Normal transaction also failed:", normalErrorMessage)
            
            // Handle insufficient balance for normal transaction
            if (
              normalErrorMessage.includes("insufficient balance") ||
              normalErrorMessage.includes("insufficient funds") ||
              normalErrorMessage.includes("balance too low")
            ) {
              throw new Error(
                `Insufficient balance for transaction. Required: ${formatEther(creditToDistribute)} ETH + gas. Please add more ETH to your wallet.`
              )
            }
            
            throw new Error(
              `Both gasless and normal transactions failed. Last error: ${normalErrorMessage}. Please try again.`
            )
          }
        } else {
          // Not a Paymaster error - handle other errors
          const errorName = gaslessError.name || gaslessError.constructor?.name || ""
          
          if (
            errorName === "UserOperationExecutionError" ||
            gaslessErrorMessage.includes("Execution reverted") ||
            gaslessErrorMessage.includes("user operation execution failed") ||
            gaslessErrorMessage.includes("revert")
          ) {
            console.error("❌ User Operation Execution Error:", gaslessError)
            
            // Extract revert reason if available
            const revertReason = 
              gaslessError.cause?.message || 
              gaslessError.reason || 
              gaslessError.details || 
              gaslessErrorMessage || 
              "Unknown error"
            
            throw new Error(
              `Transaction execution failed: ${revertReason}. Please check your wallet balance.`
            )
          }
          
          // Handle insufficient balance errors
          if (
            gaslessErrorMessage.includes("insufficient balance") ||
            gaslessErrorMessage.includes("insufficient funds") ||
            gaslessErrorMessage.includes("balance too low")
          ) {
            throw new Error(
              `Insufficient balance: ${gaslessErrorMessage}. Please ensure your wallet has enough ETH.`
            )
          }
          
          // Re-throw other errors with more context
          throw new Error(
            `Transaction failed: ${gaslessErrorMessage}. Please try again.`
          )
        }
      }

      console.log(`✅ Batch transaction sent! Hash: ${primaryTxHash}`)
      setHash(primaryTxHash)

      setStatus("Waiting for confirmation...")

      // Wait for batch transaction confirmation
      // Since we're using batch transaction, there's only one transaction hash to wait for
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: primaryTxHash,
        confirmations: 1,
      })
      
      console.log(`✅ Batch transaction confirmed successfully!`)

      if (receipt.status === "success") {
        setIsSuccess(true)
        setStatus("Recording distribution in database...")
        
        // Record distribution in database
        try {
          const distributions = botWallets.map((wallet, index) => ({
            botWalletAddress: wallet.smartWalletAddress,
            amountWei: (index === 0 ? amountForFirstBot : amountPerBot).toString(),
          }))

          const recordResponse = await fetch("/api/bot/record-distribution", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              userAddress: userAddress,
              distributions: distributions,
              txHash: primaryTxHash, // Batch transaction hash
            }),
          })

          if (!recordResponse.ok) {
            const errorData = await recordResponse.json()
            console.error("⚠️ Failed to record distribution in database:", errorData)
            // Don't throw - transaction succeeded, just log the warning
          } else {
            console.log("✅ Distribution recorded in database")
          }
        } catch (recordError: any) {
          console.error("⚠️ Error recording distribution in database:", recordError)
          // Don't throw - transaction succeeded, just log the warning
        }

        setStatus("Distribution completed!")
        
        toast.success(`Successfully distributed credit to 5 bot wallets!`, {
          description: isGasless ? `100% Gasless via CDP Paymaster` : `Normal transaction (gas paid by user)`,
          action: {
            label: "View",
            onClick: () => window.open(`https://basescan.org/tx/${primaryTxHash}`, "_blank"),
          },
        })

        return {
          success: true,
          txHash: primaryTxHash,
          amountPerBot: formatEther(amountPerBot),
          totalDistributed: formatEther(creditToDistribute),
          gasless: isGasless,
        }
      } else {
        throw new Error("Transaction failed")
      }
    } catch (err: any) {
      console.error("❌ Distribution failed:", err)
      setError(err)
      setStatus(null)
      toast.error("Distribution failed", {
        description: err.message || "Failed to distribute credits",
      })
      throw err
    } finally {
      setIsPending(false)
    }
  }

  return {
    distribute,
    hash,
    isPending,
    isSuccess,
    error,
    status,
    reset,
  }
}
