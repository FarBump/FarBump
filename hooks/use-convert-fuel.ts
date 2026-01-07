"use client"

import { useState } from "react"
import { useSmartWallets } from "@privy-io/react-auth/smart-wallets"
import { usePublicClient } from "wagmi"
import { parseUnits, isAddress, type Address, encodeFunctionData, encodeAbiParameters, type Hex } from "viem"
import { Currency, CurrencyAmount, Token, TradeType, Percent } from "@uniswap/sdk-core"
import { Pool, Route, V4Planner, Actions, SwapExactInSingle } from "@uniswap/v4-sdk"
import { CommandType } from "@uniswap/universal-router-sdk"
import {
  BUMP_TOKEN_ADDRESS,
  TREASURY_ADDRESS,
  BASE_WETH_ADDRESS,
  UNISWAP_UNIVERSAL_ROUTER,
  PERMIT2_ADDRESS,
  BUMP_POOL_CURRENCY0,
  BUMP_POOL_CURRENCY1,
  BUMP_POOL_FEE,
  BUMP_POOL_TICK_SPACING,
  BUMP_POOL_HOOK_ADDRESS,
  BUMP_DECIMALS,
  TREASURY_FEE_BPS,
  APP_FEE_BPS,
  USER_CREDIT_BPS,
  CLANKER_FEE_CONFIG,
  WETH_DECIMALS
} from "@/lib/constants"

// 0x API v2 Configuration
// NOTE: API key is now server-side only for security
// Frontend only calls /api/0x-quote proxy endpoint
const ZEROX_API_BASE_URL = "https://base.api.0x.org"

/**
 * 0x Swap API v2 Response Structure
 */
interface ZeroXQuoteResponse {
  chainId: number
  price: string
  estimatedPriceImpact: string
  buyAmount: string
  sellAmount: string
  buyToken: string
  sellToken: string
  allowanceTarget: string
  transaction: {
    to: string
    data: string
    value: string
    gas?: string
    gasPrice?: string
  }
  permit2?: {
    token: string
    spender: string
    amount: string
    expiration: string
    nonce: string
    sig: {
      r: string
      s: string
      v: number
    }
  }
  issues?: Array<{
    type: string
    reason: string
    severity: "error" | "warning" | "info"
    data?: {
      allowance?: {
        token: string
        owner: string
        spender: string
        amount: string
      }
    }
  }>
}

// ERC20 ABI for transfer
const ERC20_ABI = [
  {
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    name: "transfer",
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
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

// Universal Router ABI
// Universal Router uses execute(bytes commands, bytes[] inputs) to execute multiple commands
const UNISWAP_UNIVERSAL_ROUTER_ABI = [
  {
    inputs: [
      { name: "commands", type: "bytes" },
      { name: "inputs", type: "bytes[]" },
    ],
    name: "execute",
    outputs: [],
    stateMutability: "payable",
    type: "function",
  },
] as const

// Permit2 ABI for allowance management and approval
const PERMIT2_ABI = [
  {
    inputs: [
      { name: "token", type: "address" },
      { name: "spender", type: "address" },
      { name: "amount", type: "uint160" },
      { name: "expiration", type: "uint48" },
    ],
    name: "approve",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { name: "owner", type: "address" },
      { name: "token", type: "address" },
      { name: "spender", type: "address" },
    ],
    name: "allowance",
    outputs: [
      { name: "amount", type: "uint160" },
      { name: "expiration", type: "uint48" },
      { name: "nonce", type: "uint48" },
    ],
    stateMutability: "view",
    type: "function",
  },
] as const

// Max values for Permit2 approval
const MAX_UINT160 = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF") // 2^160 - 1
const MAX_UINT48 = 281474976710655 // 2^48 - 1 (far future expiration, fits in JS number)

// V4 SDK Token instances for Clanker integration
const CHAIN_ID = 8453 // Base mainnet
const WETH_TOKEN = new Token(CHAIN_ID, BASE_WETH_ADDRESS, 18, "WETH", "Wrapped Ether")
const BUMP_TOKEN = new Token(CHAIN_ID, BUMP_TOKEN_ADDRESS, BUMP_DECIMALS, "BUMP", "BUMP (Clanker Token)")

// Uniswap V4 PoolManager address on Base
const UNISWAP_V4_POOL_MANAGER = "0x498581fF718922c3f8e6A244956aF099B2652b2b" as const

// Uniswap V4 PoolManager ABI for swap
const UNISWAP_V4_POOL_MANAGER_ABI = [
  {
    inputs: [
      {
        components: [
          { name: "currency0", type: "address" },
          { name: "currency1", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "tickSpacing", type: "int24" },
          { name: "hooks", type: "address" },
        ],
        name: "key",
        type: "tuple",
      },
      {
        components: [
          { name: "zeroForOne", type: "bool" },
          { name: "amountSpecified", type: "int256" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
        name: "params",
        type: "tuple",
      },
      { name: "hookData", type: "bytes" },
    ],
    name: "swap",
    outputs: [{ name: "delta", type: "int256" }],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const

export function useConvertFuel() {
  const { client: smartWalletClient } = useSmartWallets()
  const publicClient = usePublicClient()
  
  const [hash, setHash] = useState<`0x${string}` | null>(null)
  const [isPending, setIsPending] = useState(false)
  const [isSuccess, setIsSuccess] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const [isApproving, setIsApproving] = useState(false)
  const [approvalHash, setApprovalHash] = useState<`0x${string}` | null>(null)
  const [swapStatus, setSwapStatus] = useState<string>("")

  /**
   * Get dynamic slippage based on token address
   * $BUMP token (0x94ce728849431818ec9a0cf29bdb24fe413bbb07) uses 3% slippage
   * Other tokens use 0.5% slippage
   */
  const getDynamicSlippage = (tokenAddress: Address): number => {
    if (tokenAddress.toLowerCase() === BUMP_TOKEN_ADDRESS.toLowerCase()) {
      return 0.03 // 3% for $BUMP token
    }
    return 0.005 // 0.5% for other tokens
  }

  const reset = () => {
    setHash(null)
    setIsPending(false)
    setIsSuccess(false)
    setError(null)
    setIsApproving(false)
    setApprovalHash(null)
  }

  /**
   * Check if user has approved $BUMP to Permit2 contract
   * This is required before Permit2 can authorize Universal Router
   */
  const checkErc20ToPermit2Allowance = async (amount: bigint): Promise<boolean> => {
    if (!publicClient || !smartWalletClient) return false

    try {
      const allowance = await publicClient.readContract({
        address: BUMP_TOKEN_ADDRESS as Address,
        abi: ERC20_ABI,
        functionName: "allowance",
        args: [smartWalletClient.account.address as Address, PERMIT2_ADDRESS as Address],
      })
      console.log(`📊 ERC20 Allowance to Permit2: ${allowance.toString()}`)
      return allowance >= amount
    } catch (err) {
      console.error("Error checking ERC20 allowance to Permit2:", err)
      return false
    }
  }

  /**
   * Check Permit2 allowance for Universal Router
   * This checks if Permit2 has authorized Universal Router to spend $BUMP
   */
  const checkPermit2Allowance = async (amount: bigint): Promise<{ hasAllowance: boolean; needsErc20Approval: boolean }> => {
    if (!publicClient || !smartWalletClient) {
      return { hasAllowance: false, needsErc20Approval: true }
    }

    // First check ERC20 allowance to Permit2
    const hasErc20Allowance = await checkErc20ToPermit2Allowance(amount)
    if (!hasErc20Allowance) {
      console.log("⚠️ Need ERC20 approval to Permit2 first")
      return { hasAllowance: false, needsErc20Approval: true }
    }

    // Then check Permit2 allowance for Universal Router
    try {
      const result = await publicClient.readContract({
        address: PERMIT2_ADDRESS as Address,
        abi: PERMIT2_ABI,
        functionName: "allowance",
        args: [
          smartWalletClient.account.address as Address, // owner
          BUMP_TOKEN_ADDRESS as Address,                 // token
          UNISWAP_UNIVERSAL_ROUTER as Address,          // spender
        ],
      })
      
      // Result is [amount, expiration, nonce] - all as bigint from viem
      const [allowedAmount, expiration] = result as unknown as [bigint, bigint, bigint]
      const currentTime = BigInt(Math.floor(Date.now() / 1000))
      
      console.log(`📊 Permit2 Allowance for Universal Router:`)
      console.log(`  - Amount: ${allowedAmount.toString()}`)
      console.log(`  - Expiration: ${expiration.toString()}`)
      console.log(`  - Current Time: ${currentTime.toString()}`)
      
      const hasEnough = allowedAmount >= amount && expiration > currentTime
      return { hasAllowance: hasEnough, needsErc20Approval: false }
    } catch (err) {
      console.error("Error checking Permit2 allowance:", err)
      // Permit2 check failed, but ERC20 allowance is ok
      return { hasAllowance: false, needsErc20Approval: false }
    }
  }

  /**
   * Encode PERMIT2_TRANSFER_FROM command input for Universal Router
   * Command: 0x07
   * This pulls tokens FROM the user's wallet via Permit2 and sends to recipient
   * Input: abi.encode(token, recipient, amount)
   * 
   * IMPORTANT: This is different from TRANSFER (0x05) which transfers from Router's balance
   */
  const encodePermit2TransferFromCommand = (
    token: Address,
    recipient: Address,
    amount: bigint
  ): Hex => {
    return encodeAbiParameters(
      [
        { name: "token", type: "address" },
        { name: "recipient", type: "address" },
        { name: "amount", type: "uint256" },
      ],
      [token, recipient, amount]
    ) as Hex
  }

  /**
   * Create V4 swap using V4Planner (Official SDK Pattern)
   * Based on Uniswap V4 SDK documentation:
   * https://docs.uniswap.org/sdk/v4/guides/swaps/single-hop-swapping
   *
   * Uses:
   * - V4Planner from @uniswap/v4-sdk
   * - Actions: SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL
   * - Returns encodedActions from v4Planner.finalize() for V4_SWAP command
   */
  const createV4SwapWithSDK = (
    amountIn: bigint,
    amountOutMinimum: bigint
  ): { commandByte: Hex; encodedActions: Hex } => {
    // Create SwapExactInSingle config (matches SDK documentation pattern)
    const swapConfig: SwapExactInSingle = {
      poolKey: {
        currency0: BUMP_POOL_CURRENCY0 as Address, // WETH
        currency1: BUMP_POOL_CURRENCY1 as Address, // $BUMP
        fee: BUMP_POOL_FEE,
        tickSpacing: BUMP_POOL_TICK_SPACING,
        hooks: BUMP_POOL_HOOK_ADDRESS as Address, // Clanker UniV4SwapExtension hook
      },
      zeroForOne: false, // false = selling currency1 ($BUMP) for currency0 (WETH)
      amountIn: amountIn.toString(),
      amountOutMinimum: amountOutMinimum.toString(),
      hookData: "0x" as Hex,
    }

    // Create V4Planner and add actions (Flash Accounting pattern)
    const v4Planner = new V4Planner()
    
    // Action 1: SETTLE_ALL - Pay input tokens ($BUMP) to PoolManager
    v4Planner.addAction(Actions.SETTLE_ALL, [
      BUMP_POOL_CURRENCY1 as Address, // currency1 ($BUMP)
      amountIn.toString(), // maxAmount
    ])
    
    // Action 2: SWAP_EXACT_IN_SINGLE - Execute the swap
    v4Planner.addAction(Actions.SWAP_EXACT_IN_SINGLE, [swapConfig])
    
    // Action 3: TAKE_ALL - Receive output tokens (WETH) from PoolManager
    v4Planner.addAction(Actions.TAKE_ALL, [
      BUMP_POOL_CURRENCY0 as Address, // currency0 (WETH)
      amountOutMinimum.toString(), // minAmount
    ])

    // Finalize V4Planner to get encoded actions (this is what we pass to Universal Router)
    const encodedActions = v4Planner.finalize() as Hex

    // V4_SWAP command byte is 0x10
    const commandByte: Hex = "0x10" as Hex

    console.log("✅ V4 Swap created using official SDK pattern:")
    console.log(`  - V4Planner Actions: ${v4Planner.actions.length} actions`)
    console.log(`  - Command: V4_SWAP (0x10)`)
    console.log(`  - AmountIn: ${amountIn.toString()} $BUMP`)
    console.log(`  - AmountOutMinimum: ${amountOutMinimum.toString()} WETH`)

    return { commandByte, encodedActions }
  }

  /**
   * Encode PAY_PORTION command input for Universal Router
   * Command: 0x06
   * Input: abi.encode(token, recipient, bips)
   */
  const encodePayPortionCommand = (
    token: Address,
    recipient: Address,
    bips: number
  ): Hex => {
    return encodeAbiParameters(
      [
        { name: "token", type: "address" },
        { name: "recipient", type: "address" },
        { name: "bips", type: "uint256" },
      ],
      [token, recipient, BigInt(bips)]
    ) as Hex
  }

  /**
   * Encode UNWRAP_WETH command input for Universal Router
   * Command: 0x0C (or 0x0D depending on Universal Router version)
   * Input: abi.encode(recipient, amountMin)
   */
  const encodeUnwrapWethCommand = (
    recipient: Address,
    amountMin: bigint
  ): Hex => {
    return encodeAbiParameters(
      [
        { name: "recipient", type: "address" },
        { name: "amountMin", type: "uint256" },
      ],
      [recipient, amountMin]
    ) as Hex
  }

  /**
   * Encode SWEEP command input for Universal Router
   * Command: 0x04
   * Input: abi.encode(token, recipient, amountMin)
   * For native ETH, use address(0) as token
   */
  const encodeSweepCommand = (
    token: Address,
    recipient: Address,
    amountMin: bigint
  ): Hex => {
    return encodeAbiParameters(
      [
        { name: "token", type: "address" },
        { name: "recipient", type: "address" },
        { name: "amountMin", type: "uint256" },
      ],
      [token, recipient, amountMin]
    ) as Hex
  }

  /**
   * Get quote from 0x Swap API v2 via Next.js API route (proxy)
   * Uses /api/0x-quote endpoint to avoid CORS issues
   * The API route makes the request server-side, avoiding browser CORS restrictions
   * 
   * @param retryWithHighSlippage - If true, will retry with 20% slippage if initial request fails with "Insufficient Liquidity"
   */
  const get0xQuote = async (
    sellToken: Address,
    buyToken: Address,
    sellAmountWei: bigint,
    takerAddress: Address,
    slippagePercentage: number = 0.5,
    retryWithHighSlippage: boolean = true
  ): Promise<ZeroXQuoteResponse> => {
    // Build query parameters for our API route
    const queryParams = new URLSearchParams({
      sellToken,
      buyToken,
      sellAmount: sellAmountWei.toString(),
      takerAddress,
      slippagePercentage: slippagePercentage.toString(),
    })

    // Use absolute URL if available (for production), otherwise use relative URL
    let baseUrl = ""
    if (typeof window !== "undefined") {
      const envUrl = process.env.NEXT_PUBLIC_APP_URL
      const originUrl = window.location.origin
      baseUrl = envUrl || originUrl
      // Remove trailing slash to avoid double slashes
      baseUrl = baseUrl.replace(/\/+$/, "")
    }
    const apiPath = `/api/0x-quote?${queryParams.toString()}`
    const url = baseUrl ? `${baseUrl}${apiPath}` : apiPath
    
    console.log("📊 Fetching 0x Swap API v2 quote via proxy...")
    console.log(`  API Route: ${url}`)
    console.log(`  Base URL: ${baseUrl || "relative"}`)
    console.log(`  Sell Token: ${sellToken}`)
    console.log(`  Buy Token: ${buyToken}`)
    console.log(`  Sell Amount: ${sellAmountWei.toString()}`)
    console.log(`  Slippage: ${slippagePercentage}%`)

    const response = await fetch(url, {
      method: "GET",
      headers: {
        "Accept": "application/json",
      },
    })

    if (!response.ok) {
      const errorText = await response.text()
      let errorData: any = { error: "Unknown error" }
      
      try {
        errorData = JSON.parse(errorText)
      } catch {
        errorData = { error: errorText || response.statusText }
      }
      
      console.error("❌ 0x API proxy error:", {
        status: response.status,
        statusText: response.statusText,
        error: errorData,
      })
      
      // Handle "Insufficient Liquidity" (400 error) - retry with high slippage if enabled
      const isInsufficientLiquidity = response.status === 400 && (
        errorData.error?.includes("Insufficient liquidity") ||
        errorData.error?.includes("no Route matched") ||
        errorData.error?.includes("NO_ROUTE_MATCHED") ||
        errorData.message?.includes("Insufficient liquidity") ||
        errorData.message?.includes("no Route matched")
      )
      
      if (isInsufficientLiquidity && retryWithHighSlippage) {
        console.log("⚠️ Insufficient Liquidity detected. Retrying with high slippage (20%)...")
        // Retry with 20% slippage (high slippage mode)
        return get0xQuote(sellToken, buyToken, sellAmountWei, takerAddress, 20, false)
      }
      
      throw new Error(errorData.error || `0x API v2 error: ${response.status} ${response.statusText}`)
    }

    const quoteData: ZeroXQuoteResponse = await response.json()
    
    console.log("✅ 0x API v2 Quote received:")
    console.log(`  - Price: ${quoteData.price}`)
    console.log(`  - Buy Amount: ${quoteData.buyAmount}`)
    console.log(`  - Sell Amount: ${quoteData.sellAmount}`)
    console.log(`  - Estimated Price Impact: ${quoteData.estimatedPriceImpact}%`)

    return quoteData
  }

  /**
   * Create swap transaction using 0x API v2 (better prices from aggregated liquidity)
   * 
   * Process:
   * 1. PERMIT2_TRANSFER_FROM (0x07): Transfer 5% $BUMP to Treasury (TREASURY_FEE_BPS = 500)
   * 2. Execute 0x Swap: Swap 95% $BUMP to WETH using 0x API v2 (better prices)
   * 3. UNWRAP_WETH (0x0c): Unwrap WETH to Native ETH
   * 4. PAY_PORTION (0x06): Send 5% ETH to Treasury/App (APP_FEE_BPS = 500)
   * 5. SWEEP (0x04): Send remaining 90% ETH to User Credit (USER_CREDIT_BPS = 9000)
   *
   * Distribution:
   * - 5% $BUMP → Treasury (TREASURY_FEE_BPS = 500)
   * - 5% ETH → Treasury/App (APP_FEE_BPS = 500)
   * - 90% ETH → User Credit (USER_CREDIT_BPS = 9000)
   */
  const create0xSwapTransaction = async (
    totalBumpWei: bigint,
    userAddress: Address,
    treasuryAddress: Address,
    slippagePercentage: number = 0.5
  ): Promise<{
    commands: Hex;
    inputs: Hex[];
    permit2Approval: { to: Address; data: Hex; value: bigint };
    zeroXSwapTransaction: { to: Address; data: Hex; value: bigint };
  }> => {
    // Calculate amounts according to correct distribution:
    // - 5% $BUMP → Treasury (TREASURY_FEE_BPS = 500)
    // - 95% $BUMP → Swap to WETH
    // - 5% ETH → Treasury/App (APP_FEE_BPS = 500)
    // - 90% ETH → User Credit (USER_CREDIT_BPS = 9000)
    const treasuryFeeWei = (totalBumpWei * BigInt(TREASURY_FEE_BPS)) / BigInt(10000)
    const swapAmountWei = totalBumpWei - treasuryFeeWei // 95% of total

    console.log("🚀 Using 0x API v2 for better swap prices:")
    console.log(`  - Total Amount: ${totalBumpWei.toString()} $BUMP`)
    console.log(`  - Treasury Fee (5% $BUMP): ${treasuryFeeWei.toString()} $BUMP`)
    console.log(`  - Swap Amount (95% $BUMP): ${swapAmountWei.toString()} $BUMP`)
    console.log(`  - App Fee (5% ETH): ${APP_FEE_BPS} bps`)
    console.log(`  - User Credit (90% ETH): ${USER_CREDIT_BPS} bps`)
    console.log(`  - Slippage: ${slippagePercentage}%`)

    // Get quote from 0x API v2 with automatic retry on "Insufficient Liquidity"
    let quoteData: ZeroXQuoteResponse
    try {
      quoteData = await get0xQuote(
        BUMP_TOKEN_ADDRESS as Address,
        BASE_WETH_ADDRESS as Address,
        swapAmountWei,
        userAddress,
        slippagePercentage,
        true // Enable retry with high slippage
      )
    } catch (error: any) {
      // If retry with high slippage also fails, try final fallback with 20% slippage
      const errorMessage = error.message || ""
      if (errorMessage.includes("Insufficient liquidity") || 
          errorMessage.includes("no Route matched") ||
          errorMessage.includes("NO_ROUTE_MATCHED")) {
        console.log("🔄 Final attempt with maximum slippage (20%)...")
        try {
          quoteData = await get0xQuote(
            BUMP_TOKEN_ADDRESS as Address,
            BASE_WETH_ADDRESS as Address,
            swapAmountWei,
            userAddress,
            20, // Maximum slippage
            false // Don't retry again
          )
          console.log("✅ Quote obtained with high slippage mode")
        } catch (finalError: any) {
          throw new Error(
            "Unable to find a route for this swap. Please try a smaller amount or contact support."
          )
        }
      } else {
        // Re-throw other errors
        throw error
      }
    }

    // Command 1: PERMIT2_TRANSFER_FROM (0x07) - Pull 5% $BUMP from user, send to Treasury
    const permit2TransferInput = encodePermit2TransferFromCommand(
      BUMP_TOKEN_ADDRESS as Address,
      treasuryAddress,
      treasuryFeeWei
    )

    // Command 2: UNWRAP_WETH (0x0c) - Unwrap all WETH to Native ETH
    // Note: 0x Swap will swap $BUMP to WETH, then we unwrap it
    const unwrapInput = encodeUnwrapWethCommand(
      userAddress, // Recipient (will receive native ETH)
      BigInt(0) // amountMin = 0 (minimal slippage)
    )

    // Command 3: PAY_PORTION (0x06) - Send 5% ETH to Treasury/App (APP_FEE_BPS = 500)
    // Since we swap 95% of total $BUMP, and we want 5% of total initial in ETH:
    // 5% of total = 5% / 95% = 5.263% of swap result
    // Formula: (APP_FEE_BPS * 10000) / (10000 - TREASURY_FEE_BPS) = (500 * 10000) / 9500 = ~526 bips
    const payPortionBips = Math.floor((APP_FEE_BPS * 10000) / (10000 - TREASURY_FEE_BPS)) // ~526 bips (5% of total = 5.263% of swap result)
    const payPortionInput = encodePayPortionCommand(
      "0x0000000000000000000000000000000000000000" as Address, // Native ETH (address(0))
      treasuryAddress, // Treasury/App address
      payPortionBips
    )

    // Command 4: SWEEP (0x04) - Send remaining 90% ETH to User Credit (USER_CREDIT_BPS = 9000)
    const sweepInput = encodeSweepCommand(
      "0x0000000000000000000000000000000000000000" as Address, // Native ETH (address(0))
      userAddress, // User receives 90% as credit
      BigInt(0) // amountMin = 0 (minimal slippage, sweep all)
    )

    // Combine commands for Universal Router:
    // PERMIT2_TRANSFER_FROM (0x07) + UNWRAP_WETH (0x0c) + PAY_PORTION (0x06) + SWEEP (0x04)
    // Note: 0x Swap is executed separately as a direct call to Settler contract
    const commands = ("0x070c0604") as Hex

    // Inputs array for Universal Router commands
    const inputs: Hex[] = [
      permit2TransferInput,  // Command 1: PERMIT2_TRANSFER_FROM (0x07) - 5% $BUMP to Treasury (TREASURY_FEE_BPS)
      unwrapInput,           // Command 2: UNWRAP_WETH (0x0c) - Unwrap WETH to Native ETH
      payPortionInput,       // Command 3: PAY_PORTION (0x06) - 5% ETH to Treasury/App (APP_FEE_BPS)
      sweepInput,            // Command 4: SWEEP (0x04) - 90% ETH to User Credit (USER_CREDIT_BPS)
    ]

    // Permit2 approval for 0x Settler contract (from quote response)
    const permit2ApprovalData = encodeFunctionData({
      abi: PERMIT2_ABI,
      functionName: "approve",
      args: [
        BUMP_TOKEN_ADDRESS as Address,           // token
        quoteData.transaction.to as Address,      // spender (0x Settler contract)
        MAX_UINT160,                              // amount
        MAX_UINT48,                               // expiration
      ],
    })

    const permit2Approval = {
      to: PERMIT2_ADDRESS as Address,
      data: permit2ApprovalData,
      value: BigInt(0),
    }

    // 0x Swap transaction (from API response)
    const zeroXSwapTransaction = {
      to: quoteData.transaction.to as Address,    // Settler contract
      data: quoteData.transaction.data as Hex,    // Swap transaction data
      value: BigInt(quoteData.transaction.value || "0"),
    }

    return { commands, inputs, permit2Approval, zeroXSwapTransaction }
  }

  /**
   * Approve $BUMP tokens to Permit2 contract
   * This is the first step - user must approve ERC20 to Permit2
   * Then Permit2.approve() will be called in convert() to authorize Universal Router
   */
  const approve = async (amount: string) => {
    setIsApproving(true)
    setError(null)

    try {
      if (!smartWalletClient) {
        throw new Error("Smart Wallet client not found. Please login again.")
      }

      if (!publicClient) {
        throw new Error("Public client not available")
      }

      const userAddress = smartWalletClient.account.address
      const amountWei = parseUnits(amount, BUMP_DECIMALS)

      // Check ERC20 allowance to Permit2
      console.log("🔍 Checking ERC20 allowance to Permit2...")
      const currentAllowance = await publicClient.readContract({
        address: BUMP_TOKEN_ADDRESS as Address,
        abi: ERC20_ABI,
        functionName: "allowance",
        args: [userAddress as Address, PERMIT2_ADDRESS as Address],
      })

      console.log(`📊 Current Allowance to Permit2: ${currentAllowance.toString()}, Required: ${amountWei.toString()}`)

      // If allowance is sufficient, no need to approve
      if (currentAllowance >= amountWei) {
        console.log("✅ Sufficient ERC20 allowance to Permit2 already exists")
        setIsApproving(false)
        return { approved: true, hash: null as `0x${string}` | null }
      }

      // Approve ERC20 to Permit2 with max amount (so user doesn't need to approve again)
      console.log("📝 ERC20 approval needed, sending approve transaction to Permit2...")
      console.log(`  - Token: ${BUMP_TOKEN_ADDRESS}`)
      console.log(`  - Spender: ${PERMIT2_ADDRESS} (Permit2)`)
      console.log(`  - Amount: MAX_UINT256 (unlimited)`)
      
      // Use max uint256 for ERC20 approval to Permit2 (common practice)
      const maxUint256 = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF")
      const approveData = encodeFunctionData({
        abi: ERC20_ABI,
        functionName: "approve",
        args: [PERMIT2_ADDRESS as Address, maxUint256],
      })

      const MAX_RETRIES = 2
      const TIMEOUT_MS = 30000
      let approveTxHash: `0x${string}` | null = null

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          if (attempt > 0) {
            const delay = Math.pow(2, attempt - 1) * 1000
            console.log(`⏳ Waiting ${delay}ms before retry...`)
            await new Promise(resolve => setTimeout(resolve, delay))
          }

          approveTxHash = await Promise.race([
            smartWalletClient.sendTransaction({
              to: BUMP_TOKEN_ADDRESS,
              data: approveData,
              value: BigInt(0),
            }),
            new Promise<never>((_, reject) => {
              setTimeout(() => reject(new Error("Transaction timeout")), TIMEOUT_MS)
            })
          ]) as `0x${string}`

          // Wait for confirmation
          await publicClient.waitForTransactionReceipt({ hash: approveTxHash })
          console.log("✅ Approval confirmed")
          setApprovalHash(approveTxHash)
          break
        } catch (attemptError: any) {
          if (attempt === MAX_RETRIES) {
            throw attemptError
          }
          const errorMessage = attemptError.message || ""
          if (errorMessage.includes("timeout") || errorMessage.includes("timed out")) {
            console.log(`⚠️ Timeout detected, will retry (${attempt + 1}/${MAX_RETRIES})...`)
            continue
          } else {
            throw attemptError
          }
        }
      }

      setIsApproving(false)
      return { approved: true, hash: approveTxHash }
    } catch (err: any) {
      setIsApproving(false)
      console.error("❌ Approval Error:", err)
      
      let friendlyMessage = err.message || "Approval failed"
      if (friendlyMessage.includes("timeout") || friendlyMessage.includes("timed out")) {
        friendlyMessage = "Approval request timed out. Please try again."
      } else if (friendlyMessage.includes("insufficient funds")) {
        friendlyMessage = "Insufficient $BUMP balance for approval."
      }

      setError(new Error(friendlyMessage))
      throw new Error(friendlyMessage)
    }
  }

  const convert = async (amount: string) => {
    reset()
    setIsPending(true)

    try {
      // 1. Validasi Smart Wallet
      if (!smartWalletClient) {
        throw new Error("Smart Wallet client not found. Please login again.")
      }

      if (!publicClient) {
        throw new Error("Public client not available")
      }

      const userAddress = smartWalletClient.account.address

      // 2. Validasi Amount
      const amountNum = parseFloat(amount)
      if (isNaN(amountNum) || amountNum <= 0) {
        throw new Error("Invalid amount")
      }

      const totalAmountWei = parseUnits(amount, BUMP_DECIMALS)

      // 2.5. Validate swap amount - warn if exceptionally large
      // Consider amounts > 1M $BUMP as "large" (adjust threshold as needed)
      const LARGE_SWAP_THRESHOLD = parseUnits("1000000", BUMP_DECIMALS) // 1M $BUMP
      if (totalAmountWei > LARGE_SWAP_THRESHOLD) {
        console.warn("⚠️ Large swap detected. Price impact might be high.")
        setSwapStatus("Large swap detected. Price impact might be high.")
        // Continue with swap but user is warned
      }

      // 3. Calculate amounts according to correct distribution:
      // - 5% $BUMP → Treasury (TREASURY_FEE_BPS = 500)
      // - 95% $BUMP → Swap to WETH
      // - 5% ETH → Treasury/App (APP_FEE_BPS = 500)
      // - 90% ETH → User Credit (USER_CREDIT_BPS = 9000)
      const treasuryFeeWei = (totalAmountWei * BigInt(TREASURY_FEE_BPS)) / BigInt(10000)
      const swapAmountWei = totalAmountWei - treasuryFeeWei

      console.log("🔄 Starting Convert $BUMP to Credit...")
      console.log(`💰 Total Amount: ${amount} $BUMP`)
      console.log(`📤 Treasury Fee (5% $BUMP): ${treasuryFeeWei.toString()} wei`)
      console.log(`💱 Swap Amount (95% $BUMP): ${swapAmountWei.toString()} wei`)
      console.log(`📊 Distribution after swap:`)
      console.log(`   - 5% ETH → Treasury/App (APP_FEE_BPS = ${APP_FEE_BPS})`)
      console.log(`   - 90% ETH → User Credit (USER_CREDIT_BPS = ${USER_CREDIT_BPS})`)

      // 4. Verify ERC20 approval to Permit2 before swap
      // User must have approved $BUMP to Permit2 first
      console.log("🔍 Verifying ERC20 allowance to Permit2...")
      const erc20ToPermit2Allowance = await publicClient.readContract({
        address: BUMP_TOKEN_ADDRESS as Address,
        abi: ERC20_ABI,
        functionName: "allowance",
        args: [userAddress as Address, PERMIT2_ADDRESS as Address],
      })
      
      console.log(`📊 ERC20 Allowance to Permit2: ${erc20ToPermit2Allowance.toString()}, Required: ${totalAmountWei.toString()}`)
      
      if (erc20ToPermit2Allowance < totalAmountWei) {
        throw new Error("Insufficient ERC20 allowance to Permit2. Please approve first by clicking the 'Approve' button.")
      }
      
      console.log("✅ ERC20 allowance to Permit2 confirmed")

      // 5. Get dynamic slippage based on token
      const dynamicSlippage = getDynamicSlippage(BUMP_TOKEN_ADDRESS as Address)
      console.log(`📊 Using dynamic slippage: ${(dynamicSlippage * 100).toFixed(1)}% for $BUMP token`)

      // 6. Get 0x API quote with Smart Wallet address as taker
      // Will automatically retry with high slippage (20%) if "Insufficient Liquidity" error occurs
      setSwapStatus("Fetching quote from 0x API...")
      console.log("📦 Fetching 0x API v2 quote...")
      let quoteData: ZeroXQuoteResponse
      let usedHighSlippage = false
      
      try {
        quoteData = await get0xQuote(
          BUMP_TOKEN_ADDRESS as Address,
          BASE_WETH_ADDRESS as Address,
          swapAmountWei,
          userAddress as Address, // Smart Wallet address as taker
          dynamicSlippage * 100, // Convert to percentage
          true // Enable retry with high slippage
        )
        
        // Check if we used high slippage by comparing with original slippage
        // If estimatedPriceImpact is very high, we likely used high slippage mode
        const priceImpact = parseFloat(quoteData.estimatedPriceImpact || "0")
        if (priceImpact > 5 || quoteData.estimatedPriceImpact === undefined) {
          // Likely used high slippage mode
          usedHighSlippage = true
          console.log("⚠️ High slippage mode activated due to liquidity constraints")
        }
      } catch (error: any) {
        // If retry with high slippage also fails, try final fallback
        const errorMessage = error.message || ""
        if (errorMessage.includes("Insufficient liquidity") || 
            errorMessage.includes("no Route matched") ||
            errorMessage.includes("NO_ROUTE_MATCHED")) {
          // Final fallback: try with maximum slippage (20%)
          console.log("🔄 Final attempt with maximum slippage (20%)...")
          setSwapStatus("Retrying with high slippage mode...")
          try {
            quoteData = await get0xQuote(
              BUMP_TOKEN_ADDRESS as Address,
              BASE_WETH_ADDRESS as Address,
              swapAmountWei,
              userAddress as Address,
              20, // Maximum slippage
              false // Don't retry again
            )
            usedHighSlippage = true
            console.log("✅ Quote obtained with high slippage mode")
          } catch (finalError: any) {
            throw new Error(
              "Unable to find a route for this swap. Please try a smaller amount or contact support."
            )
          }
        } else {
          // Re-throw other errors
          throw error
        }
      }
      
      // 6.5. Check price impact and warn user if very high (> 10%)
      const priceImpact = parseFloat(quoteData.estimatedPriceImpact || "0")
      if (priceImpact > 10) {
        const warningMessage = `Large swap detected. You will experience a significant price impact of ${priceImpact.toFixed(2)}%. Proceeding anyway...`
        console.warn(`⚠️ ${warningMessage}`)
        setSwapStatus(warningMessage)
        // Continue with swap but user is warned
      } else if (usedHighSlippage) {
        setSwapStatus("High slippage mode activated. Proceeding with swap...")
      }

      // 7. Check for allowance issues in 0x response
      let allowanceSpender: Address | null = null
      if (quoteData.issues && Array.isArray(quoteData.issues)) {
        const allowanceIssue = quoteData.issues.find(
          (issue) => issue.type === "allowance" || issue.reason?.toLowerCase().includes("allowance")
        )
        
        if (allowanceIssue && allowanceIssue.data?.allowance) {
          allowanceSpender = allowanceIssue.data.allowance.spender as Address
          console.log("⚠️ Allowance issue detected:")
          console.log(`  Token: ${allowanceIssue.data.allowance.token}`)
          console.log(`  Spender: ${allowanceSpender}`)
          console.log(`  Required Amount: ${allowanceIssue.data.allowance.amount}`)
        }
      }

      // 8. Prepare atomic batch transaction
      setSwapStatus("Processing on Uniswap V4...")
      console.log("🔄 Preparing atomic batch transaction...")
      
      const batchCalls: Array<{ to: Address; data: Hex; value: bigint }> = []

      // Call 1: Token approval if allowance issue exists
      if (allowanceSpender) {
        console.log("📝 Adding token approval to batch...")
        const approveData = encodeFunctionData({
          abi: ERC20_ABI,
          functionName: "approve",
          args: [allowanceSpender, MAX_UINT160], // Max approval for efficiency
        })
        
        batchCalls.push({
          to: BUMP_TOKEN_ADDRESS as Address,
          data: approveData,
          value: BigInt(0),
        })
        console.log(`  ✅ Approval call added for spender: ${allowanceSpender}`)
      }

      // Call 2: 0x Swap transaction
      console.log("💱 Adding 0x swap transaction to batch...")
      batchCalls.push({
        to: quoteData.transaction.to as Address,
        data: quoteData.transaction.data as Hex,
        value: BigInt(quoteData.transaction.value || "0"),
      })
      console.log(`  ✅ Swap call added: ${quoteData.transaction.to}`)
      
      console.log(`📦 Total batch calls: ${batchCalls.length}`)
      
      // 9. Execute atomic batch transaction
      setSwapStatus("Processing on Uniswap V4...")
      console.log(`📤 Executing atomic batch transaction...`)
      console.log(`  Batch contains ${batchCalls.length} calls:`)
      batchCalls.forEach((call, index) => {
        console.log(`    Call ${index + 1}: ${call.to}`)
      })
      
      const MAX_RETRIES = 2
      const TIMEOUT_MS = 30000
      
      let txHash: `0x${string}` | null = null
      let lastError: Error | null = null

      // Retry logic with exponential backoff
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          if (attempt > 0) {
            const delay = Math.pow(2, attempt - 1) * 1000
            console.log(`⏳ Waiting ${delay}ms before retry...`)
            await new Promise(resolve => setTimeout(resolve, delay))
          }
          
          // For Smart Wallet (UserOperation), set manual gas limit to prevent simulation failures
          const MANUAL_GAS_LIMIT = BigInt(3000000) // Increased for allowance + swap
          console.log(`⛽ Setting manual gas limit: ${MANUAL_GAS_LIMIT.toString()}`)
          
          console.log("✅ Sending atomic batch transaction...")
          
          // Try different batch methods depending on Smart Wallet SDK version
          // Privy Smart Wallet should support sendTransaction with batch or separate method
          try {
            // Method 1: Try sendTransactions (newer Privy SDK) - Atomic batch
            if (typeof (smartWalletClient as any).sendTransactions === 'function') {
              console.log("📦 Using sendTransactions() method (atomic batch)...")
              txHash = await Promise.race([
                (smartWalletClient as any).sendTransactions(batchCalls, { gas: MANUAL_GAS_LIMIT }),
                new Promise<never>((_, reject) => {
                  setTimeout(() => reject(new Error("Transaction timeout")), TIMEOUT_MS)
                })
              ]) as `0x${string}`
            } 
            // Method 2: Try executeBatch (alternative SDK method) - Atomic batch
            else if (typeof (smartWalletClient as any).executeBatch === 'function') {
              console.log("📦 Using executeBatch() method (atomic batch)...")
              txHash = await Promise.race([
                (smartWalletClient as any).executeBatch(batchCalls, { gas: MANUAL_GAS_LIMIT }),
                new Promise<never>((_, reject) => {
                  setTimeout(() => reject(new Error("Transaction timeout")), TIMEOUT_MS)
                })
              ]) as `0x${string}`
            }
            // Method 3: Fallback - Use sendTransaction with single call (if batch not available)
            else {
              console.log("⚠️ Batch methods not available, executing swap only...")
              // Execute only the swap transaction (approval should be handled separately if needed)
              if (batchCalls.length > 0) {
                // Execute the last call (swap transaction)
                const swapCall = batchCalls[batchCalls.length - 1]
                txHash = await Promise.race([
                  smartWalletClient.sendTransaction({
                    to: swapCall.to,
                    data: swapCall.data,
                    value: swapCall.value,
                    gas: MANUAL_GAS_LIMIT,
                  }),
                  new Promise<never>((_, reject) => {
                    setTimeout(() => reject(new Error("Transaction timeout")), TIMEOUT_MS)
                  })
                ]) as `0x${string}`
              } else {
                throw new Error("No swap transaction available")
              }
            }
          } catch (batchError: any) {
            console.error("❌ Batch/Sequential transaction failed:", batchError)
            throw batchError
          }

          break // Success
        } catch (attemptError: any) {
          lastError = attemptError
          console.error(`❌ Convert attempt ${attempt + 1} failed:`, attemptError)
          
          const errorMessage = attemptError.message || ""
          const errorDetails = attemptError.details || attemptError.cause?.details || ""
          const errorName = attemptError.name || attemptError.cause?.name || ""
          
          const isBillingError = 
            errorMessage.includes("No billing attached") ||
            errorMessage.includes("billing attached to account") ||
            errorMessage.includes("request denied") ||
            errorDetails.includes("No billing attached") ||
            errorName === "ResourceUnavailableRpcError"
          
          if (isBillingError) {
            throw attemptError
          }
          
          const isTimeout = 
            errorMessage.includes("timeout") || 
            errorMessage.includes("timed out") ||
            errorName === "TimeoutError"
          
          if (isTimeout && attempt < MAX_RETRIES) {
            console.log(`⚠️ Timeout detected, will retry (${attempt + 1}/${MAX_RETRIES})...`)
            continue
          } else {
            throw attemptError
          }
        }
      }

      if (!txHash) {
        throw lastError || new Error("Failed to send transaction after retries")
      }

      console.log("✅ Atomic batch transaction sent! Hash:", txHash)
      setHash(txHash)
      setSwapStatus("Transaction confirmed on-chain")

      // 10. Wait for confirmation
      if (publicClient) {
        console.log("⏳ Waiting for on-chain confirmation...")
        try {
          const receipt = await Promise.race([
            publicClient.waitForTransactionReceipt({ hash: txHash }),
            new Promise<never>((_, reject) => {
              setTimeout(() => {
                reject(new Error("Transaction confirmation timed out"))
              }, 120000)
            })
          ])
          console.log("🎉 Transaction Confirmed:", receipt)
        } catch (confirmationError: any) {
          console.warn("⚠️ Confirmation timeout, but transaction was sent:", confirmationError)
        }
      }

      // 7. Call API to sync credit
      console.log("🔄 Syncing credit to database...")
      try {
        const response = await fetch("/api/sync-credit", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            txHash: txHash,
            userAddress: userAddress,
            amountBump: amount,
            amountBumpWei: totalAmountWei.toString(),
          }),
        })

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}))
          throw new Error(errorData.error || "Failed to sync credit")
        }

        const result = await response.json()
        console.log("✅ Credit synced:", result)
      } catch (syncError: any) {
        console.error("⚠️ Failed to sync credit (transaction succeeded):", syncError)
        // Don't throw - transaction succeeded, sync can be retried
      }

      setIsSuccess(true)
      setSwapStatus("")
    } catch (err: any) {
      console.error("❌ Convert Error:", err)
      setSwapStatus("")
      
      let friendlyMessage = err.message || "Transaction failed"
      const errorDetails = err.details || err.cause?.details || ""
      const errorName = err.name || err.cause?.name || ""
      
      // Note: "Insufficient Liquidity" errors are now handled automatically with high slippage retry
      // This catch block only handles errors that couldn't be resolved with retry
      if (
        friendlyMessage.includes("No billing attached") ||
        friendlyMessage.includes("billing attached to account") ||
        friendlyMessage.includes("request denied") ||
        errorDetails.includes("No billing attached") ||
        errorName === "ResourceUnavailableRpcError"
      ) {
        friendlyMessage = "Paymaster billing not configured. Please configure billing for mainnet sponsorship in Coinbase CDP Dashboard."
      } else if (friendlyMessage.includes("timeout") || friendlyMessage.includes("timed out") || err.name === "TimeoutError") {
        friendlyMessage = "Transaction request timed out. Please try again in a few moments."
      } else if (friendlyMessage.includes("insufficient funds")) {
        friendlyMessage = "Insufficient $BUMP balance for conversion."
      } else if (friendlyMessage.includes("Failed to fetch") || friendlyMessage.includes("network")) {
        friendlyMessage = "Network error. Please check your internet connection."
      }

      setError(new Error(friendlyMessage))
    } finally {
      setIsPending(false)
    }
  }

  return {
    convert,
    approve,
    hash,
    approvalHash,
    isPending,
    isApproving,
    isSuccess,
    error,
    reset,
    swapStatus, // Add swap status for UI display
  }
}
