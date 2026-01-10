import { NextRequest, NextResponse } from "next/server"
import { type Address, isAddress } from "viem"
import { createSupabaseServiceClient } from "@/lib/supabase"
import { CdpClient } from "@coinbase/cdp-sdk"
import "dotenv/config"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

// Updated interface to use CDP Server Wallet V2
interface BotWalletData {
  smart_account_address: Address // Account address from CDP
  owner_address: Address // Same as smart_account_address for regular accounts
  network: string // Network ID (e.g., 'base-mainnet')
}

/**
 * API Route: Get or create 5 bot wallets using Coinbase CDP SDK V2
 * 
 * Official Documentation: 
 * https://docs.cdp.coinbase.com/server-wallets/v2/using-the-wallet-api/managing-accounts
 * 
 * CDP SDK V2 Features:
 * - Automatic key management by Coinbase in secure AWS Nitro Enclaves
 * - Named accounts for easier access (getOrCreateAccount)
 * - Native gas sponsorship support
 * - EVM and Smart Account support
 * - Production-grade security
 * 
 * Logic:
 * 1. Check if user already has 5 bot wallets in database
 * 2. If yes, return existing wallet info with hasBotWallets: true
 * 3. If no, create 5 new EVM accounts using cdp.evm.createAccount()
 * 4. Store account addresses in database with user_address categorization
 * 5. Each user's wallets are isolated by user_address column
 * 
 * Database Schema:
 * - user_address: Main user's Smart Wallet address (from Privy) - unique identifier
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
    // This ensures each user has exactly 5 bot wallets, no mixing between users
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

    // Step 3: Initialize Coinbase CDP Client V2
    // Official method: https://docs.cdp.coinbase.com/server-wallets/v2/
    console.log("🔧 Initializing Coinbase CDP SDK V2...")
    
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

    // Initialize CDP Client V2
    // Reference: https://docs.cdp.coinbase.com/server-wallets/v2/using-the-wallet-api/managing-accounts
    let cdp: CdpClient
    try {
      cdp = new CdpClient({
        apiKeyName: cdpApiKeyName,
        privateKey: cdpPrivateKey,
      })
      console.log("✅ CDP Client V2 initialized successfully")
    } catch (configError: any) {
      console.error("❌ Failed to initialize CDP Client:", configError)
      return NextResponse.json(
        { 
          error: "Failed to initialize CDP Client", 
          details: configError.message 
        },
        { status: 500 }
      )
    }

    // Step 4: Create 5 new EVM accounts using CDP V2
    // Official method: cdp.evm.createAccount()
    // Reference: https://docs.cdp.coinbase.com/server-wallets/v2/using-the-wallet-api/managing-accounts#creating-accounts
    console.log("🚀 Creating 5 bot EVM accounts using CDP V2...")

    const walletsToInsert: BotWalletData[] = []

    for (let i = 0; i < 5; i++) {
      console.log(`   Creating EVM account ${i + 1}/5...`)

      try {
        // Create EVM account on Base network
        // CDP V2 automatically manages the account on base-mainnet
        const account = await cdp.evm.createAccount()

        if (!account || !account.address) {
          throw new Error(`Account ${i + 1} created but missing address`)
        }

        console.log(`   ✅ EVM Account ${i + 1} created:`)
        console.log(`      Address: ${account.address}`)

        walletsToInsert.push({
          smart_account_address: account.address as Address,
          owner_address: account.address as Address, // For regular EVM accounts, owner = address
          network: "base-mainnet",
        })
      } catch (walletError: any) {
        console.error(`   ❌ Failed to create account ${i + 1}:`, walletError)
        console.error(`   Error details:`, walletError.message)
        
        // If one wallet fails, we should still try to create the rest
        // But log the error and continue
        console.log(`   ⚠️  Continuing to next wallet...`)
        continue
      }
    }

    // Check if we successfully created all 5 wallets
    if (walletsToInsert.length < 5) {
      console.error(`❌ Only created ${walletsToInsert.length}/5 wallets`)
      return NextResponse.json(
        { 
          error: "Failed to create all 5 wallets", 
          details: `Only ${walletsToInsert.length} wallets were created successfully` 
        },
        { status: 500 }
      )
    }

    console.log(`✅ All 5 EVM accounts created successfully`)

    // Step 5: Save wallets to database
    // IMPORTANT: Each wallet is tied to user_address to ensure proper categorization
    // This prevents wallets from mixing between different users
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
      message: "Successfully created 5 bot wallets using CDP V2",
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
