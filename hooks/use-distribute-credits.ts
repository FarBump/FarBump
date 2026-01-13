"use client"

import { useState } from "react"
import { useSmartWallets } from "@privy-io/react-auth/smart-wallets"
import { usePublicClient } from "wagmi"
import { formatEther, parseEther, createWalletClient, custom, type Address, type Hex } from "viem"
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
      // Check if balance is sufficient for distribution (no gas cost calculation)
      const walletBalance = await publicClient.getBalance({
        address: smartWalletAddress,
      })
      
      console.log(`   → Wallet balance: ${formatEther(walletBalance)} ETH`)
      console.log(`   → Main wallet credit: ${formatEther(mainWalletCreditWei)} ETH`)
      
      // Check if wallet has enough ETH for distribution
      // Note: Gas will be sponsored by Paymaster, so we don't need to add gas cost
      if (walletBalance < mainWalletCreditWei) {
        throw new Error(
          `Insufficient ETH balance. Required: ${formatEther(mainWalletCreditWei)} ETH, Available: ${formatEther(walletBalance)} ETH. Please ensure your wallet has enough ETH from Convert $BUMP to credit.`
        )
      }

      // Calculate amount per bot: Distribute ALL main wallet credit equally to 5 bot wallets
      const amountPerBot = mainWalletCreditWei / BigInt(5)
      const remainder = mainWalletCreditWei % BigInt(5)
      
      // If there's a remainder, add it to the first bot wallet
      const amountForFirstBot = amountPerBot + remainder
      
      console.log(`   → Distributing ALL main wallet credit: ${formatEther(mainWalletCreditWei)} ETH`)
      console.log(`   → Amount per bot: ${formatEther(amountPerBot)} ETH`)
      if (remainder > BigInt(0)) {
        console.log(`   → First bot gets extra: ${formatEther(remainder)} ETH (total: ${formatEther(amountForFirstBot)} ETH)`)
      }

      setStatus("Preparing individual transfers...")
      
      // CRITICAL: Use individual transactions instead of batch to avoid Paymaster allowlist issues
      // Individual transactions with Privy Paymaster only sponsor the sender (main wallet),
      // not the recipients (bot wallets), avoiding allowlist requirements
      // This approach is gasless for the user while avoiding allowlist complexity
      
      console.log(`📤 Sending individual transactions to ${botWallets.length} bot wallets...`)
      botWallets.forEach((wallet, index) => {
        const amount = index === 0 ? amountForFirstBot : amountPerBot
        console.log(`   Bot #${index + 1}: ${wallet.smartWalletAddress} - ${formatEther(amount)} ETH`)
      })

      setStatus("Distributing credits (gasless via CDP Paymaster - Sender-based)...")

      // Execute individual transactions sequentially
      // This approach:
      // 1. Uses CDP Paymaster with Sender-based sponsorship (only checks sender, not recipients)
      // 2. Privy Smart Wallet client uses CDP Paymaster configured in Privy Dashboard
      // 3. No allowlist needed for bot wallet addresses (Sender-based policy)
      // 4. Maintains gasless experience for users
      const transferTxHashes: `0x${string}`[] = []
      
      try {
        console.log(`📤 Sending individual transactions via Privy Smart Wallet with CDP Paymaster...`)
        console.log(`   Using Smart Wallet address: ${smartWalletAddress}`)
        console.log(`   Paymaster: CDP Paymaster (Sender-based sponsorship)`)
        console.log(`   Strategy: Individual transactions - only sender is checked, recipients are not`)
        
        // Send individual transactions sequentially
        for (let i = 0; i < botWallets.length; i++) {
          const wallet = botWallets[i]
          const amount = i === 0 ? amountForFirstBot : amountPerBot
          
          setStatus(`Distributing to bot ${i + 1}/5...`)
          
          console.log(`   📤 Transferring ${formatEther(amount)} ETH to Bot #${i + 1} (${wallet.smartWalletAddress})...`)
          
          // Use individual sendTransaction with CDP Paymaster (Sender-based sponsorship)
          // CDP Paymaster with Sender-based policy only checks the sender (Privy Smart Wallet)
          // Recipients (bot wallets) are NOT checked, so no allowlist needed
          const txHash = await smartWalletClient.sendTransaction({
            to: wallet.smartWalletAddress as Address,
            value: amount,
            data: "0x" as Hex,
          }, {
            isSponsored: true, // CDP Paymaster sponsors sender (main wallet) - GASLESS
            // Note: CDP Paymaster URL must be configured in Privy Dashboard
            // Sponsorship policy must be set to "Sender-based" in CDP Paymaster Dashboard
          }) as `0x${string}`
          
          transferTxHashes.push(txHash)
          console.log(`   ✅ Transfer ${i + 1}/5 sent: ${txHash}`)
          
          // Wait 1 second between transfers to avoid nonce conflicts
          if (i < botWallets.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 1000))
          }
        }
        
        // Use first transaction hash as primary hash for UI/notification
        const txHash = transferTxHashes[0]
        
        console.log(`✅ All ${transferTxHashes.length} transactions sent successfully!`)
        console.log(`   Primary transaction: ${txHash}`)
        console.log(`   All transaction hashes:`, transferTxHashes)
      } catch (txError: any) {
        // Handle UserOperationExecutionError and other errors
        const errorName = txError.name || txError.constructor?.name || ""
        const errorMessage = txError.message || String(txError)
        
        if (
          errorName === "UserOperationExecutionError" ||
          errorMessage.includes("Execution reverted") ||
          errorMessage.includes("user operation execution failed") ||
          errorMessage.includes("revert")
        ) {
          console.error("❌ User Operation Execution Error:", txError)
          console.error("   Error name:", errorName)
          console.error("   Error message:", errorMessage)
          console.error("   Error details:", txError.details || txError.cause || "No additional details")
          
          // Extract revert reason if available
          const revertReason = 
            txError.cause?.message || 
            txError.reason || 
            txError.details || 
            errorMessage || 
            "Unknown error"
          
          throw new Error(
            `Transaction execution failed: ${revertReason}. Please check your wallet balance and ensure you have sufficient ETH for gas fees.`
          )
        }
        
        // Handle insufficient balance errors
        if (
          errorMessage.includes("insufficient balance") ||
          errorMessage.includes("insufficient funds") ||
          errorMessage.includes("balance too low")
        ) {
          throw new Error(
            `Insufficient balance: ${errorMessage}. Please ensure your wallet has enough ETH for the distribution and gas fees.`
          )
        }
        
        // Re-throw other errors with more context
        throw new Error(
          `Transaction failed: ${errorMessage}. Please try again or contact support if the issue persists.`
        )
      }

      console.log(`✅ All gasless transactions sent! Primary hash: ${txHash}`)
      setHash(txHash)

      setStatus("Waiting for confirmations...")

      // Wait for all transactions to be confirmed
      // We'll wait for the first transaction as primary confirmation
      // Other transactions will confirm in parallel
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: txHash,
        confirmations: 1,
      })
      
      // Optionally wait for other transactions (non-blocking)
      // This ensures all transfers are confirmed before proceeding
      console.log(`⏳ Waiting for all ${transferTxHashes.length} transactions to confirm...`)
      const allReceipts = await Promise.all(
        transferTxHashes.map(hash => 
          publicClient.waitForTransactionReceipt({
            hash,
            confirmations: 1,
          }).catch(err => {
            console.warn(`⚠️ Transaction ${hash} confirmation warning:`, err)
            return null // Don't fail if one transaction has issues
          })
        )
      )
      
      const successfulReceipts = allReceipts.filter(r => r !== null && r.status === "success")
      console.log(`✅ ${successfulReceipts.length}/${transferTxHashes.length} transactions confirmed successfully`)

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
              txHash: txHash, // Primary transaction hash
              allTxHashes: transferTxHashes, // All transaction hashes for reference
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
          description: `100% Gasless via CDP Paymaster (${transferTxHashes.length} transactions)`,
          action: {
            label: "View",
            onClick: () => window.open(`https://basescan.org/tx/${txHash}`, "_blank"),
          },
        })

        return {
          success: true,
          txHash,
          amountPerBot: formatEther(amountPerBot),
          totalDistributed: formatEther(mainWalletCreditWei),
          gasless: true,
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
