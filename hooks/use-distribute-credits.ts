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

      setStatus("Checking wallet balance...")
      const userBalance = await publicClient.getBalance({ address: userAddress })

      if (userBalance < creditBalanceWei) {
        throw new Error(`Insufficient balance in Smart Wallet.`)
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
