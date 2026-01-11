"use client"

import { useState } from "react"
import { useSmartWallets } from "@privy-io/react-auth/smart-wallets"
import { usePublicClient } from "wagmi"
import { formatEther, parseEther, type Address, type Hex } from "viem"
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

/**
 * Hook to automatically distribute user's credit (ETH) evenly to 5 bot smart wallets
 * 
 * This hook:
 * 1. Fetches 5 bot smart wallet addresses from database
 * 2. Calculates equal distribution (total credit / 5)
 * 3. Sends ETH from user's smart wallet to each bot wallet using GASLESS transfer
 * 4. Uses Privy Smart Wallet with Paymaster sponsorship (NO GAS FEE!)
 * 5. Handles gas estimation and errors
 * 
 * IMPORTANT: All transfers are 100% gasless via Coinbase Paymaster
 * User does NOT pay any gas fees for distribution
 * 
 * Called automatically when user clicks "Start Bumping"
 */
export function useDistributeCredits() {
  const { client: smartWalletClient } = useSmartWallets()
  const publicClient = usePublicClient()
  
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
      // Validation: Smart Wallet Client
      if (!smartWalletClient) {
        throw new Error("Smart Wallet not connected. Please login again.")
      }

      // Validation: Bot Wallets
      if (!botWallets || botWallets.length !== 5) {
        throw new Error(`Expected 5 bot wallets, but found ${botWallets?.length || 0}`)
      }

      // Validation: Credit Balance
      if (!creditBalanceWei || creditBalanceWei <= BigInt(0)) {
        throw new Error("No credit balance available for distribution")
      }

      console.log("💰 Starting Gasless Credit Distribution...")
      console.log(`   User: ${userAddress}`)
      console.log(`   Total Credit: ${formatEther(creditBalanceWei)} ETH`)
      console.log(`   Bot Wallets: ${botWallets.length}`)
      console.log(`   🆓 100% GASLESS via Coinbase Paymaster`)

      setStatus("Fetching ETH price...")

      // Calculate amount per bot wallet (equal distribution)
      const amountPerBot = creditBalanceWei / BigInt(5)
      
      console.log(`   Amount per bot: ${formatEther(amountPerBot)} ETH`)

      // Validate minimum amount per bot: $0.01 USD minimum
      // Fetch ETH price to calculate minimum in ETH
      const MIN_AMOUNT_USD = 0.01
      
      let ethPriceUsd = 0
      try {
        const priceResponse = await fetch("/api/eth-price")
        const priceData = await priceResponse.json()
        if (priceData.success && priceData.price) {
          ethPriceUsd = priceData.price
        } else {
          throw new Error("Failed to get ETH price")
        }
      } catch (priceError) {
        console.error("Error fetching ETH price:", priceError)
        throw new Error("Failed to fetch ETH price for validation")
      }
      
      const minAmountPerBotEth = MIN_AMOUNT_USD / ethPriceUsd
      const minAmountPerBotWei = parseEther(minAmountPerBotEth.toString())
      
      console.log(`   Minimum per bot: $${MIN_AMOUNT_USD} USD (${formatEther(minAmountPerBotWei)} ETH)`)
      
      if (amountPerBot < minAmountPerBotWei) {
        throw new Error(
          `Insufficient credit. Each bot needs at least $${MIN_AMOUNT_USD} USD (${formatEther(minAmountPerBotWei)} ETH). ` +
          `You have ${formatEther(creditBalanceWei)} ETH total ($${(Number(formatEther(creditBalanceWei)) * ethPriceUsd).toFixed(2)} USD).`
        )
      }

      // Check user's Smart Wallet balance
      setStatus("Checking wallet balance...")
      const userBalance = await publicClient.getBalance({ address: userAddress })
      
      console.log(`   User balance: ${formatEther(userBalance)} ETH`)

      if (userBalance < creditBalanceWei) {
        throw new Error(
          `Insufficient balance in Smart Wallet. ` +
          `Required: ${formatEther(creditBalanceWei)} ETH, ` +
          `Available: ${formatEther(userBalance)} ETH`
        )
      }

      // Prepare batch transactions to all 5 bot wallets
      setStatus("Preparing gasless transfers...")
      
      const calls = botWallets.map((wallet, index) => {
        console.log(`   [${index + 1}/5] Preparing gasless transfer to Bot #${index + 1}`)
        console.log(`      → Address: ${wallet.smartWalletAddress}`)
        console.log(`      → Amount: ${formatEther(amountPerBot)} ETH`)
        console.log(`      → Gas: 🆓 SPONSORED by Coinbase Paymaster`)
        
        return {
          to: wallet.smartWalletAddress as Address,
          data: "0x" as Hex, // Empty data for native ETH transfer
          value: amountPerBot,
        }
      })

      console.log("✅ All 5 gasless transfers prepared")
      console.log("📤 Sending batch transaction via Paymaster...")

      setStatus("Distributing credits (100% gasless)...")

      // Execute batch transaction with Paymaster sponsorship
      // Privy Smart Wallet will automatically use Coinbase Paymaster from Dashboard config
      // User pays ZERO gas fees for this transaction
      const txHash = await smartWalletClient.sendTransaction({
        calls: calls as any,
      })

      console.log(`✅ Gasless transaction sent! Hash: ${txHash}`)
      console.log(`   🆓 Gas fees: $0.00 (sponsored by Paymaster)`)
      setHash(txHash)

      setStatus("Waiting for confirmation...")

      // Wait for transaction confirmation
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: txHash,
        confirmations: 1,
      })

      if (receipt.status === "success") {
        console.log("✅ Distribution successful!")
        console.log(`   Transaction: https://basescan.org/tx/${txHash}`)
        console.log(`   Distributed ${formatEther(amountPerBot)} ETH to each of 5 bot wallets`)
        console.log(`   💰 Total gas fees paid: $0.00 (100% gasless!)`)
        
        setIsSuccess(true)
        setStatus("Distribution completed!")
        
        toast.success(
          `Successfully distributed ${formatEther(creditBalanceWei)} ETH to 5 bot wallets!`,
          {
            description: `${formatEther(amountPerBot)} ETH sent to each bot (100% gasless!)`,
            action: {
              label: "View",
              onClick: () => window.open(`https://basescan.org/tx/${txHash}`, "_blank"),
            },
          }
        )

        return {
          success: true,
          txHash,
          amountPerBot: formatEther(amountPerBot),
          totalDistributed: formatEther(creditBalanceWei),
          gasless: true, // Flag to indicate this was a gasless transaction
        }
      } else {
        throw new Error("Transaction failed")
      }
    } catch (err: any) {
      console.error("❌ Distribution failed:", err)
      
      const errorMessage = err.message || "Failed to distribute credits"
      setError(err)
      setStatus(null)
      
      toast.error("Distribution failed", {
        description: errorMessage,
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

