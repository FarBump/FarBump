import { NextRequest, NextResponse } from "next/server"
import { createPublicClient, http, type Address, formatUnits } from "viem"
import { base } from "viem/chains"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const WETH_BASE = "0x4200000000000000000000000000000000000006"

// Kita tetap gunakan Public Client untuk verifikasi saldo akhir yang paling akurat (On-chain)
const publicClient = createPublicClient({
  chain: base,
  transport: http(process.env.NEXT_PUBLIC_BASE_RPC_URL),
})

const ERC20_ABI = [
  { inputs: [{ name: "_owner", type: "address" }], name: "balanceOf", outputs: [{ name: "balance", type: "uint256" }], type: "function" },
  { inputs: [], name: "decimals", outputs: [{ name: "", type: "uint8" }], type: "function" },
  { inputs: [], name: "symbol", outputs: [{ name: "", type: "string" }], type: "function" },
  { inputs: [], name: "name", outputs: [{ name: "", type: "string" }], type: "function" },
] as const

/**
 * Discovery menggunakan BaseScan V2 addresstokenbalance
 * Endpoint ini mengembalikan list token yang saat ini dimiliki (balance > 0)
 */
async function fetchTokenListV2(address: string): Promise<string[]> {
  try {
    const apiKey = process.env.BASESCAN_API_KEY
    if (!apiKey) return []

    // Menggunakan action=addresstokenbalance sesuai dokumentasi V2
    const url = `https://api.basescan.org/api?chainid=8453&module=account&action=addresstokenbalance&address=${address}&page=1&offset=100&apikey=${apiKey}`

    const response = await fetch(url, { cache: 'no-store' })
    const data = await response.json()

    if (data.status !== "1" || !Array.isArray(data.result)) {
      return []
    }

    // Mengambil property tokenAddress dari hasil V2
    return data.result.map((item: any) => item.tokenAddress.toLowerCase())
  } catch (error) {
    console.error("Discovery V2 Error:", error)
    return []
  }
}

export async function POST(request: NextRequest) {
  try {
    const { botWallets } = await request.json()
    if (!botWallets || botWallets.length === 0) {
      return NextResponse.json({ success: true, tokens: [] })
    }

    // 1. Discovery: Dapatkan list kontrak token dari semua wallet menggunakan V2
    const discoveryResults = await Promise.all(botWallets.map((addr: string) => fetchTokenListV2(addr)))
    
    // Gabungkan semua alamat token unik dari 5 wallet + pastikan WETH masuk list
    const uniqueTokens = Array.from(new Set([...discoveryResults.flat(), WETH_BASE.toLowerCase()]))

    // 2. Fetch Detail & Saldo Akurat via RPC (untuk memastikan data real-time)
    const tokenDetails = await Promise.all(
      uniqueTokens.map(async (tokenAddr) => {
        const address = tokenAddr as Address
        try {
          // Cek saldo di ke-5 wallet
          const balances = await Promise.all(
            botWallets.map((wallet: string) =>
              publicClient.readContract({
                address,
                abi: ERC20_ABI,
                functionName: "balanceOf",
                args: [wallet as Address],
              }).catch(() => BigInt(0))
            )
          )

          const totalBalance = balances.reduce((acc, curr) => acc + curr, BigInt(0))
          
          // Jika total saldo dari semua bot tetap 0, jangan tampilkan di dropdown
          if (totalBalance === BigInt(0)) return null

          // Ambil metadata token
          const [symbol, name, decimals] = await Promise.all([
            publicClient.readContract({ address, abi: ERC20_ABI, functionName: "symbol" }).catch(() => "???"),
            publicClient.readContract({ address, abi: ERC20_ABI, functionName: "name" }).catch(() => "Unknown"),
            publicClient.readContract({ address, abi: ERC20_ABI, functionName: "decimals" }).catch(() => 18),
          ])

          return {
            address: tokenAddr,
            symbol,
            name,
            decimals: Number(decimals),
            balanceWei: totalBalance.toString(),
            balanceFormatted: formatUnits(totalBalance, Number(decimals)),
            walletBalances: botWallets.map((w: string, i: number) => ({
              address: w,
              balance: balances[i].toString()
            }))
          }
        } catch {
          return null
        }
      })
    )

    // Bersihkan hasil dari null (token saldo 0)
    const tokens = tokenDetails.filter((t) => t !== null)

    // Urutkan saldo terbesar di atas
    tokens.sort((a, b) => parseFloat(b!.balanceFormatted) - parseFloat(a!.balanceFormatted))

    return NextResponse.json({ success: true, tokens })
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
