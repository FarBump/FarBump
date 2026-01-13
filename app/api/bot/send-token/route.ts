import { NextRequest, NextResponse } from "next/server"
import { formatEther, isAddress, type Address, type Hex, createPublicClient, http, encodeFunctionData } from "viem"
import { base } from "viem/chains"
import { createSupabaseServiceClient } from "@/lib/supabase"
import { CdpClient } from "@coinbase/cdp-sdk"
import "dotenv/config"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

// ERC20 ABI for transfer and balanceOf
const ERC20_ABI = [
  {
    constant: true,
    inputs: [{ name: "_owner", type: "address" }],
    name: "balanceOf",
    outputs: [{ name: "balance", type: "uint256" }],
    type: "function",
  },
  {
    constant: false,
    inputs: [
      { name: "_to", type: "address" },
      { name: "_value", type: "uint256" },
    ],
    name: "transfer",
    outputs: [{ name: "", type: "bool" }],
    type: "function",
  },
] as const

// Public client for balance checks
const publicClient = createPublicClient({
  chain: base,
  transport: http(process.env.NEXT_PUBLIC_BASE_RPC_URL),
})

/**
 * API Route: Send Token from Bot Wallet using CDP Paymaster
 * 
 * This endpoint sends tokens from a bot Smart Wallet to a recipient address
 * using CDP Paymaster with Sender-based sponsorship (gasless).
 * 
 * Flow:
 * 1. Validate inputs
 * 2. Fetch bot wallet from database
 * 3. Check token balance
 * 4. Use CDP SDK to execute transfer via Smart Account
 * 5. Return transaction hash
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const {
      botWalletAddress,
      tokenAddress,
      recipientAddress,
      amountWei,
      decimals,
      symbol,
    } = body as {
      botWalletAddress: string
      tokenAddress: string
      recipientAddress: string
      amountWei: string
      decimals: number
      symbol: string
    }

    if (!botWalletAddress || !tokenAddress || !recipientAddress || !amountWei) {
      return NextResponse.json(
        { error: "Missing required fields: botWalletAddress, tokenAddress, recipientAddress, amountWei" },
        { status: 400 }
      )
    }

    if (!isAddress(botWalletAddress) || !isAddress(tokenAddress) || !isAddress(recipientAddress)) {
      return NextResponse.json(
        { error: "Invalid address format" },
        { status: 400 }
      )
    }

    const supabase = createSupabaseServiceClient()

    // Find bot wallet in database
    const { data: botWallet, error: walletError } = await supabase
      .from("wallets_data")
      .select("smart_account_address, owner_address")
      .eq("smart_account_address", botWalletAddress.toLowerCase())
      .single()

    if (walletError || !botWallet) {
      return NextResponse.json(
        { error: "Bot wallet not found in database" },
        { status: 404 }
      )
    }

    const smartAccountAddress = botWallet.smart_account_address as Address
    const ownerAddress = botWallet.owner_address as Address

    console.log(`📤 Sending ${amountWei} (${symbol}) from ${smartAccountAddress} to ${recipientAddress}...`)

    // Check token balance
    const balance = await publicClient.readContract({
      address: tokenAddress as Address,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [smartAccountAddress],
    })

    const balanceBigInt = BigInt(balance.toString())
    const amountBigInt = BigInt(amountWei)

    if (balanceBigInt < amountBigInt) {
      return NextResponse.json(
        {
          error: "Insufficient token balance",
          balance: balanceBigInt.toString(),
          required: amountWei,
        },
        { status: 400 }
      )
    }

    // Initialize CDP Client
    const apiKeyId = process.env.CDP_API_KEY_ID
    const apiKeySecret = process.env.CDP_API_KEY_SECRET

    if (!apiKeyId || !apiKeySecret) {
      return NextResponse.json(
        { error: "CDP credentials not configured" },
        { status: 500 }
      )
    }

    const cdp = new CdpClient()
    console.log(`✅ CDP Client initialized`)

    // Get Owner Account and Smart Account
    const ownerAccount = await cdp.evm.getAccount({ address: ownerAddress })
    if (!ownerAccount) {
      throw new Error("Failed to get Owner Account from CDP")
    }

    const smartAccount = await cdp.evm.getSmartAccount({
      owner: ownerAccount,
      address: smartAccountAddress,
    })

    if (!smartAccount) {
      throw new Error("Failed to get Smart Account from CDP")
    }

    // Encode transfer function call
    const transferData = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: "transfer",
      args: [recipientAddress as Address, amountBigInt],
    })

    // Execute transfer via Smart Account (gasless via CDP Paymaster)
    console.log(`🚀 Executing token transfer (gasless via CDP Paymaster)...`)

    const transactionCall = {
      to: tokenAddress as Address,
      data: transferData as Hex,
      value: BigInt(0), // Token transfer, no ETH value
    }

    const network = "base"

    // Use Smart Account sendUserOperation
    const userOpHash = await (smartAccount as any).sendUserOperation({
      network: network,
      calls: [transactionCall],
      isSponsored: true, // Enable gas sponsorship via CDP Paymaster
    })

    console.log(`✅ User Operation submitted: ${userOpHash}`)

    // Wait for confirmation
    const userOpReceipt = await (smartAccount as any).waitForUserOperation({
      network: network,
      hash: userOpHash,
    })

    // Extract transaction hash
    let txHash: string | null = null
    if (typeof userOpReceipt === "string") {
      txHash = userOpReceipt
    } else if (userOpReceipt?.transactionHash) {
      txHash = userOpReceipt.transactionHash
    } else if (userOpReceipt?.hash) {
      txHash = userOpReceipt.hash
    } else if (userOpReceipt?.receipt?.transactionHash) {
      txHash = userOpReceipt.receipt.transactionHash
    } else {
      // Fallback: try to get from getUserOperation
      try {
        const userOp = await (smartAccount as any).getUserOperation({
          network: network,
          hash: userOpHash,
        })
        txHash = userOp?.transactionHash || userOp?.hash || userOpHash
      } catch (err) {
        console.warn("Failed to get transaction hash from getUserOperation:", err)
        txHash = userOpHash // Use userOpHash as fallback
      }
    }

    if (!txHash) {
      throw new Error("Failed to extract transaction hash from user operation receipt")
    }

    console.log(`✅ Token transfer completed! Transaction hash: ${txHash}`)

    return NextResponse.json({
      success: true,
      txHash,
      message: `Successfully sent ${amountWei} ${symbol} to ${recipientAddress}`,
    })
  } catch (error: any) {
    console.error("❌ Error in send-token API:", error)
    return NextResponse.json(
      {
        error: "Internal server error",
        details: error.message,
        stack: process.env.NODE_ENV === "development" ? error.stack : undefined,
      },
      { status: 500 }
    )
  }
}

