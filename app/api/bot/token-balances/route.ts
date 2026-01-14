import { NextRequest, NextResponse } from "next/server"
import { createPublicClient, http, type Address, formatUnits } from "viem"
import { base } from "viem/chains"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const BASESCAN_API_URL = "https://api.basescan.org/api"

const ERC20_ABI = [
  { inputs: [{ name: "_owner", type: "address" }], name: "balanceOf", outputs: [{ name: "balance", type: "uint256" }], type: "function" },
  { inputs: [], name: "decimals", outputs: [{ name: "", type: "uint8" }], type: "function" },
  { inputs: [], name: "symbol", outputs: [{ name: "", type: "string" }], type: "function" },
  { inputs: [], name: "name", outputs: [{ name: "", type: "string" }], type: "function" },
] as const

const publicClient = createPublicClient({
  chain: base,
  transport: http(process.env.NEXT_PUBLIC_BASE_RPC_URL),
})

async function fetchTokenListFromBaseScan(address: string): Promise<string[]> {
  try {
    const apiKey = process.env.BASESCAN_API_KEY || ""
    // Penting: Gunakan action=tokentx untuk mendapatkan daftar ERC20 yang pernah berinteraksi
    const url = `${BASESCAN_API_URL}?module=account&action=tokentx&address=${address}&startblock=0&endblock=99999999&sort=desc&apikey=${apiKey}`
    
    const response = await fetch(url, { next: { revalidate: 0 } })
    const data = await response.json()
    
    if (data.status !== "1" || !Array.isArray(data.result)) return []
    
    // Ambil unique contract addresses saja
    return Array.from(new Set(data.result.map((tx: any) => tx.contractAddress.toLowerCase())))
  } catch (error) {
    return []
  }
}

async function fetchTokenDetails(tokenAddress: string, walletAddresses: string[]): Promise<any | null> {
  try {
    const address = tokenAddress as Address;

    // Gunakan multicall jika RPC mendukung, atau Promise.all untuk efisiensi
    const [symbol, name, decimals] = await Promise.all([
      publicClient.readContract({ address, abi: ERC20_ABI, functionName: "symbol" }).catch(() => "???"),
      publicClient.readContract({ address, abi: ERC20_ABI, functionName: "name" }).catch(() => "Unknown"),
      publicClient.readContract({ address, abi: ERC20_ABI, functionName: "decimals" }).catch(() => 18),
    ])

    let totalBalance = BigInt(0)
    for (const wallet of walletAddresses) {
      const bal = await publicClient.readContract({
        address,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [wallet as Address],
      }).catch(() => BigInt(0))
      totalBalance += bal
    }

    if (totalBalance === BigInt(0)) return null

    const formatted = formatUnits(totalBalance, Number(decimals))

    return {
      contractAddress: tokenAddress,
      address: tokenAddress,
      symbol,
      name,
      decimals: Number(decimals),
      balance: totalBalance.toString(),
      balanceFormatted: formatted
    }
  } catch (e) {
    return null
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { botWalletAddress, botWallets } = body
    const walletAddresses = botWalletAddress ? [botWalletAddress] : (botWallets || [])

    if (walletAddresses.length === 0) {
      return NextResponse.json({ error: "No wallet address provided" }, { status: 400 })
    }

    // 1. Dapatkan semua kontrak token dari BaseScan
    const tokenDiscoveryPromises = walletAddresses.map(addr => fetchTokenListFromBaseScan(addr))
    const results = await Promise.all(tokenDiscoveryPromises)
    const uniqueTokens = Array.from(new Set(results.flat()))

    // 2. Ambil detail saldo secara paralel
    const detailsPromises = uniqueTokens.map(token => fetchTokenDetails(token, walletAddresses))
    const tokens = (await Promise.all(detailsPromises)).filter(t => t !== null)

    // 3. Sortir (Saldo terbesar di atas)
    tokens.sort((a, b) => parseFloat(b.balanceFormatted) - parseFloat(a.balanceFormatted))

    return NextResponse.json({
      success: true,
      tokens,
      count: tokens.length
    })
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
