import { NextRequest, NextResponse } from "next/server"
import { createSupabaseServiceClient } from "@/lib/supabase"
import { decryptPrivateKey } from "@/lib/bot-encryption"
import { privateKeyToSimpleSmartAccount } from "permissionless/accounts"
import { createSmartAccountClient, createBundlerClient } from "permissionless"
import { createPublicClient, http, type Address, type Hex } from "viem"
import { base } from "viem/chains"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const ZEROX_API_KEY = process.env.ZEROX_API_KEY
if (!ZEROX_API_KEY) {
  throw new Error("ZEROX_API_KEY environment variable is not set")
}

// Initialize public client for Base
const publicClient = createPublicClient({
  chain: base,
  transport: http(process.env.NEXT_PUBLIC_BASE_RPC_URL || "https://mainnet.base.org"),
})

interface ExecuteSwapRequest {
  userAddress: string
  walletIndex: number // Which bot wallet to use (0-4)
  tokenAddress: Address // Token to buy
  sellAmountWei: string // Amount of ETH to sell
}

/**
 * API Route: Execute swap for bot wallet
 * 
 * This route:
 * 1. Gets encrypted private key for bot wallet from database
 * 2. Decrypts private key (server-side only)
 * 3. Gets 0x API quote
 * 4. Signs and sends transaction via Coinbase Paymaster (gasless)
 * 5. Logs transaction to bot_logs
 * 6. Deducts credit from user balance
 * 
 * Security:
 * - Private key is never exposed to client
 * - All signing happens server-side
 * - Gasless via Coinbase Paymaster
 */
export async function POST(request: NextRequest) {
  try {
    const body: ExecuteSwapRequest = await request.json()
    const { userAddress, walletIndex, tokenAddress, sellAmountWei } = body

    if (!userAddress || walletIndex === undefined || !tokenAddress || !sellAmountWei) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 }
      )
    }

    if (walletIndex < 0 || walletIndex >= 5) {
      return NextResponse.json(
        { error: "walletIndex must be between 0 and 4" },
        { status: 400 }
      )
    }

    const supabase = createSupabaseServiceClient()

    // Get bot wallets from database
    const { data: botWalletsData, error: fetchError } = await supabase
      .from("user_bot_wallets")
      .select("wallets_data")
      .eq("user_address", userAddress.toLowerCase())
      .single()

    if (fetchError || !botWalletsData) {
      return NextResponse.json(
        { error: "Bot wallets not found. Please create bot wallets first." },
        { status: 404 }
      )
    }

    const wallets = botWalletsData.wallets_data as Array<{
      ownerPrivateKey: string // Encrypted
      smartWalletAddress: Address
      index: number
    }>

    const botWallet = wallets[walletIndex]
    if (!botWallet) {
      return NextResponse.json(
        { error: `Bot wallet at index ${walletIndex} not found` },
        { status: 404 }
      )
    }

    // Decrypt private key (server-side only)
    const ownerPrivateKey = decryptPrivateKey(botWallet.ownerPrivateKey) as Hex

    // Get 0x API quote
    console.log(`📊 Getting 0x quote for swap...`)
    const queryParams = new URLSearchParams({
      chainId: "8453",
      sellToken: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", // Native ETH
      buyToken: tokenAddress,
      sellAmount: sellAmountWei,
      taker: botWallet.smartWalletAddress,
      slippagePercentage: "1", // 1% slippage
    })

    const quoteResponse = await fetch(
      `https://api.0x.org/swap/v2/quote?${queryParams.toString()}`,
      {
        headers: {
          "0x-api-key": ZEROX_API_KEY,
          Accept: "application/json",
        },
      }
    )

    if (!quoteResponse.ok) {
      const errorData = await quoteResponse.json().catch(() => ({}))
      console.error("❌ 0x API error:", errorData)
      
      // Log error to database
      await supabase.from("bot_logs").insert({
        user_address: userAddress.toLowerCase(),
        wallet_address: botWallet.smartWalletAddress,
        token_address: tokenAddress,
        amount_wei: sellAmountWei,
        status: "failed",
        message: `0x API error: ${quoteResponse.status}`,
        error_details: errorData,
      })

      return NextResponse.json(
        { error: `0x API error: ${errorData.reason || quoteResponse.statusText}` },
        { status: quoteResponse.status }
      )
    }

    const quote = await quoteResponse.json()

    // Create Smart Account client for bot wallet
    const account = await privateKeyToSimpleSmartAccount({
      publicClient,
      privateKey: ownerPrivateKey,
      entryPoint: "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789",
      factoryAddress: "0x9406Cc6185a346906296840746125a0E44976454",
      index: BigInt(walletIndex),
    })

    // Create Bundler Client with Coinbase CDP Paymaster
    // Use Coinbase CDP bundler endpoint which includes paymaster support
    const COINBASE_CDP_BUNDLER_URL = process.env.COINBASE_CDP_BUNDLER_URL || 
      process.env.NEXT_PUBLIC_BASE_RPC_URL || 
      "https://mainnet.base.org"
    
    const bundlerClient = createBundlerClient({
      transport: http(COINBASE_CDP_BUNDLER_URL),
      chain: base,
    })

    // Execute swap transaction
    console.log(`🔄 Executing swap transaction...`)
    
    // Log pending transaction
    const logResult = await supabase.from("bot_logs").insert({
      user_address: userAddress.toLowerCase(),
      wallet_address: botWallet.smartWalletAddress,
      token_address: tokenAddress,
      amount_wei: sellAmountWei,
      status: "pending",
      message: "Transaction submitted",
    }).select("id").single()
    
    const logId = logResult.data?.id

    try {
      // Send UserOperation via Bundler with Paymaster sponsorship
      const userOpHash = await bundlerClient.sendUserOperation({
        account,
        calls: [{
          to: quote.transaction.to as Address,
          data: quote.transaction.data as Hex,
          value: BigInt(quote.transaction.value || "0"),
        }],
        paymaster: true, // Enable Coinbase Paymaster sponsorship (gasless)
      })

      console.log(`✅ UserOperation sent: ${userOpHash}`)

      // Wait for UserOperation receipt
      const receipt = await bundlerClient.waitForUserOperationReceipt({
        hash: userOpHash,
        timeout: 60000,
      })

      // Get transaction hash from receipt
      const txHash = receipt.receipt.transactionHash as Hex

      console.log(`✅ Transaction sent: ${txHash}`)

      // Wait for confirmation
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: txHash,
        timeout: 60000,
      })

      if (receipt.status === "success") {
        // Update log with success
        await supabase
          .from("bot_logs")
          .update({
            tx_hash: txHash,
            status: "success",
            message: "Transaction confirmed",
          })
          .eq("id", logId)

        // Deduct credit from user balance
        await supabase.rpc("increment_user_credit", {
          p_user_address: userAddress.toLowerCase(),
          p_amount_wei: `-${sellAmountWei}`, // Negative to deduct
        }).catch(async (error) => {
          // Fallback if RPC doesn't support negative
          const { data: currentCredit } = await supabase
            .from("user_credits")
            .select("balance_wei")
            .eq("user_address", userAddress.toLowerCase())
            .single()

          const currentBalance = currentCredit?.balance_wei
            ? BigInt(currentCredit.balance_wei.toString())
            : BigInt(0)
          const deductionAmount = BigInt(sellAmountWei)
          const newBalance = currentBalance > deductionAmount
            ? currentBalance - deductionAmount
            : BigInt(0)

          await supabase
            .from("user_credits")
            .upsert({
              user_address: userAddress.toLowerCase(),
              balance_wei: newBalance.toString(),
              last_updated: new Date().toISOString(),
            })
        })

        return NextResponse.json({
          success: true,
          txHash,
          status: "success",
        })
      } else {
        // Transaction failed
        await supabase
          .from("bot_logs")
          .update({
            tx_hash: txHash,
            status: "failed",
            message: "Transaction reverted",
          })
          .eq("id", logId)

        return NextResponse.json(
          { error: "Transaction reverted", txHash },
          { status: 500 }
        )
      }
    } catch (error: any) {
      console.error("❌ Error executing swap:", error)
      
      // Update log with error
      if (logId) {
        await supabase
          .from("bot_logs")
          .update({
            status: "failed",
            message: error.message || "Transaction failed",
            error_details: { error: error.message, stack: error.stack },
          })
          .eq("id", logId)
      }

      return NextResponse.json(
        { error: error.message || "Failed to execute swap" },
        { status: 500 }
      )
    }
  } catch (error: any) {
    console.error("❌ Error in execute-swap:", error)
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    )
  }
}

