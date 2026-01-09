import { NextRequest, NextResponse } from "next/server"
import { createSupabaseServiceClient } from "@/lib/supabase"
import { parseUnits, type Address } from "viem"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

interface FundWalletsRequest {
  userAddress: string
  walletAddresses: Address[]
  totalAmountWei: string // Total ETH to distribute across all wallets
}

/**
 * API Route: Calculate funding amounts and validate credit balance
 * 
 * This route:
 * 1. Validates user has enough credit balance
 * 2. Calculates ETH amount per wallet (totalAmount / number of wallets)
 * 3. Returns funding instructions for frontend to execute batch transfer
 * 
 * Note: Actual ETH transfer is done from frontend using Privy Smart Wallet batch transaction
 */
export async function POST(request: NextRequest) {
  try {
    const body: FundWalletsRequest = await request.json()
    const { userAddress, walletAddresses, totalAmountWei } = body

    // IMPORTANT: userAddress is the Smart Wallet address from Privy (NOT Embedded Wallet)
    // This is used as the unique identifier (user_address) in all database tables
    // We do NOT use Supabase Auth - only wallet address-based identification

    if (!userAddress || !walletAddresses || !totalAmountWei) {
      return NextResponse.json(
        { error: "Missing required fields: userAddress, walletAddresses, totalAmountWei" },
        { status: 400 }
      )
    }

    const normalizedUserAddress = userAddress.toLowerCase()

    if (!Array.isArray(walletAddresses) || walletAddresses.length === 0) {
      return NextResponse.json(
        { error: "walletAddresses must be a non-empty array" },
        { status: 400 }
      )
    }

    const supabase = createSupabaseServiceClient()

    // Get user credit balance
    // Database query uses user_address column (NOT user_id)
    const { data: creditData, error: creditError } = await supabase
      .from("user_credits")
      .select("balance_wei")
      .eq("user_address", normalizedUserAddress)
      .single()

    if (creditError && creditError.code !== "PGRST116") {
      console.error("❌ Error fetching credit balance:", creditError)
      return NextResponse.json(
        { error: "Failed to fetch credit balance" },
        { status: 500 }
      )
    }

    const creditBalanceWei = creditData?.balance_wei
      ? BigInt(creditData.balance_wei.toString())
      : BigInt(0)
    const requiredAmountWei = BigInt(totalAmountWei)

    // Validate credit balance
    if (creditBalanceWei < requiredAmountWei) {
      const creditEth = Number(creditBalanceWei) / 1e18
      const requiredEth = Number(requiredAmountWei) / 1e18
      return NextResponse.json(
        {
          error: "Insufficient credit balance",
          creditBalance: creditBalanceWei.toString(),
          requiredAmount: requiredAmountWei.toString(),
          creditBalanceEth: creditEth.toFixed(6),
          requiredAmountEth: requiredEth.toFixed(6),
        },
        { status: 400 }
      )
    }

    // Calculate amount per wallet (distribute evenly)
    const numberOfWallets = walletAddresses.length
    const amountPerWalletWei = requiredAmountWei / BigInt(numberOfWallets)
    const remainderWei = requiredAmountWei % BigInt(numberOfWallets)

    // Distribute amounts (add remainder to first wallet for precision)
    const fundingInstructions = walletAddresses.map((wallet, index) => ({
      to: wallet,
      value: (amountPerWalletWei + (index === 0 ? remainderWei : BigInt(0))).toString(),
    }))

    console.log(`✅ Funding validation passed for user: ${userAddress}`)
    console.log(`   Total amount: ${requiredAmountWei.toString()} wei`)
    console.log(`   Amount per wallet: ${amountPerWalletWei.toString()} wei`)
    console.log(`   Number of wallets: ${numberOfWallets}`)

    return NextResponse.json({
      success: true,
      fundingInstructions,
      totalAmount: requiredAmountWei.toString(),
      amountPerWallet: amountPerWalletWei.toString(),
      creditBalance: creditBalanceWei.toString(),
    })
  } catch (error: any) {
    console.error("❌ Error in fund-wallets:", error)
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    )
  }
}



