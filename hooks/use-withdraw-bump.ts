"use client"

import { useState } from "react"
import { useSmartWallets } from "@privy-io/react-auth/smart-wallets"
import { useWallets } from "@privy-io/react-auth"
import { usePublicClient } from "wagmi"
import { base } from "wagmi/chains"
import { parseUnits, isAddress, type Address, encodeFunctionData, numberToHex } from "viem"

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

      // CRITICAL: Use wallet_sendCalls with Paymaster capabilities
      // Based on Base Paymaster documentation: https://docs.base.org/base-account/improve-ux/sponsor-gas/paymasters
      // This method explicitly uses Paymaster sponsorship via wallet_sendCalls RPC method
      // Privy Smart Wallets support wallet_sendCalls with Paymaster capabilities
      
      // Validate Smart Wallet client is available
      if (!smartWalletClient) {
        throw new Error("Smart Wallet client not available. Please ensure your Smart Wallet is connected.")
      }
      
      // Validate public client is available for transaction confirmation
      if (!publicClient) {
        throw new Error("Public client not available. Please ensure Wagmi is properly configured.")
      }
      
      // Get Ethereum provider for wallet_sendCalls
      // Privy injects provider to window.ethereum or we can use provider from Smart Wallet client
      // For wallet_sendCalls, we need a provider that supports this RPC method
      let provider: any = null
      
      // Try to get provider from window.ethereum (Privy injects this)
      if (typeof window !== 'undefined' && (window as any).ethereum) {
        provider = (window as any).ethereum
      } else if (smartWalletClient && (smartWalletClient as any).transport) {
        // Try to get provider from Smart Wallet client transport
        provider = (smartWalletClient as any).transport
      } else {
        // Fallback: Try to get provider from Smart Wallet in wallets array
        const smartWallet = wallets.find(
          (w) => w.walletClientType === 'smart_wallet' || (w as any).type === 'smart_wallet'
        )
        if (smartWallet && (smartWallet as any).provider) {
          provider = (smartWallet as any).provider
        }
      }
      
      if (!provider || !provider.request) {
        throw new Error("Ethereum provider not available. Please ensure your Smart Wallet is connected.")
      }
      
      // Get Paymaster service URL from environment or use Privy's configured Paymaster
      // Note: If Paymaster is configured in Privy Dashboard, Privy will handle it automatically
      // But we can also explicitly pass the Paymaster URL if needed
      // If not provided, Privy will use the Paymaster configured in Dashboard
      const paymasterServiceUrl = process.env.NEXT_PUBLIC_PAYMASTER_SERVICE_URL || undefined
      
      // Prepare the transaction call according to Base Paymaster documentation
      // Format: { to, value, data }
      const calls = [
        {
          to: BUMP_TOKEN_ADDRESS as Address,
          value: '0x0' as `0x${string}`,
          data: data as `0x${string}`,
        }
      ]
      
      console.log("🔄 Using wallet_sendCalls with Paymaster sponsorship:")
      console.log("  - Method: wallet_sendCalls")
      console.log("  - Chain ID:", base.id)
      console.log("  - From:", walletAddress)
      console.log("  - To:", BUMP_TOKEN_ADDRESS)
      console.log("  - Paymaster Service URL:", paymasterServiceUrl || "Using Privy Dashboard config")
      
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
          
          // Use wallet_sendCalls with Paymaster capabilities
          // Based on Base Paymaster docs: https://docs.base.org/base-account/improve-ux/sponsor-gas/paymasters
          const result = await provider.request({
            method: 'wallet_sendCalls',
            params: [{
              version: '1.0',
              chainId: numberToHex(base.id),
              from: walletAddress as Address,
              calls: calls,
              capabilities: paymasterServiceUrl ? {
                paymasterService: {
                  url: paymasterServiceUrl
                }
              } : undefined, // If not provided, Privy will use Dashboard Paymaster config
            }]
          })
          
          // Extract transaction hash from result
          // wallet_sendCalls returns an object with transaction identifiers
          if (result && typeof result === 'object') {
            // The result should contain transaction hash(es)
            // For single transaction, it might be in result[0] or result.hash
            txHash = (result as any).hash || (result as any)[0] || (Array.isArray(result) ? result[0] : null)
            if (!txHash) {
              // If hash is not directly available, try to get it from the result structure
              console.log("⚠️ Transaction result structure:", result)
              // For wallet_sendCalls, the result might be a string or an array
              txHash = (typeof result === 'string' ? result : null) as `0x${string}` | null
            }
          } else if (typeof result === 'string') {
            txHash = result as `0x${string}`
          }
          
          if (!txHash) {
            throw new Error("Failed to extract transaction hash from wallet_sendCalls result")
          }
          
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

