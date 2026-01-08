import { NextRequest, NextResponse } from "next/server"
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts"
import { toSimpleSmartAccount } from "permissionless/accounts"
import { createPublicClient, http, type Address } from "viem"
import { base } from "viem/chains"
import { createSupabaseServiceClient } from "@/lib/supabase"
import { encryptPrivateKey } from "@/lib/bot-encryption"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

// Initialize public client for Base
// Create client inside function to ensure it's properly initialized
function getPublicClient() {
  return createPublicClient({
    chain: base,
    transport: http(process.env.NEXT_PUBLIC_BASE_RPC_URL || "https://mainnet.base.org"),
  })
}

interface BotWallet {
  ownerPrivateKey: string // Encrypted
  smartWalletAddress: Address
  index: number
}

/**
 * API Route: Get or create 5 bot wallets for user
 * 
 * Logic:
 * 1. Check if user already has bot wallets in database
 * 2. If yes, return existing wallets (decrypt not needed here, just return encrypted)
 * 3. If no, generate 5 EOA private keys, calculate Smart Wallet addresses, encrypt, save
 * 
 * Security:
 * - Private keys are encrypted before storage
 * - Never exposed to client
 * - Only server-side operations
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { userAddress } = body as { userAddress: string }

    if (!userAddress) {
      return NextResponse.json(
        { error: "Missing required field: userAddress" },
        { status: 400 }
      )
    }

    const supabase = createSupabaseServiceClient()

    // Check if user already has bot wallets
    const { data: existingWallets, error: fetchError } = await supabase
      .from("user_bot_wallets")
      .select("wallets_data")
      .eq("user_address", userAddress.toLowerCase())
      .single()

    if (existingWallets && !fetchError) {
      // User already has wallets, return them
      console.log(`✅ Found existing bot wallets for user: ${userAddress}`)
      return NextResponse.json({
        success: true,
        wallets: existingWallets.wallets_data as BotWallet[],
        created: false,
      })
    }

    // Generate 5 new bot wallets
    console.log(`🔄 Generating 5 new bot wallets for user: ${userAddress}`)
    const botWallets: BotWallet[] = []

    try {
      for (let i = 0; i < 5; i++) {
        // Generate EOA private key
        const ownerPrivateKey = generatePrivateKey()
        
        // Create EOA account from private key (required as owner/signer for SimpleAccount)
        const ownerAccount = privateKeyToAccount(ownerPrivateKey)

        // Create SimpleAccount Smart Wallet address deterministically
        // Using permissionless.js SimpleAccount (ERC-4337 compatible)
        let account
        // Define constants outside try block for error logging
        const entryPointAddress = "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789" as Address
        const factoryAddress = "0x9406Cc6185a346906296840746125a0E44976454" as Address
        
        try {
          // Get fresh public client instance
          const client = getPublicClient()
          
          // Validate that all required values are defined
          if (!client) {
            throw new Error("client is not defined")
          }
          if (!client.chain) {
            throw new Error("client.chain is not defined")
          }
          if (!ownerAccount) {
            throw new Error("ownerAccount is not defined")
          }
          if (!entryPointAddress) {
            throw new Error("entryPointAddress is not defined")
          }
          if (!factoryAddress) {
            throw new Error("factoryAddress is not defined")
          }
          
          // Create entryPoint object with proper structure
          const entryPoint = {
            address: entryPointAddress,
            version: "0.6" as const,
          }
          
          console.log(`  Creating Smart Account ${i + 1} with:`)
          console.log(`    - Chain: ${client.chain.name} (ID: ${client.chain.id})`)
          console.log(`    - EntryPoint: ${entryPoint.address} (v${entryPoint.version})`)
          console.log(`    - Factory: ${factoryAddress}`)
          console.log(`    - Index: ${i}`)
          
          account = await toSimpleSmartAccount({
            client: client,
            signer: ownerAccount,
            entryPoint: entryPoint,
            factoryAddress: factoryAddress,
            index: BigInt(i),
          } as any) // Type assertion needed for permissionless.js compatibility
          
          if (!account || !account.address) {
            throw new Error("Account creation returned invalid result")
          }
        } catch (accountError: any) {
          console.error(`❌ Error creating Smart Account for wallet ${i + 1}:`, accountError)
          console.error(`   Error type: ${accountError?.constructor?.name || typeof accountError}`)
          console.error(`   Error message: ${accountError?.message || String(accountError)}`)
          console.error(`   Error stack: ${accountError?.stack || "No stack trace"}`)
          
          // Log additional debugging info
          const client = getPublicClient()
          console.error(`   Debug info:`)
          console.error(`     - client: ${!!client}`)
          console.error(`     - client.chain: ${!!client?.chain}`)
          console.error(`     - client.chain.name: ${client?.chain?.name || "undefined"}`)
          console.error(`     - ownerAccount: ${!!ownerAccount}`)
          console.error(`     - entryPointAddress: ${entryPointAddress || "undefined"}`)
          console.error(`     - factoryAddress: ${factoryAddress || "undefined"}`)
          
          throw new Error(
            `Failed to create Smart Account ${i + 1}: ${accountError?.message || String(accountError)}`
          )
        }

        // Encrypt private key before storage
        const encryptedPrivateKey = encryptPrivateKey(ownerPrivateKey)

        botWallets.push({
          ownerPrivateKey: encryptedPrivateKey,
          smartWalletAddress: account.address,
          index: i,
        })

        console.log(`  Bot Wallet ${i + 1}: ${account.address}`)
      }
    } catch (walletGenError: any) {
      console.error("❌ Error generating bot wallets:", walletGenError)
      console.error("   Error type:", walletGenError?.constructor?.name || typeof walletGenError)
      console.error("   Error message:", walletGenError?.message || String(walletGenError))
      console.error("   Error stack:", walletGenError?.stack || "No stack trace")
      return NextResponse.json(
        { 
          error: `Failed to generate bot wallets: ${walletGenError?.message || "Unknown error"}`,
          details: process.env.NODE_ENV === "development" ? walletGenError?.stack : undefined
        },
        { status: 500 }
      )
    }

    // Save to database
    const { error: insertError } = await supabase
      .from("user_bot_wallets")
      .insert({
        user_address: userAddress.toLowerCase(),
        wallets_data: botWallets,
      })

    if (insertError) {
      console.error("❌ Error saving bot wallets:", insertError)
      return NextResponse.json(
        { error: "Failed to save bot wallets to database" },
        { status: 500 }
      )
    }

    console.log(`✅ Successfully created 5 bot wallets for user: ${userAddress}`)

    // Return wallet addresses only (not encrypted keys for security)
    return NextResponse.json({
      success: true,
      wallets: botWallets.map((w) => ({
        smartWalletAddress: w.smartWalletAddress,
        index: w.index,
      })),
      created: true,
    })
  } catch (error: any) {
    console.error("❌ Error in get-or-create-wallets:", error)
    console.error("   Error type:", error?.constructor?.name || typeof error)
    console.error("   Error message:", error?.message || String(error))
    console.error("   Error stack:", error?.stack || "No stack trace")
    return NextResponse.json(
      { 
        error: error?.message || "Internal server error",
        details: process.env.NODE_ENV === "development" ? error?.stack : undefined
      },
      { status: 500 }
    )
  }
}

