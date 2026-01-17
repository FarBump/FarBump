import { NextRequest, NextResponse } from "next/server"
import { formatEther, parseEther, isAddress, type Address, type Hex, createPublicClient, http, encodeFunctionData } from "viem"
import { base } from "viem/chains"
import { createSupabaseServiceClient } from "@/lib/supabase"
import { CdpClient } from "@coinbase/cdp-sdk"
import "dotenv/config"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

// Constants
const WETH_ADDRESS = "0x4200000000000000000000000000000000000006" as const
const BUMP_TOKEN_ADDRESS = "0x8984B389cB82e05016DB2E4c7230ca0791b9Cb07" as const

// ERC20 ABI for balance, approval, and transfer
const ERC20_ABI = [
  {
    inputs: [{ name: "account", type: "address" }],
    name: "balanceOf",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    name: "allowance",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    name: "approve",
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const

// Public client for balance checks
const publicClient = createPublicClient({
  chain: base,
  transport: http(process.env.NEXT_PUBLIC_BASE_RPC_URL),
})

/**
 * API Route: Liquidate $BUMP Token to WETH (Real Execution)
 * 
 * Flow:
 * 1. Get Bot Smart Account address and Owner Account
 * 2. Check $BUMP token balance
 * 3. Get swap quote from 0x API v2 ($BUMP → WETH)
 * 4. Approve $BUMP token to AllowanceHolder (if needed)
 * 5. Execute swap transaction (gasless via CDP Paymaster)
 * 6. Return transaction hash
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { botAddress } = body as { botAddress: string }

    if (!botAddress || !isAddress(botAddress)) {
      return NextResponse.json(
        { success: false, error: "Invalid or missing botAddress" },
        { status: 400 }
      )
    }

    console.log(`🤖 [Liquidate Bot] Starting liquidation for Bot: ${botAddress}`)

    // Step 1: Initialize CDP Client
    console.log("🔧 Initializing Coinbase CDP SDK V2...")
    
    const apiKeyId = process.env.CDP_API_KEY_ID
    const apiKeySecret = process.env.CDP_API_KEY_SECRET
    const zeroXApiKey = process.env.ZEROX_API_KEY

    if (!apiKeyId || !apiKeySecret) {
      console.error("❌ Missing CDP credentials")
      return NextResponse.json(
        { success: false, error: "CDP credentials not configured" },
        { status: 500 }
      )
    }

    if (!zeroXApiKey) {
      console.error("❌ Missing 0x API key")
      return NextResponse.json(
        { success: false, error: "0x API key not configured" },
        { status: 500 }
      )
    }

    const cdp = new CdpClient()
    console.log(`✅ CDP Client V2 initialized`)

    // Step 2: Fetch bot wallet data from database
    console.log(`📊 Fetching bot wallet data...`)
    
    const supabase = createSupabaseServiceClient()
    const { data: botWallet, error: walletError } = await supabase
      .from("wallets_data")
      .select("*")
      .eq("smart_account_address", botAddress.toLowerCase())
      .single()

    if (walletError || !botWallet) {
      console.error("❌ Bot wallet not found in database:", walletError)
      return NextResponse.json(
        { success: false, error: "Bot wallet not found in database" },
        { status: 404 }
      )
    }

    const smartAccountAddress = botWallet.smart_account_address as Address
    const ownerAddress = botWallet.owner_address as Address

    console.log(`✅ Bot Wallet found:`)
    console.log(`   Smart Account: ${smartAccountAddress}`)
    console.log(`   Owner Account: ${ownerAddress}`)

    // Step 3: Check $BUMP token balance
    console.log(`💰 Checking $BUMP token balance...`)
    
    let bumpBalanceWei: bigint
    try {
      bumpBalanceWei = await publicClient.readContract({
        address: BUMP_TOKEN_ADDRESS,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [smartAccountAddress],
      }) as bigint

      console.log(`   $BUMP Balance: ${formatEther(bumpBalanceWei)} BUMP`)
    } catch (balanceError: any) {
      console.error(`❌ Failed to check $BUMP balance: ${balanceError.message}`)
      return NextResponse.json(
        { success: false, error: `Failed to check $BUMP balance: ${balanceError.message}` },
        { status: 500 }
      )
    }

    // Check if balance is zero
    if (bumpBalanceWei === BigInt(0)) {
      console.log(`⚠️ Bot has no $BUMP tokens - Nothing to liquidate`)
      return NextResponse.json({
        success: false,
        error: "No $BUMP tokens to liquidate",
        balance: "0",
      })
    }

    // Step 4: Get swap quote from 0x API v2 ($BUMP → WETH)
    console.log(`📊 Fetching swap quote from 0x API v2 ($BUMP → WETH)...`)
    
    let quote: any = null
    let quoteError: any = null
    let requestId: string | null = null
    let attempt = 1
    const maxAttempts = 2

    while (attempt <= maxAttempts && !quote) {
      console.log(`\n🔄 Attempt ${attempt}/${maxAttempts} - Getting 0x API v2 quote...`)
      
      const quoteParams = new URLSearchParams({
        chainId: "8453", // Base Mainnet
        sellToken: BUMP_TOKEN_ADDRESS.toLowerCase(), // $BUMP token
        buyToken: WETH_ADDRESS.toLowerCase(), // WETH
        sellAmount: bumpBalanceWei.toString(), // Sell all $BUMP
        taker: smartAccountAddress.toLowerCase(),
        slippageBps: attempt === 1 ? "500" : "1000", // 5% or 10% slippage
      })

      const quoteUrl = `https://api.0x.org/swap/allowance-holder/quote?${quoteParams.toString()}`
      console.log(`   Endpoint: /swap/allowance-holder/quote ($BUMP → WETH)`)
      console.log(`   Sell Amount: ${formatEther(bumpBalanceWei)} BUMP`)
      console.log(`   Slippage: ${attempt === 1 ? "5%" : "10%"}`)

      const quoteResponse = await fetch(quoteUrl, {
        headers: {
          "0x-api-key": zeroXApiKey,
          "0x-version": "v2",
          "Accept": "application/json",
        },
      })

      if (!quoteResponse.ok) {
        try {
          quoteError = await quoteResponse.json()
          requestId = quoteError.request_id || quoteError.requestId || null
        } catch (e) {
          quoteError = { message: quoteResponse.statusText }
        }
        
        console.warn(`⚠️ Attempt ${attempt} failed:`, quoteError)
        
        if (quoteError.message && 
            (quoteError.message.includes("no Route matched") || 
             quoteError.message.includes("No route found") ||
             quoteError.message.includes("INSUFFICIENT_ASSET_LIQUIDITY")) &&
            attempt < maxAttempts) {
          console.log(`   → Retrying with higher slippage...`)
          attempt++
          continue
        } else {
          break
        }
      } else {
        quote = await quoteResponse.json()
        console.log(`✅ Got swap quote on attempt ${attempt}:`)
        const transaction = quote.transaction || quote
        console.log(`   To: ${transaction.to}`)
        console.log(`   Buy Amount (WETH): ${quote.buyAmount ? formatEther(BigInt(quote.buyAmount)) : 'N/A'} WETH`)
        console.log(`   Allowance Target: ${quote.allowanceTarget || 'N/A'}`)
        console.log(`   Price: ${quote.price || 'N/A'}`)
        break
      }
    }

    if (!quote) {
      const errorMessage = quoteError?.message || "Unknown error"
      console.error("❌ Failed to get swap quote:", quoteError)
      return NextResponse.json({
        success: false,
        error: `Failed to get swap quote: ${errorMessage}`,
        details: quoteError,
        request_id: requestId,
      }, { status: 400 })
    }

    // Step 5: Check $BUMP approval for AllowanceHolder
    const allowanceTarget = quote.allowanceTarget || quote.transaction?.to
    
    if (!allowanceTarget) {
      console.error(`❌ No allowance target found in quote response`)
      return NextResponse.json({
        success: false,
        error: "Invalid quote response: missing allowanceTarget",
      }, { status: 500 })
    }
    
    console.log(`🔐 Checking $BUMP approval for AllowanceHolder...`)
    console.log(`   AllowanceHolder: ${allowanceTarget}`)
    
    let needsApproval = false
    try {
      const currentAllowance = await publicClient.readContract({
        address: BUMP_TOKEN_ADDRESS,
        abi: ERC20_ABI,
        functionName: "allowance",
        args: [smartAccountAddress, allowanceTarget as Address],
      }) as bigint

      console.log(`   Current allowance: ${formatEther(currentAllowance)} BUMP`)
      console.log(`   Required amount: ${formatEther(bumpBalanceWei)} BUMP`)

      if (currentAllowance < bumpBalanceWei) {
        needsApproval = true
        console.log(`   ⚠️ Insufficient allowance. Need to approve $BUMP.`)
      } else {
        console.log(`   ✅ Sufficient allowance.`)
      }
    } catch (approvalCheckError: any) {
      console.warn(`   ⚠️ Failed to check allowance: ${approvalCheckError.message}`)
      needsApproval = true
    }

    // Step 6: Approve $BUMP if needed
    if (needsApproval) {
      console.log(`🔐 Approving $BUMP for AllowanceHolder...`)
      
      try {
        const ownerAccount = await cdp.evm.getAccount({ address: ownerAddress })
        if (!ownerAccount) {
          throw new Error("Failed to get Owner Account from CDP")
        }

        const smartAccount = await cdp.evm.getSmartAccount({ 
          owner: ownerAccount,
          address: smartAccountAddress 
        })
        if (!smartAccount) {
          throw new Error("Failed to get Smart Account from CDP")
        }

        const maxApproval = BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff")
        const approveData = encodeFunctionData({
          abi: ERC20_ABI,
          functionName: "approve",
          args: [allowanceTarget as Address, maxApproval],
        })

        const approveCall = {
          to: BUMP_TOKEN_ADDRESS,
          data: approveData,
          value: BigInt(0),
        }

        console.log(`   → Executing approval transaction...`)
        const approveUserOpHash = await (smartAccount as any).sendUserOperation({
          network: "base",
          calls: [approveCall],
          isSponsored: true, // Gasless via CDP Paymaster
        })

        const approveUserOpHashStr = typeof approveUserOpHash === 'string' 
          ? approveUserOpHash 
          : (approveUserOpHash?.hash || approveUserOpHash?.userOpHash || String(approveUserOpHash))

        console.log(`   → Approval submitted: ${approveUserOpHashStr}`)

        // Wait for approval confirmation
        if (typeof (smartAccount as any).waitForUserOperation === 'function') {
          await (smartAccount as any).waitForUserOperation({
            userOpHash: approveUserOpHashStr,
            network: "base",
          })
          console.log(`   ✅ $BUMP approval confirmed`)
        } else {
          await new Promise(resolve => setTimeout(resolve, 5000))
          console.log(`   ✅ $BUMP approval submitted (waiting 5s)`)
        }
      } catch (approvalError: any) {
        console.error(`   ❌ Approval failed: ${approvalError.message}`)
        return NextResponse.json({
          success: false,
          error: `Failed to approve $BUMP: ${approvalError.message}`,
        }, { status: 500 })
      }
    }

    // Step 7: Execute swap transaction
    console.log(`🚀 Executing swap ($BUMP → WETH) with gasless transaction...`)
    
    try {
      const ownerAccount = await cdp.evm.getAccount({ address: ownerAddress })
      if (!ownerAccount) {
        throw new Error("Failed to get Owner Account from CDP")
      }
