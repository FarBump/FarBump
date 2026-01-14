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
      // Privy will automatically handle sponsorship via Dashboard configuration
      // =============================================
      setStatus("Calculating distribution amount...")
      
      console.log(`\n📊 Distribution Calculation:`)
      console.log(`   → Wallet balance: ${formatEther(walletBalance)} ETH`)
      console.log(`   → Credit in database: ${formatEther(mainWalletCreditWei)} ETH`)

      // Privy automatically handles sponsorship, so we can use full balance
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
      // Execute Individual Transactions (Like Withdraw Function)
      // Privy automatically handles sponsorship via Dashboard configuration
      // Use individual transactions to avoid batch allowlist restrictions
      // =============================================
      setStatus("Preparing individual transactions...")
      
      console.log(`\n📤 Sending INDIVIDUAL transactions...`)
      console.log(`   → Smart Wallet: ${smartWalletAddress}`)
      console.log(`   → Total transfers: ${botWallets.length}`)
      console.log(`   → Strategy: Individual transactions (like Withdraw) to avoid batch allowlist restrictions`)
      console.log(`   → Privy will automatically handle sponsorship via Dashboard configuration`)

      const txHashes: `0x${string}`[] = []

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

        try {
          // Execute individual transaction (same format as Withdraw)
          // Privy automatically handles sponsorship via Dashboard configuration
          const txHash = await smartWalletClient.sendTransaction({
            to: checksumAddress as Address,
            value: amount,
            data: "0x" as Hex, // Empty data for simple ETH transfer
          }) as `0x${string}`

          txHashes.push(txHash)
          console.log(`      ✅ Transaction ${i + 1} submitted: ${txHash}`)

          // Wait between transactions to avoid nonce conflicts
          // Same delay as Withdraw function uses
          if (i < botWallets.length - 1) {
            const delay = 2000 // 2 seconds between transactions
            console.log(`      → Waiting ${delay}ms before next transaction...`)
            await new Promise(resolve => setTimeout(resolve, delay))
          }
        } catch (transferError: any) {
          console.error(`      ❌ Transfer ${i + 1} failed:`, transferError.message)
          throw transferError // Re-throw to stop execution
        }
      }

      // Use first transaction hash as primary
      const txHash = txHashes.length > 0 ? txHashes[0] : null

      if (!txHash || txHashes.length === 0) {
        throw new Error("All individual transactions failed")
      }

      if (txHashes.length < botWallets.length) {
        console.warn(`⚠️ Only ${txHashes.length}/${botWallets.length} transfers succeeded`)
      } else {
        console.log(`✅ All ${txHashes.length} individual transactions submitted successfully!`)
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

      // Record distribution in database
      setStatus("Recording distribution...")
      
      const distributions = botWallets.map((wallet, index) => {
        const distAmount: bigint = index === 0 ? amountForFirstBot : amountPerBot
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
        method: "user_smart_wallet_individual",
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
      }

      toast.error("Distribution failed", { 
        description: errorMessage,
      })
      throw err
    } finally {
      setIsPending(false)
    }
  }, [smartWalletClient, privySmartWalletAddress, publicClient, reset])

  return { distribute, hash, isPending, isSuccess, error, status, reset }
}
