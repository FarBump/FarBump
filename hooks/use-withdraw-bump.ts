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
      // Debug: Log all wallets to understand what's available
      console.log("🔍 Withdraw: Checking for Smart Wallet...")
      console.log("  - Total wallets:", wallets.length)
      console.log("  - All wallets:", wallets.map(w => ({
        address: w.address,
        walletClientType: w.walletClientType,
        type: (w as any).type,
        chainId: w.chainId
      })))
      console.log("  - Smart Wallet Client available:", !!smartWalletClient)
      console.log("  - Smart Wallet Client address:", smartWalletClient?.account?.address)

      // Try to get Smart Wallet from wallets array first
      let smartWallet = wallets.find(
        (w) => w.walletClientType === 'smart_wallet' || (w as any).type === 'smart_wallet'
      )

      // If not found in wallets array, try to use smartWalletClient
      if (!smartWallet && smartWalletClient) {
        console.log("⚠️ Smart Wallet not found in wallets array, trying to use smartWalletClient...")
        // Try to find wallet by matching address with smartWalletClient
        const clientAddress = smartWalletClient.account.address
        smartWallet = wallets.find(w => w.address.toLowerCase() === clientAddress.toLowerCase())
        
        if (!smartWallet) {
          console.log("⚠️ Smart Wallet not found by address match, will try using smartWalletClient directly")
        }
      }

      // Validate Smart Wallet is available
      if (!smartWallet && !smartWalletClient) {
        const error = new Error(
          "Smart Wallet not available. Please ensure your Smart Wallet is connected. " +
          `Found ${wallets.length} wallet(s) but none are Smart Wallets.`
        )
        console.error("❌ Smart Wallet validation failed:", error.message)
        setError(error)
        setIsPending(false)
        throw error
      }

      // Use smartWalletClient if smartWallet is not available
      const walletToUse = smartWallet || smartWalletClient
      if (!walletToUse) {
        const error = new Error("Unable to access Smart Wallet. Please try reconnecting.")
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

      const walletAddress = smartWallet?.address || smartWalletClient?.account?.address
      console.log("🔄 Withdrawing $BUMP via Smart Wallet (User Operation):")
      console.log("  - To:", to)
      console.log("  - Amount:", amount, "$BUMP")
      console.log("  - Amount (wei):", amountWei.toString())
      console.log("  - Smart Wallet Address:", walletAddress)
      console.log("  - Using wallet from:", smartWallet ? "wallets array" : "smartWalletClient")
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
      let txHash: `0x${string}`
      
      if (smartWallet) {
        // Use wallet from wallets array
        txHash = await smartWallet.sendTransaction({
          to: BUMP_TOKEN_ADDRESS as Address,
          data,
          chain: base,
        }) as `0x${string}`
      } else if (smartWalletClient) {
        // Fallback: Use smartWalletClient's writeContract method
        console.log("⚠️ Using smartWalletClient.writeContract as fallback")
        txHash = await smartWalletClient.writeContract({
          address: BUMP_TOKEN_ADDRESS as Address,
          abi: ERC20_ABI,
          functionName: "transfer",
          args: [to as Address, amountWei],
          chain: base,
        }) as `0x${string}`
      } else {
        throw new Error("No Smart Wallet available for transaction")
      }

      console.log("✅ Transaction hash (User Operation):", txHash)
      setHash(txHash)

      // Wait for transaction confirmation
      // Smart Wallet handles User Operation execution and confirmation
      // The receipt will be available once the User Operation is executed on-chain
      const receipt = smartWallet
        ? await smartWallet.waitForTransactionReceipt({ hash: txHash })
        : await smartWalletClient!.waitForTransactionReceipt({ hash: txHash })

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

