"use client"

import { useState } from "react"
import { useSmartWallets } from "@privy-io/react-auth/smart-wallets"
import { usePublicClient } from "wagmi"
import { parseUnits, type Address, encodeFunctionData, encodeAbiParameters, type Hex } from "viem"
import {
  BUMP_TOKEN_ADDRESS,
  TREASURY_ADDRESS,
  BASE_WETH_ADDRESS,
  PERMIT2_ADDRESS,
  BUMP_DECIMALS,
  TREASURY_FEE_BPS,
  APP_FEE_BPS,
  USER_CREDIT_BPS,
} from "@/lib/constants"

interface ZeroXQuoteResponse {
  transaction: {
    to: string
    data: string
    value: string
  }
  price: string
  buyAmount: string
  estimatedPriceImpact: string
}

const ERC20_ABI = [
  {
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    name: "allowance",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    name: "approve",
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const

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
  
  const [isPending, setIsPending] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const [swapStatus, setSwapStatus] = useState<string>("")

  const get0xQuote = async (
    sellToken: Address,
    buyToken: Address,
    sellAmountWei: bigint,
    takerAddress: Address,
    slippagePercentage: number = 3,
    retryWithHighSlippage: boolean = true
  ): Promise<ZeroXQuoteResponse> => {
    
    const queryParams = new URLSearchParams({
      sellToken,
      buyToken,
      sellAmount: sellAmountWei.toString(),
      takerAddress,
      slippagePercentage: slippagePercentage.toString(), // Kirim "3" atau "20"
    })

    const url = `${window.location.origin}/api/0x-quote?${queryParams.toString()}`
    
    console.log(`📡 Fetching 0x Quote: ${slippagePercentage}% slippage`)

    const response = await fetch(url)
    const data = await response.json()

    if (!response.ok) {
      if (response.status === 400 && retryWithHighSlippage) {
        console.warn("⚠️ Liquidity low, retrying with 20% slippage...")
        setSwapStatus("Optimizing route for low liquidity (20% slippage)...")
        return get0xQuote(sellToken, buyToken, sellAmountWei, takerAddress, 20, false)
      }
      throw new Error(data.error || "Failed to fetch swap quote")
    }

    return data
  }

  const convert = async (amount: string) => {
    setIsPending(true)
    setError(null)
    setSwapStatus("Starting conversion...")

    try {
      if (!smartWalletClient || !publicClient) throw new Error("Wallet not connected")

      const userAddress = smartWalletClient.account.address as Address
      const totalAmountWei = parseUnits(amount, BUMP_DECIMALS)
      const treasuryFeeWei = (totalAmountWei * BigInt(TREASURY_FEE_BPS)) / BigInt(10000)
      const swapAmountWei = totalAmountWei - treasuryFeeWei

      // 1. Cek Allowance ke Permit2
      setSwapStatus("Checking allowance...")
      const allowance = await publicClient.readContract({
        address: BUMP_TOKEN_ADDRESS as Address,
        abi: ERC20_ABI,
        functionName: "allowance",
        args: [userAddress, PERMIT2_ADDRESS as Address],
      })

      if (allowance < totalAmountWei) {
        throw new Error("Please approve BUMP tokens first.")
      }

      // 2. Ambil Quote (Otomatis retry 20% jika liquidity rendah)
      setSwapStatus("Fetching best route...")
      const quote = await get0xQuote(
        BUMP_TOKEN_ADDRESS as Address,
        BASE_WETH_ADDRESS as Address,
        swapAmountWei,
        userAddress,
        3
      )

      // 3. Bangun Transaksi (Batch)
      setSwapStatus("Preparing transaction...")
      
      // Approval Permit2 untuk Settler Contract 0x
      const permit2Approval = {
        to: PERMIT2_ADDRESS as Address,
        data: encodeFunctionData({
          abi: PERMIT2_ABI,
          functionName: "approve",
          args: [BUMP_TOKEN_ADDRESS as Address, quote.transaction.to as Address, MAX_UINT160, MAX_UINT48],
        }),
        value: BigInt(0),
      }

      // Transaksi Swap dari 0x
      const swapTx = {
        to: quote.transaction.to as Address,
        data: quote.transaction.data as Hex,
        value: BigInt(quote.transaction.value || "0"),
      }

      // Eksekusi Batch
      setSwapStatus("Waiting for signature...")
      const txHash = await smartWalletClient.sendTransaction({
        calls: [permit2Approval, swapTx] as any,
      })

      console.log("✅ Swap success:", txHash)
      setSwapStatus("Conversion successful!")
      return txHash

    } catch (err: any) {
      console.error("❌ Convert error:", err)
      setError(err)
      setSwapStatus("")
    } finally {
      setIsPending(false)
    }
  }

  return { convert, isPending, error, swapStatus }
}
