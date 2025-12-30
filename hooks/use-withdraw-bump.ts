"use client"

import { useState } from "react"
import { useSmartWallets } from "@privy-io/react-auth/smart-wallets"
import { usePublicClient } from "wagmi"
import { parseUnits, isAddress, type Address, encodeFunctionData } from "viem"

// Konfigurasi Token
const BUMP_TOKEN_ADDRESS = "0x94ce728849431818ec9a0cf29bdb24fe413bbb07" as const
const BUMP_DECIMALS = 18

// ABI minimal untuk transfer ERC20
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
    setError(null)

    try {
      // 1. Validasi Dasar
      if (!smartWalletClient) {
        throw new Error("Smart Wallet belum siap. Pastikan Anda sudah login.")
      }

      if (!isAddress(to)) {
        throw new Error("Alamat tujuan tidak valid.")
      }

      const amountNum = parseFloat(amount)
      if (isNaN(amountNum) || amountNum <= 0) {
        throw new Error("Jumlah transfer harus lebih dari 0.")
      }

      // 2. Persiapkan Data Transaksi
      const amountWei = parseUnits(amount, BUMP_DECIMALS)
      const callData = encodeFunctionData({
        abi: ERC20_ABI,
        functionName: "transfer",
        args: [to as Address, amountWei],
      })

      console.log("🚀 Menyiapkan transaksi gasless...")

      /**
       * 3. Eksekusi menggunakan Ethereum Provider (EIP-1193)
       * Ini adalah metode paling stabil untuk memicu Paymaster/Sponsorship
       * melalui infrastruktur Privy.
       */
      const provider = await smartWalletClient.getEthereumProvider()
      
      const txHash = await provider.request({
        method: 'eth_sendTransaction',
        params: [{
          from: smartWalletClient.account.address,
          to: BUMP_TOKEN_ADDRESS,
          data: callData,
          value: '0x0', // Penting: harus string hex untuk provider.request
        }],
      })

      console.log("✅ Transaksi terkirim! Hash:", txHash)
      setHash(txHash as `0x${string}`)

      // 4. Tunggu Konfirmasi di Blockchain
      if (publicClient) {
        console.log("⏳ Menunggu konfirmasi jaringan Base...")
        const receipt = await publicClient.waitForTransactionReceipt({ 
          hash: txHash as `0x${string}` 
        })
        console.log("🎉 Berhasil! Receipt:", receipt)
      }

      setIsSuccess(true)
    } catch (err: any) {
      console.error("❌ Withdrawal Failed:", err)

      // Mapping error agar user paham apa yang terjadi
      let message = err.message || "Terjadi kesalahan saat withdraw."
      
      if (message.includes("User rejected")) {
        message = "Transaksi dibatalkan oleh pengguna."
      } else if (message.includes("timeout") || message.includes("fetch")) {
        message = "Koneksi ke layanan Gas (Paymaster) lambat. Pastikan domain Anda sudah terdaftar di Coinbase CDP dan coba lagi."
      } else if (message.includes("insufficient funds")) {
        message = "Saldo gas tidak mencukupi atau Paymaster menolak transaksi ini."
      }

      setError(new Error(message))
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
