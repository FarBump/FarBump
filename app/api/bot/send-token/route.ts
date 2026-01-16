import { NextRequest, NextResponse } from "next/server"
import { isAddress, type Address, type Hex, createPublicClient, http, encodeFunctionData } from "viem"
import { base } from "viem/chains"
import { createSupabaseServiceClient } from "@/lib/supabase"
import { CdpClient } from "@coinbase/cdp-sdk"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const ERC20_ABI = [
  { constant: true, inputs: [{ name: "_owner", type: "address" }], name: "balanceOf", outputs: [{ name: "balance", type: "uint256" }], type: "function" },
  { constant: false, inputs: [{ name: "_to", type: "address" }, { name: "_value", type: "uint256" }], name: "transfer", outputs: [{ name: "", type: "bool" }], type: "function" },
] as const

const publicClient = createPublicClient({
  chain: base,
  transport: http(process.env.NEXT_PUBLIC_BASE_RPC_URL),
})

export async function POST(request: NextRequest) {
  try {
    // 1. Validasi Variabel Lingkungan di dalam POST
    const apiKeyName = process.env.CDP_API_KEY_ID;
    const privateKey = process.env.CDP_API_KEY_SECRET?.replace(/\\n/g, "\n");

    if (!apiKeyName || !privateKey) {
      console.error("❌ CDP SDK not configured: Missing env variables");
      return NextResponse.json({ error: "Server configuration error" }, { status: 500 });
    }

    /** * Update Cara Konfigurasi: 
     * Beberapa versi CDP menggunakan CdpClient.configure, 
     * yang lain menggunakan konfigurasi saat inisialisasi.
     */
    try {
      if (typeof (CdpClient as any).configure === 'function') {
        (CdpClient as any).configure({ apiKeyName, privateKey });
      }
    } catch (e) {
      console.warn("CDP Manual config failed, proceeding with instance config");
    }

    const body = await request.json()
    const { botWalletAddress, tokenAddress, recipientAddress, amountWei, symbol } = body

    if (!botWalletAddress || !tokenAddress || !recipientAddress || !amountWei) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 })
    }

    const supabase = createSupabaseServiceClient()
    const { data: botWallet, error: walletError } = await supabase
      .from("wallets_data")
      .select("smart_account_address, owner_address")
      .eq("smart_account_address", botWalletAddress.toLowerCase())
      .single()

    if (walletError || !botWallet) return NextResponse.json({ error: "Wallet not found" }, { status: 404 })

    // 2. Inisialisasi Client
    const cdp = new CdpClient({ apiKeyName, privateKey });
    const ownerAccount = await cdp.evm.getAccount({ address: botWallet.owner_address as Address })
    const smartAccount = await cdp.evm.getSmartAccount({
      owner: ownerAccount,
      address: botWallet.smart_account_address as Address,
    })

    const transferData = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: "transfer",
      args: [recipientAddress as Address, BigInt(amountWei)],
    })

    const userOpHash = await (smartAccount as any).sendUserOperation({
      network: "base",
      calls: [{ to: tokenAddress as Address, data: transferData as Hex, value: BigInt(0) }],
      isSponsored: true,
    })

    const userOpReceipt = await (smartAccount as any).waitForUserOperation({
      network: "base",
      hash: userOpHash,
    })

    return NextResponse.json({
      success: true,
      txHash: userOpReceipt?.transactionHash || userOpHash,
      message: `Sent ${symbol} to ${recipientAddress}`,
    })

  } catch (error: any) {
    console.error("❌ Error:", error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
