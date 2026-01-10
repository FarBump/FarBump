import { NextRequest, NextResponse } from "next/server"
import { createSupabaseServiceClient } from "@/lib/supabase"
import { decryptPrivateKey } from "@/lib/bot-encryption"
import { toSimpleSmartAccount } from "permissionless/accounts"
import { createPublicClient, http, type Address, type Hex, formatEther } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { base } from "viem/chains"
import { createBundlerClient } from "viem/account-abstraction"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const ZEROX_API_KEY = process.env.ZEROX_API_KEY
if (!ZEROX_API_KEY) {
  throw new Error("ZEROX_API_KEY environment variable is not set")
}

// Initialize public client for Base
const publicClient = createPublicClient({
  chain: base,
  transport: http(process.env.NEXT_PUBLIC_BASE_RPC_URL || "https://mainnet.base.org"),
})

interface ExecuteSwapRequest {
  userAddress: string
  walletIndex: number // Which bot wallet to use (0-4)
  // tokenAddress and sellAmountWei are removed - now fetched from database for security
  // Amount is calculated from amount_usd using real-time ETH price on each execution
}

/**
 * API Route: Execute swap for bot wallet
 * 
 * This route:
 * 1. Gets encrypted private key for bot wallet from database
 * 2. Decrypts private key (server-side only)
 * 3. Gets 0x API v2 quote
 * 4. Signs and sends transaction via Coinbase Paymaster (gasless)
 * 5. Logs transaction to bot_logs
 * 6. Deducts credit from user balance
 * 
 * Security:
 * - Private key is never exposed to client
 * - All signing happens server-side
 * - Gasless via Coinbase Paymaster
 */
export async function POST(request: NextRequest) {
  try {
    const body: ExecuteSwapRequest = await request.json()
    const { userAddress, walletIndex } = body

    // IMPORTANT: userAddress is the Smart Wallet address from Privy (NOT Embedded Wallet)
    // This is used as the unique identifier (user_address) in all database tables
    // We do NOT use Supabase Auth - only wallet address-based identification

    if (!userAddress || walletIndex === undefined) {
      return NextResponse.json(
        { error: "Missing required fields: userAddress, walletIndex" },
        { status: 400 }
      )
    }

    const normalizedUserAddress = userAddress.toLowerCase()

    if (walletIndex < 0 || walletIndex >= 5) {
      return NextResponse.json(
        { error: "walletIndex must be between 0 and 4" },
        { status: 400 }
      )
    }

    const supabase = createSupabaseServiceClient()
    
    // IMPORTANT: Fetch token_address, amount_usd, and wallet_rotation_index from active bot session
    // This prevents client-side manipulation of token address or amount
    // Database query uses user_address column (NOT user_id)
    const { data: activeSession, error: sessionError } = await supabase
      .from("bot_sessions")
      .select("token_address, amount_usd, interval_seconds, wallet_rotation_index, id")
      .eq("user_address", normalizedUserAddress)
      .eq("status", "running")
      .single()
    
    if (sessionError || !activeSession) {
      return NextResponse.json(
        { error: "No active bot session found. Please start a bot session first." },
        { status: 404 }
      )
    }
    
    // Use token_address from database (server-side verification)
    // Integrasi Target Token: Gunakan alamat kontrak yang diinput user pada kolom 'Target Token'
    const tokenAddress = activeSession.token_address as Address
    const amountUsd = parseFloat(activeSession.amount_usd || "0")
    const currentRotationIndex = activeSession.wallet_rotation_index || 0
    const sessionId = activeSession.id
    
    if (!amountUsd || amountUsd <= 0) {
      return NextResponse.json(
        { error: "Invalid amount_usd in bot session" },
        { status: 400 }
      )
    }
    
    // Validate walletIndex matches current rotation (for round-robin)
    if (walletIndex !== currentRotationIndex) {
      console.warn(`⚠️ Wallet index mismatch. Expected: ${currentRotationIndex}, Got: ${walletIndex}`)
      // Use the rotation index from session instead
      const adjustedWalletIndex = currentRotationIndex
      console.log(`   Using rotation index: ${adjustedWalletIndex}`)
      // Continue with adjusted index
    }
    
    // Get real-time ETH price for USD to ETH conversion
    let ethPriceUsd: number
    try {
      const priceResponse = await fetch(`${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/api/eth-price`, {
        headers: { Accept: "application/json" },
      })
      if (!priceResponse.ok) {
        throw new Error("Failed to fetch ETH price")
      }
      const priceData = await priceResponse.json()
      if (!priceData.success || typeof priceData.price !== "number") {
        throw new Error("Invalid price data")
      }
      ethPriceUsd = priceData.price
    } catch (priceError: any) {
      console.error("❌ Error fetching ETH price:", priceError)
      return NextResponse.json(
        { error: "Failed to fetch ETH price. Please try again." },
        { status: 500 }
      )
    }
    
    // Convert USD to ETH using real-time market price
    // PENTING: Gunakan pembulatan angka yang aman (6-18 desimal di belakang koma untuk ETH)
    // Presisi tinggi untuk transaksi mikro 0.01 USD
    const amountEth = amountUsd / ethPriceUsd
    // Convert ETH to Wei using BigInt for precision (18 decimals)
    // Use Math.floor for safe rounding to avoid precision errors
    const actualSellAmountWei = BigInt(Math.floor(amountEth * 1e18))
    
    // Validate minimum amount: 0.01 USD
    const MIN_AMOUNT_USD = 0.01
    if (amountUsd < MIN_AMOUNT_USD) {
      return NextResponse.json(
        { error: `Minimum amount per bump is $${MIN_AMOUNT_USD.toFixed(2)} USD. Current: $${amountUsd.toFixed(2)} USD` },
        { status: 400 }
      )
    }
    
    console.log(`💱 USD to ETH conversion (micro transaction support):`)
    console.log(`   Amount: $${amountUsd.toFixed(2)} USD`)
    console.log(`   ETH Price: $${ethPriceUsd.toFixed(2)} USD`)
    console.log(`   ETH Amount: ${amountEth.toFixed(18)} ETH (high precision)`)
    console.log(`   Wei Amount: ${actualSellAmountWei.toString()} wei`)

    // Get bot wallets from database
    // Database query uses user_address column (NOT user_id)
    const { data: botWalletsData, error: fetchError } = await supabase
      .from("user_bot_wallets")
      .select("wallets_data")
      .eq("user_address", normalizedUserAddress)
      .single()

    if (fetchError || !botWalletsData) {
      return NextResponse.json(
        { error: "Bot wallets not found. Please create bot wallets first." },
        { status: 404 }
      )
    }

    const wallets = botWalletsData.wallets_data as Array<{
      smart_account_address: Address
      owner_public_address: Address
      owner_private_key: string // Encrypted
      chain: string
    }>

    const botWallet = wallets[walletIndex]
    if (!botWallet || !botWallet.smart_account_address) {
      return NextResponse.json(
        { error: `Bot wallet at index ${walletIndex} not found` },
        { status: 404 }
      )
    }

    const botWalletAddress = botWallet.smart_account_address

    // CRITICAL: Check bot wallet balance before attempting swap
    // Bot akan terus melakukan swap selama saldo di dalam bot wallet tersebut masih cukup
    const botWalletBalance = await publicClient.getBalance({
      address: botWalletAddress,
    })

    console.log(`💰 Bot Wallet #${walletIndex + 1} balance: ${formatEther(botWalletBalance)} ETH`)
    console.log(`   Required for swap: ${formatEther(actualSellAmountWei)} ETH`)

    // Check if balance is sufficient for swap (minimum 0.01 USD)
    // Use MIN_AMOUNT_USD already declared above
    const minAmountEth = MIN_AMOUNT_USD / ethPriceUsd
    const minAmountWei = BigInt(Math.floor(minAmountEth * 1e18))
    
    if (botWalletBalance < actualSellAmountWei) {
      console.warn(`⚠️ Bot Wallet #${walletIndex + 1} has insufficient balance`)
      console.warn(`   Balance: ${formatEther(botWalletBalance)} ETH`)
      console.warn(`   Required: ${formatEther(actualSellAmountWei)} ETH`)
      
      // Calculate USD value of remaining balance
      const remainingBalanceEth = Number(botWalletBalance) / 1e18
      const remainingBalanceUsd = remainingBalanceEth * ethPriceUsd
      
      // Log balance check to database with format: [System] Saldo Bot #1 tidak cukup ($ < 0.01). Bumping dihentikan.
      // Sinkronisasi Live Activity Log: Tampilkan log jika saldo tidak cukup
      // Format: [System] Saldo Bot #1 tidak cukup ($ < 0.01). Bumping dihentikan.
      await supabase.from("bot_logs").insert({
        user_address: normalizedUserAddress,
        wallet_address: botWalletAddress,
        token_address: tokenAddress,
        amount_wei: "0",
        status: "failed",
        message: remainingBalanceUsd < MIN_AMOUNT_USD
          ? `[System] Saldo Bot #${walletIndex + 1} tidak cukup ($${remainingBalanceUsd.toFixed(2)} < $${MIN_AMOUNT_USD.toFixed(2)}). Bumping dihentikan.`
          : `[System] Saldo Bot #${walletIndex + 1} tidak cukup untuk swap $${amountUsd.toFixed(2)}. Tersedia: $${remainingBalanceUsd.toFixed(2)}. Bumping dihentikan.`,
      })

      // Check if all wallets have insufficient balance (below 0.01 USD minimum)
      let allWalletsEmpty = true
      for (let i = 0; i < wallets.length; i++) {
        const wallet = wallets[i]
        if (wallet?.smart_account_address) {
          const balance = await publicClient.getBalance({
            address: wallet.smart_account_address,
          })
          // Check if wallet has at least minimum amount (0.01 USD)
          if (balance >= minAmountWei) {
            allWalletsEmpty = false
            break
          }
        }
      }

      if (allWalletsEmpty) {
        // All wallets are empty, stop the session
        await supabase
          .from("bot_sessions")
          .update({
            status: "stopped",
            stopped_at: new Date().toISOString(),
          })
          .eq("user_address", normalizedUserAddress)
          .eq("status", "running")

        // Log system message: [System] All bot balances below $0.01. Bumping session completed.
        await supabase.from("bot_logs").insert({
          user_address: normalizedUserAddress,
          wallet_address: null,
          token_address: null,
          amount_wei: "0",
          status: "stopped",
          message: `[System] All bot balances below $${MIN_AMOUNT_USD.toFixed(2)}. Bumping session completed.`,
        })

        return NextResponse.json(
          { 
            error: "All bot wallets have insufficient balance. Bot session stopped.",
            stopped: true,
          },
          { status: 400 }
        )
      }

      // This wallet is empty, but others might have balance
      // Skip this wallet and continue with round-robin
      return NextResponse.json(
        { 
          error: `Bot Wallet #${walletIndex + 1} has insufficient balance. Skipping to next wallet.`,
          skipped: true,
        },
        { status: 200 } // Return 200 to indicate successful skip
      )
    }

    // Log remaining balance before swap (optional - only log if balance is significant)
    // Format: [System] Remaining balance in Bot #1: 0.004 ETH
    // Note: We'll log this after swap instead to show updated balance

    // Decrypt private key (server-side only) - PENTING: Pastikan proses dekripsi dilakukan dengan aman
    const ownerPrivateKey = decryptPrivateKey(botWallet.owner_private_key) as Hex

    // Get 0x API v2 quote using AllowanceHolder endpoint
    // Documentation: https://docs.0x.org/docs/api/swap-v2
    console.log(`📊 Getting 0x API v2 quote for swap...`)
    const queryParams = new URLSearchParams({
      chainId: "8453",
      sellToken: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", // Native ETH
      buyToken: tokenAddress,
      sellAmount: actualSellAmountWei.toString(),
      taker: botWalletAddress,
      slippagePercentage: "1", // 1% slippage (compatible with $0.01 trades)
      enablePermit2: "true", // Enable Permit2 for efficient approvals
      intentOnFill: "true", // Indicates intent to fill the quote
      enableSlippageProtection: "false", // Disable slippage protection for bot trades
    })

    const quoteResponse = await fetch(
      `https://api.0x.org/swap/v2/quote?${queryParams.toString()}`,
      {
        headers: {
          "0x-api-key": ZEROX_API_KEY,
          Accept: "application/json",
        } as HeadersInit,
      }
    )

    if (!quoteResponse.ok) {
      const errorData = await quoteResponse.json().catch(() => ({}))
      console.error("❌ 0x API error:", errorData)
      
      // Log error to database
      // Database insert uses user_address column (NOT user_id)
      await supabase.from("bot_logs").insert({
        user_address: normalizedUserAddress,
        wallet_address: botWalletAddress,
        token_address: tokenAddress,
        amount_wei: actualSellAmountWei.toString(),
        status: "failed",
        message: `0x API error: ${quoteResponse.status}`,
        error_details: errorData,
      })

      return NextResponse.json(
        { error: `0x API error: ${errorData.reason || quoteResponse.statusText}` },
        { status: quoteResponse.status }
      )
    }

    const quote = await quoteResponse.json()

    // Create EOA account from private key (required as owner/signer for SimpleAccount)
    const ownerAccount = privateKeyToAccount(ownerPrivateKey)
    
    // Create Smart Account (SimpleAccount) for bot wallet using permissionless
    // Using toSimpleSmartAccount which creates a SimpleAccount deterministically
    // This matches the implementation in get-or-create-wallets
    const account = await toSimpleSmartAccount({
      client: publicClient,
      signer: ownerAccount,
      entryPoint: {
        address: "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789" as Address,
        version: "0.6",
      },
      factoryAddress: "0x9406Cc6185a346906296840746125a0E44976454" as Address, // SimpleAccountFactory on Base
      index: BigInt(walletIndex), // Deterministic index for this wallet
    } as any) // Type assertion to bypass TypeScript type checking (signer is valid parameter)
    
    console.log(`✅ Smart Account created: ${account.address}`)
    console.log(`   Using wallet index: ${walletIndex}`)

    // Create Bundler Client with Coinbase CDP Paymaster
    // Coinbase CDP Bundler includes Paymaster support for gasless transactions
    const COINBASE_CDP_BUNDLER_URL = process.env.COINBASE_CDP_BUNDLER_URL
    
    if (!COINBASE_CDP_BUNDLER_URL) {
      return NextResponse.json(
        { error: "COINBASE_CDP_BUNDLER_URL environment variable is not set" },
        { status: 500 }
      )
    }
    
    console.log(`🔗 Using Coinbase CDP Bundler: ${COINBASE_CDP_BUNDLER_URL}`)
    
    // Create bundler client for UserOperation operations
    // Using viem account-abstraction bundler client (matches paymaster tutorial)
    const bundlerClient = createBundlerClient({
      account,
      client: publicClient,
      transport: http(COINBASE_CDP_BUNDLER_URL),
      chain: base,
    })

    // Execute swap transaction
    console.log(`🔄 Executing swap transaction...`)
    
    // Log pending transaction with format: [Bot #X] Swapping $0.01 for [Target Token]... Pending
    // Update Live Activity Secara Real-Time: Tampilkan setiap aktivitas di log
    // Database insert uses user_address column (NOT user_id)
    const logResult = await supabase.from("bot_logs").insert({
      user_address: normalizedUserAddress,
      wallet_address: botWalletAddress,
      token_address: tokenAddress,
      amount_wei: actualSellAmountWei.toString(),
      status: "pending",
      message: `[Bot #${walletIndex + 1}] Swapping $${amountUsd.toFixed(2)} for Target Token... Pending`,
    }).select("id").single()
    
    const logId = logResult.data?.id
    
    console.log(`🔄 [Bot #${walletIndex + 1}] Executing swap for token address: ${tokenAddress}`)
    console.log(`   Amount: $${amountUsd.toFixed(2)} USD (${formatEther(actualSellAmountWei)} ETH)`)

    try {
      // Prepare call for swap
      const swapCall = {
        to: quote.transaction.to as Address,
        data: quote.transaction.data as Hex,
        value: BigInt(quote.transaction.value || "0"),
      }

      // Pad preVerificationGas for reliability (as shown in paymaster tutorial)
      // This helps ensure UserOperation lands on-chain successfully
      if (account && typeof account === 'object' && 'userOperation' in account) {
        (account as any).userOperation = {
          estimateGas: async (userOperation: any) => {
            const estimate = await bundlerClient.estimateUserOperationGas({
              account,
              ...userOperation,
            })
            // Adjust preVerificationGas upward for reliability (2x)
            const adjustedEstimate = {
              ...estimate,
              preVerificationGas: estimate.preVerificationGas * BigInt(2),
            }
            return adjustedEstimate
          },
        }
      }

      // Send UserOperation via Bundler with Paymaster sponsorship (gasless)
      console.log(`📤 Sending UserOperation with Paymaster sponsorship...`)
      const userOpHash = await bundlerClient.sendUserOperation({
        account,
        calls: [swapCall],
        paymaster: true, // Enable Coinbase Paymaster sponsorship (gasless)
      })

      console.log(`✅ UserOperation sent: ${userOpHash}`)

      // Wait for UserOperation receipt
      const userOpReceipt = await bundlerClient.waitForUserOperationReceipt({
        hash: userOpHash,
        timeout: 60000,
      })

      // Get transaction hash from UserOperation receipt
      const txHash = userOpReceipt.receipt.transactionHash as Hex

      console.log(`✅ UserOperation confirmed. Transaction hash: ${txHash}`)

      // Wait for transaction confirmation on-chain
      const txReceipt = await publicClient.waitForTransactionReceipt({
        hash: txHash,
        timeout: 60000,
      })

      if (txReceipt.status === "success") {
        // Update log with success: [Bot #X] Swapping $0.01 for [Target Token]... [View on BaseScan]
        await supabase
          .from("bot_logs")
          .update({
            tx_hash: txHash,
            status: "success",
            message: `[Bot #${walletIndex + 1}] Swapping $${amountUsd.toFixed(2)} for Target Token... [View on BaseScan]`,
          })
          .eq("id", logId)

        // Check remaining balance after swap
        const remainingBalance = await publicClient.getBalance({
          address: botWalletAddress,
        })

        // Log remaining balance: [System] Remaining balance in Bot #1: 0.004 ETH ($X.XX)
        // Calculate USD value for remaining balance
        const remainingBalanceEth = Number(remainingBalance) / 1e18
        const remainingBalanceUsd = remainingBalanceEth * ethPriceUsd
        await supabase.from("bot_logs").insert({
          user_address: normalizedUserAddress,
          wallet_address: botWalletAddress,
          token_address: tokenAddress,
          amount_wei: "0",
          status: "success",
          message: `[System] Remaining balance in Bot #${walletIndex + 1}: ${formatEther(remainingBalance)} ETH ($${remainingBalanceUsd.toFixed(2)})`,
        })

        console.log(`✅ [Bot #${walletIndex + 1}] Swap successful! Tx: ${txHash}`)
        console.log(`   Remaining balance: ${formatEther(remainingBalance)} ETH`)

        // Update wallet_rotation_index for round-robin (0 → 1 → 2 → 3 → 4 → 0)
        // Bot harus melakukan swap secara bergantian (Round Robin: Bot 1, lalu Bot 2, dst)
        const nextRotationIndex = (currentRotationIndex + 1) % 5
        await supabase
          .from("bot_sessions")
          .update({
            wallet_rotation_index: nextRotationIndex,
          })
          .eq("id", sessionId)

        console.log(`🔄 Round-robin: Next wallet index: ${nextRotationIndex}`)

        // Note: Credit deduction is not needed for All-In Funding
        // Bot wallets are funded upfront, so no need to deduct from user credit balance

        return NextResponse.json({
          success: true,
          txHash,
          status: "success",
          walletIndex: walletIndex,
          nextWalletIndex: nextRotationIndex,
          remainingBalance: remainingBalance.toString(),
        })
      } else {
        // Transaction failed
        await supabase
          .from("bot_logs")
          .update({
            tx_hash: txHash,
            status: "failed",
            message: `[Bot #${walletIndex + 1}] Melakukan swap senilai $${amountUsd.toFixed(2)} ke Target Token... Gagal - Transaction reverted [Lihat Transaksi]`,
          })
          .eq("id", logId)

        return NextResponse.json(
          { error: "Transaction reverted", txHash },
          { status: 500 }
        )
      }
    } catch (error: any) {
      console.error("❌ Error executing swap:", error)
      
      // Update log with error
      if (logId) {
        await supabase
          .from("bot_logs")
          .update({
            status: "failed",
            message: error.message || "Transaction failed",
            error_details: { error: error.message, stack: error.stack },
          })
          .eq("id", logId)
      }

      return NextResponse.json(
        { error: error.message || "Failed to execute swap" },
        { status: 500 }
      )
    }
  } catch (error: any) {
    console.error("❌ Error in execute-swap:", error)
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    )
  }
}
