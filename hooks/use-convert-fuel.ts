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
  CLANKER_FEE_CONFIG
} from "@/lib/constants"

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
  ): { commandByte: string; encodedActions: Hex } => {
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
    const encodedActions = v4Planner.finalize()

    // V4_SWAP command byte is 0x10
    const commandByte = "10"

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
   * Create Clanker V4 swap transaction using official Uniswap V4 SDK
   * Based on documentation: https://docs.uniswap.org/sdk/v4/guides/swaps/single-hop-swapping
   *
   * Process for Clanker-deployed $BUMP token:
   * 1. PERMIT2_TRANSFER_FROM (0x07): Transfer 5% $BUMP to Treasury
   * 2. V4_SWAP (0x10): Swap 95% $BUMP to WETH using V4Planner
   * 3. UNWRAP_WETH (0x0c): Unwrap WETH to Native ETH
   * 4. PAY_PORTION (0x06): Send 5% ETH to Treasury
   * 5. SWEEP (0x04): Send remaining 90% ETH to User
   *
   * Compatible with Clanker SDK v4.0.0 dynamic fee pools
   * Uses official V4Planner from @uniswap/v4-sdk
   */
  const createV4SwapTransaction = (
    totalBumpWei: bigint,
    userAddress: Address,
    treasuryAddress: Address
  ): {
    commands: Hex;
    inputs: Hex[];
    permit2Approval: { to: Address; data: Hex; value: bigint };
  } => {
    // Calculate amounts
    const treasuryFeeWei = (totalBumpWei * BigInt(TREASURY_FEE_BPS)) / BigInt(10000)
    const swapAmountWei = totalBumpWei - treasuryFeeWei // 95% of total
    const amountOutMinimum = BigInt(0) // Minimal slippage for testing

    console.log("🚀 Using Clanker V4 Swap with Official SDK:")
    console.log(`  - Universal Router: ${UNISWAP_UNIVERSAL_ROUTER}`)
    console.log(`  - Clanker Token: $BUMP (${BUMP_TOKEN_ADDRESS})`)
    console.log(`  - AmountIn: ${swapAmountWei.toString()} $BUMP`)
    console.log(`  - Treasury Fee: ${treasuryFeeWei.toString()} $BUMP`)
    console.log(`  - Fee Type: ${CLANKER_FEE_CONFIG.type} (${CLANKER_FEE_CONFIG.preset})`)
    console.log(`  - Fee Value: ${BUMP_POOL_FEE} (dynamic)`)
    console.log(`  - Hook Address: ${BUMP_POOL_HOOK_ADDRESS} (Clanker UniV4SwapExtension)`)

    // Create V4 swap using official SDK pattern
    const { commandByte: v4SwapCommandByte, encodedActions } = createV4SwapWithSDK(
      swapAmountWei,
      amountOutMinimum
    )

    // Command 1: PERMIT2_TRANSFER_FROM (0x07) - Pull 5% $BUMP from user, send to Treasury
    const permit2TransferInput = encodePermit2TransferFromCommand(
      BUMP_TOKEN_ADDRESS as Address,
      treasuryAddress,
      treasuryFeeWei
    )

    // Command 2: V4_SWAP (0x10) - Swap 95% $BUMP to WETH using V4Planner
    // encodedActions is the result of v4Planner.finalize() - this is what we pass to Universal Router
    // According to docs: universalRouter.execute(routePlanner.commands, [encodedActions], deadline)
    const v4SwapInputHex = encodedActions

    // Command 3: UNWRAP_WETH (0x0c) - Unwrap all WETH to Native ETH
    const unwrapInput = encodeUnwrapWethCommand(
      userAddress, // Recipient (will receive native ETH)
      BigInt(0) // amountMin = 0 (minimal slippage)
    )

    // Command 4: PAY_PORTION (0x06) - Send 5% (from total initial amount) of ETH to Treasury
    // Since we swap 95% of total, and we want 5% of total initial in ETH:
    // 5% of total = 5% / 95% = 5.263% of swap result
    // Formula: (5% of total) / (95% of total) = 5/95 = ~0.0526 = 526 bips
    const payPortionBips = Math.floor((TREASURY_FEE_BPS * 10000) / (10000 - TREASURY_FEE_BPS)) // ~526 bips
    const payPortionInput = encodePayPortionCommand(
      "0x0000000000000000000000000000000000000000" as Address, // Native ETH (address(0))
      treasuryAddress,
      payPortionBips
    )

    // Command 5: SWEEP (0x04) - Send remaining 90% native ETH to user
    const sweepInput = encodeSweepCommand(
      "0x0000000000000000000000000000000000000000" as Address, // Native ETH (address(0))
      userAddress,
      BigInt(0) // amountMin = 0 (minimal slippage, sweep all)
    )

    // Combine all commands: PERMIT2_TRANSFER_FROM + V4_SWAP + UNWRAP_WETH + PAY_PORTION + SWEEP
    // Command IDs: 0x07 (PERMIT2_TRANSFER_FROM) + 0x10 (V4_SWAP) + 0x0c (UNWRAP_WETH) + 0x06 (PAY_PORTION) + 0x04 (SWEEP)
    const commands = ("0x07" + v4SwapCommandByte + "0c0604") as Hex

    // Inputs array: one input per command (in same order as commands)
    const inputs: Hex[] = [
      permit2TransferInput,  // Command 1: PERMIT2_TRANSFER_FROM (0x07) - 5% $BUMP to Treasury
      v4SwapInputHex,        // Command 2: V4_SWAP (0x10) - Swap 95% $BUMP to WETH
      unwrapInput,           // Command 3: UNWRAP_WETH (0x0c) - Unwrap WETH to Native ETH
      payPortionInput,       // Command 4: PAY_PORTION (0x06) - 5% ETH to Treasury
      sweepInput,            // Command 5: SWEEP (0x04) - 90% ETH to User
    ]

    // Permit2 approval for Universal Router
    const permit2ApprovalData = encodeFunctionData({
      abi: PERMIT2_ABI,
      functionName: "approve",
      args: [
        BUMP_TOKEN_ADDRESS as Address,           // token
        UNISWAP_UNIVERSAL_ROUTER as Address,     // spender
        MAX_UINT160,                              // amount
        MAX_UINT48,                               // expiration
      ],
    })

    const permit2Approval = {
      to: PERMIT2_ADDRESS as Address,
      data: permit2ApprovalData,
      value: BigInt(0),
    }

    return { commands, inputs, permit2Approval }
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

      // 3. Calculate amounts
      // 5% to treasury (in $BUMP)
      const treasuryFeeWei = (totalAmountWei * BigInt(TREASURY_FEE_BPS)) / BigInt(10000)
      // 95% to swap (in $BUMP)
      const swapAmountWei = totalAmountWei - treasuryFeeWei

      console.log("🔄 Starting Convert $BUMP to Credit...")
      console.log(`💰 Total Amount: ${amount} $BUMP`)
      console.log(`📤 Treasury Fee (5%): ${treasuryFeeWei.toString()} wei`)
      console.log(`💱 Swap Amount (95%): ${swapAmountWei.toString()} wei`)

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

      // 5. Create V4 swap transaction using official SDK
      console.log("📦 Creating V4 swap transaction with official SDK...")
      const { commands, inputs, permit2Approval } = createV4SwapTransaction(
        totalAmountWei,
        userAddress as Address,
        TREASURY_ADDRESS as Address
      )
      
      // 6. Execute transaction
      console.log(`📤 Executing Universal Router transaction...`)
      console.log("  Step 1: Permit2.approve() - Authorize Universal Router")
      console.log("  Step 2: UniversalRouter.execute() - All operations in one call")
      console.log(`    - PERMIT2_TRANSFER_FROM (0x07): 5% $BUMP to Treasury`)
      console.log(`    - V4_SWAP (0x10): Swap 95% $BUMP to WETH (using V4Planner)`)
      console.log(`    - UNWRAP_WETH (0x0c): Unwrap WETH to Native ETH`)
      console.log(`    - PAY_PORTION (0x06): 5% ETH to Treasury`)
      console.log(`    - SWEEP (0x04): 90% ETH to User`)
      console.log(`📋 Universal Router Commands: ${commands}`)
      
      // 6. Prepare Universal Router execute call
      const universalRouterData = encodeFunctionData({
        abi: UNISWAP_UNIVERSAL_ROUTER_ABI,
        functionName: "execute",
        args: [commands, inputs],
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
          // 2,000,000 gas units should be sufficient for Permit2 approve + Universal Router execute with V4 swap
          const MANUAL_GAS_LIMIT = BigInt(2000000)
          console.log(`⛽ Setting manual gas limit: ${MANUAL_GAS_LIMIT.toString()}`)
          
          // Bundle calls in a single UserOperation using Smart Wallet batch
          // Call 1: Permit2.approve() for Universal Router
          // Call 2: UniversalRouter.execute() - All operations (V4 swap + ETH distribution)
          console.log("✅ Sending batch transaction...")
          console.log("  Call 1: Permit2.approve(Universal Router)")
          console.log("  Call 2: UniversalRouter.execute(V4 Swap + ETH Distribution)")

          // Smart Wallet batch transaction: array of calls processed atomically
          const batchCalls = [
            permit2Approval,  // Permit2 approval for Universal Router
            {
              to: UNISWAP_UNIVERSAL_ROUTER as Address,
              data: universalRouterData,
              value: BigInt(0),
            },
          ]
          
          // Try different batch methods depending on Smart Wallet SDK version
          // Privy Smart Wallet should support sendTransaction with batch or separate method
          try {
            // Method 1: Try sendTransaction with calls array (newer Privy SDK)
            if (typeof (smartWalletClient as any).sendTransactions === 'function') {
              console.log("📦 Using sendTransactions() method...")
              txHash = await Promise.race([
                (smartWalletClient as any).sendTransactions(batchCalls, { gas: MANUAL_GAS_LIMIT }),
                new Promise<never>((_, reject) => {
                  setTimeout(() => reject(new Error("Transaction timeout")), TIMEOUT_MS)
                })
              ]) as `0x${string}`
            } 
            // Method 2: Try executeBatch (alternative SDK method)
            else if (typeof (smartWalletClient as any).executeBatch === 'function') {
              console.log("📦 Using executeBatch() method...")
              txHash = await Promise.race([
                (smartWalletClient as any).executeBatch(batchCalls, { gas: MANUAL_GAS_LIMIT }),
                new Promise<never>((_, reject) => {
                  setTimeout(() => reject(new Error("Transaction timeout")), TIMEOUT_MS)
                })
              ]) as `0x${string}`
            }
            // Method 3: Fallback - Execute sequentially as single UserOp
            // Encode multicall manually if batch methods not available
            else {
              console.log("📦 Batch method not available, using sequential transactions...")
              // First approve Permit2
              console.log("  Step 1/2: Permit2.approve()...")
              const approveHash = await Promise.race([
                smartWalletClient.sendTransaction({
                  to: PERMIT2_ADDRESS as Address,
                  data: permit2Approval.data,
                  value: BigInt(0),
                  gas: BigInt(100000),
                }),
                new Promise<never>((_, reject) => {
                  setTimeout(() => reject(new Error("Approve timeout")), TIMEOUT_MS)
                })
              ]) as `0x${string}`
              
              console.log(`  ✅ Permit2 approve sent: ${approveHash}`)
              
              // Wait for approve confirmation
              if (publicClient) {
                await publicClient.waitForTransactionReceipt({ hash: approveHash })
                console.log("  ✅ Permit2 approve confirmed")
              }
              
              // Then execute Universal Router
              console.log("  Step 2/2: UniversalRouter.execute()...")
              txHash = await Promise.race([
                smartWalletClient.sendTransaction({
                  to: UNISWAP_UNIVERSAL_ROUTER as Address,
                  data: universalRouterData,
                  value: BigInt(0),
                  gas: MANUAL_GAS_LIMIT,
                }),
                new Promise<never>((_, reject) => {
                  setTimeout(() => reject(new Error("Transaction timeout")), TIMEOUT_MS)
                })
              ]) as `0x${string}`
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

      console.log("✅ Transaction Sent! Hash:", txHash)
      setHash(txHash)

      // 6. Wait for confirmation
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
    } catch (err: any) {
      console.error("❌ Convert Error:", err)
      
      let friendlyMessage = err.message || "Transaction failed"
      const errorDetails = err.details || err.cause?.details || ""
      const errorName = err.name || err.cause?.name || ""
      
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
  }
}

