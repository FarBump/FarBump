"use client"

import { useState } from "react"
import { useSmartWallets } from "@privy-io/react-auth/smart-wallets"
import { usePublicClient } from "wagmi"
import { parseUnits, type Address, encodeFunctionData, type Hex } from "viem"
import {
  BUMP_TOKEN_ADDRESS,
  BASE_WETH_ADDRESS,
  PERMIT2_ADDRESS,
  BUMP_DECIMALS,
  TREASURY_FEE_BPS,
} from "@/lib/constants"

const PERMIT2_ABI = [
  {
    inputs: [
      { name: "token", type: "address" },
      { name: "spender", type: "address" },
      { name: "amount", type: "uint160" },
      { name: "expiration", type: "uint48" },
    ],
    name: "approve",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const

const MAX_UINT160 = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF")
const MAX_UINT48 = 281474976710655

export function useConvertFuel() {
  const { client: smartWalletClient } = useSmartWallets()
  const publicClient = usePublicClient()
  
  const [hash, setHash] = useState<Hex | null>(null)
  const [isPending, setIsPending] = useState(false)
  const [isSuccess, setIsSuccess] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const [swapStatus, setSwapStatus] = useState<string>("")

  // --- Fungsi Internal untuk Quote ---
  const get0xQuote = async (
    sellToken: Address,
    buyToken: Address,
    sellAmountWei: bigint,
    takerAddress: Address,
    slippage: number = 3
  ) => {
    const params = new URLSearchParams({
      sellToken,
      buyToken,
      sellAmount: sellAmountWei.toString(),
      takerAddress,
      slippagePercentage: slippage.toString(),
    })
    const res = await fetch(`/api/0x-quote?${params.toString()}`)
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || "Gagal ambil quote")
    return data
  }

  // --- Fungsi Utama yang dipanggil ConfigPanel ---
  const convert = async (amount: string) => {
    setIsPending(true)
    setIsSuccess(false)
    setError(null)
    setSwapStatus("Mempersiapkan transaksi...")

    try {
      if (!smartWalletClient || !publicClient) throw new Error("Wallet tidak terhubung")

      const userAddress = smartWalletClient.account.address as Address
      const totalAmountWei = parseUnits(amount, BUMP_DECIMALS)
      const treasuryFeeWei = (totalAmountWei * BigInt(TREASURY_FEE_BPS)) / BigInt(10000)
      const swapAmountWei = totalAmountWei - treasuryFeeWei

      // Ambil rute swap dari 0x
      const quote = await get0xQuote(BUMP_TOKEN_ADDRESS as Address, BASE_WETH_ADDRESS as Address, swapAmountWei, userAddress)

      // Jalankan Permit2 + Swap dalam satu Batch
      const txHash = await smartWalletClient.sendTransaction({
        calls: [
          {
            to: PERMIT2_ADDRESS as Address,
            data: encodeFunctionData({
              abi: PERMIT2_ABI,
              functionName: "approve",
              args: [BUMP_TOKEN_ADDRESS as Address, quote.transaction.to as Address, MAX_UINT160, MAX_UINT48],
            }),
          },
          {
            to: quote.transaction.to as Address,
            data: quote.transaction.data as Hex,
            value: BigInt(quote.transaction.value || "0"),
          }
        ] as any
      })

      setHash(txHash)
      setIsSuccess(true)
      return txHash
    } catch (err: any) {
      setError(err)
      throw err
    } finally {
      setIsPending(false)
    }
  }

  // --- Mock Functions agar ConfigPanel tidak Error ---
  // Karena kita menggunakan Batch Call, kita tidak butuh step approve terpisah.
  // Tapi ConfigPanel memanggilnya, jadi kita buat fungsi "kosong" yang langsung sukses.
  const approve = async (amount: string) => {
    console.log("Batch mode: Approval will be handled inside convert().")
    return true 
  }

  const reset = () => {
    setHash(null)
    setIsPending(false)
    setIsSuccess(false)
    setError(null)
  }

  return { 
    convert, 
    approve, // Dibutuhkan oleh ConfigPanel
    reset,
    hash, 
    approvalHash: null, // Dibutuhkan oleh ConfigPanel (null karena batch)
    isPending, 
    isApproving: false, // Dibutuhkan oleh ConfigPanel
    isSuccess, 
    error, 
    swapStatus 
  }
}
