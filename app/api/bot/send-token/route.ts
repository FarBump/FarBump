import { NextRequest, NextResponse } from "next/server"
import { isAddress, type Address, type Hex, createPublicClient, http, encodeFunctionData } from "viem"
import { base } from "viem/chains"
import { createSupabaseServiceClient } from "@/lib/supabase"
import { CdpClient } from "@coinbase/cdp-sdk"
import "dotenv/config"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

// Konfigurasi CDP SDK global (Gunakan variabel env yang sesuai di Railway/Vercel)
CdpClient.configure({
  apiKeyName: process.env.CDP_API_KEY_ID || "",
  privateKey: (process.env.CDP_API_KEY_SECRET || "").replace(/\\n/g, "\n"),
});

// ERC20 ABI standar untuk cek saldo dan transfer
const ERC20_ABI = [
  {
    constant: true,
    inputs: [{ name: "_owner", type: "address" }],
    name: "balanceOf",
    outputs: [{ name: "balance", type: "uint256" }],
    type: "function",
  },
  {
    constant: false,
    inputs: [
      { name: "_to", type: "address" },
      { name: "_value", type: "uint256" },
    ],
    name: "transfer",
    outputs: [{ name: "", type: "bool" }],
    type: "function",
  },
] as const

const publicClient = createPublicClient({
  chain: base,
  transport: http(process.env.NEXT_PUBLIC_BASE_RPC_URL),
})

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const {
      botWalletAddress,
      tokenAddress,
      recipientAddress,
      amountWei,
      symbol,
    } = body as {
      botWalletAddress: string
      tokenAddress: string
      recipientAddress: string
      amountWei: string
      symbol: string
    }

    // 1. Validasi Input Dasar
    if (!botWalletAddress || !tokenAddress || !recipientAddress || !amountWei) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 }
      )
    }

    if (!isAddress(botWalletAddress) || !isAddress(tokenAddress) || !isAddress(recipientAddress)) {
      return NextResponse.json(
        { error: "Invalid Ethereum address format" },
        { status: 400 }
      )
    }

    // 2. Verifikasi Wallet di Database (Gunakan Service Role untuk bypass RLS jika perlu)
    const supabase = createSupabaseServiceClient()
    const { data: botWallet, error: walletError } = await supabase
      .from("wallets_data")
      .select("smart_account_address, owner_address")
      .eq("smart_account_address", botWalletAddress.toLowerCase())
      .single()

    if (walletError || !botWallet) {
      return NextResponse.json({ error: "Bot wallet not found" }, { status: 404 })
    }

    const smartAccountAddress = botWallet.smart_account_address as Address
    const ownerAddress = botWallet.owner_address as Address

    // 3. Cek Saldo On-Chain sebelum mencoba transaksi
    const balance = await publicClient.readContract({
      address: tokenAddress as Address,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [smartAccountAddress],
    })

    if (BigInt(balance) < BigInt(amountWei)) {
      return NextResponse.json({ error: "Insufficient balance on-chain" }, { status: 400 })
    }

    // 4. Eksekusi via CDP Smart Account (Gasless)
    const cdp = new CdpClient()
    const ownerAccount = await cdp.evm.getAccount({ address: ownerAddress })
    
    const smartAccount = await cdp.evm.getSmartAccount({
      owner: ownerAccount,
      address: smartAccountAddress,
    })

    // Encode data transfer ERC20
    const transferData = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: "transfer",
      args: [recipientAddress as Address, BigInt(amountWei)],
    })

    console.log(`🚀 Sending UserOp for ${symbol} from ${smartAccountAddress}`)

    // Kirim User Operation dengan Sponsorship (Paymaster)
    const userOpHash = await (smartAccount as any).sendUserOperation({
      network: "base",
      calls: [{
        to: tokenAddress as Address,
        data: transferData as Hex,
        value: BigInt(0),
      }],
      isSponsored: true, 
    })

    // 5. Tunggu Konfirmasi & Ambil Tx Hash
    const userOpReceipt = await (smartAccount as any).waitForUserOperation({
      network: "base",
      hash: userOpHash,
    })

    const txHash = userOpReceipt?.transactionHash || userOpReceipt?.hash || userOpHash

    return NextResponse.json({
      success: true,
      txHash,
      message: `Successfully sent ${symbol} to ${recipientAddress}`,
    })

  } catch (error: any) {
    console.error("❌ Send Token Error:", error)
    return NextResponse.json(
      { error: "Transaction failed", details: error.message },
      { status: 500 }
    )
  }
}
