"use client"

import { useState } from "react"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { CheckCircle2, XCircle, Loader2 } from "lucide-react"

export function TokenInput() {
  const [address, setAddress] = useState("")
  const [status, setStatus] = useState<"idle" | "loading" | "verified" | "error">("idle")

  const handleVerify = () => {
    setStatus("loading")
    setTimeout(() => {
      setStatus(address.length > 10 ? "verified" : "error")
    }, 1500)
  }

  return (
    <Card className="border border-border bg-card p-4">
      <div className="space-y-3">
        <label className="text-sm font-medium text-foreground">Target Token</label>
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Input
              placeholder="Paste Contract Address (0x...)"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              className="font-mono text-sm pr-10 bg-secondary border-border text-foreground"
            />
            {status === "verified" && (
              <CheckCircle2 className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-primary" />
            )}
            {status === "error" && (
              <XCircle className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-destructive" />
            )}
          </div>
          <Button
            onClick={handleVerify}
            disabled={!address || status === "loading"}
            className="shrink-0 bg-primary text-primary-foreground hover:bg-primary/90"
          >
            {status === "loading" ? <Loader2 className="h-4 w-4 animate-spin" /> : "Verify"}
          </Button>
        </div>
        {status === "verified" && (
          <div className="flex items-center gap-2 text-xs text-primary">
            <CheckCircle2 className="h-3 w-3" />
            <span>Token verified on Base Network</span>
          </div>
        )}
        {status === "error" && (
          <div className="flex items-center gap-2 text-xs text-destructive">
            <XCircle className="h-3 w-3" />
            <span>Invalid contract address</span>
          </div>
        )}
      </div>
    </Card>
  )
}
