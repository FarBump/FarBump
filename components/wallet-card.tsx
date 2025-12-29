"use client"

import { useState } from "react"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Copy, Check, Shield } from "lucide-react"

interface WalletCardProps {
  fuelBalance?: number
  credits?: number
  walletAddress?: string | null
}

export function WalletCard({ fuelBalance = 0, credits = 0, walletAddress }: WalletCardProps) {
  const [copied, setCopied] = useState(false)
  // Privy Smart Wallet address (untuk display)
  const smartWalletAddress = walletAddress || "0x000...000"
  const ethBalance = 2.4567

  const handleCopy = () => {
    navigator.clipboard.writeText(smartWalletAddress)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <Card className="border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 border border-primary/20">
            <Shield className="h-5 w-5 text-primary" />
          </div>
          <div className="flex-1 space-y-1">
            <p className="text-xs font-medium text-foreground">Privy Smart Wallet</p>
            <p className="font-mono text-xs text-foreground break-all">{smartWalletAddress || "0x000...000"}</p>
            <p className="text-[10px] leading-tight text-muted-foreground pt-0.5">
              Dedicated secure wallet for FarBump automation on Base Network.
            </p>
          </div>
        </div>
        <Button size="sm" variant="ghost" className="shrink-0 h-8 w-8 p-0 hover:bg-muted" onClick={handleCopy}>
          {copied ? <Check className="h-4 w-4 text-primary" /> : <Copy className="h-4 w-4 text-muted-foreground" />}
        </Button>
      </div>

      <div className="mt-4 space-y-3">
        <div className="rounded-lg bg-secondary border border-border p-3">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Token Balance ($BUMP)</p>
          <p className="mt-1 font-mono text-sm font-semibold text-primary">{fuelBalance || "0"}</p>
        </div>

        <div className="rounded-lg bg-secondary border border-border p-3">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Credits</p>
          <p className="mt-1 font-mono text-sm font-semibold text-foreground">${credits.toFixed(2)}</p>
        </div>

        <div className="px-1 py-2">
          <p className="text-[9px] text-muted-foreground uppercase tracking-wide">Gas (ETH)</p>
          <p className="mt-0.5 font-mono text-xs font-medium text-foreground">{ethBalance}</p>
        </div>
      </div>
    </Card>
  )
}
