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

// WETH ABI for balance and approval
const WETH_ABI = [
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
 * API Route: Debug Swap Flow for CDP Server Wallets V2
 * 
 * This endpoint tests and debugs the complete swap flow without executing the actual swap.
 * It verifies all steps and returns detailed information about each stage.
 * 
 * Steps:
 * 1. Validate input parameters
 * 2. Check CDP credentials
 * 3. Fetch bot wallet data
 * 4. Initialize CDP Client
 * 5. Check WETH balance (on-chain and database)
 * 6. Calculate swap amount
 * 7. Get 0x API quote (with retry logic)
 * 8. Check WETH approval status
 * 9. Verify Smart Account and Owner Account access
 * 10. Return complete debug information
 */
export async function POST(request: NextRequest) {
  const debugInfo: any = {
    timestamp: new Date().toISOString(),
    steps: [],
    errors: [],
    warnings: [],
  }

  try {
    // Step 1: Validate input parameters
    debugInfo.steps.push({ step: 1, name: "Validate Input", status: "started" })
    
    const body = await request.json()
    const { 
      userAddress, 
      tokenAddress, 
      amountUsd, 
      walletIndex = 0 
    } = body as { 
      userAddress: string
      tokenAddress: string
      amountUsd: string
      walletIndex?: number
    }

    if (!userAddress || !tokenAddress || !amountUsd) {
      debugInfo.errors.push("Missing required fields: userAddress, tokenAddress, or amountUsd")
      return NextResponse.json({
        success: false,
        debugInfo,
        error: "Missing required fields"
      }, { status: 400 })
    }

    debugInfo.input = {
      userAddress,
      tokenAddress,
      amountUsd,
      walletIndex,
    }
    debugInfo.steps[0].status = "completed"

    // Step 2: Check CDP credentials
    debugInfo.steps.push({ step: 2, name: "Check CDP Credentials", status: "started" })
    
    const apiKeyId = process.env.CDP_API_KEY_ID
    const apiKeySecret = process.env.CDP_API_KEY_SECRET
    const zeroXApiKey = process.env.ZEROX_API_KEY

    if (!apiKeyId || !apiKeySecret) {
      debugInfo.errors.push("CDP credentials not configured")
      debugInfo.steps[1].status = "failed"
      return NextResponse.json({
        success: false,
        debugInfo,
        error: "CDP credentials not configured"
      }, { status: 500 })
    }

    if (!zeroXApiKey) {
      debugInfo.errors.push("0x API key not configured")
      debugInfo.steps[1].status = "failed"
      return NextResponse.json({
        success: false,
        debugInfo,
        error: "0x API key not configured"
      }, { status: 500 })
    }

    debugInfo.credentials = {
      cdpConfigured: true,
      zeroXConfigured: true,
    }
    debugInfo.steps[1].status = "completed"

    // Step 3: Fetch bot wallet data
    debugInfo.steps.push({ step: 3, name: "Fetch Bot Wallet", status: "started" })
    
    const supabase = createSupabaseServiceClient()

    const { data: botWallets, error: walletsError } = await supabase
      .from("wallets_data")
      .select("*")
      .eq("user_address", userAddress.toLowerCase())
      .order("created_at", { ascending: true })

    if (walletsError || !botWallets || botWallets.length === 0) {
      debugInfo.errors.push(`Failed to fetch bot wallets: ${walletsError?.message || "No wallets found"}`)
      debugInfo.steps[2].status = "failed"
      return NextResponse.json({
        success: false,
        debugInfo,
        error: "Bot wallets not found"
      }, { status: 404 })
    }

    const botWallet = botWallets[walletIndex]
    
    if (!botWallet) {
      debugInfo.errors.push(`Bot wallet at index ${walletIndex} not found`)
      debugInfo.steps[2].status = "failed"
      return NextResponse.json({
        success: false,
        debugInfo,
        error: `Bot wallet at index ${walletIndex} not found`
      }, { status: 404 })
    }

    const smartAccountAddress = botWallet.smart_account_address as Address
    const ownerAddress = botWallet.owner_address as Address

    debugInfo.wallet = {
      index: walletIndex,
      smartAccountAddress,
      ownerAddress,
      totalWallets: botWallets.length,
    }
    debugInfo.steps[2].status = "completed"

    // Step 4: Initialize CDP Client
    debugInfo.steps.push({ step: 4, name: "Initialize CDP Client", status: "started" })
    
    try {
      const cdp = new CdpClient()
      debugInfo.cdp = {
        initialized: true,
        clientType: "CdpClient V2",
      }
      debugInfo.steps[3].status = "completed"
    } catch (cdpError: any) {
      debugInfo.errors.push(`CDP initialization failed: ${cdpError.message}`)
      debugInfo.steps[3].status = "failed"
      return NextResponse.json({
        success: false,
        debugInfo,
        error: "CDP initialization failed"
      }, { status: 500 })
    }

    // Step 5: Check WETH balance (on-chain and database)
    debugInfo.steps.push({ step: 5, name: "Check WETH Balance", status: "started" })
    
    // Check database balance
    const { data: creditRecord, error: creditError } = await supabase
      .from("bot_wallet_credits")
      .select("weth_balance_wei")
      .eq("user_address", userAddress.toLowerCase())
      .eq("bot_wallet_address", smartAccountAddress.toLowerCase())
      .single()

    const wethBalanceWeiDB = creditRecord 
      ? BigInt(creditRecord.weth_balance_wei || "0")
      : BigInt(0)

    // Check on-chain balance
    let wethBalanceWeiOnChain = BigInt(0)
    try {
      wethBalanceWeiOnChain = await publicClient.readContract({
        address: WETH_ADDRESS,
        abi: WETH_ABI,
        functionName: "balanceOf",
        args: [smartAccountAddress],
      }) as bigint
    } catch (balanceError: any) {
      debugInfo.warnings.push(`Failed to check on-chain WETH balance: ${balanceError.message}`)
    }

    // Get ETH price for USD conversion
    let ethPriceUsd = 3000 // Default fallback
    try {
      const ethPriceResponse = await fetch(`${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/api/eth-price`)
      const ethPriceData = await ethPriceResponse.json()
      ethPriceUsd = ethPriceData.price
    } catch (priceError: any) {
      debugInfo.warnings.push(`Failed to fetch ETH price: ${priceError.message}. Using default: $${ethPriceUsd}`)
    }

    const balanceInUsdDB = Number(formatEther(wethBalanceWeiDB)) * ethPriceUsd
    const balanceInUsdOnChain = Number(formatEther(wethBalanceWeiOnChain)) * ethPriceUsd

    debugInfo.balance = {
      database: {
        wei: wethBalanceWeiDB.toString(),
        eth: formatEther(wethBalanceWeiDB),
        usd: balanceInUsdDB.toFixed(4),
      },
      onchain: {
        wei: wethBalanceWeiOnChain.toString(),
        eth: formatEther(wethBalanceWeiOnChain),
        usd: balanceInUsdOnChain.toFixed(4),
      },
      ethPriceUsd,
      synced: wethBalanceWeiDB === wethBalanceWeiOnChain,
    }

    if (wethBalanceWeiDB !== wethBalanceWeiOnChain) {
      debugInfo.warnings.push(`Balance mismatch: DB (${formatEther(wethBalanceWeiDB)}) vs On-chain (${formatEther(wethBalanceWeiOnChain)})`)
    }

    debugInfo.steps[4].status = "completed"

    // Step 6: Calculate swap amount
    debugInfo.steps.push({ step: 6, name: "Calculate Swap Amount", status: "started" })
    
    const amountUsdValue = parseFloat(amountUsd)
    const amountEthValue = amountUsdValue / ethPriceUsd
    const amountWei = BigInt(Math.floor(amountEthValue * 1e18))

    debugInfo.swapAmount = {
      usd: amountUsdValue,
      eth: formatEther(amountWei),
      wei: amountWei.toString(),
    }

    if (amountWei === BigInt(0)) {
      debugInfo.errors.push("Invalid swap amount: amountWei is 0")
      debugInfo.steps[5].status = "failed"
      return NextResponse.json({
        success: false,
        debugInfo,
        error: "Invalid swap amount"
      }, { status: 400 })
    }

    if (wethBalanceWeiDB < amountWei) {
      debugInfo.warnings.push(`Insufficient WETH balance: ${formatEther(wethBalanceWeiDB)} < ${formatEther(amountWei)}`)
    }

    debugInfo.steps[5].status = "completed"

    // Step 7: Get 0x API quote (with retry logic)
    debugInfo.steps.push({ step: 7, name: "Get 0x API Quote", status: "started" })
    
    if (!isAddress(tokenAddress)) {
      debugInfo.errors.push(`Invalid token address: ${tokenAddress}`)
      debugInfo.steps[6].status = "failed"
      return NextResponse.json({
        success: false,
        debugInfo,
        error: "Invalid token address"
      }, { status: 400 })
    }

    let quote: any = null
    let quoteError: any = null
    let requestId: string | null = null
    const maxAttempts = 2

    debugInfo.quoteAttempts = []

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const quoteParams = new URLSearchParams({
        chainId: "8453",
        sellToken: WETH_ADDRESS.toLowerCase(),
        buyToken: tokenAddress.toLowerCase(),
        sellAmount: amountWei.toString(),
        taker: smartAccountAddress.toLowerCase(),
        slippageBps: attempt === 1 ? "500" : "1000",
      })

      const quoteUrl = `https://api.0x.org/swap/allowance-holder/quote?${quoteParams.toString()}`

      const attemptInfo: any = {
        attempt,
        slippage: attempt === 1 ? "5%" : "10%",
        url: quoteUrl,
      }

      try {
        const quoteResponse = await fetch(quoteUrl, {
          headers: {
            "0x-api-key": zeroXApiKey,
            "0x-version": "v2",
            "Accept": "application/json",
          },
        })

        if (!quoteResponse.ok) {
          const errorData = await quoteResponse.json()
          quoteError = errorData
          requestId = errorData.request_id || errorData.requestId || null
          
          attemptInfo.status = "failed"
          attemptInfo.error = errorData.message || quoteResponse.statusText
          attemptInfo.requestId = requestId
          
          debugInfo.quoteAttempts.push(attemptInfo)
          
          if (attempt < maxAttempts && 
              (errorData.message?.includes("no Route matched") || 
               errorData.message?.includes("No route found") ||
               errorData.message?.includes("INSUFFICIENT_ASSET_LIQUIDITY"))) {
            continue
          }
        } else {
          quote = await quoteResponse.json()
          attemptInfo.status = "success"
          attemptInfo.quote = {
            buyAmount: quote.buyAmount,
            price: quote.price,
            allowanceTarget: quote.allowanceTarget,
            transaction: {
              to: quote.transaction?.to,
              value: quote.transaction?.value || "0",
              dataLength: quote.transaction?.data?.length || 0,
            },
          }
          debugInfo.quoteAttempts.push(attemptInfo)
          break
        }
      } catch (fetchError: any) {
        attemptInfo.status = "error"
        attemptInfo.error = fetchError.message
        debugInfo.quoteAttempts.push(attemptInfo)
      }
    }

    if (!quote) {
      debugInfo.errors.push(`Failed to get quote: ${quoteError?.message || "Unknown error"}`)
      debugInfo.steps[6].status = "failed"
      return NextResponse.json({
        success: false,
        debugInfo,
        error: "Failed to get swap quote"
      }, { status: 200 }) // Return 200 for debugging purposes
    }

    debugInfo.steps[6].status = "completed"

    // Step 8: Check WETH approval status
    debugInfo.steps.push({ step: 8, name: "Check WETH Approval", status: "started" })
    
    const allowanceTarget = quote.allowanceTarget || quote.transaction?.to

    if (!allowanceTarget) {
      debugInfo.errors.push("No allowance target found in quote response")
      debugInfo.steps[7].status = "failed"
    } else {
      try {
        const currentAllowance = await publicClient.readContract({
          address: WETH_ADDRESS,
          abi: WETH_ABI,
          functionName: "allowance",
          args: [smartAccountAddress, allowanceTarget as Address],
        }) as bigint

        debugInfo.approval = {
          allowanceTarget,
          currentAllowance: {
            wei: currentAllowance.toString(),
            eth: formatEther(currentAllowance),
          },
          requiredAmount: {
            wei: amountWei.toString(),
            eth: formatEther(amountWei),
          },
          needsApproval: currentAllowance < amountWei,
        }

        debugInfo.steps[7].status = "completed"
      } catch (approvalError: any) {
        debugInfo.warnings.push(`Failed to check allowance: ${approvalError.message}`)
        debugInfo.approval = {
          allowanceTarget,
          error: approvalError.message,
          needsApproval: true, // Assume approval needed if check fails
        }
        debugInfo.steps[7].status = "completed_with_warning"
      }
    }

    // Step 9: Verify Smart Account and Owner Account access
    debugInfo.steps.push({ step: 9, name: "Verify CDP Account Access", status: "started" })
    
    try {
      const cdp = new CdpClient()
      
      const ownerAccount = await cdp.evm.getAccount({ address: ownerAddress })
      const smartAccount = await cdp.evm.getSmartAccount({ 
        owner: ownerAccount,
        address: smartAccountAddress 
      })

      debugInfo.cdpAccounts = {
        ownerAccount: {
          accessible: !!ownerAccount,
          address: ownerAddress,
        },
        smartAccount: {
          accessible: !!smartAccount,
          address: smartAccountAddress,
        },
      }

      debugInfo.steps[8].status = "completed"
    } catch (accountError: any) {
      debugInfo.errors.push(`Failed to access CDP accounts: ${accountError.message}`)
      debugInfo.steps[8].status = "failed"
    }

    // Final summary
    debugInfo.summary = {
      readyToSwap: debugInfo.errors.length === 0,
      totalSteps: debugInfo.steps.length,
      completedSteps: debugInfo.steps.filter((s: any) => s.status === "completed").length,
      failedSteps: debugInfo.steps.filter((s: any) => s.status === "failed").length,
      warnings: debugInfo.warnings.length,
      errors: debugInfo.errors.length,
    }

    return NextResponse.json({
      success: true,
      debugInfo,
      message: debugInfo.errors.length === 0 
        ? "All checks passed! Ready to execute swap." 
        : "Some checks failed. Review errors before executing swap.",
    })

  } catch (error: any) {
    debugInfo.errors.push(`Unexpected error: ${error.message}`)
    
    return NextResponse.json({
      success: false,
      debugInfo,
      error: error.message,
      stack: error.stack,
    }, { status: 500 })
  }
}
