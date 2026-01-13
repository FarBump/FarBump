import { NextRequest, NextResponse } from "next/server"
import { 
  createPublicClient, 
  createWalletClient,
  http, 
  formatEther, 
  getAddress, 
  encodeFunctionData,
  parseAbi,
  type Address,
  type Hex,
} from "viem"
import { base } from "viem/chains"
import { privateKeyToAccount } from "viem/accounts"
import { createSupabaseServiceClient } from "@/lib/supabase"
import "dotenv/config"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 60

// Initialize public client for Base mainnet
const publicClient = createPublicClient({
  chain: base,
  transport: http(process.env.NEXT_PUBLIC_BASE_RPC_URL),
})

// Relayer wallet - pays gas for users
// This should be a funded EOA that can pay gas on behalf of users
const RELAYER_PRIVATE_KEY = process.env.RELAYER_PRIVATE_KEY as Hex | undefined

// Coinbase Smart Wallet ABI for execute and executeBatch
const SMART_WALLET_ABI = parseAbi([
  "function execute(address target, uint256 value, bytes data) payable",
  "function executeBatch((address target, uint256 value, bytes data)[] calls) payable",
  "function isOwner(address account) view returns (bool)",
  "function entryPoint() view returns (address)",
])

interface DistributeRequest {
  userAddress: string
  botWallets: { smartWalletAddress: string }[]
  // Optional: signed authorization from the user
  signature?: string
  signedMessage?: string
}

/**
 * API Route: Distribute Credits from User's Smart Wallet to Bot Wallets
 * 
 * This endpoint handles credit distribution using a RELAYER pattern:
 * 1. Verifies user's credit balance in database
 * 2. Uses a backend relayer wallet to send ETH to bot wallets
 * 3. Deducts credit from user's database balance
 * 
 * This bypasses Paymaster allowlist issues by not going through the bundler.
 * The user's ETH stays in their Smart Wallet until they withdraw it.
 * 
 * Required environment variable:
 * - RELAYER_PRIVATE_KEY: Private key of the relayer wallet (must be funded with ETH)
 */
export async function POST(request: NextRequest) {
  try {
    console.log("=====================================")
    console.log("📤 DISTRIBUTE CREDITS API CALLED")
    console.log("=====================================")

    // Parse request body
    const body: DistributeRequest = await request.json()
    const { userAddress, botWallets } = body

    // Validate inputs
    if (!userAddress) {
      return NextResponse.json(
        { error: "Missing userAddress" },
        { status: 400 }
      )
    }

    if (!botWallets || !Array.isArray(botWallets) || botWallets.length !== 5) {
      return NextResponse.json(
        { error: "Expected exactly 5 bot wallets" },
        { status: 400 }
      )
    }

    // Check if relayer is configured
    if (!RELAYER_PRIVATE_KEY) {
      console.log("⚠️ RELAYER_PRIVATE_KEY not configured - fallback to frontend distribution")
      return NextResponse.json(
        { 
          fallback: true,
          error: "Backend relayer not configured. Please use frontend distribution." 
        },
        { status: 200 }
      )
    }

    const normalizedUserAddress = userAddress.toLowerCase()
    console.log(`📊 User Smart Wallet: ${userAddress}`)
    console.log(`📊 Bot Wallets: ${botWallets.length}`)

    const supabase = createSupabaseServiceClient()

    // Step 1: Verify user's credit balance in database
    console.log(`\n🔍 Step 1: Verifying user's credit balance...`)
    
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

    const mainWalletCreditWei = BigInt(creditData?.balance_wei || "0")
    console.log(`   → Main wallet credit: ${formatEther(mainWalletCreditWei)} ETH`)

    if (mainWalletCreditWei <= BigInt(0)) {
      return NextResponse.json(
        { error: "No credit available in main wallet. Please convert $BUMP to credit first." },
        { status: 400 }
      )
    }

    // Step 2: Check relayer wallet balance
    console.log(`\n🔍 Step 2: Checking relayer wallet balance...`)
    
    const relayerAccount = privateKeyToAccount(RELAYER_PRIVATE_KEY)
    const relayerBalance = await publicClient.getBalance({
      address: relayerAccount.address,
    })
    
    console.log(`   → Relayer address: ${relayerAccount.address}`)
    console.log(`   → Relayer balance: ${formatEther(relayerBalance)} ETH`)

    // Estimate gas cost for 5 transfers
    const estimatedGasPerTransfer = BigInt(21000) // Basic ETH transfer
    const gasPrice = await publicClient.getGasPrice()
    const totalGasCost = estimatedGasPerTransfer * BigInt(5) * gasPrice * BigInt(2) // 2x buffer
    
    console.log(`   → Estimated gas cost: ${formatEther(totalGasCost)} ETH`)

    // Use minimum of credit balance and available relayer balance (minus gas)
    const availableForDistribution = relayerBalance > totalGasCost 
      ? relayerBalance - totalGasCost 
      : BigInt(0)
    
    const creditToDistribute = mainWalletCreditWei < availableForDistribution
      ? mainWalletCreditWei
      : availableForDistribution

    if (creditToDistribute <= BigInt(0)) {
      return NextResponse.json(
        { 
          error: "Insufficient balance in relayer wallet",
          relayerBalance: formatEther(relayerBalance),
          requiredGas: formatEther(totalGasCost),
          creditBalance: formatEther(mainWalletCreditWei),
          fallback: true, // Signal frontend to try its own method
        },
        { status: 400 }
      )
    }

    console.log(`   → Credit to distribute: ${formatEther(creditToDistribute)} ETH`)

    // Step 3: Calculate distribution amounts
    console.log(`\n💰 Step 3: Calculating distribution amounts...`)
    
    const amountPerBot = creditToDistribute / BigInt(5)
    const remainder = creditToDistribute % BigInt(5)
    const amountForFirstBot = amountPerBot + remainder

    console.log(`   → Amount per bot: ${formatEther(amountPerBot)} ETH`)
    if (remainder > BigInt(0)) {
      console.log(`   → First bot gets extra: ${formatEther(remainder)} ETH`)
    }

    // Step 4: Create wallet client for relayer
    console.log(`\n📤 Step 4: Executing transfers via relayer...`)
    
    const walletClient = createWalletClient({
      account: relayerAccount,
      chain: base,
      transport: http(process.env.NEXT_PUBLIC_BASE_RPC_URL),
    })

    const transfers: { botWalletAddress: string; amountWei: string; txHash: string }[] = []
    
    for (let i = 0; i < botWallets.length; i++) {
      const botWallet = botWallets[i]
      const amount = i === 0 ? amountForFirstBot : amountPerBot
      const checksumAddress = getAddress(botWallet.smartWalletAddress)
      
      console.log(`\n   📤 Transfer ${i + 1}/5 to Bot #${i + 1}`)
      console.log(`      Address: ${checksumAddress}`)
      console.log(`      Amount: ${formatEther(amount)} ETH`)
      
      try {
        // Send ETH from relayer to bot wallet
        const txHash = await walletClient.sendTransaction({
          to: checksumAddress,
          value: amount,
        })
        
        console.log(`      ✅ Transaction sent: ${txHash}`)
        
        // Wait for confirmation
        const receipt = await publicClient.waitForTransactionReceipt({
          hash: txHash,
          confirmations: 1,
        })
        
        if (receipt.status === "success") {
          console.log(`      ✅ Transaction confirmed`)
          transfers.push({
            botWalletAddress: checksumAddress,
            amountWei: amount.toString(),
            txHash: txHash,
          })
        } else {
          console.error(`      ❌ Transaction failed on-chain`)
        }
      } catch (transferError: any) {
        console.error(`      ❌ Transfer failed:`, transferError.message)
        // Continue with other transfers even if one fails
      }
    }

    if (transfers.length === 0) {
      return NextResponse.json(
        { error: "All transfers failed" },
        { status: 500 }
      )
    }

    // Step 5: Update credit balance in database
    console.log(`\n💾 Step 5: Updating credit balance in database...`)
    
    // Calculate total actually distributed
    const totalDistributed = transfers.reduce(
      (sum, t) => sum + BigInt(t.amountWei), 
      BigInt(0)
    )
    
    // Deduct from main wallet credit
    const newCreditBalance = mainWalletCreditWei - totalDistributed
    
    const { error: updateError } = await supabase
      .from("user_credits")
      .update({ 
        balance_wei: newCreditBalance.toString(),
        updated_at: new Date().toISOString(),
      })
      .eq("user_address", normalizedUserAddress)

    if (updateError) {
      console.error("⚠️ Failed to update credit balance:", updateError)
    } else {
      console.log(`   → New credit balance: ${formatEther(newCreditBalance)} ETH`)
    }

    // Record distributions in bot_wallet_credits
    for (const transfer of transfers) {
      await supabase
        .from("bot_wallet_credits")
        .upsert({
          user_address: normalizedUserAddress,
          bot_wallet_address: transfer.botWalletAddress.toLowerCase(),
          distributed_amount_wei: transfer.amountWei,
          updated_at: new Date().toISOString(),
        }, {
          onConflict: "user_address,bot_wallet_address",
        })
    }

    // Record each transfer in bot_logs
    for (let i = 0; i < transfers.length; i++) {
      const transfer = transfers[i]
      await supabase
        .from("bot_logs")
        .insert({
          user_address: normalizedUserAddress,
          bot_wallet_address: transfer.botWalletAddress.toLowerCase(),
          action: "credit_distribution",
          status: "success",
          tx_hash: transfer.txHash,
          details: {
            amount_eth: formatEther(BigInt(transfer.amountWei)),
            amount_wei: transfer.amountWei,
            method: "backend_relayer",
            bot_index: i + 1,
          },
        })
    }

    console.log(`\n✅ Distribution completed!`)
    console.log(`   → Total distributed: ${formatEther(totalDistributed)} ETH`)
    console.log(`   → Successful transfers: ${transfers.length}/5`)
    console.log("=====================================\n")

    return NextResponse.json({
      success: true,
      totalDistributed: formatEther(totalDistributed),
      amountPerBot: formatEther(amountPerBot),
      transfers: transfers,
      txHash: transfers[0]?.txHash, // Primary tx hash for reference
      method: "backend_relayer",
    })
  } catch (error: any) {
    console.error("❌ Error in distribute-credits API:", error)
    return NextResponse.json(
      {
        error: "Internal server error",
        details: error.message,
        fallback: true,
      },
      { status: 500 }
    )
  }
}

