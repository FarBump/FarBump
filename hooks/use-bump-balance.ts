"use client"

import { useReadContract } from "wagmi"
import { base } from "wagmi/chains"
import { formatUnits } from "viem"

// $BUMP Token Contract Address on Base Network
const BUMP_TOKEN_ADDRESS = "0x94ce728849431818ec9a0cf29bdb24fe413bbb07" as const
const BUMP_DECIMALS = 18

// ERC20 ABI for balanceOf function
const ERC20_ABI = [
  {
    inputs: [{ name: "account", type: "address" }],
    name: "balanceOf",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const

interface UseBumpBalanceProps {
  address: string | null | undefined
  enabled?: boolean
}

export function useBumpBalance({ address, enabled = true }: UseBumpBalanceProps) {
  const { data, isLoading, error, refetch } = useReadContract({
    address: BUMP_TOKEN_ADDRESS,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: address ? [address as `0x${string}`] : undefined,
    chainId: base.id,
    query: {
      enabled: enabled && !!address && address !== "0x000...000",
      refetchInterval: 30000, // Refetch every 30 seconds
    },
  })

  // Format balance from wei to readable format
  const balance = data ? formatUnits(data, BUMP_DECIMALS) : "0"
  const formattedBalance = parseFloat(balance).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  })

  return {
    balance: data ? BigInt(data.toString()) : 0n,
    formattedBalance,
    isLoading,
    error,
    refetch,
  }
}






