"use client"

import { useState, useCallback } from "react"
import { useSmartWallets } from "@privy-io/react-auth/smart-wallets"
import { usePublicClient } from "wagmi"
import { formatEther, getAddress, encodeFunctionData, type Address, type Hex } from "viem"
import { toast } from "sonner"

// WETH Contract Address (Base Network)
const WETH_ADDRESS = "0x4200000000000000000000000000000000000006" as const

// WETH ABI for deposit and transfer
const WETH_ABI = [
  {
    inputs: [],
    name: "deposit",
    outputs: [],
    stateMutability: "payable",
    type: "function",
  },
  {
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    name: "transfer",
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const

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
      console.log(`   → Amount per bot: ${formatEther(amountPerBot)} ETH (will be converted to WETH)`)
      if (remainder > BigInt(0)) {
        console.log(`   → First bot gets remainder: +${formatEther(remainder)} ETH`)
      }

      // =============================================
      // STEP 1: Deposit ETH to WETH
      // Convert all ETH to WETH before distribution
      // This ensures 100% gasless transactions and avoids Paymaster allowlist errors
      // =============================================
      setStatus("Depositing ETH to WETH...")
      
      console.log(`\n🔄 Converting ETH to WETH...`)
      console.log(`   → WETH Contract: ${WETH_ADDRESS}`)
      console.log(`   → Amount: ${formatEther(creditToDistribute)} ETH`)
      console.log(`   → Strategy: Deposit ETH to WETH, then distribute WETH to bot wallets`)
      console.log(`   → Bot Strategy: Bot wallets will hold WETH. Uniswap v4 can use WETH directly for swaps.`)
      
      /**
       * STRATEGY: WETH-Based Credit Distribution
       * 
       * Why WETH instead of Native ETH?
       * 1. Gasless Transactions: Paymaster Coinbase allows ERC20 (WETH) transfers to bot addresses
       *    that were previously rejected for Native ETH transfers (allowlist restrictions).
       * 2. Uniswap v4 Compatibility: Bot wallets hold WETH, which can be directly used in Uniswap v4
       *    swaps without needing to unwrap back to Native ETH.
       * 3. 1:1 Value: WETH maintains 1:1 value with ETH, so credit calculations remain accurate.
       * 
       * Bot Wallet Behavior:
       * - Bot wallets now receive WETH instead of Native ETH
       * - When bot performs swaps via Uniswap v4, it uses WETH directly
       * - No unwrap operation needed (WETH → Token swap is more efficient)
       * 
       * Credit Display:
       * - UI displays as "Total Credit" or "Total ETH" (1:1 equivalent)
       * - Database tracks both distributed_amount_wei (ETH) and weth_balance_wei (WETH)
       * - Total Credit = Native ETH (main wallet) + WETH (bot wallets)
       */

      let depositTxHash: `0x${string}` | null = null

      try {
        // Encode deposit function call (WETH.deposit())
        const depositData = encodeFunctionData({
          abi: WETH_ABI,
          functionName: "deposit",
          args: [],
        })

        // Send transaction to WETH contract with ETH value
        // Privy automatically handles sponsorship via Dashboard configuration
        depositTxHash = await smartWalletClient.sendTransaction({
          to: WETH_ADDRESS,
          value: creditToDistribute, // Send ETH to WETH contract
          data: depositData,
        }) as `0x${string}`

        console.log(`   ✅ WETH deposit transaction submitted: ${depositTxHash}`)
        
        // Wait for deposit confirmation
        setStatus("Waiting for WETH deposit confirmation...")
        const depositReceipt = await publicClient.waitForTransactionReceipt({
          hash: depositTxHash,
          confirmations: 1,
        })

        if (depositReceipt.status !== "success") {
          throw new Error("WETH deposit transaction failed on-chain")
        }

        console.log(`   ✅ WETH deposit confirmed!`)
        console.log(`      → Block: ${depositReceipt.blockNumber}`)
        console.log(`      → Gas used: ${depositReceipt.gasUsed.toString()}`)
      } catch (depositError: any) {
        console.error(`   ❌ WETH deposit failed:`, depositError.message)
        throw new Error(`Failed to deposit ETH to WETH: ${depositError.message}`)
      }

      // =============================================
      // STEP 2: Execute Individual WETH Transfers (Like Withdraw Function)
      // Privy automatically handles sponsorship via Dashboard configuration
      // Use individual transactions to avoid batch allowlist restrictions
      // =============================================
      setStatus("Preparing WETH distribution...")
      
      console.log(`\n📤 Sending INDIVIDUAL WETH transfers...`)
      console.log(`   → Smart Wallet: ${smartWalletAddress}`)
      console.log(`   → Total transfers: ${botWallets.length}`)
      console.log(`   → Strategy: Individual WETH (ERC20) transfers (like Withdraw $BUMP) to avoid batch allowlist restrictions`)
      console.log(`   → Privy will automatically handle sponsorship via Dashboard configuration`)

      const txHashes: `0x${string}`[] = []

      // Try batch transaction first (faster, single transaction)
      // If batch fails, fallback to individual transactions
      setStatus("Preparing batch WETH transfer...")
      
      console.log(`\n📤 Attempting BATCH WETH transfer (all transfers in one transaction)...`)
      console.log(`   → Smart Wallet: ${smartWalletAddress}`)
      console.log(`   → Total transfers: ${botWallets.length}`)
      console.log(`   → Strategy: Batch all WETH transfers in single transaction (faster, no delay)`)
      
      let batchSuccess = false
      let batchTxHash: `0x${string}` | null = null
      
      try {
        // Prepare all transfer calls for batch
        const batchCalls = botWallets.map((wallet, index) => {
          const amount: bigint = index === 0 ? amountForFirstBot : amountPerBot
          const checksumAddress = getAddress(wallet.smartWalletAddress)
          
          const transferData = encodeFunctionData({
            abi: WETH_ABI,
            functionName: "transfer",
            args: [checksumAddress as Address, amount],
          })
          
          return {
            to: WETH_ADDRESS,
            data: transferData,
            value: BigInt(0), // ERC20 transfer, value is 0
          }
        })
        
        console.log(`   → Executing batch transaction with ${batchCalls.length} calls...`)
        
        // Execute batch transaction
        batchTxHash = await smartWalletClient.sendTransaction({
          calls: batchCalls as any,
        }) as `0x${string}`
        
        console.log(`   ✅ Batch transaction submitted: ${batchTxHash}`)
        batchSuccess = true
        txHashes.push(batchTxHash)
        
      } catch (batchError: any) {
        console.warn(`   ⚠️ Batch transaction failed: ${batchError.message}`)
        console.log(`   → Falling back to individual transactions...`)
        batchSuccess = false
      }
      
      // Fallback to individual transactions if batch failed
      if (!batchSuccess) {
        console.log(`\n📤 Executing INDIVIDUAL WETH transfers (fallback)...`)
        
        for (let i = 0; i < botWallets.length; i++) {
          const wallet = botWallets[i]
          const amount: bigint = i === 0 ? amountForFirstBot : amountPerBot
          const checksumAddress = getAddress(wallet.smartWalletAddress)
          
          setStatus(`Sending WETH transfer ${i + 1}/${botWallets.length}...`)
          
          console.log(`\n   📤 WETH Transfer ${i + 1}/${botWallets.length}:`)
          console.log(`      → To: ${checksumAddress}`)
          console.log(`      → Amount: ${formatEther(amount)} WETH`)

          try {
            // Encode WETH transfer function call (WETH.transfer(address, uint256))
            const transferData = encodeFunctionData({
              abi: WETH_ABI,
              functionName: "transfer",
              args: [checksumAddress as Address, amount],
            })

            // Execute individual WETH transfer (same pattern as Withdraw $BUMP)
            // Privy automatically handles sponsorship via Dashboard configuration
            const txHash = await smartWalletClient.sendTransaction({
              to: WETH_ADDRESS,
              data: transferData,
              value: BigInt(0), // ERC20 transfer, value is 0
            }) as `0x${string}`

            txHashes.push(txHash)
            console.log(`      ✅ Transaction ${i + 1} submitted: ${txHash}`)
            
            // No delay - removed as requested
          } catch (transferError: any) {
            console.error(`      ❌ Transfer ${i + 1} failed:`, transferError.message)
            throw transferError // Re-throw to stop execution
          }
        }
      }

      // Use deposit transaction hash as primary (or first transfer if deposit failed)
      const txHash = depositTxHash || (txHashes.length > 0 ? txHashes[0] : null)

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
      // Note: We record as WETH balance, but display as "Credit" (1:1 with ETH)
      setStatus("Recording distribution...")
      
      const distributions = botWallets.map((wallet, index) => {
        const distAmount: bigint = index === 0 ? amountForFirstBot : amountPerBot
        return {
          botWalletAddress: wallet.smartWalletAddress,
          amountWei: distAmount.toString(), // Amount in wei (same value for ETH and WETH)
          wethAmountWei: distAmount.toString(), // Explicitly record as WETH
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

      // Deduct credit from user_credits (main wallet)
      // CRITICAL: This reduces balance_wei in user_credits after distribution
      setStatus("Updating main wallet credit...")
      console.log(`\n💰 Deducting credit from main wallet (user_credits)...`)
      try {
        const deductResponse = await fetch("/api/deduct-credit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            userAddress: userAddress,
            amountWei: creditToDistribute.toString(),
          }),
        })

        if (!deductResponse.ok) {
          const deductError = await deductResponse.json()
          console.warn(`⚠️ Failed to deduct credit from main wallet: ${deductError.error || deductError.details}`)
        } else {
          console.log(`   ✅ Credit deducted from main wallet (user_credits)`)
          console.log(`   → Amount deducted: ${formatEther(creditToDistribute)} ETH`)
        }
      } catch (deductError) {
        console.warn("⚠️ Failed to deduct credit from main wallet:", deductError)
        // Don't throw - distribution succeeded, just log warning
      }

      setIsSuccess(true)
      setStatus("Distribution completed!")
      
      toast.success("Successfully distributed WETH credit to 5 bot wallets!", {
        description: `Total: ${formatEther(creditToDistribute)} WETH (1:1 with ETH)`,
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
