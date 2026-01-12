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

      setStatus("Validating ETH balance...")
      
      // Validate ETH balance in Privy Smart Wallet
      // Check if balance is sufficient for total distribution + gas estimate
      const walletBalance = await publicClient.getBalance({
        address: smartWalletAddress,
      })
      
      // Estimate gas for batch transaction (approximate: 21000 gas per transfer * 5 + overhead)
      // Base gas: 21000 per transfer, batch overhead: ~50000
      const estimatedGasPerTransfer = BigInt(21000)
      const batchOverhead = BigInt(50000)
      const estimatedTotalGas = estimatedGasPerTransfer * BigInt(5) + batchOverhead
      
      // Get current gas price
      const gasPrice = await publicClient.getGasPrice()
      const estimatedGasCost = estimatedTotalGas * gasPrice
      
      // Total required: distribution amount + gas cost
      const totalRequired = creditBalanceWei + estimatedGasCost
      
      console.log(`   → Wallet balance: ${formatEther(walletBalance)} ETH`)
      console.log(`   → Distribution amount: ${formatEther(creditBalanceWei)} ETH`)
      console.log(`   → Estimated gas cost: ${formatEther(estimatedGasCost)} ETH`)
      console.log(`   → Total required: ${formatEther(totalRequired)} ETH`)
      
      if (walletBalance < totalRequired) {
        throw new Error(
          `Insufficient ETH balance. Required: ${formatEther(totalRequired)} ETH (${formatEther(creditBalanceWei)} ETH for distribution + ${formatEther(estimatedGasCost)} ETH for gas), Available: ${formatEther(walletBalance)} ETH`
        )
      }

      setStatus("Preparing multi-call transfers...")
      
      // Prepare calls array for batch transaction
      // Privy Smart Wallet supports batch transactions via calls array
      const calls = botWallets.map((wallet) => ({
        to: wallet.smartWalletAddress as Address,
        data: "0x" as Hex,
        value: amountPerBot,
      }))

      console.log(`📤 Sending batch transaction to ${calls.length} bot wallets...`)
      calls.forEach((call, index) => {
        console.log(`   Bot #${index + 1}: ${call.to} - ${formatEther(call.value)} ETH`)
      })

      setStatus("Distributing credits (gasless via Privy Smart Wallet)...")

      // Send batch transaction using Privy Smart Wallet client
      // Privy Smart Wallet client supports batch transactions via calls array
      // This is the recommended way to send batch transactions with Privy Smart Wallet
      let txHash: `0x${string}`
      
      try {
        // Use Privy Smart Wallet client's sendTransaction with calls array
        // This supports batch transactions and Paymaster sponsorship if configured
        console.log(`📤 Sending batch transaction via Privy Smart Wallet client...`)
        console.log(`   Using Smart Wallet address: ${smartWalletAddress}`)
        
        txHash = await smartWalletClient.sendTransaction(
          {
            calls: calls as any,
          },
          {
            isSponsored: true, // Enable Paymaster sponsorship if configured
          }
        ) as `0x${string}`
        
        console.log(`✅ Batch transaction sent: ${txHash}`)
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
