"use client"

import { useState, useCallback } from "react"
import { useSmartWallets } from "@privy-io/react-auth/smart-wallets"
import { usePublicClient } from "wagmi"
import { formatEther, getAddress, parseEther, type Address, type Hex } from "viem"
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
  creditBalanceWei: bigint
}

// Estimated gas per transfer (basic ETH transfer = 21000)
// For Smart Account batch, we estimate higher to account for overhead
const ESTIMATED_GAS_PER_TRANSFER = BigInt(35000)
// Smart Account deployment cost estimate (only first tx if not deployed)
const SMART_ACCOUNT_DEPLOYMENT_GAS = BigInt(300000)

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

  const reset = useCallback(() => {
    setHash(null)
    setIsPending(false)
    setIsSuccess(false)
    setError(null)
    setStatus(null)
  }, [])

  /**
   * Check if Smart Account is deployed on-chain
   */
  const checkSmartAccountDeployed = useCallback(async (address: Address): Promise<boolean> => {
    try {
      const code = await publicClient.getCode({ address })
      // If code exists and is not "0x", the account is deployed
      return code !== undefined && code !== "0x" && code.length > 2
    } catch {
      return false
    }
  }, [publicClient])

  /**
   * Estimate gas cost for the batch transaction
   */
  const estimateGasCost = useCallback(async (
    numTransfers: number,
    isDeployed: boolean
  ): Promise<bigint> => {
    try {
      // Get current gas price
      const gasPrice = await publicClient.getGasPrice()
      
      // Calculate gas units needed
      let totalGasUnits = ESTIMATED_GAS_PER_TRANSFER * BigInt(numTransfers)
      
      // Add deployment cost if Smart Account is not yet deployed
      if (!isDeployed) {
        totalGasUnits += SMART_ACCOUNT_DEPLOYMENT_GAS
        console.log(`   ⚠️ Smart Account not deployed - adding deployment gas estimate`)
      }
      
      // Add 50% buffer for safety
      const gasWithBuffer = (totalGasUnits * BigInt(150)) / BigInt(100)
      
      // Calculate total gas cost
      const gasCost = gasWithBuffer * gasPrice
      
      console.log(`   → Gas price: ${formatEther(gasPrice * BigInt(1e9))} Gwei`)
      console.log(`   → Estimated gas units: ${totalGasUnits.toString()}`)
      console.log(`   → Estimated gas cost: ${formatEther(gasCost)} ETH`)
      
      return gasCost
    } catch (err) {
      console.warn("⚠️ Failed to estimate gas, using default estimate")
      // Default estimate: 0.001 ETH
      return parseEther("0.001")
    }
  }, [publicClient])

  /**
   * Main distribute function
   * Sends ETH from Privy Smart Account to 5 bot wallets in ONE batch transaction
   * WITHOUT using Paymaster - user pays gas from their native ETH balance
   */
  const distribute = useCallback(async ({ 
    userAddress, 
    botWallets, 
    creditBalanceWei 
  }: DistributeCreditsParams) => {
    reset()
    setIsPending(true)

    try {
      console.log("=====================================")
      console.log("💰 DISTRIBUTE CREDITS - NO PAYMASTER")
      console.log("=====================================")
      
      // =============================================
      // STEP 1: Validate Smart Wallet Client
      // =============================================
      if (!smartWalletClient) {
        throw new Error("Smart Wallet client not found. Please login again.")
      }

      if (!privySmartWalletAddress) {
        throw new Error("Smart Wallet address not found. Please login again.")
      }

      // Determine which address to use
      const smartWalletAddress = userAddress.toLowerCase() === privySmartWalletAddress.toLowerCase()
        ? privySmartWalletAddress
        : (userAddress as Address)

      console.log(`\n📊 Smart Wallet: ${smartWalletAddress}`)
      console.log(`   Chain: Base Mainnet (${base.id})`)

      // =============================================
      // STEP 2: Validate Bot Wallets
      // =============================================
      if (!botWallets || botWallets.length !== 5) {
        throw new Error(`Expected 5 bot wallets, but found ${botWallets?.length || 0}`)
      }

      console.log(`   Bot Wallets: ${botWallets.length}`)

      // =============================================
      // STEP 3: Check Smart Account Deployment Status
      // =============================================
      setStatus("Checking Smart Account status...")
      
      const isDeployed = await checkSmartAccountDeployed(smartWalletAddress)
      console.log(`\n🔍 Smart Account deployed: ${isDeployed ? "YES" : "NO"}`)
      
      if (!isDeployed) {
        console.log(`   ⚠️ First transaction will include deployment cost`)
      }

      // =============================================
      // STEP 4: Check Native ETH Balance
      // =============================================
      setStatus("Checking ETH balance...")
      
      const walletBalance = await publicClient.getBalance({
        address: smartWalletAddress,
      })
      
      console.log(`\n💰 Wallet ETH Balance: ${formatEther(walletBalance)} ETH`)

      // =============================================
      // STEP 5: Fetch Credit Balance from Database
      // =============================================
      setStatus("Fetching credit balance...")
      
      const creditResponse = await fetch("/api/credit-balance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userAddress }),
      })
      
      if (!creditResponse.ok) {
        const errorData = await creditResponse.json().catch(() => ({}))
        throw new Error(`Failed to fetch credit balance: ${errorData.error || creditResponse.statusText}`)
      }
      
      const creditData = await creditResponse.json()
      const mainWalletCreditWei = BigInt(creditData.mainWalletCreditWei || "0")
      
      console.log(`   Database credit: ${formatEther(mainWalletCreditWei)} ETH`)

      if (mainWalletCreditWei <= BigInt(0)) {
        throw new Error("No credit available in main wallet. Please convert $BUMP to credit first.")
      }

      // =============================================
      // STEP 6: Estimate Gas Cost
      // =============================================
      setStatus("Estimating gas cost...")
      
      const estimatedGasCost = await estimateGasCost(5, isDeployed)
      
      console.log(`\n⛽ Gas Estimation:`)
      console.log(`   → Estimated gas cost: ${formatEther(estimatedGasCost)} ETH`)

      // =============================================
      // STEP 7: Calculate Distribution Amount
      // =============================================
      // Amount available for distribution = wallet balance - gas cost
      // Explicitly type as bigint to avoid union type issues
      const availableForDistribution: bigint = walletBalance > estimatedGasCost 
        ? BigInt(walletBalance.toString()) - BigInt(estimatedGasCost.toString())
        : BigInt(0)
      
      console.log(`\n📊 Distribution Calculation:`)
      console.log(`   → Wallet balance: ${formatEther(walletBalance)} ETH`)
      console.log(`   → Reserved for gas: ${formatEther(estimatedGasCost)} ETH`)
      console.log(`   → Available for distribution: ${formatEther(availableForDistribution)} ETH`)
      console.log(`   → Credit in database: ${formatEther(mainWalletCreditWei)} ETH`)

      // Check if we have enough ETH
      if (availableForDistribution <= BigInt(0)) {
        throw new Error(
          `Insufficient ETH balance for gas and distribution. ` +
          `Balance: ${formatEther(walletBalance)} ETH, ` +
          `Required for gas: ~${formatEther(estimatedGasCost)} ETH. ` +
          `Please add more ETH to your wallet.`
        )
      }

      // Use minimum of available balance and credit
      const creditToDistribute: bigint = availableForDistribution < mainWalletCreditWei
        ? availableForDistribution
        : mainWalletCreditWei

      if (creditToDistribute <= BigInt(0)) {
        throw new Error("No credit available for distribution after gas reservation.")
      }

      console.log(`   → Credit to distribute: ${formatEther(creditToDistribute)} ETH`)

      // =============================================
      // STEP 8: Calculate Amount Per Bot
      // =============================================
      // Ensure we're working with BigInt
      const creditBigInt = BigInt(creditToDistribute.toString())
      const amountPerBot: bigint = creditBigInt / BigInt(5)
      const remainder: bigint = creditBigInt % BigInt(5)
      const amountForFirstBot: bigint = amountPerBot + remainder

      console.log(`\n📦 Distribution per bot:`)
      console.log(`   → Amount per bot: ${formatEther(amountPerBot)} ETH`)
      if (remainder > BigInt(0)) {
        console.log(`   → First bot gets remainder: +${formatEther(remainder)} ETH`)
      }

      // =============================================
      // STEP 9: Prepare Batch Calls Array
      // =============================================
      setStatus("Preparing batch transaction...")
      
      // Create array of 5 transfer calls - ONE signature required
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
      // STEP 10: Execute Batch Transaction
      // NO PAYMASTER - User pays gas with native ETH
      // =============================================
      setStatus("Awaiting signature... (1 approval for 5 transfers)")
      
      console.log(`\n📤 Sending BATCH transaction (NO PAYMASTER)...`)
      console.log(`   → Total calls: ${calls.length}`)
      console.log(`   → User pays gas: YES`)
      console.log(`   → Paymaster: DISABLED`)

      // Execute batch transaction with Paymaster DISABLED
      // Using only isSponsored: false - NO paymasterService config
      const txHash = await smartWalletClient.sendTransaction(
        {
          calls: calls, // Array of 5 calls - batched into single tx
        },
        {
          // CRITICAL: Disable Paymaster sponsorship
          // User pays gas from their own ETH balance
          isSponsored: false,
          // DO NOT include paymasterService or capabilities
          // This forces the transaction to use native ETH for gas
        }
      ) as `0x${string}`

      console.log(`\n✅ Transaction submitted!`)
      console.log(`   → Hash: ${txHash}`)

      setHash(txHash)
      setStatus("Waiting for confirmation...")

      // =============================================
      // STEP 11: Wait for Transaction Confirmation
      // =============================================
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: txHash,
        confirmations: 1,
      })

      console.log(`\n✅ Transaction confirmed!`)
      console.log(`   → Block: ${receipt.blockNumber}`)
      console.log(`   → Gas used: ${receipt.gasUsed.toString()}`)
      console.log(`   → Status: ${receipt.status}`)

      if (receipt.status !== "success") {
        throw new Error("Transaction failed on-chain")
      }

      // =============================================
      // STEP 12: Record Distribution in Database
      // =============================================
      setStatus("Recording distribution...")
      
      try {
        const distributions = botWallets.map((wallet, index) => {
          const distAmount: bigint = index === 0 ? amountForFirstBot : amountPerBot
          return {
            botWalletAddress: wallet.smartWalletAddress,
            amountWei: distAmount.toString(),
          }
        })

        const recordResponse = await fetch("/api/bot/record-distribution", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            userAddress: userAddress,
            distributions: distributions,
            txHash: txHash,
          }),
        })

        if (recordResponse.ok) {
          console.log("✅ Distribution recorded in database")
        } else {
          console.warn("⚠️ Failed to record distribution in database")
        }
      } catch (recordError) {
        console.error("⚠️ Error recording distribution:", recordError)
      }

      // =============================================
      // STEP 13: Success!
      // =============================================
      setIsSuccess(true)
      setStatus("Distribution completed!")

      console.log(`\n=====================================`)
      console.log(`✅ DISTRIBUTION COMPLETE!`)
      console.log(`   → Total: ${formatEther(creditToDistribute)} ETH`)
      console.log(`   → Bot wallets: 5`)
      console.log(`   → Tx: ${txHash}`)
      console.log(`=====================================\n`)

      toast.success("Successfully distributed credit to 5 bot wallets!", {
        description: `Total: ${formatEther(creditToDistribute)} ETH`,
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
        method: "smart_wallet_batch",
      }

    } catch (err: any) {
      console.error("❌ Distribution failed:", err)
      setError(err)
      setStatus(null)

      // User-friendly error messages
      let errorMessage = err.message || "Failed to distribute credits"

      if (errorMessage.includes("insufficient") || errorMessage.includes("Insufficient")) {
        errorMessage = "Insufficient ETH balance for gas and distribution. Please add more ETH to your wallet."
      } else if (errorMessage.includes("rejected") || errorMessage.includes("denied") || errorMessage.includes("User rejected")) {
        errorMessage = "Transaction was rejected by user."
      } else if (errorMessage.includes("Paymaster") || errorMessage.includes("pm_") || errorMessage.includes("allowlist")) {
        errorMessage = "Paymaster error. Transaction will retry without Paymaster. Please try again."
      }

      toast.error("Distribution failed", {
        description: errorMessage,
      })

      throw err
    } finally {
      setIsPending(false)
    }
  }, [smartWalletClient, privySmartWalletAddress, publicClient, checkSmartAccountDeployed, estimateGasCost, reset])

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
