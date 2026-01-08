import { NextRequest, NextResponse } from "next/server"
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts"
import { toSimpleSmartAccount } from "permissionless/accounts"
import { createPublicClient, http, type Address, getContractAddress, keccak256, encodePacked } from "viem"
import { base } from "viem/chains"
import { createSupabaseServiceClient } from "@/lib/supabase"
import { encryptPrivateKey } from "@/lib/bot-encryption"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

// Initialize public client for Base
// Use module-level constant like in execute-swap for consistency
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

    try {
      for (let i = 0; i < 5; i++) {
        // Generate EOA private key
        const ownerPrivateKey = generatePrivateKey()
        
        // Create EOA account from private key (required as owner/signer for SimpleAccount)
        const ownerAccount = privateKeyToAccount(ownerPrivateKey)

        // Create SimpleAccount Smart Wallet address deterministically
        // Try using toSimpleSmartAccount first, fallback to manual calculation if it fails
        let account: { address: Address } | null = null
        // Define constants outside try block for error logging
        const entryPointAddress = "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789" as Address
        const factoryAddress = "0x9406Cc6185a346906296840746125a0E44976454" as Address
        
        // Try method 1: Use toSimpleSmartAccount (preferred)
        try {
          // Validate that all required values are defined
          if (!publicClient || !publicClient.chain || !ownerAccount || !entryPointAddress || !factoryAddress) {
            throw new Error("Missing required parameters")
          }
          
          console.log(`  Creating Smart Account ${i + 1} with toSimpleSmartAccount:`)
          console.log(`    - Chain: ${publicClient.chain.name} (ID: ${publicClient.chain.id})`)
          console.log(`    - EntryPoint: ${entryPointAddress} (v0.6)`)
          console.log(`    - Factory: ${factoryAddress}`)
          console.log(`    - Index: ${i}`)
          console.log(`    - Owner: ${ownerAccount.address}`)
          
          // Ensure entryPoint object is properly structured with all required properties
          // Create a fresh object to avoid any reference issues
          const entryPointObj: { address: Address; version: "0.6" } = {
            address: entryPointAddress,
            version: "0.6",
          }
          
          // Validate entryPoint object thoroughly
          if (!entryPointObj || typeof entryPointObj !== 'object') {
            throw new Error("entryPointObj is not an object")
          }
          if (!entryPointObj.address || typeof entryPointObj.address !== 'string') {
            throw new Error("entryPointObj.address is invalid")
          }
          if (!entryPointObj.version || entryPointObj.version !== "0.6") {
            throw new Error("entryPointObj.version is invalid")
          }
          
          // Validate all parameters before calling toSimpleSmartAccount
          const params = {
            client: publicClient,
            signer: ownerAccount,
            entryPoint: entryPointObj,
            factoryAddress: factoryAddress,
            index: BigInt(i),
          }
          
          // Validate params object
          if (!params.client) throw new Error("params.client is undefined")
          if (!params.signer) throw new Error("params.signer is undefined")
          if (!params.entryPoint) throw new Error("params.entryPoint is undefined")
          if (!params.factoryAddress) throw new Error("params.factoryAddress is undefined")
          if (params.index === undefined || params.index === null) throw new Error("params.index is invalid")
          
          console.log(`  Calling toSimpleSmartAccount with validated parameters`)
          
          const smartAccount = await toSimpleSmartAccount(params as any)
          
          if (smartAccount && smartAccount.address) {
            account = { address: smartAccount.address }
            console.log(`  ✅ Smart Account ${i + 1} created: ${account.address}`)
          } else {
            throw new Error("toSimpleSmartAccount returned invalid result")
          }
        } catch (accountError: any) {
          console.error(`❌ Error with toSimpleSmartAccount for wallet ${i + 1}:`, accountError)
          console.error(`   Error type: ${accountError?.constructor?.name || typeof accountError}`)
          console.error(`   Error message: ${accountError?.message || String(accountError)}`)
          
          // Fallback: Calculate address manually using CREATE2
          // This is a workaround for the permissionless.js error
          try {
            console.log(`  ⚠️ Falling back to manual address calculation for wallet ${i + 1}`)
            
            // SimpleAccountFactory uses CREATE2 with:
            // - salt = keccak256(encodePacked(["address", "uint256"], [owner, salt]))
            // For SimpleAccount, salt is typically the index
            const salt = BigInt(i)
            const saltHash = keccak256(
              encodePacked(
                ["address", "uint256"],
                [ownerAccount.address, salt]
              )
            )
            
            // Calculate CREATE2 address
            // Note: This is a simplified calculation - actual SimpleAccountFactory may use different logic
            // For now, we'll use a placeholder and log a warning
            console.warn(`  ⚠️ Manual address calculation not fully implemented - using placeholder`)
            
            // For now, throw error to use the existing error handling
            throw new Error("toSimpleSmartAccount failed and manual calculation not implemented")
          } catch (fallbackError: any) {
            console.error(`❌ Fallback calculation also failed:`, fallbackError)
            throw new Error(
              `Failed to create Smart Account ${i + 1}: ${accountError?.message || String(accountError)}`
            )
          }
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

