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
      // Validate inputs
      if (!botWallets || botWallets.length !== 5) {
        throw new Error(`Expected 5 bot wallets, but found ${botWallets?.length || 0}`)
      }

      if (!creditBalanceWei || creditBalanceWei <= BigInt(0)) {
        throw new Error("No credit balance available for distribution")
      }

      console.log("💰 Starting Credit Distribution...")
      console.log(`   → User Address: ${userAddress}`)
      console.log(`   → Bot Wallets: ${botWallets.length}`)

      // ===============================================
      // METHOD 1: Try Backend API (Relayer) First
      // This bypasses Paymaster allowlist issues
      // ===============================================
      setStatus("Connecting to backend relayer...")

      try {
        console.log(`\n📤 Attempting backend API distribution...`)
        
        const response = await fetch("/api/bot/distribute-credits", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            userAddress: userAddress,
            botWallets: botWallets.map(w => ({ smartWalletAddress: w.smartWalletAddress })),
          }),
        })

        const data = await response.json()

        // If backend succeeded
        if (response.ok && data.success) {
          console.log(`✅ Backend distribution successful!`)
          console.log(`   → Transaction hash: ${data.txHash}`)
          console.log(`   → Total distributed: ${data.totalDistributed} ETH`)
          console.log(`   → Method: ${data.method}`)
          
          setHash(data.txHash as `0x${string}`)
          setIsSuccess(true)
          setStatus("Distribution completed!")
          
          toast.success(`Successfully distributed credit to ${data.transfers?.length || 5} bot wallets!`, {
            description: `Total: ${data.totalDistributed} ETH`,
            action: data.txHash ? {
              label: "View",
              onClick: () => window.open(`https://basescan.org/tx/${data.txHash}`, "_blank"),
            } : undefined,
          })

          return {
            success: true,
            txHash: data.txHash,
            amountPerBot: data.amountPerBot,
            totalDistributed: data.totalDistributed,
            method: "backend",
          }
        }

        // If backend says to fallback
        if (data.fallback) {
          console.log(`⚠️ Backend API requested fallback: ${data.error || "Not available"}`)
          throw new Error("FALLBACK_TO_FRONTEND")
        }

        // Backend returned an error
        throw new Error(data.error || "Backend distribution failed")
      } catch (backendError: any) {
        if (backendError.message !== "FALLBACK_TO_FRONTEND") {
          console.warn(`⚠️ Backend distribution failed: ${backendError.message}`)
        }
        console.log(`🔄 Falling back to frontend Smart Wallet...`)
      }

      // ===============================================
      // METHOD 2: Fallback to Frontend Smart Wallet
      // Uses Privy Smart Wallet with isSponsored: false
      // ===============================================
      
      // Validate Privy Smart Wallet for fallback
      if (!smartWalletClient) {
        throw new Error("Smart Wallet client not found and backend API unavailable. Please login again.")
      }

      if (!privySmartWalletAddress) {
        throw new Error("Smart Wallet address not found. Please login again.")
      }

      const smartWalletAddress = userAddress.toLowerCase() === privySmartWalletAddress.toLowerCase()
        ? privySmartWalletAddress
        : (userAddress as Address)

      console.log(`\n💰 Using frontend Smart Wallet: ${smartWalletAddress}`)
      console.log(`   Chain: Base Mainnet (${base.id})`)
      
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
      
      // Use available credit - distribute ALL credit without minimum amount
      // Take the minimum of wallet balance and main wallet credit to ensure we don't over-distribute
      const creditToDistribute = walletBalance < mainWalletCreditWei 
        ? walletBalance 
        : mainWalletCreditWei
      
      // Allow distribution of any amount (no minimum)
      if (creditToDistribute <= BigInt(0)) {
        throw new Error(
          `No credit available for distribution. Wallet balance: ${formatEther(walletBalance)} ETH, Credit in DB: ${formatEther(mainWalletCreditWei)} ETH.`
        )
      }
      
      console.log(`   → Credit to distribute: ${formatEther(creditToDistribute)} ETH (100% of available credit)`)

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
      
      console.log(`📤 Sending batch transaction (NORMAL - NO PAYMASTER - user pays gas)...`)
      console.log(`   Using Smart Wallet address: ${smartWalletAddress}`)
      console.log(`   Total calls: ${calls.length}`)
      
      // CRITICAL: Send transaction WITHOUT Paymaster
      // Try multiple approaches to completely disable Paymaster
      try {
        // Approach 1: Try with explicit isSponsored: false and empty capabilities
        console.log(`   Attempting with isSponsored: false and empty capabilities...`)
        primaryTxHash = await smartWalletClient.sendTransaction(
          {
            calls: calls,
          },
          {
            isSponsored: false,
            // Explicitly set empty capabilities to prevent Paymaster
            capabilities: {} as any,
          }
        ) as `0x${string}`
      } catch (approach1Error: any) {
        console.log(`   Approach 1 failed: ${approach1Error.message}`)
        
        // Check if it's a Paymaster error
        if (approach1Error.message?.includes("Paymaster") || 
            approach1Error.message?.includes("pm_") ||
            approach1Error.message?.includes("allowlist") ||
            approach1Error.message?.includes("not available")) {
          
          console.log(`   Trying Approach 2: Send individual transactions...`)
          
          // Approach 2: Send transactions one by one
          const txHashes: `0x${string}`[] = []
          
          for (let i = 0; i < calls.length; i++) {
            const call = calls[i]
            console.log(`   Sending transfer ${i + 1}/${calls.length} to ${call.to}...`)
            
            try {
              const singleTxHash = await smartWalletClient.sendTransaction(
                {
                  to: call.to,
                  value: call.value,
                  data: call.data,
                },
                {
                  isSponsored: false,
                }
              ) as `0x${string}`
              
              txHashes.push(singleTxHash)
              console.log(`   ✅ Transfer ${i + 1} sent: ${singleTxHash}`)
              
              // Wait a bit between transactions to avoid nonce issues
              if (i < calls.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 2000))
              }
            } catch (singleTxError: any) {
              console.error(`   ❌ Transfer ${i + 1} failed:`, singleTxError.message)
              
              // If single transaction also fails with Paymaster error, throw
              if (singleTxError.message?.includes("Paymaster") || 
                  singleTxError.message?.includes("pm_") ||
                  singleTxError.message?.includes("allowlist")) {
                throw new Error(
                  `Paymaster error persists. The Smart Wallet bundler requires Paymaster. ` +
                  `Please ensure your Coinbase CDP Paymaster policy allows these addresses, ` +
                  `or contact support. Error: ${singleTxError.message}`
                )
              }
              throw singleTxError
            }
          }
          
          // Use first transaction hash as primary
          primaryTxHash = txHashes[0]
          console.log(`   ✅ All ${txHashes.length} transfers sent individually`)
        } else {
          // Not a Paymaster error, re-throw
          throw approach1Error
        }
      }
      
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
