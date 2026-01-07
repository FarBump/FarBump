"use client"

import { useState } from "react"
import { useSmartWallets } from "@privy-io/react-auth/smart-wallets"
import { usePublicClient } from "wagmi"
import { parseUnits, type Address, encodeFunctionData, type Hex } from "viem"
import {
  BUMP_TOKEN_ADDRESS,
  BUMP_DECIMALS,
} from "@/lib/constants"

// Alamat Spender Resmi 0x v2 (AllowanceHolder) untuk jaringan Base
const ZEROX_ALLOWANCE_HOLDER = "0x0000000000001fF3684f28c67538d4D072C22734";

const ERC20_ABI = [
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
] as const;

export function useConvertFuel() {
  const { client: smartWalletClient } = useSmartWallets()
  const publicClient = usePublicClient()
  
  const [hash, setHash] = useState<Hex | null>(null)
  const [isPending, setIsPending] = useState(false)
  const [isSuccess, setIsSuccess] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  const get0xQuote = async (sellAmountWei: bigint, taker: Address) => {
    // Kita tidak perlu lagi mengirim buyToken dari sini 
    // karena backend sudah memaksanya menjadi "ETH"
    const params = new URLSearchParams({
      sellToken: BUMP_TOKEN_ADDRESS,
      sellAmount: sellAmountWei.toString(),
      takerAddress: taker,
    });

    const res = await fetch(`/api/0x-quote?${params.toString()}`);
    const data = await res.json();
    
    if (!res.ok) {
      throw new Error(data.error || data.reason || "Gagal mendapatkan rute swap");
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
      const swapAmountWei = parseUnits(amount, BUMP_DECIMALS);

      // 1. Ambil Quote (Backend akan mengembalikan data swap untuk Native ETH)
      const quote = await get0xQuote(swapAmountWei, userAddress);

      // 2. Batch Transaction melalui Coinbase Paymaster
      // Call 1: Approve $BUMP ke 0x AllowanceHolder
      // Call 2: Execute Swap (Native ETH akan masuk ke dompet user)
      const txHash = await smartWalletClient.sendTransaction({
        calls: [
          {
            to: BUMP_TOKEN_ADDRESS as Address,
            data: encodeFunctionData({
              abi: ERC20_ABI,
              functionName: "approve",
              args: [ZEROX_ALLOWANCE_HOLDER as Address, swapAmountWei],
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
      console.error("Convert Flow Error:", err);
      setError(err);
      throw err;
    } finally {
      setIsPending(false);
    }
  }

  const reset = () => {
    setHash(null);
    setIsPending(false);
    setIsSuccess(false);
    setError(null);
  }

  return { 
    convert, 
    reset,
    hash, 
    isPending, 
    isSuccess, 
    error,
    approve: async () => true,
    isApproving: false,
    approvalHash: null
  }
}
