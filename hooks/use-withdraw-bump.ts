"use client"

import { useState } from "react"
import { useSmartWallets } from "@privy-io/react-auth/smart-wallets"
import { useWallets } from "@privy-io/react-auth"
import { base } from "wagmi/chains"
import { parseUnits, isAddress, type Address, encodeFunctionData } from "viem"

// $BUMP Token Contract Address on Base Network
const BUMP_TOKEN_ADDRESS = "0x94ce728849431818ec9a0cf29bdb24fe413bbb07" as const
const BUMP_DECIMALS = 18

// ERC20 ABI for transfer function
const ERC20_ABI = [
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

interface UseWithdrawBumpProps {
  enabled?: boolean
}

export function useWithdrawBump({ enabled = true }: UseWithdrawBumpProps = {}) {
  const { client: smartWalletClient } = useSmartWallets()
  const { wallets } = useWallets()
  const [hash, setHash] = useState<`0x${string}` | null>(null)
  const [isPending, setIsPending] = useState(false)
  const [isSuccess, setIsSuccess] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  const reset = () => {
    setHash(null)
    setIsPending(false)
    setIsSuccess(false)
    setError(null)
  }

  const withdraw = async (to: string, amount: string) => {
    // Reset previous state
    reset()
    setIsPending(true)
    setError(null)

    try {
      // Get Smart Wallet from wallets array (more reliable than client)
      const smartWallet = wallets.find(
        (w) => w.walletClientType === 'smart_wallet' || (w as any).type === 'smart_wallet'
      )

      // Validate Smart Wallet is available
      if (!smartWallet) {
        const error = new Error("Smart Wallet not available. Please ensure your Smart Wallet is connected.")
        setError(error)
        setIsPending(false)
        throw error
      }

      // Validate address
      if (!isAddress(to)) {
        const error = new Error("Invalid Ethereum address")
        setError(error)
        setIsPending(false)
        throw error
      }

      // Validate amount
      const amountNum = parseFloat(amount)
      if (isNaN(amountNum) || amountNum <= 0) {
        const error = new Error("Invalid amount")
        setError(error)
        setIsPending(false)
        throw error
      }

      // Convert amount to wei
      const amountWei = parseUnits(amount, BUMP_DECIMALS)

      console.log("🔄 Withdrawing $BUMP via Smart Wallet (User Operation):")
      console.log("  - To:", to)
      console.log("  - Amount:", amount, "$BUMP")
      console.log("  - Amount (wei):", amountWei.toString())
      console.log("  - Smart Wallet Address:", smartWallet.address)
      console.log("  - Using Paymaster for gas sponsorship ✅")

      // Encode the function call
      const data = encodeFunctionData({
        abi: ERC20_ABI,
        functionName: "transfer",
        args: [to as Address, amountWei],
      })

      // Use Smart Wallet's sendTransaction method
      // This will send a User Operation, allowing Paymaster to sponsor gas fees
      // The Smart Wallet automatically handles User Operation creation and submission
      const txHash = await smartWallet.sendTransaction({
        to: BUMP_TOKEN_ADDRESS as Address,
        data,
        chain: base,
      })

      console.log("✅ Transaction hash (User Operation):", txHash)
      setHash(txHash as `0x${string}`)

      // Wait for transaction confirmation
      // Smart Wallet handles User Operation execution and confirmation
      // The receipt will be available once the User Operation is executed on-chain
      const receipt = await smartWallet.waitForTransactionReceipt({
        hash: txHash as `0x${string}`,
      })

      console.log("✅ Transaction confirmed! Receipt:", receipt)
      setIsSuccess(true)
      setIsPending(false)
    } catch (err: any) {
      console.error("❌ Withdrawal failed:", err)
      const error = err instanceof Error ? err : new Error(err?.message || "Transaction failed")
      setError(error)
      setIsPending(false)
      setIsSuccess(false)
      // Don't throw here - let the caller handle it if needed
      // The error state is already set
    }
  }

  return {
    withdraw,
    hash,
    isPending,
    isSuccess,
    error,
    reset,
  }
}

