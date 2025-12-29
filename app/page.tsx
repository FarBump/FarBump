"use client"

import { useState, useEffect } from "react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Button } from "@/components/ui/button"
import { WalletCard } from "@/components/wallet-card"
import { TokenInput } from "@/components/token-input"
import { ConfigPanel } from "@/components/config-panel"
import { ActionButton } from "@/components/action-button"
import { ActivityFeed } from "@/components/activity-feed"
import { PriceChart } from "@/components/price-chart"
import { AnalyticsCards } from "@/components/analytics-cards"
import { WalletHistory } from "@/components/wallet-history"
import { GlobalFeed } from "@/components/global-feed"
import { User } from "lucide-react"
import Image from "next/image"
import { useFarcasterMiniApp } from "@/components/miniapp-provider"
import { sdk } from "@farcaster/miniapp-sdk"

export default function BumpBotDashboard() {
  const { isInWarpcast, isReady } = useFarcasterMiniApp()

  // Ensure ready() is called after component mounts
  useEffect(() => {
    if (isReady && isInWarpcast) {
      // Call ready() to hide splash screen
      sdk.actions.ready().catch((error) => {
        console.error("Failed to call ready():", error)
      })
    }
  }, [isReady, isInWarpcast])
  const [isActive, setIsActive] = useState(false)
  const [isConnected, setIsConnected] = useState(true)
  const [userFid] = useState("12345")
  const [username] = useState("@faruser")
  const [userAvatar] = useState("/user-avatar.jpg")
  const [fuelBalance] = useState(1250.5)
  const [credits] = useState(0)

  const [activities, setActivities] = useState<
    Array<{
      id: string
      type: "buy" | "sell"
      amount: string
      hash: string
      timestamp: Date
    }>
  >([])

  const handleToggle = () => {
    setIsActive(!isActive)

    if (!isActive) {
      const interval = setInterval(() => {
        const newActivity = {
          id: Math.random().toString(36).substr(2, 9),
          type: Math.random() > 0.5 ? "buy" : ("sell" as "buy" | "sell"),
          amount: (Math.random() * 0.001).toFixed(6),
          hash: `0x${Math.random().toString(16).substr(2, 8)}...`,
          timestamp: new Date(),
        }
        setActivities((prev) => [newActivity, ...prev].slice(0, 20))
      }, 3000)

      return () => clearInterval(interval)
    }
  }

  return (
    <div className="min-h-screen bg-background p-4 pb-safe">
      <div className="mx-auto max-w-2xl space-y-4">
        <header className="rounded-lg border border-border bg-card p-4">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="relative h-16 w-16 shrink-0 sm:h-20 sm:w-20">
                <Image src="/farbump-logo.png" alt="FarBump Logo" fill className="object-contain" priority />
              </div>
              <div>
                <h1 className="font-mono text-base font-semibold tracking-tight text-foreground sm:text-lg">FarBump</h1>
                <p className="text-xs text-muted-foreground">Built to Trend</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2">
                <div className={`h-2.5 w-2.5 rounded-full ${isActive ? "bg-primary pulse-glow" : "bg-muted"}`} />
                <span className="hidden text-xs font-medium text-foreground sm:inline">
                  {isActive ? "LIVE" : "IDLE"}
                </span>
              </div>
              {isConnected ? (
                <div className="flex items-center gap-2 rounded-lg border border-border bg-secondary px-3 py-2">
                  <div className="relative h-6 w-6 overflow-hidden rounded-full border border-primary/20">
                    <Image src={userAvatar || "/placeholder.svg"} alt="User Avatar" fill className="object-cover" />
                  </div>
                  <span className="hidden font-mono text-xs font-medium text-foreground sm:inline">{username}</span>
                </div>
              ) : (
                <Button
                  size="sm"
                  onClick={() => setIsConnected(true)}
                  className="bg-primary text-primary-foreground hover:bg-primary/90 font-medium"
                >
                  <User className="mr-1.5 h-4 w-4" />
                  Connect
                </Button>
              )}
            </div>
          </div>
        </header>

        <Tabs defaultValue="control" className="w-full">
          <TabsList className="w-full grid grid-cols-3 p-1 bg-card border border-border">
            <TabsTrigger
              value="control"
              className="text-xs font-medium data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
            >
              Control Panel
            </TabsTrigger>
            <TabsTrigger
              value="history"
              className="text-xs font-medium data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
            >
              Wallet History
            </TabsTrigger>
            <TabsTrigger
              value="global"
              className="text-xs font-medium data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
            >
              Global Feed
            </TabsTrigger>
          </TabsList>

          <TabsContent value="control" className="mt-4 space-y-4">
            <AnalyticsCards isActive={isActive} />
            <PriceChart />
            <WalletCard fuelBalance={fuelBalance} credits={credits} />
            <TokenInput />
            <ConfigPanel fuelBalance={fuelBalance} credits={credits} />
            <ActionButton isActive={isActive} onToggle={handleToggle} credits={credits} />
            <ActivityFeed activities={activities} isActive={isActive} />
          </TabsContent>

          <TabsContent value="history" className="mt-4">
            <WalletHistory />
          </TabsContent>

          <TabsContent value="global" className="mt-4">
            <GlobalFeed />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  )
}
