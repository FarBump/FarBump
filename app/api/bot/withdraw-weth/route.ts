import { NextRequest, NextResponse } from "next/server"
import { formatEther, isAddress, type Address, type Hex, createPublicClient, http, encodeFunctionData } from "viem"
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

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { sessionId, walletIndex } = body as { sessionId: string; walletIndex: number }

    if (!sessionId || walletIndex === undefined) {
      return NextResponse.json(
        { error: "Missing required fields: sessionId, walletIndex" },
        { status: 400 }
      )
    }

    const supabase = createSupabaseServiceClient()

    // Step 1: Fetch active bot session
    console.log(`🤖 [Bot Swap] Fetching session ${sessionId}...`)
    const { data: session, error: sessionError } = await supabase
      .from("bot_sessions")
      .select("*")
      .eq("id", sessionId)
      .eq("status", "running")
      .single()

    if (sessionError || !session) {
      console.error("❌ Session not found or inactive:", sessionError)
      return NextResponse.json({ error: "Session not found or inactive" }, { status: 404 })
    }

    const { user_address, token_address, amount_usd, wallet_rotation_index } = session

    // Step 2: Fetch bot wallets for this user
    const { data: botWallets, error: walletsError } = await supabase
      .from("wallets_data")
      .select("*")
      .eq("user_address", user_address.toLowerCase())
      .order("created_at", { ascending: true })

    if (walletsError || !botWallets || botWallets.length !== 5) {
      return NextResponse.json({ error: "Bot wallets incomplete" }, { status: 404 })
    }

    // Step 3: Select bot wallet
    const botWallet = botWallets[walletIndex]
    if (!botWallet) {
      return NextResponse.json({ error: "Bot wallet not found" }, { status: 404 })
    }

    const smartAccountAddress = botWallet.smart_account_address as Address
    const ownerAddress = botWallet.owner_address as Address

    // Step 4: Initialize CDP Client V2
    const apiKeyId = process.env.CDP_API_KEY_ID
    const apiKeySecret = process.env.CDP_API_KEY_SECRET

    if (!apiKeyId || !apiKeySecret) {
      return NextResponse.json({ error: "CDP credentials missing" }, { status: 500 })
    }

    const cdp = new CdpClient()

    // Step 5: Check Database WETH balance
    const { data: creditRecord } = await supabase
      .from("bot_wallet_credits")
      .select("weth_balance_wei")
      .eq("user_address", user_address.toLowerCase())
      .eq("bot_wallet_address", smartAccountAddress.toLowerCase())
      .single()

    const wethBalanceWei = creditRecord ? BigInt(creditRecord.weth_balance_wei || "0") : BigInt(0)

    // Fetch ETH price for conversion
    const ethPriceResponse = await fetch(`${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/api/eth-price`)
    const { price: ethPriceUsd } = await ethPriceResponse.json()
    const amountEthValue = parseFloat(amount_usd) / ethPriceUsd
    const amountWei = BigInt(Math.floor(amountEthValue * 1e18))

    if (wethBalanceWei < amountWei) {
      return NextResponse.json({ message: "Insufficient WETH balance", skipped: true })
    }

    // Step 7: Get swap quote from 0x API v2 (Retry Logic)
    let quote: any = null
    let quoteError: any = null
    let attempt = 1
    const maxAttempts = 2

    while (attempt <= maxAttempts && !quote) {
      const quoteParams = new URLSearchParams({
        chainId: "8453",
        sellToken: WETH_ADDRESS.toLowerCase(),
        buyToken: token_address.toLowerCase(),
        sellAmount: amountWei.toString(),
        taker: smartAccountAddress.toLowerCase(),
        slippageBps: attempt === 1 ? "500" : "1000",
      })

      const quoteResponse = await fetch(`https://api.0x.org/swap/allowance-holder/quote?${quoteParams.toString()}`, {
        headers: {
          "0x-api-key": process.env.ZEROX_API_KEY || "",
          "0x-version": "v2",
        },
      })

      if (!quoteResponse.ok) {
        quoteError = await quoteResponse.json()
        if (attempt < maxAttempts) {
          attempt++
          continue
        }
        break
      } else {
        quote = await quoteResponse.json()
      }
    }

    if (!quote) {
      return NextResponse.json({ error: "Quote failed", details: quoteError }, { status: 400 })
    }

    // Step 8 & 9: Approval & Execution via CDP V2
    const ownerAccount = await cdp.evm.getAccount({ address: ownerAddress })
    const smartAccount = await cdp.evm.getSmartAccount({
      owner: ownerAccount,
      address: smartAccountAddress
    })

    const allowanceTarget = quote.allowanceTarget || quote.transaction?.to
    
    // Execute User Operation (Approve + Swap)
    const txOp = await (smartAccount as any).sendUserOperation({
      network: "base",
      calls: [
        {
          to: WETH_ADDRESS,
          data: encodeFunctionData({
            abi: WETH_ABI,
            functionName: "approve",
            args: [allowanceTarget as Address, amountWei],
          }),
          value: BigInt(0),
        },
        {
          to: quote.transaction.to as Address,
          data: quote.transaction.data as Hex,
          value: BigInt(0),
        }
      ],
      isSponsored: true,
    })

    return NextResponse.json({ success: true, userOpHash: txOp })

  } catch (error: any) {
    console.error("CRITICAL ERROR:", error)
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }
}
