import { NextRequest, NextResponse } from "next/server";
import { type Address, encodeFunctionData } from "viem";
import { CdpClient } from "@coinbase/cdp-sdk";
import { createSupabaseServiceClient } from "@/lib/supabase";

export async function POST(request: NextRequest) {
  try {
    const { botWalletAddresses, tokenAddress, recipientAddress, symbol } = await request.json();
    const cdp = new CdpClient();
    const supabase = createSupabaseServiceClient();
    const results = [];

    for (const address of botWalletAddresses) {
      try {
        // 1. Ambil data bot dari Supabase
        const { data: bot, error: fetchError } = await supabase
          .from("wallets_data")
          .select("*")
          .ilike("smart_account_address", address)
          .single();

        if (!bot || fetchError) continue;

        const ownerAccount = await cdp.evm.getAccount({ address: bot.owner_address as Address });
        const smartAccount = await cdp.evm.getSmartAccount({ owner: ownerAccount, address: address as Address });

        const WETH_ADDRESS = "0x4200000000000000000000000000000000000006";

        // 2. Eksekusi Swap Seluruh Saldo Token ke WETH (Gunakan referensi execute-swap)
        // Kita asumsikan menggunakan CDP SDK createSwap yang mendukung gasless via paymaster
        const swap = await (smartAccount as any).createSwap({
          fromAssetId: tokenAddress,
          toAssetId: WETH_ADDRESS,
          amount: "max", 
          networkId: "base"
        });

        await swap.wait();
        const amountWeth = swap.toAmount;

        // 3. Kirim WETH ke Recipient
        const transferTx = await (smartAccount as any).sendUserOperation({
          calls: [{
            to: WETH_ADDRESS,
            data: encodeFunctionData({
              abi: [{ name: 'transfer', type: 'function', inputs: [{ name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] }],
              functionName: 'transfer',
              args: [recipientAddress as Address, amountWeth]
            }),
            value: 0n
          }],
          isSponsored: true
        });

        await transferTx.wait();

        // 4. SINKRONISASI DATABASE (Penting!)
        // Kita set saldo token yang baru saja di-withdraw menjadi 0 di database
        const { error: updateError } = await supabase
          .from("wallets_data")
          .update({ 
            last_balance_update: new Date().toISOString(),
            // Opsional: Jika Anda menyimpan saldo spesifik token di kolom jsonb
            // balances: { ...bot.balances, [symbol]: "0" } 
          })
          .eq("smart_account_address", address);

        // Jika Anda memiliki tabel khusus saldo seperti 'bot_balances'
        await supabase
          .from("bot_balances")
          .update({ balance: "0" })
          .match({ smart_account_address: address, token_address: tokenAddress });

        results.push({ address, status: "success", txHash: transferTx.getTransactionHash() });

      } catch (err: any) {
        console.error(`Error on bot ${address}:`, err);
        results.push({ address, status: "failed", error: err.message });
      }
    }

    return NextResponse.json({ success: true, details: results });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
