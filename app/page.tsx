"use client"

import { useState, useEffect } from "react"
import { sdk } from "@farcaster/miniapp-sdk"
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
import { useFarcasterAuth } from "@/hooks/use-farcaster-auth"
import { usePrivy, useWallets } from "@privy-io/react-auth"
import { useAccount } from "wagmi"

export default function BumpBotDashboard() {
  const { isInWarpcast, isReady, context } = useFarcasterMiniApp()
  const { 
    isAuthenticated,
    farcasterUser,
    privyUser,
    initLoginToMiniApp,
    loginToMiniApp
  } = useFarcasterAuth()
  
  const { ready: privyReady } = usePrivy()
  const { wallets } = useWallets()
  const { address: wagmiAddress, isConnected: wagmiConnected } = useAccount()
  
  // Get Smart Wallet address (Smart Wallet untuk transaksi di app)
  // Smart Wallet memiliki walletClientType === 'smart_wallet'
  const smartWallet = wallets.find(w => w.walletClientType === 'smart_wallet')
  // Fallback ke wagmiAddress jika Smart Wallet belum ready (useAccount sudah terhubung dengan Smart Wallet)
  const privySmartWalletAddress = smartWallet?.address || wagmiAddress || null
  
  // Debug: Log wallet information
  useEffect(() => {
    if (wallets.length > 0) {
      console.log("🔍 Privy Wallets:", wallets.map(w => ({
        address: w.address,
        walletClientType: w.walletClientType,
        chainId: w.chainId
      })))
      console.log("🔍 Smart Wallet:", smartWallet ? {
        address: smartWallet.address,
        walletClientType: smartWallet.walletClientType
      } : "Not found")
      console.log("🔍 Wagmi Address:", wagmiAddress)
      console.log("🔍 Final Smart Wallet Address:", privySmartWalletAddress)
    }
  }, [wallets, smartWallet, wagmiAddress, privySmartWalletAddress])
  
  const [isConnecting, setIsConnecting] = useState(false)
  const [isActive, setIsActive] = useState(false)
  const [fuelBalance] = useState(1250.5)
  const [credits] = useState(0)

  // Extract user data dari Farcaster context
  const username = farcasterUser?.username 
    ? `@${farcasterUser.username}` 
    : privyUser?.farcaster?.username 
    ? `@${privyUser.farcaster.username}` 
    : null

  const userFid = farcasterUser?.fid?.toString() || privyUser?.farcaster?.fid?.toString() || null

  const userAvatar = farcasterUser?.pfp?.url || 
    (privyUser?.farcaster as any)?.profilePicture || 
    "/user-avatar.jpg"

  // Farcaster Embed Wallet address (untuk verifikasi di Step 3)
  const farcasterEmbedWallet = context?.user?.custodyAddress || null

  // Determine connection states
  const isWalletReady = wagmiConnected && !!wagmiAddress
  const isConnected = isAuthenticated && username && userFid && farcasterEmbedWallet && isWalletReady
  const isInitializing = isAuthenticated && username && userFid && farcasterEmbedWallet && !isWalletReady

  const [activities, setActivities] = useState<
    Array<{
      id: string
      type: "buy" | "sell"
      amount: string
      hash: string
      timestamp: Date
    }>
  >([])

  // Call sdk.actions.ready() to hide splash screen in Farcaster Mini App
  // This MUST be called in page.tsx, otherwise splash screen won't close
  useEffect(() => {
    const callReady = async () => {
      // Only call if in Warpcast and SDK is ready
      if (isInWarpcast && isReady && typeof window !== 'undefined') {
        try {
          console.log("📱 Calling sdk.actions.ready() to hide splash screen...")
          await sdk.actions.ready()
          console.log("✅ sdk.actions.ready() called successfully")
        } catch (error) {
          console.error("❌ Failed to call sdk.actions.ready():", error)
        }
      }
    }

    callReady()
  }, [isInWarpcast, isReady])

  // Handle Connect button click - Step 2: User login dengan Farcaster Mini App flow
  // Flow: initLoginToMiniApp() -> sdk.actions.signIn({nonce}) -> loginToMiniApp({message, signature})
  const handleConnect = async () => {
    setIsConnecting(true)
    try {
      console.log("🔘 Connect Button: Clicked, initiating Farcaster Mini App login...")
      
      // Step 1: Initialize login to get nonce
      const { nonce } = await initLoginToMiniApp()
      console.log("✅ Step 1: Login initialized, nonce received:", nonce)
      
      // Step 2: Sign in with Farcaster Mini App SDK
      // This returns { message, signature }
      const { message, signature } = await sdk.actions.signIn({ nonce })
      console.log("✅ Step 2: Signed in with Farcaster, signature received")
      
      // Step 3: Complete login with Privy using message and signature
      await loginToMiniApp({ message, signature })
      console.log("✅ Step 3: Login completed with Privy")
      
      // Setelah ini, Privy akan otomatis create Smart Wallet
    } catch (error) {
      console.error("❌ Connect Button: Login failed:", error)
      setIsConnecting(false)
    }
  }

  // Handle login completion - Step 3: Verifikasi user data setelah login
  useEffect(() => {
    if (isAuthenticated && username && userFid) {
      // Verifikasi: username, FID, dan Farcaster Embed Wallet
      if (farcasterEmbedWallet) {
        console.log("✅ User data verified:", {
          username,
          fid: userFid,
          farcasterEmbedWallet, // Farcaster Embed Wallet untuk verifikasi
          hasPrivySmartWallet: !!privySmartWalletAddress
        })
        
        if (privySmartWalletAddress) {
          console.log("✅ Privy Smart Wallet ready:", privySmartWalletAddress)
          setIsConnecting(false)
        } else {
          console.log("⏳ Waiting for Privy Smart Wallet creation...")
        }
      }
    }
  }, [isAuthenticated, username, userFid, farcasterEmbedWallet, privySmartWalletAddress])
  
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
                // State 3: Connected (Privy Smart Wallet ready)
                <div className="flex items-center gap-2 rounded-lg border border-border bg-secondary px-3 py-2">
                  <div className="relative h-6 w-6 overflow-hidden rounded-full border border-primary/20">
                    <Image src={userAvatar || "/placeholder.svg"} alt="User Avatar" fill className="object-cover rounded-full" />
                  </div>
                  <span className="hidden font-mono text-xs font-medium text-foreground sm:inline">{username}</span>
                </div>
              ) : isInitializing ? (
                // State 2: Initializing (Privy Smart Wallet sedang dibuat)
                <Button
                  size="sm"
                  disabled
                  className="bg-primary text-primary-foreground hover:bg-primary/90 font-medium animate-pulse"
                >
                  <User className="mr-1.5 h-4 w-4" />
                  INITIALIZING...
                </Button>
              ) : (
                // State 1: Not Connected
                <Button
                  size="sm"
                  onClick={handleConnect}
                  disabled={isConnecting || !privyReady}
                  className="bg-primary text-primary-foreground hover:bg-primary/90 font-medium shadow-lg shadow-primary/50"
                >
                  <User className="mr-1.5 h-4 w-4" />
                  CONNECT
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
            <WalletCard fuelBalance={fuelBalance} credits={credits} walletAddress={privySmartWalletAddress} />
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
