"use client"

import { useState } from "react"
import { useSmartWallets } from "@privy-io/react-auth/smart-wallets"
import { usePublicClient } from "wagmi"
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

export function useWithdrawBump() {
  const { client: smartWalletClient } = useSmartWallets()
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
    reset()
    setIsPending(true)

    try {
      // 1. Validasi Smart Wallet
      if (!smartWalletClient) {
        throw new Error("Smart Wallet client not found. Please login again.")
      }

      // 2. Validasi Alamat & Amount
      if (!isAddress(to)) throw new Error("Invalid destination address")
      const amountNum = parseFloat(amount)
      if (isNaN(amountNum) || amountNum <= 0) throw new Error("Invalid amount")

      // 3. Encode Data Transaksi
      const amountWei = parseUnits(amount, BUMP_DECIMALS)
      const data = encodeFunctionData({
        abi: ERC20_ABI,
        functionName: "transfer",
        args: [to as Address, amountWei],
      })

      console.log("🚀 Starting Gasless Withdrawal...")
      console.log(`📍 Destination: ${to}`)
      console.log(`💰 Amount: ${amount} $BUMP`)

      /**
       * CRITICAL: Menggunakan smartWalletClient.sendTransaction
       * Privy akan otomatis mendeteksi konfigurasi Paymaster di Dashboard
       * dan mengirimkan ini sebagai Sponsored User Operation.
       */
      const txHash = await smartWalletClient.sendTransaction({
        to: BUMP_TOKEN_ADDRESS,
        data: data,
        value: BigInt(0),
      })

      console.log("✅ Transaction Sent! Hash:", txHash)
      setHash(txHash)

      // 4. Tunggu Konfirmasi Transaksi
      if (publicClient) {
        console.log("⏳ Waiting for on-chain confirmation...")
        const receipt = await publicClient.waitForTransactionReceipt({ 
          hash: txHash 
        })
        console.log("🎉 Transaction Confirmed:", receipt)
      }

      setIsSuccess(true)
    } catch (err: any) {
      console.error("❌ Withdrawal Error:", err)
      
      // Menangani pesan error umum agar lebih user-friendly
      let friendlyMessage = err.message || "Transaction failed"
      if (friendlyMessage.includes("insufficient funds")) {
        friendlyMessage = "Insufficient ETH for gas. Check if Paymaster is correctly configured in Privy Dashboard."
      } else if (friendlyMessage.includes("Failed to fetch")) {
        friendlyMessage = "Network error. Please check your internet or Coinbase CDP domain whitelist."
      }

      setError(new Error(friendlyMessage))
    } finally {
      setIsPending(false)
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
