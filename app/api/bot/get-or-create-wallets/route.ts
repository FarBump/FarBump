import { NextRequest, NextResponse } from "next/server"
import { 
  getAddress, 
  encodeFunctionData, 
  keccak256, 
  encodeAbiParameters, 
  getContractAddress,
  type Address,
  isAddress 
} from "viem"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { createSupabaseServiceClient } from "@/lib/supabase"
import { encryptPrivateKey } from "@/lib/bot-encryption"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

// Konstanta Resmi (Base Mainnet)
const FACTORY: Address = "0x9406Cc6185a346906296840746125a0E44976454"
const ENTRY_POINT: Address = "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789"

// ABI untuk SimpleAccountFactory.createAccount
const SIMPLE_ACCOUNT_FACTORY_ABI = [
  {
    name: "createAccount",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "owner", type: "address" },
      { name: "salt", type: "uint256" }
    ],
    outputs: [{ name: "account", type: "address" }]
  }
] as const

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
 * 3. If no, generate 5 EOA private keys, calculate Smart Wallet addresses using CREATE2, encrypt, save
 * 
 * Security:
 * - Private keys are encrypted before storage
 * - Never exposed to client
 * - Only server-side operations
 * - Uses CREATE2 for deterministic address calculation (100% accurate, no library dependency)
 * 
 * PENTING: Jangan mengimpor atau memanggil toSimpleSmartAccount atau signerToSimpleSmartAccount 
 * dari permissionless di dalam file ini agar tidak memicu error internal 'in operator'
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { userAddress } = body as { userAddress: string }

    // Validation: Pastikan userAddress yang dikirim dari frontend divalidasi sebagai alamat yang benar
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

    // Generate 5 new bot wallets using CREATE2 manual calculation
    console.log(`🔄 Generating 5 new bot wallets for user: ${userAddress}`)
    console.log(`   Normalized user address: ${normalizedUserAddress}`)
    console.log(`   Using CREATE2 manual calculation (Helper Resmi Viem)`)
    console.log(`   Factory: ${FACTORY}`)
    console.log(`   EntryPoint: ${ENTRY_POINT}`)
    
    const wallets_data: BotWalletData[] = []

    try {
      for (let i = 0; i < 5; i++) {
        console.log(`\n  📝 Creating Bot Wallet ${i + 1} (Index: ${i}):`)
        
        try {
          // Step a: Generate Private Key baru
          const ownerPrivateKey = generatePrivateKey()
          if (!ownerPrivateKey || typeof ownerPrivateKey !== 'string') {
            throw new Error(`Failed to generate private key for wallet ${i + 1}`)
          }
          console.log(`    ✅ Private key generated`)
          
          // Step b: Ambil ownerAddress dari Private Key tersebut
          const ownerAccount = privateKeyToAccount(ownerPrivateKey)
          if (!ownerAccount || !ownerAccount.address) {
            throw new Error(`Failed to create owner account for wallet ${i + 1}`)
          }
          const ownerAddress = getAddress(ownerAccount.address) // Normalize to checksum format
          console.log(`    ✅ Owner address: ${ownerAddress}`)
          
          // Step c: Hitung salt menggunakan keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [ownerAddress, BigInt(i)]))
          const salt = keccak256(
            encodeAbiParameters(
              [
                { type: "address" },
                { type: "uint256" }
              ],
              [ownerAddress, BigInt(i)]
            )
          )
          console.log(`    ✅ Salt calculated: ${salt}`)
          
          // Step d: Hitung initCode (CallData untuk Factory)
          // encodeFunctionData dengan ABI createAccount(owner, salt)
          const initCode = encodeFunctionData({
            abi: SIMPLE_ACCOUNT_FACTORY_ABI,
            functionName: "createAccount",
            args: [ownerAddress, BigInt(i)]
          })
          console.log(`    ✅ InitCode (createAccount calldata): ${initCode}`)
          
          // Step e: Dapatkan smartAccountAddress menggunakan helper resmi Viem
          // getContractAddress({ from: FACTORY, salt: salt, bytecode: initCode, opcode: 'CREATE2' })
          const smartAccountAddress = getContractAddress({
            from: FACTORY,
            salt: salt,
            bytecode: initCode,
            opcode: "CREATE2"
          })
          console.log(`    ✅ Smart Account Address (CREATE2): ${smartAccountAddress}`)
          
          // Validate address
          if (!isAddress(smartAccountAddress)) {
            throw new Error(`Invalid smart account address generated for wallet ${i + 1}: ${smartAccountAddress}`)
          }
          
          // CRITICAL: Validate ownerPrivateKey before encryption
          if (!ownerPrivateKey || typeof ownerPrivateKey !== 'string') {
            throw new Error(`Private key is invalid for wallet ${i + 1}`)
          }

          // Enkripsi & Simpan: Encrypt private key before storage
          let encryptedPrivateKey: string
          try {
            encryptedPrivateKey = encryptPrivateKey(ownerPrivateKey)
            if (!encryptedPrivateKey || typeof encryptedPrivateKey !== 'string') {
              throw new Error(`Encryption failed for wallet ${i + 1}`)
            }
          } catch (encryptError: any) {
            throw new Error(`Failed to encrypt private key for wallet ${i + 1}: ${encryptError?.message || String(encryptError)}`)
          }

          // Susun objek wallets_data sesuai struktur yang diminta
          // Pastikan 'wallets_data' menyimpan 'smart_account_address: account.address'
          const walletData: BotWalletData = {
            smart_account_address: smartAccountAddress, // ✅ Menggunakan hasil CREATE2 calculation
            owner_public_address: ownerAddress,
            owner_private_key: encryptedPrivateKey,
            chain: 'base',
          }

          wallets_data.push(walletData)

          console.log(`  ✅ Bot Wallet ${i + 1} completed:`)
          console.log(`    - Smart Account Address: ${smartAccountAddress}`)
          console.log(`    - Owner (EOA): ${ownerAddress}`)
          console.log(`    - Chain: base`)
          console.log(`    - Private key encrypted: Yes`)
        } catch (walletError: any) {
          console.error(`❌ Error creating Bot Wallet ${i + 1}:`, walletError)
          console.error(`   Error type: ${walletError?.constructor?.name || typeof walletError}`)
          console.error(`   Error message: ${walletError?.message || String(walletError)}`)
          console.error(`   Error stack: ${walletError?.stack || "No stack trace"}`)
          throw new Error(
            `Failed to create Bot Wallet ${i + 1}: ${walletError?.message || String(walletError)}`
          )
        }
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

    console.log(`\n✅ Successfully created 5 bot wallets for user: ${userAddress}`)
    console.log(`   Saved to database with user_address: ${normalizedUserAddress}`)
    console.log(`   All addresses calculated using CREATE2 (100% accurate, no library dependency)`)

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
