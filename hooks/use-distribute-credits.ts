"use client"

import { useState } from "react"
import { useSmartWallets } from "@privy-io/react-auth/smart-wallets"
import { usePublicClient } from "wagmi"
import { formatEther, getAddress, type Address, type Hex } from "viem"
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

      const smartWalletAddress = userAddress.toLowerCase() === privySmartWalletAddress.toLowerCase()
        ? privySmartWalletAddress
        : (userAddress as Address)

      console.log(`✅ Privy Smart Wallet connected: ${smartWalletAddress}`)
      console.log(`   Chain: Base Mainnet (${base.id})`)

      if (!botWallets || botWallets.length !== 5) {
        throw new Error(`Expected 5 bot wallets, but found ${botWallets?.length || 0}`)
      }

      if (!creditBalanceWei || creditBalanceWei <= BigInt(0)) {
        throw new Error("No credit balance available for distribution")
      }

      console.log("💰 Starting Credit Distribution (Normal Transaction)...")
      console.log(`   → Distributing ALL credit from main wallet to 5 bot wallets`)
      
      setStatus("Checking credit balance...")
      
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
      
      // Use main wallet credit for distribution
      const mainWalletCreditWei = BigInt(creditData.mainWalletCreditWei || "0")
      
      if (mainWalletCreditWei <= BigInt(0)) {
        throw new Error(
          `No credit available in main wallet. Please convert $BUMP to credit first.`
        )
      }

      // Validate ETH balance in Privy Smart Wallet
      const walletBalance = await publicClient.getBalance({
        address: smartWalletAddress,
      })
      
      console.log(`   → Wallet balance: ${formatEther(walletBalance)} ETH`)
      console.log(`   → Main wallet credit (from DB): ${formatEther(mainWalletCreditWei)} ETH`)
      
      // Use available credit (minimum of balance and credit in DB)
      // Reserve some ETH for gas fees (estimate ~0.001 ETH for batch transaction)
      const gasReserve = BigInt("1000000000000000") // 0.001 ETH for gas
      const availableForDistribution = walletBalance > gasReserve ? walletBalance - gasReserve : BigInt(0)
      const creditToDistribute = availableForDistribution < mainWalletCreditWei 
        ? availableForDistribution 
        : mainWalletCreditWei
      
      if (creditToDistribute <= BigInt(0)) {
        throw new Error(
          `Insufficient balance for distribution. Wallet balance: ${formatEther(walletBalance)} ETH (need ~0.001 ETH for gas). Please add more ETH to your wallet.`
        )
      }
      
      console.log(`   → Credit to distribute: ${formatEther(creditToDistribute)} ETH`)
      console.log(`   → Gas reserve: ${formatEther(gasReserve)} ETH`)

      // Calculate amount per bot
      const amountPerBot = creditToDistribute / BigInt(5)
      const remainder = creditToDistribute % BigInt(5)
      const amountForFirstBot = amountPerBot + remainder
      
      console.log(`   → Amount per bot: ${formatEther(amountPerBot)} ETH`)
      if (remainder > BigInt(0)) {
        console.log(`   → First bot gets extra: ${formatEther(remainder)} ETH (total: ${formatEther(amountForFirstBot)} ETH)`)
      }

      setStatus("Preparing batch transaction...")
      
      // Prepare batch calls array with checksum addresses
      const calls = botWallets.map((wallet, index) => {
        const amount = index === 0 ? amountForFirstBot : amountPerBot
        const checksumAddress = getAddress(wallet.smartWalletAddress)
        
        console.log(`   Bot #${index + 1}: ${checksumAddress} - ${formatEther(amount)} ETH`)
        
        return {
          to: checksumAddress as Address,
          value: amount,
          data: "0x" as Hex,
        }
      })

      setStatus("Sending transaction (user pays gas)...")

      let primaryTxHash: `0x${string}`
      
      console.log(`📤 Sending batch transaction (normal - user pays gas)...`)
      console.log(`   Using Smart Wallet address: ${smartWalletAddress}`)
      console.log(`   Total calls: ${calls.length}`)
      
      // Send normal batch transaction (user pays gas)
      primaryTxHash = await smartWalletClient.sendTransaction({
        calls: calls,
      }) as `0x${string}`
      
      console.log(`✅ Batch transaction sent successfully!`)
      console.log(`   Transaction hash: ${primaryTxHash}`)
      console.log(`   Total transfers: ${calls.length}`)

      setHash(primaryTxHash)
      setStatus("Waiting for confirmation...")

      // Wait for transaction confirmation
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: primaryTxHash,
        confirmations: 1,
      })
      
      console.log(`✅ Transaction confirmed!`)

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
              txHash: primaryTxHash,
            }),
          })

          if (!recordResponse.ok) {
            const errorData = await recordResponse.json()
            console.error("⚠️ Failed to record distribution in database:", errorData)
          } else {
            console.log("✅ Distribution recorded in database")
          }
        } catch (recordError: any) {
          console.error("⚠️ Error recording distribution in database:", recordError)
        }

        setStatus("Distribution completed!")
        
        toast.success(`Successfully distributed credit to 5 bot wallets!`, {
          description: `Total: ${formatEther(creditToDistribute)} ETH`,
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
          gasless: false,
        }
      } else {
        throw new Error("Transaction failed on-chain")
      }
    } catch (err: any) {
      console.error("❌ Distribution failed:", err)
      setError(err)
      setStatus(null)
      
      // Provide user-friendly error messages
      let errorMessage = err.message || "Failed to distribute credits"
      
      if (errorMessage.includes("insufficient") || errorMessage.includes("balance")) {
        errorMessage = "Insufficient balance. Please add more ETH to your wallet for gas fees."
      } else if (errorMessage.includes("rejected") || errorMessage.includes("denied")) {
        errorMessage = "Transaction was rejected. Please try again."
      }
      
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
