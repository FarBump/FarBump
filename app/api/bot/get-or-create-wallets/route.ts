import { NextRequest, NextResponse } from "next/server"
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts"
import { toSimpleSmartAccount } from "permissionless/accounts"
import { createPublicClient, http, type Address, getContractAddress, keccak256, encodePacked } from "viem"
import { base } from "viem/chains"
import { createSupabaseServiceClient } from "@/lib/supabase"
import { encryptPrivateKey } from "@/lib/bot-encryption"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

// CRITICAL: Don't initialize publicClient at module level
// Initialize it inside the POST function to ensure chain object is properly defined
// This prevents "Cannot use 'in' operator" errors in production

// Updated interface to match new wallets_data structure
interface BotWalletData {
  smart_account_address: Address
  owner_public_address: Address
  owner_private_key: string // Encrypted
  chain: string
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

    // IMPORTANT: userAddress is the Smart Wallet address from Privy (NOT Embedded Wallet)
    // This is used as the unique identifier (user_address) in all database tables
    // We do NOT use Supabase Auth (auth.uid() or getUser()) - only wallet address-based identification
    const normalizedUserAddress = userAddress.toLowerCase()

    const supabase = createSupabaseServiceClient()

    // Check if user already has bot wallets
    // Database query uses user_address column (NOT user_id)
    const { data: existingWallets, error: fetchError } = await supabase
      .from("user_bot_wallets")
      .select("wallets_data")
      .eq("user_address", normalizedUserAddress)
      .single()

    if (existingWallets && !fetchError) {
      // User already has wallets, return them
      console.log(`✅ Found existing bot wallets for user: ${userAddress}`)
      const walletsData = existingWallets.wallets_data as BotWalletData[] | BotWalletData
      
      // Handle both array and object formats
      const walletsArray = Array.isArray(walletsData) 
        ? walletsData 
        : walletsData ? [walletsData] : []
      
      // Convert to expected format for frontend
      const wallets = walletsArray.map((w, idx) => ({
        smartWalletAddress: w.smart_account_address,
        index: idx,
      }))
      
      return NextResponse.json({
        success: true,
        wallets: wallets,
        created: false,
      })
    }

    // Generate 5 new bot wallets
    console.log(`🔄 Generating 5 new bot wallets for user: ${userAddress}`)
    console.log(`   Normalized user address: ${normalizedUserAddress}`)
    
    // CRITICAL: Fix Type 'base'
    // Import base from viem/chains (already imported at top)
    // Create baseChain with explicit type property
    const baseChain = {
      ...base,
      type: 'base' as const,
    }
    
    // CRITICAL: Initialize publicClient using baseChain
    const publicClient = createPublicClient({
      chain: baseChain,
      transport: http(process.env.NEXT_PUBLIC_BASE_RPC_URL || "https://mainnet.base.org"),
    })
    
    // CRITICAL: Logging - Ensure publicClient.chain is not undefined before loop
    if (!publicClient) {
      console.error("❌ CRITICAL: publicClient is undefined")
      return NextResponse.json(
        { error: "Failed to initialize public client" },
        { status: 500 }
      )
    }
    
    if (!publicClient.chain) {
      console.error("❌ CRITICAL: publicClient.chain is undefined")
      return NextResponse.json(
        { error: "Failed to initialize public client chain object" },
        { status: 500 }
      )
    }
    
    // PENTING: Before calling toSimpleSmartAccount, ensure 'type' property exists
    // Use Object.defineProperty to make it enumerable (required for 'in' operator)
    if (!('type' in publicClient.chain)) {
      Object.defineProperty(publicClient.chain, 'type', {
        value: 'base',
        enumerable: true,
        writable: false,
        configurable: true,
      })
    }
    
    // Logging: Verify chain object before loop
    console.log(`✅ Public client initialized:`)
    console.log(`   - Chain name: ${publicClient.chain.name}`)
    console.log(`   - Chain ID: ${publicClient.chain.id}`)
    console.log(`   - Chain type: ${typeof publicClient.chain}`)
    console.log(`   - Chain has 'type' property: ${'type' in publicClient.chain}`)
    console.log(`   - Chain 'type' value: ${(publicClient.chain as any).type || 'undefined'}`)
    console.log(`   - Chain object keys: ${Object.keys(publicClient.chain).join(', ')}`)
    
    const wallets_data: BotWalletData[] = []
    
    // Constants for SimpleAccount
    const entryPointAddress = "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789" as Address
    const factoryAddress = "0x9406Cc6185a346906296840746125a0E44976454" as Address

    try {
      for (let i = 0; i < 5; i++) {
        // Generate EOA private key (Signer for bot wallet)
        const ownerPrivateKey = generatePrivateKey()
        
        // Create EOA account from private key (required as owner/signer for SimpleAccount)
        const ownerAccount = privateKeyToAccount(ownerPrivateKey)

        // Create SimpleAccount Smart Wallet address deterministically
        // Use toSimpleSmartAccount from permissionless
        let account: { address: Address } | null = null
        
        try {
          console.log(`  Creating Smart Account ${i + 1}:`)
          console.log(`    - Chain: ${publicClient.chain.name} (ID: ${publicClient.chain.id})`)
          console.log(`    - EntryPoint: ${entryPointAddress} (v0.6)`)
          console.log(`    - Factory: ${factoryAddress}`)
          console.log(`    - Index: ${i}`)
          console.log(`    - Owner (EOA Signer): ${ownerAccount.address}`)
          
          // CRITICAL: Verify chain object before each call
          if (!publicClient.chain) {
            throw new Error("Chain object is undefined before toSimpleSmartAccount call")
          }
          
          // PENTING: Before calling toSimpleSmartAccount, ensure 'type' property exists
          if (!('type' in publicClient.chain)) {
            console.warn(`   ⚠️ Chain missing 'type' property, adding it...`)
            Object.defineProperty(publicClient.chain, 'type', {
              value: 'base',
              enumerable: true,
              writable: false,
              configurable: true,
            })
          }
          
          // Casting: Use client: publicClient as any for library compatibility
          const smartAccount = await toSimpleSmartAccount({
            client: publicClient as any,
            signer: ownerAccount,
            entryPoint: {
              address: entryPointAddress,
              version: "0.6",
            },
            factoryAddress: factoryAddress,
            index: BigInt(i), // Deterministic index for this wallet
          } as any)
          
          if (smartAccount && smartAccount.address) {
            account = { address: smartAccount.address }
            console.log(`  ✅ Smart Account ${i + 1} created: ${account.address}`)
          } else {
            throw new Error("toSimpleSmartAccount returned invalid result")
          }
        } catch (accountError: any) {
          console.error(`❌ Error creating Smart Account ${i + 1}:`, accountError)
          console.error(`   Error type: ${accountError?.constructor?.name || typeof accountError}`)
          console.error(`   Error message: ${accountError?.message || String(accountError)}`)
          console.error(`   Error stack: ${accountError?.stack || "No stack trace"}`)
          
          // Check if error is about 'in' operator and 'type' property
          const errorMessage = String(accountError?.message || accountError || "")
          const isTypeError = errorMessage.includes("Cannot use 'in' operator") && errorMessage.includes("type")
          
          if (isTypeError) {
            console.error(`   🔍 Detected 'in' operator error - attempting manual chain patching...`)
            
            // Try creating a new publicClient with explicit chain patching
            try {
              // Create baseChain with explicit type property
              const retryBaseChain = {
                ...base,
                type: 'base' as const,
              }
              
              const fixedPublicClient = createPublicClient({
                chain: retryBaseChain,
                transport: http(process.env.NEXT_PUBLIC_BASE_RPC_URL || "https://mainnet.base.org"),
              })
              
              // Validate fixed client
              if (!fixedPublicClient || !fixedPublicClient.chain) {
                throw new Error("Failed to create fixed publicClient")
              }
              
              // PENTING: Before calling toSimpleSmartAccount, ensure 'type' property exists
              if (!('type' in fixedPublicClient.chain)) {
                Object.defineProperty(fixedPublicClient.chain, 'type', {
                  value: 'base',
                  enumerable: true,
                  writable: false,
                  configurable: true,
                })
              }
              
              console.log(`   Retrying with manually patched chain object...`)
              console.log(`   Chain type: ${typeof fixedPublicClient.chain}`)
              console.log(`   Chain has 'type': ${'type' in fixedPublicClient.chain}`)
              console.log(`   Chain 'type' value: ${(fixedPublicClient.chain as any).type}`)
              
              // Casting: Use client: fixedPublicClient as any
              const retryAccount = await toSimpleSmartAccount({
                client: fixedPublicClient as any,
                signer: ownerAccount,
                entryPoint: {
                  address: entryPointAddress,
                  version: "0.6",
                },
                factoryAddress: factoryAddress,
                index: BigInt(i),
              } as any)
              
              if (retryAccount && retryAccount.address) {
                account = { address: retryAccount.address }
                console.log(`  ✅ Smart Account ${i + 1} created with retry: ${account.address}`)
              } else {
                throw new Error("Retry returned invalid result")
              }
            } catch (retryError: any) {
              console.error(`   ❌ Retry also failed:`, retryError?.message)
              throw new Error(
                `Failed to create Smart Account ${i + 1}: ${accountError?.message || String(accountError)}`
              )
            }
          } else {
            // For other errors, throw immediately
            throw new Error(
              `Failed to create Smart Account ${i + 1}: ${accountError?.message || String(accountError)}`
            )
          }
        }

        // CRITICAL: Ensure account was created successfully before proceeding
        if (!account || !account.address) {
          throw new Error(`Failed to create Smart Account ${i + 1}: Account is null or missing address`)
        }

        // Enkripsi & Simpan: Encrypt private key before storage
        const encryptedPrivateKey = encryptPrivateKey(ownerPrivateKey)

        // Susun objek wallets_data sesuai struktur yang diminta
        const walletData: BotWalletData = {
          smart_account_address: account.address,
          owner_public_address: ownerAccount.address,
          owner_private_key: encryptedPrivateKey,
          chain: 'base',
        }

        wallets_data.push(walletData)

        console.log(`  Bot Wallet ${i + 1}:`)
        console.log(`    - Smart Account: ${account.address}`)
        console.log(`    - Owner (EOA): ${ownerAccount.address}`)
        console.log(`    - Chain: base`)
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

    // Save to database using upsert
    // IMPORTANT: Using user_address column (NOT user_id) - this is the Smart Wallet address
    // Use upsert to handle both insert and update cases
    const { error: upsertError } = await supabase
      .from("user_bot_wallets")
      .upsert({
        user_address: normalizedUserAddress,
        wallets_data: wallets_data,
      }, {
        onConflict: 'user_address',
      })

    if (upsertError) {
      console.error("❌ Error saving bot wallets:", upsertError)
      return NextResponse.json(
        { error: "Failed to save bot wallets to database" },
        { status: 500 }
      )
    }

    console.log(`✅ Successfully created 5 bot wallets for user: ${userAddress}`)
    console.log(`   Saved to database with user_address: ${normalizedUserAddress}`)

    // Return wallet addresses only (not encrypted keys for security)
    return NextResponse.json({
      success: true,
      wallets: wallets_data.map((w, idx) => ({
        smartWalletAddress: w.smart_account_address,
        index: idx,
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

