"use client"

import { Card } from "@/components/ui/card"
import { TrendingUp, BarChart3 } from "lucide-react"

export function PriceChart() {
  return (
    <Card className="border border-border bg-card p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <BarChart3 className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-semibold text-foreground">Live Price Chart</h3>
        </div>
        <div className="flex items-center gap-1 text-primary">
          <TrendingUp className="h-3 w-3" />
          <span className="text-xs font-medium">+4.2%</span>
        </div>
      </div>

      <div className="relative h-48 overflow-hidden rounded-lg bg-secondary border border-border">
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="flex flex-col items-center gap-2 text-muted-foreground">
            <BarChart3 className="h-8 w-8 opacity-50" />
            <p className="text-xs">Chart integration point</p>
            <p className="text-xs font-mono text-muted-foreground/60">TradingView / Recharts</p>
          </div>
        </div>

        <div className="absolute inset-0 flex items-end justify-around gap-1 p-4 opacity-30">
          {Array.from({ length: 12 }).map((_, i) => {
            const height = Math.random() * 80 + 20
            const isGreen = Math.random() > 0.5
            return (
              <div
                key={i}
                className={`w-full rounded-t ${isGreen ? "bg-primary" : "bg-destructive"}`}
                style={{ height: `${height}%` }}
              />
            )
          })}
        </div>
      </div>

      <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
        <span>24h</span>
        <span className="font-mono">$0.000234</span>
      </div>
    </Card>
  )
}
