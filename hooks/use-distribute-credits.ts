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
      // With Paymaster Proxy, gas is sponsored (gasless)
      // So we can use full wallet balance for distribution
      // =============================================
      setStatus("Calculating distribution amount...")
      
      console.log(`\n📊 Distribution Calculation (Gasless via Paymaster):`)
      console.log(`   → Wallet balance: ${formatEther(walletBalance)} ETH`)
      console.log(`   → Gas cost: 0 ETH (sponsored by Paymaster)`)
      console.log(`   → Available for distribution: ${formatEther(walletBalance)} ETH`)
      console.log(`   → Credit in database: ${formatEther(mainWalletCreditWei)} ETH`)

      // With Paymaster, we don't need to reserve gas
      // Use minimum of wallet balance and credit balance
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

      // Calculate amount per bot
      const amountPerBot: bigint = creditToDistribute / BigInt(5)
      const remainder: bigint = creditToDistribute % BigInt(5)
      const amountForFirstBot: bigint = amountPerBot + remainder

      console.log(`\n📦 Distribution per bot:`)
      console.log(`   → Amount per bot: ${formatEther(amountPerBot)} ETH`)
      if (remainder > BigInt(0)) {
        console.log(`   → First bot gets remainder: +${formatEther(remainder)} ETH`)
      }

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
      // Execute Batch Transaction
      // WITH PAYMASTER PROXY - Gasless transaction
      // =============================================
      setStatus("Awaiting signature... (1 approval for 5 transfers)")
      
      // Build Paymaster Proxy URL
      const paymasterProxyUrl = typeof window !== "undefined" 
        ? `${window.location.origin}/api/paymaster`
        : "/api/paymaster"
      
      console.log(`\n📤 Sending BATCH transaction (WITH PAYMASTER PROXY)...`)
      console.log(`   → Total calls: ${calls.length}`)
      console.log(`   → User pays gas: NO (Gasless via Paymaster)`)
      console.log(`   → Paymaster Proxy: ${paymasterProxyUrl}`)

      // Execute batch transaction with Paymaster Proxy
      // Using paymasterService to route through our proxy endpoint
      const txHash = await smartWalletClient.sendTransaction(
        {
          calls: calls, // Array of 5 calls - batched into single tx
        },
        {
          // Enable Paymaster sponsorship via proxy
          isSponsored: true,
          // Use Paymaster Proxy to bypass allowlist restrictions
          capabilities: {
            paymasterService: {
              url: paymasterProxyUrl,
            },
          },
        }
      ) as `0x${string}`

      console.log(`\n✅ Transaction submitted!`)
      console.log(`   → Hash: ${txHash}`)

      setHash(txHash)
      setStatus("Confirming on blockchain...")

      const receipt = await publicClient.waitForTransactionReceipt({
        hash: txHash,
        confirmations: 1,
      })

      if (receipt.status !== "success") {
        throw new Error("Transaction failed on-chain")
      }

      // Record to DB
      setStatus("Recording distribution...")
      const distributions = botWallets.map((wallet, index) => {
        const distAmount: bigint = index === 0 ? amountForFirstBot : amountPerBot
        return {
          botWalletAddress: wallet.smartWalletAddress,
          amountWei: distAmount.toString(),
        }
      })

      await fetch("/api/bot/record-distribution", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userAddress,
          distributions,
          txHash,
        }),
      })

      setIsSuccess(true)
      setStatus("Success!")
      
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
        method: "smart_wallet_batch_paymaster_proxy",
        gasless: true,
      }

    } catch (err: any) {
      console.error("❌ Distribution failed:", err)
      setError(err)
      setStatus(null)

      // User-friendly error messages
      let errorMessage = err.message || "Failed to distribute credits"

      if (errorMessage.includes("insufficient") || errorMessage.includes("Insufficient")) {
        errorMessage = "Insufficient ETH balance for distribution. Please add more ETH to your wallet."
      } else if (errorMessage.includes("rejected") || errorMessage.includes("denied") || errorMessage.includes("User rejected")) {
        errorMessage = "Transaction was rejected by user."
      } else if (errorMessage.includes("Paymaster") || errorMessage.includes("pm_") || errorMessage.includes("allowlist") || errorMessage.includes("not allowlisted")) {
        errorMessage = "Paymaster Proxy error. Please check CDP_PAYMASTER_URL configuration or try again."
      } else if (errorMessage.includes("not configured") || errorMessage.includes("CDP_PAYMASTER_URL")) {
        errorMessage = "Paymaster service not configured. Please contact support."
      }

      toast.error("Distribution failed", { description: errorMessage })
      throw err
    } finally {
      setIsPending(false)
    }
  }, [smartWalletClient, privySmartWalletAddress, publicClient, reset])

  return { distribute, hash, isPending, isSuccess, error, status, reset }
}
