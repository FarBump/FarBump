import { NextRequest, NextResponse } from "next/server";
import { type Address, encodeFunctionData, createPublicClient, http } from "viem";
import { base } from "viem/chains";
import { CdpClient } from "@coinbase/cdp-sdk";
import { createSupabaseServiceClient } from "@/lib/supabase";

const WETH_ADDRESS = "0x4200000000000000000000000000000000000006" as const;
const ERC20_ABI = [
  { inputs: [], name: "deposit", outputs: [], type: "function", stateMutability: "payable" },
  { inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], name: "transfer", outputs: [{ name: "", type: "bool" }], type: "function" },
] as const;

export async function POST(req: NextRequest) {
  try {
    const { botAddress, recipient } = await req.json();
    const supabase = createSupabaseServiceClient();

    const { data: botWallet } = await supabase.from("wallets_data").select("*").ilike("smart_account_address", botAddress).single();
    if (!botWallet) throw new Error("Wallet not found");

    const cdp = new CdpClient();
    const ownerAccount = await cdp.evm.getAccount({ address: botWallet.owner_address as Address });
    const smartAccount = await cdp.evm.getSmartAccount({ owner: ownerAccount, address: botAddress as Address });

    const publicClient = createPublicClient({ chain: base, transport: http() });
    const ethBalance = await publicClient.getBalance({ address: botAddress as Address });

    if (ethBalance === 0n) throw new Error("No ETH balance to wrap");

    // Eksekusi Full Gasless via Paymaster
    const op = await smartAccount.sendUserOperation({
      calls: [
        {
          to: WETH_ADDRESS,
          data: encodeFunctionData({ abi: ERC20_ABI, functionName: "deposit", args: [] }),
          value: ethBalance,
        },
        {
          to: WETH_ADDRESS,
          data: encodeFunctionData({ abi: ERC20_ABI, functionName: "transfer", args: [recipient as Address, ethBalance] }),
        },
      ],
    });

    await op.wait();
    return NextResponse.json({ success: true, txHash: op.userOpHash });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
