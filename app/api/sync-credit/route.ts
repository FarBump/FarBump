import { NextRequest, NextResponse } from "next/server"
import { createPublicClient, http, parseAbiItem, type Address, type Hex } from "viem"
import { base } from "viem/chains"
import { createSupabaseServiceClient } from "@/lib/supabase"
import { TREASURY_ADDRESS, APP_FEE_BPS, USER_CREDIT_BPS } from "@/lib/constants"

// Initialize public client for Base mainnet
const publicClient = createPublicClient({
  chain: base,
  transport: http(process.env.NEXT_PUBLIC_BASE_RPC_URL || "https://mainnet.base.org"),
})

// ERC20 Transfer event ABI
const TRANSFER_EVENT = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)"
)

// Uniswap V4 PoolManager Swap event ABI
const UNISWAP_V4_SWAP_EVENT = parseAbiItem(
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee, uint24 tickSpacing)"
)

interface SyncCreditRequest {
  txHash: string
  userAddress: string
  amountBump: string
  amountBumpWei: string
}

/**
 * Verifies transaction and calculates ETH credit amount
 * Returns the ETH amount (in wei) that should be credited to user (90% of swap result)
 */
async function verifyAndCalculateCredit(
  txHash: Hex,
  userAddress: Address
): Promise<{ ethAmountWei: bigint; isValid: boolean }> {
  try {
    // 1. Get transaction receipt
    const receipt = await publicClient.getTransactionReceipt({ hash: txHash })

    if (!receipt || receipt.status !== "success") {
      return { ethAmountWei: BigInt(0), isValid: false }
    }

    // 2. Verify that treasury received the 5% $BUMP fee
    // Look for Transfer event from userAddress to TREASURY_ADDRESS
    const treasuryTransferLog = receipt.logs.find((log) => {
      try {
        const decoded = publicClient.decodeEventLog({
          abi: [TRANSFER_EVENT],
          data: log.data,
          topics: log.topics,
        })
        return (
          decoded.eventName === "Transfer" &&
          decoded.args.from?.toLowerCase() === userAddress.toLowerCase() &&
          decoded.args.to?.toLowerCase() === TREASURY_ADDRESS.toLowerCase()
        )
      } catch {
        return false
      }
    })

    if (!treasuryTransferLog) {
      console.warn("⚠️ Treasury fee transfer not found in transaction logs")
      // Still proceed, but log warning
    }

    // 3. Calculate ETH received from swap
    // Method 1: Parse Uniswap V4 Swap event (most accurate)
    let ethReceivedWei = BigInt(0)
    const BUMP_TOKEN_ADDRESS = "0x94ce728849431818ec9a0cf29bdb24fe413bbb07"
    const BASE_WETH_ADDRESS = "0x4200000000000000000000000000000000000006"
    
    // Determine token order (same as frontend)
    const isBumpToken0 = BUMP_TOKEN_ADDRESS.toLowerCase() < BASE_WETH_ADDRESS.toLowerCase()
    
    // Look for Uniswap V4 Swap event
    const swapEventLog = receipt.logs.find((log) => {
      try {
        const decoded = publicClient.decodeEventLog({
          abi: [UNISWAP_V4_SWAP_EVENT],
          data: log.data,
          topics: log.topics,
        })
        return (
          decoded.eventName === "Swap" &&
          decoded.args.recipient?.toLowerCase() === userAddress.toLowerCase() &&
          log.address.toLowerCase() === "0x498581ff718922c3f8e6a244956af099b2652b2b" // PoolManager address
        )
      } catch {
        return false
      }
    })

    if (swapEventLog) {
      try {
        const decoded = publicClient.decodeEventLog({
          abi: [UNISWAP_V4_SWAP_EVENT],
          data: swapEventLog.data,
          topics: swapEventLog.topics,
        })
        
        // amount0 and amount1 are int256, negative means input, positive means output
        // If BUMP is token0 and we're swapping BUMP -> WETH (zeroForOne = true):
        //   amount0 will be negative (input BUMP)
        //   amount1 will be positive (output WETH)
        // If BUMP is token1 and we're swapping BUMP -> WETH (zeroForOne = false):
        //   amount0 will be positive (output WETH)
        //   amount1 will be negative (input BUMP)
        
        const amount0 = decoded.args.amount0 || BigInt(0)
        const amount1 = decoded.args.amount1 || BigInt(0)
        
        if (isBumpToken0) {
          // BUMP is token0, WETH is token1
          // amount1 should be positive (WETH output)
          if (amount1 > BigInt(0)) {
            ethReceivedWei = BigInt(amount1.toString())
          }
        } else {
          // WETH is token0, BUMP is token1
          // amount0 should be positive (WETH output)
          if (amount0 > BigInt(0)) {
            ethReceivedWei = BigInt(amount0.toString())
          }
        }
        
        console.log(`✅ Parsed Swap event: amount0=${amount0.toString()}, amount1=${amount1.toString()}, ETH received=${ethReceivedWei.toString()}`)
      } catch (decodeError) {
        console.error("❌ Error decoding Swap event:", decodeError)
      }
    }

    // Method 2: Fallback - Check WETH transfers to userAddress
    if (ethReceivedWei === BigInt(0)) {
      console.log("⚠️ Swap event not found, checking WETH transfers...")
      const wethTransferLogs = receipt.logs.filter((log) => {
        try {
          const decoded = publicClient.decodeEventLog({
            abi: [TRANSFER_EVENT],
            data: log.data,
            topics: log.topics,
          })
          return (
            decoded.eventName === "Transfer" &&
            decoded.args.to?.toLowerCase() === userAddress.toLowerCase() &&
            log.address.toLowerCase() === BASE_WETH_ADDRESS.toLowerCase()
          )
        } catch {
          return false
        }
      })

      if (wethTransferLogs.length > 0) {
        // Sum all WETH transfers to user
        for (const log of wethTransferLogs) {
          try {
            const decoded = publicClient.decodeEventLog({
              abi: [TRANSFER_EVENT],
              data: log.data,
              topics: log.topics,
            })
            if (decoded.args.value) {
              ethReceivedWei += BigInt(decoded.args.value.toString())
            }
          } catch (decodeError) {
            console.error("❌ Error decoding WETH transfer:", decodeError)
          }
        }
      }
    }

    if (ethReceivedWei === BigInt(0)) {
      console.warn("⚠️ No ETH received detected in transaction")
      return { ethAmountWei: BigInt(0), isValid: false }
    }

    // 4. Calculate 90% credit (after 5% app fee)
    // Note: The 5% app fee should be transferred separately or calculated here
    // For now, we'll credit 90% of the ETH received
    const creditAmountWei = (ethReceivedWei * BigInt(USER_CREDIT_BPS)) / BigInt(10000)

    return {
      ethAmountWei: creditAmountWei,
      isValid: true,
    }
  } catch (error) {
    console.error("❌ Error verifying transaction:", error)
    return { ethAmountWei: BigInt(0), isValid: false }
  }
}

export async function POST(request: NextRequest) {
  try {
    const body: SyncCreditRequest = await request.json()
    const { txHash, userAddress, amountBump, amountBumpWei } = body

    // Validation
    if (!txHash || !userAddress) {
      return NextResponse.json(
        { error: "Missing required fields: txHash and userAddress" },
        { status: 400 }
      )
    }

    // Verify transaction and calculate credit
    const { ethAmountWei, isValid } = await verifyAndCalculateCredit(
      txHash as Hex,
      userAddress as Address
    )

    if (!isValid || ethAmountWei === BigInt(0)) {
      return NextResponse.json(
        { error: "Transaction verification failed or no ETH credit to add" },
        { status: 400 }
      )
    }

    // Initialize Supabase service client (bypasses RLS)
    const supabase = createSupabaseServiceClient()

    // Update user_credits table with increment
    // Using raw SQL to ensure atomic increment
    const { error: updateError } = await supabase.rpc("increment_user_credit", {
      p_user_address: userAddress.toLowerCase(),
      p_amount_wei: ethAmountWei.toString(),
    })

    // If RPC function doesn't exist, use upsert with raw SQL increment
    if (updateError) {
      console.warn("⚠️ RPC function not found, using upsert with SQL increment:", updateError)
      
      // Get current balance
      const { data: currentCredit, error: fetchError } = await supabase
        .from("user_credits")
        .select("balance_wei")
        .eq("user_address", userAddress.toLowerCase())
        .single()

      const currentBalanceWei = currentCredit?.balance_wei 
        ? BigInt(currentCredit.balance_wei.toString())
        : BigInt(0)

      const newBalanceWei = currentBalanceWei + ethAmountWei

      // Upsert with new balance
      const { error: upsertError } = await supabase
        .from("user_credits")
        .upsert(
          {
            user_address: userAddress.toLowerCase(),
            balance_wei: newBalanceWei.toString(),
            last_updated: new Date().toISOString(),
          },
          {
            onConflict: "user_address",
          }
        )

      if (upsertError) {
        console.error("❌ Error updating user_credits:", upsertError)
        return NextResponse.json(
          { error: "Failed to update user credit balance" },
          { status: 500 }
        )
      }
    }

    // Save audit log
    const { error: logError } = await supabase.from("conversion_logs").insert({
      user_address: userAddress.toLowerCase(),
      tx_hash: txHash,
      amount_bump: amountBump,
      amount_bump_wei: amountBumpWei,
      eth_credit_wei: ethAmountWei.toString(),
      created_at: new Date().toISOString(),
    })

    if (logError) {
      console.error("⚠️ Error saving conversion log (non-critical):", logError)
      // Don't fail the request if logging fails
    }

    return NextResponse.json({
      success: true,
      ethCreditWei: ethAmountWei.toString(),
      message: "Credit synced successfully",
    })
  } catch (error: any) {
    console.error("❌ Error in sync-credit API:", error)
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    )
  }
}
