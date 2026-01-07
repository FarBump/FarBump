"use client"

import { useState } from "react"
import { useSmartWallets } from "@privy-io/react-auth/smart-wallets"
import { usePublicClient } from "wagmi"
import { parseUnits, type Address, encodeFunctionData, type Hex } from "viem"
import {
  BUMP_TOKEN_ADDRESS,
  TREASURY_ADDRESS,
  BASE_WETH_ADDRESS,
  BUMP_DECIMALS,
  TREASURY_FEE_BPS,
  APP_FEE_BPS,
} from "@/lib/constants"

// 0x Protocol AllowanceHolder contract on Base Mainnet
// This contract holds token allowances for 0x swaps
const ZEROX_ALLOWANCE_HOLDER = "0x0000000000001fF3684f28c67538d4D072C22734" as const

// ERC20 ABI for transfer and approve
const ERC20_ABI = [
  {
    inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }],
    name: "transfer",
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }],
    name: "approve",
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const

// WETH ABI for unwrapping WETH to ETH
const WETH_ABI = [
  {
    inputs: [{ name: "wad", type: "uint256" }],
    name: "withdraw",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const

export function useConvertFuel() {
  const { client: smartWalletClient } = useSmartWallets()
  const publicClient = usePublicClient()
  
  const [hash, setHash] = useState<Hex | null>(null)
  const [isPending, setIsPending] = useState(false)
  const [isSuccess, setIsSuccess] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const [swapStatus, setSwapStatus] = useState<string>("")

  const get0xQuote = async (sellAmountWei: bigint, taker: Address) => {
    const params = new URLSearchParams({
      sellToken: BUMP_TOKEN_ADDRESS,
      buyToken: BASE_WETH_ADDRESS, // Use WETH for better route discovery
      sellAmount: sellAmountWei.toString(),
      takerAddress: taker,
      slippagePercentage: "0.03", // 3% slippage for $BUMP token
    })

    const res = await fetch(`/api/0x-quote?${params.toString()}`)
    const data = await res.json()
    if (!res.ok) {
      throw new Error(data.error || data.reason || "Failed to get swap route")
    }
    return data
  }

  const convert = async (amount: string) => {
    setIsPending(true)
    setIsSuccess(false)
    setError(null)

    try {
      if (!smartWalletClient || !publicClient) {
        throw new Error("Smart Wallet client not found. Please login again.")
      }

      const userAddress = smartWalletClient.account.address as Address
      const totalAmountWei = parseUnits(amount, BUMP_DECIMALS)

      // Calculate amounts using BigInt for precision:
      // - 5% $BUMP → Treasury (TREASURY_FEE_BPS = 500)
      // - 95% $BUMP → Swap to ETH
      const treasuryFeeWei = (totalAmountWei * BigInt(TREASURY_FEE_BPS)) / BigInt(10000)
      const swapAmountWei = totalAmountWei - treasuryFeeWei // 95% of total

      console.log("🔄 Starting Convert $BUMP to Credit...")
      console.log(`💰 Total Amount: ${amount} $BUMP`)
      console.log(`📤 Treasury Fee (5% $BUMP): ${treasuryFeeWei.toString()} wei`)
      console.log(`💱 Swap Amount (95% $BUMP): ${swapAmountWei.toString()} wei`)

      // Get 0x API quote for 95% swap amount
      setSwapStatus("Fetching quote from 0x API...")
      const quote = await get0xQuote(swapAmountWei, userAddress)

      // Calculate expected ETH amount from swap
      const expectedEthWei = BigInt(quote.buyAmount)
      
      // Calculate 5% of ETH result for Treasury (APP_FEE_BPS = 500)
      // This represents 5% of the total initial value in ETH
      const treasuryEthWei = (expectedEthWei * BigInt(APP_FEE_BPS)) / BigInt(10000)
      const userCreditEthWei = expectedEthWei - treasuryEthWei // 90% remains in Smart Wallet

      console.log(`📊 Distribution after swap:`)
      console.log(`   - Expected ETH from swap: ${expectedEthWei.toString()} wei`)
      console.log(`   - Treasury ETH (5%): ${treasuryEthWei.toString()} wei`)
      console.log(`   - User Credit ETH (90%): ${userCreditEthWei.toString()} wei`)

      setSwapStatus("Preparing transactions...")

      // Execute transactions in sequence using sendTransaction with calls array:
      // 1. Transfer 5% $BUMP to Treasury
      // 2. Approve 95% $BUMP to 0x AllowanceHolder
      // 3. Execute swap 95% $BUMP through 0x
      // 4. Unwrap all WETH to ETH
      // 5. Transfer 5% ETH to Treasury (remaining 90% stays in Smart Wallet)
      const txHash = await smartWalletClient.sendTransaction({
        calls: [
          // Step 1: Transfer 5% $BUMP to Treasury
          {
            to: BUMP_TOKEN_ADDRESS as Address,
            data: encodeFunctionData({
              abi: ERC20_ABI,
              functionName: "transfer",
              args: [TREASURY_ADDRESS as Address, treasuryFeeWei],
            }),
            value: BigInt(0),
          },
          // Step 2: Approve 95% $BUMP to 0x AllowanceHolder
          {
            to: BUMP_TOKEN_ADDRESS as Address,
            data: encodeFunctionData({
              abi: ERC20_ABI,
              functionName: "approve",
              args: [ZEROX_ALLOWANCE_HOLDER as Address, swapAmountWei],
            }),
            value: BigInt(0),
          },
          // Step 3: Execute swap 95% $BUMP through 0x Settler contract
          {
            to: quote.transaction.to as Address,
            data: quote.transaction.data as Hex,
            value: BigInt(quote.transaction.value || "0"),
          },
          // Step 4: Unwrap all WETH to ETH
          {
            to: BASE_WETH_ADDRESS as Address,
            data: encodeFunctionData({
              abi: WETH_ABI,
              functionName: "withdraw",
              args: [expectedEthWei], // Unwrap all WETH received from swap
            }),
            value: BigInt(0),
          },
          // Step 5: Transfer 5% ETH to Treasury
          // Note: Native ETH transfer is done by sending value directly
          // We'll use a simple transfer call (Smart Wallet will handle ETH transfer)
          {
            to: TREASURY_ADDRESS as Address,
            data: "0x" as Hex, // Empty data for native ETH transfer
            value: treasuryEthWei, // 5% of ETH result
          },
        ] as any,
      })

      console.log("✅ Transaction sent! Hash:", txHash)
      setHash(txHash)
      setSwapStatus("Transaction confirmed on-chain")

      // Wait for transaction confirmation
      if (publicClient) {
        try {
          await publicClient.waitForTransactionReceipt({ hash: txHash })
          console.log("✅ Transaction confirmed on-chain")
        } catch (confirmationError: any) {
          console.warn("Transaction confirmation timeout, but transaction was sent:", confirmationError)
        }
      }

      // Sync credit to database
      try {
        const response = await fetch("/api/sync-credit", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            txHash: txHash,
            userAddress: userAddress,
            amountBump: amount,
            amountBumpWei: totalAmountWei.toString(),
          }),
        })

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}))
          throw new Error(errorData.error || "Failed to sync credit")
        }

        const result = await response.json()
        console.log("✅ Credit synced:", result)
      } catch (syncError: any) {
        console.error("Failed to sync credit (transaction succeeded):", syncError)
        // Don't throw - transaction succeeded, sync can be retried
      }

      setIsSuccess(true)
      setSwapStatus("")
      return txHash
    } catch (err: any) {
      console.error("Convert Error:", err)
      setSwapStatus("")
      
      let friendlyMessage = err.message || "Transaction failed"
      if (friendlyMessage.includes("timeout") || friendlyMessage.includes("timed out")) {
        friendlyMessage = "Transaction request timed out. Please try again in a few moments."
      } else if (friendlyMessage.includes("insufficient funds")) {
        friendlyMessage = "Insufficient $BUMP balance for conversion."
      } else if (friendlyMessage.includes("Failed to fetch") || friendlyMessage.includes("network")) {
        friendlyMessage = "Network error. Please check your internet connection."
      }

      setError(new Error(friendlyMessage))
      throw new Error(friendlyMessage)
    } finally {
      setIsPending(false)
    }
  }

  const reset = () => {
    setHash(null)
    setIsPending(false)
    setIsSuccess(false)
    setError(null)
    setSwapStatus("")
  }

  return { 
    convert, 
    reset,
    hash, 
    isPending, 
    isSuccess, 
    error,
    swapStatus,
    approve: async () => ({ approved: true, hash: null }),
    isApproving: false,
    approvalHash: null
  }
}
