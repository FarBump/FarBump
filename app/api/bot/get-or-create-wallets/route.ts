import { NextRequest, NextResponse } from "next/server"
import { type Address, isAddress } from "viem"
import { createSupabaseServiceClient } from "@/lib/supabase"
import { CdpClient } from "@coinbase/cdp-sdk"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

// Updated interface to use CDP Smart Account
interface BotWalletData {
  smart_account_address: Address // Smart Account address (EIP-4337)
  owner_address: Address // Owner EOA address
  network: string // Network ID (e.g., 'base-mainnet')
}

/**
 * API Route: Get or create 5 bot smart wallets using CDP Server Wallets V2
 * 
 * CDP Smart Accounts (EIP-4337) Benefits:
 * - Native gas sponsorship (no Paymaster configuration needed)
 * - Transaction batching support
 * - Private keys managed by Coinbase in AWS Nitro Enclaves
 * - Spend permissions support
 * - Production-grade security
 * 
 * Logic:
 * 1. Check if user already has 5 bot wallets in database
 * 2. If yes, return existing wallet info
 * 3. If no, create 5 new smart accounts using cdp.evm.createSmartAccount()
 * 4. Each smart account has an owner EOA that CDP manages
 * 5. Store smart account addresses in database
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
      console.log(`✅ User ${normalizedUserAddress} already has 5 bot wallets (CDP Smart Accounts)`)
      return NextResponse.json({
        message: "Bot wallets already exist",
        wallets: existingWallets.map(w => ({
          smart_account_address: w.smart_account_address,
          owner_address: w.owner_address,
          network: w.network,
        })),
        hasBotWallets: true,
      })
    }

    // Step 3: Initialize Coinbase CDP Client
    console.log("🔧 Initializing Coinbase CDP Client...")
    
    const cdpApiKeyId = process.env.CDP_API_KEY_ID
    const cdpApiKeySecret = process.env.CDP_API_KEY_SECRET

    if (!cdpApiKeyId || !cdpApiKeySecret) {
      console.error("❌ Missing CDP credentials in environment variables")
      return NextResponse.json(
        { 
          error: "CDP credentials not configured", 
          details: "Please set CDP_API_KEY_ID and CDP_API_KEY_SECRET in .env" 
        },
        { status: 500 }
      )
    }

    // Configure CDP Client
    const cdp = new CdpClient({
      apiKeyId: cdpApiKeyId,
      apiKeySecret: cdpApiKeySecret,
    })

    console.log("✅ CDP Client configured successfully")

    // Step 4: Create 5 smart accounts using CDP
    console.log("🚀 Creating 5 bot smart accounts (EIP-4337) on Base Mainnet...")

    const walletsToInsert: BotWalletData[] = []

    for (let i = 0; i < 5; i++) {
      console.log(`   Creating smart account ${i + 1}/5...`)

      try {
        // Create owner EOA account (CDP manages the private key)
        const owner = await cdp.evm.createAccount({})
        
        console.log(`   Owner EOA created: ${owner.address}`)

        // Create smart account with the owner
        // This is an EIP-4337 smart account with gas sponsorship support
        const smartAccount = await cdp.evm.createSmartAccount({
          owner,
        })

        console.log(`   ✅ Smart Account ${i + 1} created:`)
        console.log(`      Smart Account Address: ${smartAccount.address}`)
        console.log(`      Owner Address: ${owner.address}`)

        walletsToInsert.push({
          smart_account_address: smartAccount.address as Address,
          owner_address: owner.address as Address,
          network: "base-mainnet",
        })
      } catch (walletError: any) {
        console.error(`   ❌ Failed to create smart account ${i + 1}:`, walletError)
        throw new Error(`Smart account creation failed at index ${i}: ${walletError.message}`)
      }
    }

    console.log(`✅ All 5 smart accounts created successfully (CDP EIP-4337)`)

    // Step 5: Save wallets to database
    console.log("💾 Saving wallets to Supabase...")

    const walletsToStore = walletsToInsert.map((wallet) => ({
      user_address: normalizedUserAddress,
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

    return NextResponse.json({
      message: "Successfully created 5 bot smart accounts using CDP",
      wallets: walletsToInsert,
      hasBotWallets: true,
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
