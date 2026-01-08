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
const publicClient = createPublicClient({
  chain: base,
  transport: http(process.env.NEXT_PUBLIC_BASE_RPC_URL || "https://mainnet.base.org"),
})

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

    for (let i = 0; i < 5; i++) {
      // Generate EOA private key
      const ownerPrivateKey = generatePrivateKey()
      
      // Create EOA account from private key (required as owner/signer for SimpleAccount)
      const ownerAccount = privateKeyToAccount(ownerPrivateKey)

      // Create SimpleAccount Smart Wallet address deterministically
      // Using permissionless.js SimpleAccount (ERC-4337 compatible)
      const account = await toSimpleSmartAccount({
        client: publicClient,
        signer: ownerAccount,
        entryPoint: {
          address: "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789" as Address,
          version: "0.6",
        },
        factoryAddress: "0x9406Cc6185a346906296840746125a0E44976454" as Address, // SimpleAccountFactory on Base
        index: BigInt(i), // Deterministic index for this wallet
      } as any) // Type assertion to bypass TypeScript type checking (signer is valid parameter)

      // Encrypt private key before storage
      const encryptedPrivateKey = encryptPrivateKey(ownerPrivateKey)

      botWallets.push({
        ownerPrivateKey: encryptedPrivateKey,
        smartWalletAddress: account.address,
        index: i,
      })

      console.log(`  Bot Wallet ${i + 1}: ${account.address}`)
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
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    )
  }
}

