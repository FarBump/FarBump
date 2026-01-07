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

  const get0xQuote = async (sellAmountWei: bigint, taker: Address) => {
    const params = new URLSearchParams({
      sellToken: BUMP_TOKEN_ADDRESS,
      buyToken: BASE_WETH_ADDRESS,
      sellAmount: sellAmountWei.toString(),
      takerAddress: taker,
    });

    const res = await fetch(`/api/0x-quote?${params.toString()}`);
    const data = await res.json();
    
    if (!res.ok) {
      throw new Error(data.message || data.reason || "Gagal mengambil rute swap v4");
    }
    return data;
  }

  const convert = async (amount: string) => {
    setIsPending(true)
    setIsSuccess(false)
    setError(null)

    try {
      if (!smartWalletClient || !publicClient) throw new Error("Wallet tidak terhubung");

      const userAddress = smartWalletClient.account.address as Address;
      const totalAmountWei = parseUnits(amount, BUMP_DECIMALS);
      
      // Hitung fee treasury
      const treasuryFeeWei = (totalAmountWei * BigInt(TREASURY_FEE_BPS)) / BigInt(10000);
      const swapAmountWei = totalAmountWei - treasuryFeeWei;

      // 1. Ambil Quote v2 (Uniswap v4 support)
      const quote = await get0xQuote(swapAmountWei, userAddress);

      // 2. Kirim Batch Transaction (Permit2 + Swap)
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
      });

      setHash(txHash);
      setIsSuccess(true);
      return txHash;
    } catch (err: any) {
      console.error("Convert Error:", err);
      setError(err);
      throw err;
    } finally {
      setIsPending(false);
    }
  }

  // Mock function untuk ConfigPanel agar flow UI tidak rusak
  const approve = async () => {
    console.log("Uniswap v4: Approval handled via Permit2 in Batch.");
    return true;
  }

  const reset = () => {
    setHash(null);
    setIsPending(false);
    setIsSuccess(false);
    setError(null);
  }

  return { 
    convert, 
    approve, 
    reset,
    hash, 
    approvalHash: null,
    isPending, 
    isApproving: false, 
    isSuccess, 
    error 
  }
}
