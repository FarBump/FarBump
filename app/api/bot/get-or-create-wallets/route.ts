import { NextRequest, NextResponse } from "next/server"
import { type Address, isAddress } from "viem"
import { createSupabaseServiceClient } from "@/lib/supabase"
import { Coinbase, Wallet } from "@coinbase/coinbase-sdk"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

// Updated interface to use CDP Server Wallet ID
interface BotWalletData {
  coinbase_wallet_id: string // CDP Wallet ID (used to fetch wallet from CDP)
  smart_account_address: Address // Default address of the wallet
  chain: string // Network ID (e.g., 'base-mainnet')
}

/**
 * API Route: Get or create 5 bot wallets using CDP Server Wallets V2
 * 
 * Benefits of CDP Server Wallets:
 * - Private keys managed by Coinbase in secure AWS Nitro Enclaves
 * - Native gas sponsorship (no Paymaster allowlist issues)
 * - Simple API (no manual CREATE2, encryption, or signing)
 * - Production-grade security and reliability
 * 
 * Logic:
 * 1. Check if user already has bot wallets in database
 * 2. If yes, return existing wallet info
 * 3. If no, create 5 new wallets using Wallet.create()
 * 4. Store wallet.getId() and wallet.getDefaultAddress() in database
 * 
 * Security:
 * - Private keys never exposed (managed by CDP)
 * - Server-side only operations
 * - CDP credentials from environment variables
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { userAddress } = body as { userAddress: string }

    // Validation: Ensure userAddress is provided
    if (!userAddress) {
      return NextResponse.json(
        { error: "Missing required field: userAddress" },
        { status: 400 }
      )
    }

    // Validation: Validate userAddress is a valid Ethereum address
    if (typeof userAddress !== 'string') {
      return NextResponse.json(
        { error: "Invalid userAddress: must be a string" },
        { status: 400 }
      )
    }

    if (!isAddress(userAddress)) {
      return NextResponse.json(
        { error: `Invalid Ethereum address format: ${userAddress}` },
        { status: 400 }
      )
    }

    // IMPORTANT: userAddress is the Smart Wallet address from Privy
    // This is used as the unique identifier in all database tables
    const normalizedUserAddress = userAddress.toLowerCase()

    const supabase = createSupabaseServiceClient()

    // Step 1: Check if user already has bot wallets
    const { data: existingWallets, error: fetchError } = await supabase
      .from("wallets_data")
      .select("*")
      .eq("user_address", normalizedUserAddress)

    if (fetchError) {
      console.error("❌ Supabase fetch error:", fetchError)
      return NextResponse.json(
        { error: "Failed to fetch existing wallets", details: fetchError.message },
        { status: 500 }
      )
    }

    // Step 2: If user already has 5 wallets, return them
    if (existingWallets && existingWallets.length === 5) {
      console.log(`✅ User ${normalizedUserAddress} already has 5 bot wallets (CDP)`)
      return NextResponse.json({
        message: "Bot wallets already exist",
        wallets: existingWallets.map(w => ({
          coinbase_wallet_id: w.coinbase_wallet_id,
          smart_account_address: w.smart_account_address,
          chain: w.chain,
        })),
      })
    }

    // Step 3: Initialize Coinbase SDK
    console.log("🔧 Initializing Coinbase CDP SDK...")
    
    const cdpApiKeyName = process.env.CDP_API_KEY_NAME
    const cdpPrivateKey = process.env.CDP_PRIVATE_KEY

    if (!cdpApiKeyName || !cdpPrivateKey) {
      console.error("❌ Missing CDP credentials in environment variables")
      return NextResponse.json(
        { 
          error: "CDP credentials not configured", 
          details: "Please set CDP_API_KEY_NAME and CDP_PRIVATE_KEY in .env" 
        },
        { status: 500 }
      )
    }

    // Configure Coinbase SDK
    Coinbase.configure({
      apiKeyName: cdpApiKeyName,
      privateKey: cdpPrivateKey,
    })

    console.log("✅ CDP SDK configured successfully")

    // Step 4: Create 5 new wallets using CDP
    console.log("🚀 Creating 5 bot wallets using CDP Server Wallets V2...")

    const walletsToInsert: BotWalletData[] = []

    for (let i = 0; i < 5; i++) {
      console.log(`   Creating wallet ${i + 1}/5...`)

      try {
        // Create wallet on Base Mainnet
        const wallet = await Wallet.create({
          networkId: "base-mainnet",
        })

        const walletId = wallet.getId()
        const defaultAddress = wallet.getDefaultAddress()

        if (!walletId || !defaultAddress) {
          throw new Error(`Wallet ${i + 1} created but missing ID or address`)
        }

        console.log(`   ✅ Wallet ${i + 1} created:`)
        console.log(`      CDP Wallet ID: ${walletId}`)
        console.log(`      Address: ${defaultAddress.getId()}`)

        walletsToInsert.push({
          coinbase_wallet_id: walletId,
          smart_account_address: defaultAddress.getId() as Address,
          chain: "base-mainnet",
        })
      } catch (walletError: any) {
        console.error(`   ❌ Failed to create wallet ${i + 1}:`, walletError)
        throw new Error(`Wallet creation failed at index ${i}: ${walletError.message}`)
      }
    }

    console.log(`✅ All 5 wallets created successfully (CDP)`)

    // Step 5: Save wallets to database
    console.log("💾 Saving wallets to Supabase...")

    const walletsToStore = walletsToInsert.map((wallet) => ({
      user_address: normalizedUserAddress,
      coinbase_wallet_id: wallet.coinbase_wallet_id,
      smart_account_address: wallet.smart_account_address,
      chain: wallet.chain,
      created_at: new Date().toISOString(),
    }))

    const { data: insertedWallets, error: insertError } = await supabase
      .from("wallets_data")
      .insert(walletsToStore)
      .select()

    if (insertError) {
      console.error("❌ Supabase insert error:", insertError)
      return NextResponse.json(
        { error: "Failed to save wallets to database", details: insertError.message },
        { status: 500 }
      )
    }

    console.log(`✅ Saved ${insertedWallets.length} wallets to database`)

    return NextResponse.json({
      message: "Successfully created 5 bot wallets using CDP",
      wallets: walletsToInsert,
    })
  } catch (error: any) {
    console.error("❌ Error in get-or-create-wallets:", error)
    return NextResponse.json(
      { 
        error: "Internal server error", 
        details: error.message,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
      },
      { status: 500 }
    )
  }
}
