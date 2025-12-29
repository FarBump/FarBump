"use client"

import { useWriteContract, useWaitForTransactionReceipt } from "wagmi"
import { base } from "wagmi/chains"
import { parseUnits, isAddress } from "viem"

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
  const {
    writeContract,
    data: hash,
    isPending: isWriting,
    error: writeError,
    reset,
  } = useWriteContract()

  const {
    isLoading: isConfirming,
    isSuccess: isConfirmed,
    error: receiptError,
  } = useWaitForTransactionReceipt({
    hash,
    query: {
      enabled: enabled && !!hash,
    },
  })

  const withdraw = async (to: string, amount: string) => {
    // Validate address
    if (!isAddress(to)) {
      throw new Error("Invalid Ethereum address")
    }

    // Validate amount
    const amountNum = parseFloat(amount)
    if (isNaN(amountNum) || amountNum <= 0) {
      throw new Error("Invalid amount")
    }

    // Convert amount to wei
    const amountWei = parseUnits(amount, BUMP_DECIMALS)

    // Execute transfer
    writeContract({
      address: BUMP_TOKEN_ADDRESS,
      abi: ERC20_ABI,
      functionName: "transfer",
      args: [to as `0x${string}`, amountWei],
      chainId: base.id,
    })
  }

  return {
    withdraw,
    hash,
    isPending: isWriting || isConfirming,
    isSuccess: isConfirmed,
    error: writeError || receiptError,
    reset,
  }
}

