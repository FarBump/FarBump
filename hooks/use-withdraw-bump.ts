"use client"

import { useState } from "react"
import { useSmartWallets } from "@privy-io/react-auth/smart-wallets"
import { useWallets } from "@privy-io/react-auth"
import { usePublicClient } from "wagmi"
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
  const publicClient = usePublicClient()
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

      // CRITICAL: Use Smart Wallet client to send User Operation with Paymaster sponsorship
      // Based on Base Paymaster documentation: https://docs.base.org/base-account/improve-ux/sponsor-gas/paymasters
      // Privy Smart Wallets automatically use the Paymaster configured in Privy Dashboard (Coinbase CDP)
      // The transaction will be sent as a User Operation, allowing gasless transactions (0 ETH required)
      
      // Validate Smart Wallet client is available
      if (!smartWalletClient) {
        throw new Error("Smart Wallet client not available. Please ensure your Smart Wallet is connected.")
      }
      
      // Validate public client is available for transaction confirmation
      if (!publicClient) {
        throw new Error("Public client not available. Please ensure Wagmi is properly configured.")
      }
      
      // Retry logic for Paymaster API calls (in case of network timeouts)
      const maxRetries = 2
      let txHash: `0x${string}` | null = null
      let lastError: any = null
      
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          if (attempt > 0) {
            console.log(`🔄 Retry attempt ${attempt}/${maxRetries} for Paymaster transaction...`)
            // Wait before retry (exponential backoff)
            await new Promise(resolve => setTimeout(resolve, 1000 * attempt))
          }
          
          // PREFERRED: Use smartWalletClient.writeContract() - This is the recommended method
          // It automatically sends User Operations through Privy's Paymaster
          // Based on Base Paymaster docs: Smart Wallet transactions are automatically sponsored
          console.log("✅ Using smartWalletClient.writeContract (recommended for Paymaster)")
          txHash = await smartWalletClient.writeContract({
            address: BUMP_TOKEN_ADDRESS as Address,
            abi: ERC20_ABI,
            functionName: "transfer",
            args: [to as Address, amountWei],
            chain: base,
            // Note: Paymaster sponsorship is handled automatically by Privy
            // Privy uses the Paymaster configured in Dashboard (Coinbase CDP)
            // The transaction will be sent as a User Operation with Paymaster sponsorship
            // No need to specify paymasterAndData - Privy handles this automatically
          }) as `0x${string}`
          break // Success, exit retry loop
        } catch (retryErr: any) {
          lastError = retryErr
          const isPaymasterError = 
            retryErr?.message?.includes("Paymaster") ||
            retryErr?.message?.includes("pm_getPaymasterStubData") ||
            retryErr?.message?.includes("api.developer.coinbase.com") ||
            retryErr?.message?.includes("CONNECTION_TIMED_OUT") ||
            retryErr?.message?.includes("Failed to fetch") ||
            retryErr?.message?.includes("HTTP request failed") ||
            retryErr?.message?.includes("HttpRequestError")
          
          // Only retry on Paymaster errors, not on other errors
          if (isPaymasterError && attempt < maxRetries) {
            console.warn(`⚠️ Paymaster error on attempt ${attempt + 1}, will retry...`)
            continue
          } else {
            throw retryErr // Re-throw if not a Paymaster error or max retries reached
          }
        }
      }
      
      if (!txHash) {
        throw lastError || new Error("Transaction failed after retries")
      }

      console.log("✅ Transaction hash (User Operation):", txHash)
      console.log("  - Transaction sponsored by Paymaster ✅")
      console.log("  - User did not need ETH for gas fees ✅")
      setHash(txHash)

      // Wait for transaction confirmation using public client
      // Smart Wallet handles User Operation execution and confirmation
      // The receipt will be available once the User Operation is executed on-chain
      // Note: The transaction was sponsored by Paymaster, so user didn't need ETH for gas
      console.log("⏳ Waiting for transaction confirmation...")
      const receipt = await publicClient.waitForTransactionReceipt({ 
        hash: txHash,
        timeout: 120_000, // 2 minutes timeout
      })

      console.log("✅ Transaction confirmed! Receipt:", receipt)
      setIsSuccess(true)
      setIsPending(false)
    } catch (err: any) {
      console.error("❌ Withdrawal failed:", err)
      
      // Check for Paymaster-related errors
      const errorMessage = err?.message || err?.toString() || "Transaction failed"
      const isPaymasterError = 
        errorMessage.includes("Paymaster") ||
        errorMessage.includes("pm_getPaymasterStubData") ||
        errorMessage.includes("api.developer.coinbase.com") ||
        errorMessage.includes("CONNECTION_TIMED_OUT") ||
        errorMessage.includes("Failed to fetch") ||
        errorMessage.includes("HTTP request failed")
      
      let userFriendlyError: Error
      if (isPaymasterError) {
        userFriendlyError = new Error(
          "Paymaster service unavailable. This might be a temporary network issue. " +
          "Please check your Privy Dashboard Paymaster configuration or try again later."
        )
      } else {
        userFriendlyError = err instanceof Error ? err : new Error(errorMessage)
      }
      
      setError(userFriendlyError)
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

