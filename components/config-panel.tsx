"use client"

import { useState } from "react"
import { Card } from "@/components/ui/card"
import { Slider } from "@/components/ui/slider"
import { Input } from "@/components/ui/input"
import { Clock, Coins, Fuel, ExternalLink, AlertCircle, ArrowRightLeft, ArrowDownUp } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useBumpBalance } from "@/hooks/use-bump-balance"
import { useFarcasterMiniApp } from "@/components/miniapp-provider"
import { sdk } from "@farcaster/miniapp-sdk"
import { WithdrawModal } from "@/components/withdraw-modal"

interface ConfigPanelProps {
  fuelBalance?: number
  credits?: number
  smartWalletAddress?: string | null
}

export function ConfigPanel({ fuelBalance = 0, credits = 0, smartWalletAddress }: ConfigPanelProps) {
  // Fetch $BUMP token balance from Smart Wallet address (same as WalletCard)
  const { formattedBalance, isLoading: isLoadingBalance } = useBumpBalance({
    address: smartWalletAddress || null,
    enabled: !!smartWalletAddress && smartWalletAddress !== "0x000...000",
  })
  const { isInWarpcast } = useFarcasterMiniApp()
  const [bumpSpeed, setBumpSpeed] = useState([5])
  const [amount, setAmount] = useState("0.0001")
  const [withdrawModalOpen, setWithdrawModalOpen] = useState(false)

  // Handle Buy $BUMP using Farcaster Native Swap
  // Based on: https://miniapps.farcaster.xyz/docs/sdk/actions/swap-token#buytoken-optional
  // Format: CAIP-19 asset ID (eip155:chainId/erc20:address)
  const handleBuyBump = async () => {
    if (!isInWarpcast) {
      // Fallback to external link if not in Warpcast
      window.open(`https://app.uniswap.org/swap?chain=base&outputCurrency=0x94ce728849431818ec9a0cf29bdb24fe413bbb07`, '_blank')
      return
    }

    try {
      // Use Farcaster SDK swapToken action for native swap
      // CAIP-19 format: eip155:8453/erc20:0x94ce728849431818ec9a0cf29bdb24fe413bbb07
      const result = await sdk.actions.swapToken({
        buyToken: "eip155:8453/erc20:0x94ce728849431818ec9a0cf29bdb24fe413bbb07", // $BUMP token on Base
      })

      if (result.success) {
        console.log("✅ Swap successful:", result.swap.transactions)
      } else {
        console.warn("⚠️ Swap rejected or failed:", result.reason)
      }
    } catch (error) {
      console.error("Failed to open swap interface:", error)
      // Fallback to external link
      window.open(`https://app.uniswap.org/swap?chain=base&outputCurrency=0x94ce728849431818ec9a0cf29bdb24fe413bbb07`, '_blank')
    }
  }

  return (
    <div className="space-y-4">
      <Card className="border border-border bg-card p-4">
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Fuel className="h-4 w-4 text-primary" />
              <span className="text-sm font-semibold text-foreground">Fuel Status</span>
            </div>
          </div>

          <div className="space-y-3 rounded-lg bg-secondary border border-border p-3">
            <div className="space-y-1">
              <p className="text-xs font-medium text-foreground">Current Balance</p>
              <p className="font-mono text-lg font-bold text-primary">
                {isLoadingBalance ? (
                  <span className="text-muted-foreground">Loading...</span>
                ) : (
                  `${formattedBalance} $BUMP`
                )}
              </p>
              <p className="text-[10px] text-muted-foreground leading-tight">This app runs ONLY on $BUMP tokens</p>
            </div>

            <Button 
              size="sm" 
              className="w-full bg-primary text-primary-foreground hover:bg-primary/90 font-semibold"
              disabled={!smartWalletAddress}
              title={!smartWalletAddress ? "Smart Wallet not ready" : "Convert $BUMP to Credit using Smart Wallet"}
            >
              <ArrowRightLeft className="mr-2 h-4 w-4" />
              Convert $BUMP to Credit
            </Button>

            <Button
              size="sm"
              variant="outline"
              className="w-full border-primary/20 text-primary hover:bg-primary/10 font-medium bg-transparent"
              onClick={handleBuyBump}
              disabled={!smartWalletAddress}
              title={!smartWalletAddress ? "Smart Wallet not ready" : "Buy $BUMP using Farcaster Native Swap"}
            >
              <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
              Buy $BUMP
            </Button>

            <Button
              size="sm"
              variant="outline"
              className="w-full border-border text-foreground hover:bg-secondary font-medium"
              onClick={() => setWithdrawModalOpen(true)}
              disabled={!smartWalletAddress || isLoadingBalance}
              title={!smartWalletAddress ? "Smart Wallet not ready" : "Withdraw $BUMP to another address"}
            >
              <ArrowDownUp className="mr-1.5 h-3.5 w-3.5" />
              Withdraw $BUMP
            </Button>
          </div>

          <WithdrawModal
            open={withdrawModalOpen}
            onOpenChange={setWithdrawModalOpen}
            smartWalletAddress={smartWalletAddress}
          />

          {credits === 0 && (
            <div className="flex items-start gap-2 rounded-lg bg-destructive/10 border border-destructive/20 p-3">
              <AlertCircle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
              <div className="space-y-1">
                <p className="text-xs font-semibold text-destructive">NO FUEL DETECTED</p>
                <p className="text-[10px] text-destructive/80 leading-tight">
                  Convert $BUMP tokens to Credits to power your bumping automation
                </p>
              </div>
            </div>
          )}
        </div>
      </Card>

      <Card className="border border-border bg-card p-4">
        <div className="space-y-6">
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Clock className="h-4 w-4 text-primary" />
                <label className="text-sm font-medium text-foreground">Bump Speed</label>
              </div>
              <span className="font-mono text-sm font-semibold text-primary">{bumpSpeed[0]} min</span>
            </div>
            <Slider
              value={bumpSpeed}
              onValueChange={setBumpSpeed}
              min={1}
              max={30}
              step={1}
              className="cursor-pointer"
            />
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>1 min</span>
              <span>Fast</span>
              <span>30 min</span>
            </div>
          </div>

          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Coins className="h-4 w-4 text-primary" />
              <label className="text-sm font-medium text-foreground">Amount per Bump</label>
            </div>
            <div className="relative">
              <Input
                type="number"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="font-mono pr-16 bg-secondary border-border text-foreground"
                step="0.01"
                min="0"
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm font-medium text-muted-foreground">
                Credit
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              Estimated cost: ~{(Number.parseFloat(amount) * 24 * (60 / bumpSpeed[0])).toFixed(2)} credits/day
            </p>
          </div>
        </div>
      </Card>
    </div>
  )
}
