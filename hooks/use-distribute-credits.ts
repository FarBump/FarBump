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
      if (!smartWalletClient) {
        throw new Error("Smart Wallet not connected. Please login again.")
      }

      if (!botWallets || botWallets.length !== 5) {
        throw new Error(`Expected 5 bot wallets, but found ${botWallets?.length || 0}`)
      }

      if (!creditBalanceWei || creditBalanceWei <= BigInt(0)) {
        throw new Error("No credit balance available for distribution")
      }

      console.log("💰 Starting Gasless Credit Distribution...")
      
      setStatus("Fetching ETH price...")

      const amountPerBot = creditBalanceWei / BigInt(5)
      
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
      
      if (amountPerBot < minAmountPerBotWei) {
        throw new Error(
          `Insufficient credit. Minimum $${MIN_AMOUNT_USD} per bot required.`
        )
      }

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
      console.log(`   → Requested distribution: ${formatEther(creditBalanceWei)} ETH`)
      
      // Check if database credit balance is sufficient
      if (dbCreditBalanceWei < creditBalanceWei) {
        throw new Error(
          `Insufficient credit balance. Available: ${formatEther(dbCreditBalanceWei)} ETH, Required: ${formatEther(creditBalanceWei)} ETH. Please convert more $BUMP to credit first.`
        )
      }
      
      // Additional check: Verify main wallet has enough credit to distribute
      // We can only distribute from main wallet credit, not from bot wallet credits
      const mainWalletCreditWei = BigInt(creditData.mainWalletCreditWei || "0")
      if (mainWalletCreditWei < creditBalanceWei) {
        throw new Error(
          `Insufficient main wallet credit. Main wallet credit: ${formatEther(mainWalletCreditWei)} ETH, Required: ${formatEther(creditBalanceWei)} ETH. Bot wallet credits cannot be redistributed. Please convert more $BUMP to credit first.`
        )
      }

      setStatus("Preparing gasless transfers...")
      
      const calls = botWallets.map((wallet) => ({
        to: wallet.smartWalletAddress as Address,
        data: "0x" as Hex,
        value: amountPerBot,
      }))

      setStatus("Distributing credits (100% gasless)...")

      // --- PERUBAHAN DISINI: Menambahkan isSponsored: true ---
      const txHash = await smartWalletClient.sendTransaction(
        {
          calls: calls as any,
        },
        {
          isSponsored: true, // Mengaktifkan sponsorship Coinbase Paymaster via Privy
        }
      )

      console.log(`✅ Gasless transaction sent! Hash: ${txHash}`)
      setHash(txHash)

      setStatus("Waiting for confirmation...")

      const receipt = await publicClient.waitForTransactionReceipt({
        hash: txHash,
        confirmations: 1,
      })

      if (receipt.status === "success") {
        setIsSuccess(true)
        setStatus("Recording distribution in database...")
        
        // Record distribution in database
        try {
          const distributions = botWallets.map((wallet) => ({
            botWalletAddress: wallet.smartWalletAddress,
            amountWei: amountPerBot.toString(),
          }))

          const recordResponse = await fetch("/api/bot/record-distribution", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              userAddress: userAddress,
              distributions: distributions,
              txHash: txHash,
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
          description: "100% Gasless Transaction",
          action: {
            label: "View",
            onClick: () => window.open(`https://basescan.org/tx/${txHash}`, "_blank"),
          },
        })

        return {
          success: true,
          txHash,
          amountPerBot: formatEther(amountPerBot),
          totalDistributed: formatEther(creditBalanceWei),
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
