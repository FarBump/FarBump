import { NextRequest, NextResponse } from "next/server"
import { type Address, isAddress } from "viem"
import { createSupabaseServiceClient } from "@/lib/supabase"
import { Coinbase, Wallet } from "@coinbase/coinbase-sdk"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

// Updated interface to use CDP Wallet
interface BotWalletData {
  smart_account_address: Address // Wallet address from CDP
  owner_address: Address // Same as smart_account_address for regular wallets
  network: string // Network ID (e.g., 'base-mainnet')
}

/**
 * API Route: Get or create 5 bot wallets using Coinbase CDP SDK
 * 
 * Official Coinbase CDP Documentation:
 * https://docs.cdp.coinbase.com/wallets/docs/creating-wallets
 * 
 * Benefits:
 * - Private keys managed securely by Coinbase
 * - No manual key generation or encryption needed
 * - Gas sponsorship support (when configured)
 * - Production-grade security
 * 
 * Logic:
 * 1. Check if user already has 5 bot wallets in database
 * 2. If yes, return existing wallet info with hasBotWallets: true
 * 3. If no, create 5 new wallets using Wallet.create()
 * 4. Store wallet addresses in database
 * 5. Each user's wallets are isolated by user_address column
 * 
 * Database Schema:
 * - user_address: Main user's Smart Wallet address (from Privy)
 * - smart_account_address: Bot wallet address from CDP
 * - owner_address: Same as smart_account_address (for compatibility)
 * - network: 'base-mainnet'
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
    // This is used as the unique identifier to categorize wallets per user
    const normalizedUserAddress = userAddress.toLowerCase()

    const supabase = createSupabaseServiceClient()

    // Step 1: Check if user already has bot wallets
    // Database query filters by user_address to ensure proper categorization
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
    // This ensures each user has exactly 5 bot wallets, no mixing
    if (existingWallets && existingWallets.length === 5) {
      console.log(`✅ User ${normalizedUserAddress} already has 5 bot wallets`)
      return NextResponse.json({
        message: "Bot wallets already exist",
        wallets: existingWallets.map(w => ({
          smart_account_address: w.smart_account_address,
          owner_address: w.owner_address,
          network: w.network,
        })),
        hasBotWallets: true, // Flag for frontend to show "Start Bumping" button
      })
    }

    // Step 3: Initialize Coinbase SDK
    // Official method: https://docs.cdp.coinbase.com/wallets/docs/authentication
    console.log("🔧 Initializing Coinbase CDP SDK...")
    
    const cdpApiKeyName = process.env.CDP_API_KEY_NAME
    const cdpPrivateKey = process.env.CDP_PRIVATE_KEY

    if (!cdpApiKeyName || !cdpPrivateKey) {
      console.error("❌ Missing CDP credentials in environment variables")
      console.error("   Expected: CDP_API_KEY_NAME and CDP_PRIVATE_KEY")
      console.error("   Get these from: https://portal.cdp.coinbase.com/")
      return NextResponse.json(
        { 
          error: "CDP credentials not configured", 
          details: "Please set CDP_API_KEY_NAME and CDP_PRIVATE_KEY in environment variables. See CDP-SETUP-BENAR.md for instructions." 
        },
        { status: 500 }
      )
    }

    // Configure Coinbase SDK with credentials
    // Official documentation: https://docs.cdp.coinbase.com/wallets/docs/authentication#configure-sdk
    try {
      Coinbase.configure({
        apiKeyName: cdpApiKeyName,
        privateKey: cdpPrivateKey,
      })
      console.log("✅ CDP SDK configured successfully")
    } catch (configError: any) {
      console.error("❌ Failed to configure CDP SDK:", configError)
      return NextResponse.json(
        { 
          error: "Failed to configure CDP SDK", 
          details: configError.message 
        },
        { status: 500 }
      )
    }

    // Step 4: Create 5 new wallets using CDP
    // Official method: https://docs.cdp.coinbase.com/wallets/docs/creating-wallets
    console.log("🚀 Creating 5 bot wallets using Coinbase CDP...")

    const walletsToInsert: BotWalletData[] = []

    for (let i = 0; i < 5; i++) {
      console.log(`   Creating wallet ${i + 1}/5...`)

      try {
        // Create wallet on Base Mainnet
        // Official API: Wallet.create({ networkId: 'base-mainnet' })
        const wallet = await Wallet.create({
          networkId: "base-mainnet",
        })

        // Get wallet address
        const defaultAddress = wallet.getDefaultAddress()

        if (!defaultAddress) {
          throw new Error(`Wallet ${i + 1} created but missing default address`)
        }

        const walletAddress = defaultAddress.getId()
        
        console.log(`   ✅ Wallet ${i + 1} created:`)
        console.log(`      Address: ${walletAddress}`)

        walletsToInsert.push({
          smart_account_address: walletAddress as Address,
          owner_address: walletAddress as Address, // For regular wallets, owner = smart account
          network: "base-mainnet",
        })
      } catch (walletError: any) {
        console.error(`   ❌ Failed to create wallet ${i + 1}:`, walletError)
        console.error(`   Error details:`, walletError.message)
        throw new Error(`Wallet creation failed at index ${i}: ${walletError.message}`)
      }
    }

    console.log(`✅ All 5 wallets created successfully`)

    // Step 5: Save wallets to database
    // IMPORTANT: Each wallet is tied to user_address to ensure proper categorization
    console.log("💾 Saving wallets to Supabase...")

    const walletsToStore = walletsToInsert.map((wallet) => ({
      user_address: normalizedUserAddress, // This ensures wallets are categorized per user
      smart_account_address: wallet.smart_account_address,
      owner_address: wallet.owner_address,
      network: wallet.network,
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
    console.log(`✅ Wallets categorized under user: ${normalizedUserAddress}`)

    return NextResponse.json({
      message: "Successfully created 5 bot wallets using CDP",
      wallets: walletsToInsert,
      hasBotWallets: true, // Flag for frontend to show "Start Bumping" button
    })
  } catch (error: any) {
    console.error("❌ Error in get-or-create-wallets:", error)
    console.error("   Error stack:", error.stack)
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
