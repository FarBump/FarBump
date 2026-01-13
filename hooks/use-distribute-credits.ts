"use client"

import { useState, useCallback } from "react"
import { useSmartWallets } from "@privy-io/react-auth/smart-wallets"
import { usePublicClient } from "wagmi"
import { formatEther, getAddress, parseEther, type Address, type Hex } from "viem"
import { base } from "viem/chains"
import { toast } from "sonner"

interface BotWallet {
  smartWalletAddress: string
  ownerAddress?: string
  network?: string
}

interface DistributeCreditsParams {
  userAddress: Address
  botWallets: BotWallet[]
  creditBalanceWei: bigint
}

const ESTIMATED_GAS_PER_TRANSFER = BigInt(35000)
const SMART_ACCOUNT_DEPLOYMENT_GAS = BigInt(300000)

export function useDistributeCredits() {
  const { client: smartWalletClient } = useSmartWallets()
  const publicClient = usePublicClient()
  
  const privySmartWalletAddress = smartWalletClient?.account?.address as Address | undefined
  
  const [hash, setHash] = useState<`0x${string}` | null>(null)
  const [isPending, setIsPending] = useState(false)
  const [isSuccess, setIsSuccess] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const [status, setStatus] = useState<string | null>(null)

  const reset = useCallback(() => {
    setHash(null)
    setIsPending(false)
    setIsSuccess(false)
    setError(null)
    setStatus(null)
  }, [])

  const checkSmartAccountDeployed = useCallback(async (address: Address): Promise<boolean> => {
    try {
      const code = await publicClient.getCode({ address })
      return code !== undefined && code !== "0x" && code.length > 2
    } catch {
      return false
    }
  }, [publicClient])

  const estimateGasCost = useCallback(async (
    numTransfers: number,
    isDeployed: boolean
  ): Promise<bigint> => {
    try {
      const gasPrice = await publicClient.getGasPrice()
      let totalGasUnits = ESTIMATED_GAS_PER_TRANSFER * BigInt(numTransfers)
      
      if (!isDeployed) {
        totalGasUnits += SMART_ACCOUNT_DEPLOYMENT_GAS
      }
      
      const gasWithBuffer = (totalGasUnits * BigInt(150)) / BigInt(100)
      return gasWithBuffer * gasPrice
    } catch (err) {
      return parseEther("0.001")
    }
  }, [publicClient])

  const distribute = useCallback(async ({ 
    userAddress, 
    botWallets, 
    creditBalanceWei 
  }: DistributeCreditsParams) => {
    reset()
    setIsPending(true)

    try {
      if (!smartWalletClient || !privySmartWalletAddress) {
        throw new Error("Smart Wallet client not found. Please login again.")
      }

      const smartWalletAddress = userAddress.toLowerCase() === privySmartWalletAddress.toLowerCase()
        ? privySmartWalletAddress
        : (userAddress as Address)

      if (!botWallets || botWallets.length !== 5) {
        throw new Error(`Expected 5 bot wallets, but found ${botWallets?.length || 0}`)
      }

      setStatus("Checking balance & status...")
      const isDeployed = await checkSmartAccountDeployed(smartWalletAddress)
      const walletBalance = await publicClient.getBalance({ address: smartWalletAddress })

      // Fetch Credit from DB
      const creditResponse = await fetch("/api/credit-balance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userAddress }),
      })
      
      const creditData = await creditResponse.json()
      const mainWalletCreditWei = BigInt(creditData.mainWalletCreditWei || "0")

      if (mainWalletCreditWei <= BigInt(0)) {
        throw new Error("No credit available in main wallet.")
      }

      const estimatedGasCost = await estimateGasCost(5, isDeployed)
      const availableForDistribution = walletBalance > estimatedGasCost 
        ? walletBalance - estimatedGasCost
        : BigInt(0)

      if (availableForDistribution <= BigInt(0)) {
        throw new Error(`Insufficient ETH for gas. Need ~${formatEther(estimatedGasCost)} ETH.`)
      }

      const creditToDistribute = availableForDistribution < mainWalletCreditWei
        ? availableForDistribution
        : mainWalletCreditWei

      const amountPerBot = creditToDistribute / BigInt(5)
      const remainder = creditToDistribute % BigInt(5)
      const amountForFirstBot = amountPerBot + remainder

      // Prepare Calls
      const calls = botWallets.map((wallet, index) => ({
        to: getAddress(wallet.smartWalletAddress) as Address,
        value: index === 0 ? amountForFirstBot : amountPerBot,
        data: "0x" as Hex,
      }))

      // =============================================
      // STEP 10: Execute Batch Transaction (FIXED)
      // =============================================
      setStatus("Awaiting signature...")
      
      /**
       * UNTUK MENGHINDARI ResourceUnavailableRpcError:
       * 1. Hapus parameter 'isSponsored' karena ini memicu call ke Paymaster.
       * 2. Gunakan 'capabilities: {}' untuk memberi tahu SDK agar tidak menggunakan Paymaster.
       * 3. Kirim sebagai transaksi batch native.
       */
      const txHash = await smartWalletClient.sendTransaction({
        account: smartWalletClient.account,
        calls: calls,
        chain: base,
        capabilities: {}, // Explicitly bypass paymaster capabilities
      }) as `0x${string}`

      setHash(txHash)
      setStatus("Confirming on blockchain...")

      const receipt = await publicClient.waitForTransactionReceipt({
        hash: txHash,
        confirmations: 1,
      })

      if (receipt.status !== "success") throw new Error("Transaction failed on-chain")

      // Record to DB
      setStatus("Recording distribution...")
      const distributions = botWallets.map((wallet, index) => ({
        botWalletAddress: wallet.smartWalletAddress,
        amountWei: (index === 0 ? amountForFirstBot : amountPerBot).toString(),
      }))

      await fetch("/api/bot/record-distribution", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userAddress,
          distributions,
          txHash,
        }),
      })

      setIsSuccess(true)
      setStatus("Success!")
      toast.success("Distributed successfully!")

      return { success: true, txHash }

    } catch (err: any) {
      console.error("❌ Distribution failed:", err)
      setError(err)
      
      let msg = err.message || "Distribution failed"
      if (msg.includes("ResourceUnavailable") || msg.includes("allowlist")) {
        msg = "Wallet RPC error. Ensure you have ETH in your Smart Account to pay for gas."
      }

      toast.error("Failed", { description: msg })
      throw err
    } finally {
      setIsPending(false)
    }
  }, [smartWalletClient, privySmartWalletAddress, publicClient, checkSmartAccountDeployed, estimateGasCost, reset])

  return { distribute, hash, isPending, isSuccess, error, status, reset }
}
