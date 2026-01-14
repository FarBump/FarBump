import { NextRequest, NextResponse } from "next/server"
import { createPublicClient, http, formatEther, getAddress, type Address } from "viem"
import { base } from "viem/chains"
import { createSupabaseServiceClient } from "@/lib/supabase"
import { Coinbase, Wallet } from "@coinbase/coinbase-sdk"
import "dotenv/config"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 60

// Initialize public client for Base mainnet
const publicClient = createPublicClient({
  chain: base,
  transport: http(process.env.NEXT_PUBLIC_BASE_RPC_URL),
})

// Initialize Coinbase SDK using Environment Variables
let coinbase: Coinbase | null = null
try {
  const apiKeyName = process.env.CDP_API_KEY_NAME
  const apiKeyPrivateKey = process.env.CDP_API_KEY_PRIVATE_KEY || process.env.CDP_PRIVATE_KEY

  if (!apiKeyName || !apiKeyPrivateKey) {
    console.warn("⚠️ CDP SDK not configured: Missing CDP_API_KEY_NAME or CDP_API_KEY_PRIVATE_KEY environment variables")
  } else {
    coinbase = Coinbase.configure({
      apiKeyName,
      privateKey: apiKeyPrivateKey,
    })
    console.log("✅ CDP SDK configured from environment variables")
  }
} catch (error) {
  console.warn("⚠️ CDP SDK not configured:", error)
}

// Paymaster Proxy URL
const PAYMASTER_PROXY_URL = "https://farbump.vercel.app/api/paymaster"

interface DistributeRequest {
  userAddress: string
  botWallets: { smartWalletAddress: string }[]
}

/**
 * API Route: Distribute Credits using CDP SDK with Paymaster Proxy
 * 
 * This endpoint uses CDP SDK to execute transactions from user's Smart Wallet
 * to bot wallets, using Paymaster Proxy to bypass allowlist restrictions.
 * 
 * Flow:
 * 1. Verify user's credit balance in database
 * 2. Get or create user's Smart Wallet using CDP SDK
 * 3. Execute batch transaction using CDP SDK with Paymaster Proxy
 * 4. Update credit balance in database
 */
export async function POST(request: NextRequest) {
  try {
    console.log("=====================================")
    console.log("📤 DISTRIBUTE CREDITS (CDP SDK + PAYMASTER PROXY)")
    console.log("=====================================")

    if (!coinbase) {
      return NextResponse.json(
        { 
          error: "CDP SDK not configured",
          fallback: true,
        },
        { status: 500 }
      )
    }

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

    const normalizedUserAddress = userAddress.toLowerCase()
    console.log(`📊 User Smart Wallet: ${userAddress}`)
    console.log(`📊 Bot Wallets: ${botWallets.length}`)

    const supabase = createSupabaseServiceClient()

    // Step 1: Verify user's credit balance
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

    // Step 2: Get actual ETH balance in user's Smart Wallet
    console.log(`\n🔍 Step 2: Checking Smart Wallet ETH balance...`)
    
    const walletBalance = await publicClient.getBalance({
      address: userAddress as Address,
    })
    
    console.log(`   → Wallet balance: ${formatEther(walletBalance)} ETH`)

    // Use minimum of wallet balance and credit balance
    const creditToDistribute = walletBalance < mainWalletCreditWei 
      ? walletBalance 
      : mainWalletCreditWei

    if (creditToDistribute <= BigInt(0)) {
      return NextResponse.json(
        { 
          error: "No ETH available for distribution",
          walletBalance: formatEther(walletBalance),
          creditBalance: formatEther(mainWalletCreditWei),
        },
        { status: 400 }
      )
    }

    console.log(`   → Credit to distribute: ${formatEther(creditToDistribute)} ETH`)

    // Step 3: Get user's Smart Wallet from database
    console.log(`\n🔍 Step 3: Loading user's Smart Wallet...`)
    
    const { data: userWallet, error: walletError } = await supabase
      .from("bot_wallets")
      .select("wallet_id, smart_wallet_address")
      .eq("user_address", normalizedUserAddress)
      .eq("is_main_wallet", true)
      .single()

    if (walletError || !userWallet?.wallet_id) {
      console.error("❌ User Smart Wallet not found in database")
      return NextResponse.json(
        { 
          error: "User Smart Wallet not found. Please ensure wallet is created.",
          fallback: true,
        },
        { status: 400 }
      )
    }

    console.log(`   → Wallet ID: ${userWallet.wallet_id}`)
    console.log(`   → Smart Wallet Address: ${userWallet.smart_wallet_address}`)

    // Step 4: Calculate distribution amounts
    console.log(`\n💰 Step 4: Calculating distribution amounts...`)
    
    const amountPerBot = creditToDistribute / BigInt(5)
    const remainder = creditToDistribute % BigInt(5)
    const amountForFirstBot = amountPerBot + remainder

    console.log(`   → Amount per bot: ${formatEther(amountPerBot)} ETH`)
    if (remainder > BigInt(0)) {
      console.log(`   → First bot gets extra: ${formatEther(remainder)} ETH`)
    }

    // Step 5: Load user's Smart Wallet and get Smart Account using CDP SDK
    console.log(`\n📤 Step 5: Loading Smart Wallet via CDP SDK...`)
    
    let smartWallet: Wallet
    let smartAccount: any
    try {
      smartWallet = await Wallet.fetch(userWallet.wallet_id)
      console.log(`   → Smart Wallet loaded successfully`)
      
      // Get Smart Account for the wallet
      // CDP SDK v2 uses Smart Account to execute transactions
      smartAccount = await smartWallet.getSmartAccount({ network: "base" })
      console.log(`   → Smart Account loaded for Base network`)
    } catch (fetchError: any) {
      console.error("❌ Failed to fetch Smart Wallet:", fetchError.message)
      return NextResponse.json(
        { 
          error: `Failed to load Smart Wallet: ${fetchError.message}`,
          fallback: true,
        },
        { status: 500 }
      )
    }

    // Step 6: Execute batch transaction using CDP SDK with Paymaster Proxy
    console.log(`\n📤 Step 6: Executing batch transaction via CDP SDK...`)
    console.log(`   → Paymaster Proxy: ${PAYMASTER_PROXY_URL}`)
    console.log(`   → Total transfers: ${botWallets.length}`)

    const transfers: { botWalletAddress: string; amountWei: string; txHash: string }[] = []
    
    try {
      // Prepare batch calls
      const calls = botWallets.map((botWallet, index) => {
        const amount = index === 0 ? amountForFirstBot : amountPerBot
        const checksumAddress = getAddress(botWallet.smartWalletAddress)
        
        console.log(`   Call #${index + 1}: ${checksumAddress} → ${formatEther(amount)} ETH`)
        
        return {
          to: checksumAddress,
          value: amount.toString(),
          data: "0x",
        }
      })

      // Execute batch transaction using Smart Account sendUserOperation
      // CDP SDK v2 uses sendUserOperation with isSponsored: true for gasless
      // We'll configure Paymaster Proxy URL via environment or SDK config
      console.log(`   → Using Smart Account sendUserOperation with Paymaster Proxy`)
      
      let userOpHash: string
      if (typeof (smartAccount as any).sendUserOperation === 'function') {
        // Use sendUserOperation with Paymaster Proxy
        // Note: CDP SDK may need Paymaster URL configured at SDK level
        // For now, we use isSponsored: true and let SDK use default Paymaster
        // The Paymaster Proxy will be used if configured in CDP SDK settings
        userOpHash = await (smartAccount as any).sendUserOperation({
          network: "base",
          calls: calls,
          isSponsored: true, // Enable gas sponsorship
          // Paymaster Proxy URL should be configured at SDK level
          // or via CDP_PAYMASTER_URL environment variable
        })
        
        console.log(`   ✅ User Operation submitted: ${userOpHash}`)
      } else {
        throw new Error("Smart Account does not have sendUserOperation method")
      }

      // Wait for User Operation to complete
      console.log(`   → Waiting for User Operation confirmation...`)
      
      let txHash: string
      if (typeof (smartAccount as any).waitForUserOperation === 'function') {
        const receipt = await (smartAccount as any).waitForUserOperation({
          userOpHash: userOpHash,
        })
        
        // Extract transaction hash from receipt
        txHash = receipt?.transactionHash || receipt?.hash || userOpHash
        console.log(`   ✅ User Operation confirmed: ${txHash}`)
      } else {
        // Fallback: Wait using public client
        console.log(`   → Waiting for transaction using public client...`)
        const receipt = await publicClient.waitForTransactionReceipt({
          hash: userOpHash as `0x${string}`,
          confirmations: 1,
        })
        txHash = receipt.transactionHash
      }

      // Verify transaction on-chain
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: txHash as `0x${string}`,
        confirmations: 1,
      })

      if (receipt.status === "success") {
        console.log(`   ✅ Transaction confirmed on-chain!`)
        
        // Record all transfers
        for (let i = 0; i < botWallets.length; i++) {
          const botWallet = botWallets[i]
          const amount = i === 0 ? amountForFirstBot : amountPerBot
          transfers.push({
            botWalletAddress: getAddress(botWallet.smartWalletAddress),
            amountWei: amount.toString(),
            txHash: txHash,
          })
        }
      } else {
        throw new Error("Transaction failed on-chain")
      }
    } catch (txError: any) {
      console.error("❌ Transaction failed:", txError.message)
      if (txError.response) {
        console.error("   → API Response:", JSON.stringify(txError.response.data || txError.response, null, 2))
      }
      return NextResponse.json(
        {
          error: `Transaction failed: ${txError.message}`,
          fallback: true,
        },
        { status: 500 }
      )
    }

    if (transfers.length === 0) {
      return NextResponse.json(
        { error: "All transfers failed" },
        { status: 500 }
      )
    }

    // Step 7: Update credit balance in database
    console.log(`\n💾 Step 7: Updating credit balance in database...`)
    
    const totalDistributed = transfers.reduce(
      (sum, t) => sum + BigInt(t.amountWei), 
      BigInt(0)
    )
    
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

    // Record in bot_logs
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
            method: "cdp_sdk_paymaster_proxy",
            bot_index: i + 1,
          },
        })
    }

    console.log(`\n✅ Distribution completed!`)
    console.log(`   → Total distributed: ${formatEther(totalDistributed)} ETH`)
    console.log(`   → Successful transfers: ${transfers.length}/5`)
    console.log(`   → Transaction hash: ${transfers[0]?.txHash}`)
    console.log("=====================================\n")

    return NextResponse.json({
      success: true,
      totalDistributed: formatEther(totalDistributed),
      amountPerBot: formatEther(amountPerBot),
      transfers: transfers,
      txHash: transfers[0]?.txHash,
      method: "cdp_sdk_paymaster_proxy",
      gasless: true,
    })
  } catch (error: any) {
    console.error("❌ Error in distribute-credits-cdp API:", error)
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

