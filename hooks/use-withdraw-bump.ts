"use client"

import { useState } from "react"
import { useSmartWallets } from "@privy-io/react-auth/smart-wallets"
import { useWallets } from "@privy-io/react-auth" // Tambahkan ini
import { usePublicClient } from "wagmi"
import { parseUnits, isAddress, type Address, encodeFunctionData } from "viem"

const BUMP_TOKEN_ADDRESS = "0x94ce728849431818ec9a0cf29bdb24fe413bbb07" as const
const BUMP_DECIMALS = 18

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
  const { wallets } = useWallets() // Ambil daftar wallet
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
      if (!smartWalletClient) throw new Error("Smart Wallet belum siap.")
      if (!isAddress(to)) throw new Error("Alamat tujuan tidak valid.")

      // 1. Cari wallet yang sesuai dengan smartWalletClient
      const wallet = wallets.find((w) => w.address === smartWalletClient.account.address) || wallets[0];
      if (!wallet) throw new Error("Wallet provider tidak ditemukan.");

      const amountWei = parseUnits(amount, BUMP_DECIMALS)
      const callData = encodeFunctionData({
        abi: ERC20_ABI,
        functionName: "transfer",
        args: [to as Address, amountWei],
      })

      console.log("🚀 Menggunakan provider dari:", wallet.address);

      // 2. Dapatkan provider dengan cara yang lebih kompatibel
      const provider = await wallet.getEthereumProvider();
      
      // 3. Kirim Transaksi
      const txHash = await provider.request({
        method: 'eth_sendTransaction',
        params: [{
          from: smartWalletClient.account.address as `0x${string}`,
          to: BUMP_TOKEN_ADDRESS,
          data: callData,
          value: '0x0',
        }],
      })

      console.log("✅ Transaksi terkirim! Hash:", txHash)
      setHash(txHash as `0x${string}`)

      if (publicClient) {
        await publicClient.waitForTransactionReceipt({ hash: txHash as `0x${string}` })
      }

      setIsSuccess(true)
    } catch (err: any) {
      console.error("❌ Withdrawal Error:", err)
      setError(new Error(err.message || "Withdrawal failed"))
    } finally {
      setIsPending(false)
    }
  }

  return { withdraw, hash, isPending, isSuccess, error, reset }
}
