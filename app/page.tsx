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
import { useSmartWallets } from "@privy-io/react-auth/smart-wallets"
import { useAccount } from "wagmi"
import { base } from "wagmi/chains"

export default function BumpBotDashboard() {
  const { isInWarpcast, isReady, context } = useFarcasterMiniApp()
  const { 
    isAuthenticated,
    farcasterUser,
    privyUser,
    initLoginToMiniApp,
    loginToMiniApp
  } = useFarcasterAuth()
  
  const { ready: privyReady, user, authenticated, login, createWallet } = usePrivy()
  const { wallets } = useWallets()
  const { address: wagmiAddress, isConnected: wagmiConnected } = useAccount()
  
  // Use useSmartWallets hook to detect Smart Account
  // This is the recommended way to access Smart Wallets in Privy
  const { client: smartWalletClient } = useSmartWallets()
  
  // State to store Smart Wallet address (detected via useEffect when ready)
  const [privySmartWalletAddress, setPrivySmartWalletAddress] = useState<string | null>(null)
  const [smartWallet, setSmartWallet] = useState<any>(null)
  const [sdkReady, setSdkReady] = useState(false)
  const [isCreatingSmartWallet, setIsCreatingSmartWallet] = useState(false)
  
  // Farcaster Embed Wallet address (hanya untuk informasi, TIDAK digunakan untuk verifikasi atau transaksi)
  // Ini adalah wallet yang dibuat oleh Farcaster untuk user (custody address)
  const farcasterEmbedWallet = context?.user?.custodyAddress || null
  
  // Embedded Wallet (signer) - hanya untuk informasi, tidak digunakan untuk transaksi
  const embeddedWallet = privyReady 
    ? wallets.find((w) => w.walletClientType === 'privy')
    : null
  
  // Get smartWallets array for UI logic (used in JSX and useEffect)
  // Filter Smart Wallets from wallets array
  const smartWallets = privyReady 
    ? wallets.filter((w) => (w as any).type === 'smart_wallet' || w.walletClientType === 'smart_wallet')
    : []
  
  // Smart Wallet Detection using useSmartWallets hook
  // CRITICAL: Wrap detection in useEffect that triggers when ready is true
  useEffect(() => {
    if (!privyReady) {
      console.log("⏳ Waiting for Privy to be ready before checking Smart Wallets...")
      setPrivySmartWalletAddress(null)
      setSmartWallet(null)
      return
    }

    console.log("🔍 Smart Wallet Detection (Privy Ready):")
    console.log("  - Privy Ready:", privyReady, "✅")
    console.log("  - Is Authenticated:", authenticated)
    console.log("  - Total Wallets:", wallets.length)
    
    // Use the smartWallets array defined outside useEffect
    console.log("  - Smart Wallets Found (from wallets array):", smartWallets.length)
    console.log("  - Smart Wallets Array:", smartWallets)
    console.log("  - Smart Wallets Details:", smartWallets.map(w => ({
      address: w.address,
      type: w.type,
      walletClientType: w.walletClientType,
      chainId: w.chainId
    })))
    
    // Check smartWalletClient from useSmartWallets hook
    const clientAddress = smartWalletClient?.account?.address as string | undefined
    console.log("  - Smart Wallet Client (from useSmartWallets hook):", clientAddress || "❌ Not available")
    
    // If smartWallets.length === 0 but authenticated is true, log user.linkedAccounts
    if (smartWallets.length === 0 && authenticated && user) {
      console.warn("⚠️ WARNING: No Smart Wallets found but user is authenticated!")
      console.warn("  - Checking user.linkedAccounts for smart_wallet type...")
      console.log("  - User ID:", user.id)
      console.log("  - User linkedAccounts (FULL):", JSON.stringify(user.linkedAccounts, null, 2))
      
      // Check if smart_wallet exists in linkedAccounts
      const smartWalletInLinkedAccounts = user.linkedAccounts?.filter((account: any) => 
        account.type === 'smart_wallet' || account.walletClientType === 'smart_wallet'
      )
      
      if (smartWalletInLinkedAccounts && smartWalletInLinkedAccounts.length > 0) {
        console.warn("  - ⚠️ Smart Wallet EXISTS in user.linkedAccounts but NOT in wallets array!")
        console.warn("  - Smart Wallet in linkedAccounts:", smartWalletInLinkedAccounts)
        console.warn("  - This suggests the Smart Wallet exists in Privy Dashboard but is not being loaded by useWallets() hook")
      } else {
        console.warn("  - ❌ No smart_wallet type found in user.linkedAccounts either")
      }
    }
    
    // Determine Smart Wallet address
    // Priority: 1. smartWalletClient.account.address, 2. smartWallets[0].address, 3. null
    const detectedSmartWallet = smartWallets[0] || null
    const detectedAddress = clientAddress || detectedSmartWallet?.address || null
    
    setSmartWallet(detectedSmartWallet)
    setPrivySmartWalletAddress(detectedAddress)
    
    if (detectedAddress) {
      console.log("✅ Smart Wallet detected:", detectedAddress)
      console.log("  - Source:", clientAddress ? "useSmartWallets hook (client)" : "wallets array")
    } else {
      console.warn("❌ Smart Wallet NOT detected")
    }
    
    // Additional debug info
    console.log("  - All Wallets:", wallets.map(w => ({
      address: w.address,
      type: w.type,
      walletClientType: w.walletClientType,
      chainId: w.chainId
    })))
    console.log("  - Embedded Wallet (signer):", embeddedWallet ? {
      address: embeddedWallet.address,
      walletClientType: embeddedWallet.walletClientType
    } : "Not found")
    console.log("  - Wagmi Address:", wagmiAddress, "(NOT USED - may point to Farcaster Embed Wallet)")
    console.log("  - ✅ PRIMARY ADDRESS (Smart Wallet):", detectedAddress || "❌ NOT READY")
    
  }, [privyReady, authenticated, wallets, smartWalletClient, user, embeddedWallet, wagmiAddress, smartWallets])
  
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

  // Determine connection states
  // CRITICAL: Hanya gunakan Privy Smart Wallet untuk menentukan status koneksi
  // Farcaster Embed Wallet TIDAK digunakan untuk verifikasi status koneksi
  // Status koneksi hanya bergantung pada:
  // 1. isAuthenticated (user sudah login dengan Privy)
  // 2. username dan userFid (user data dari Farcaster)
  // 3. privySmartWalletAddress (Privy Smart Wallet sudah dibuat)
  const isWalletReady = !!privySmartWalletAddress
  const isConnected = isAuthenticated && username && userFid && isWalletReady
  const isInitializing = isAuthenticated && username && userFid && !isWalletReady

  const [activities, setActivities] = useState<
    Array<{
      id: string
      type: "buy" | "sell"
      amount: string
      hash: string
      timestamp: Date
    }>
  >([])

  // CRITICAL: Call sdk.actions.ready() FIRST before any Privy action
  // This MUST be called in page.tsx, otherwise splash screen won't close
  // This must complete before any Privy login or wallet operations
  useEffect(() => {
    const callReady = async () => {
      // Only call if in Warpcast and SDK is ready
      if (isInWarpcast && isReady && typeof window !== 'undefined') {
        try {
          console.log("📱 Calling sdk.actions.ready() to hide splash screen (BEFORE Privy actions)...")
          await sdk.actions.ready()
          console.log("✅ sdk.actions.ready() called successfully")
          setSdkReady(true)
        } catch (error) {
          console.error("❌ Failed to call sdk.actions.ready():", error)
          // Still set ready to true to allow app to continue
          setSdkReady(true)
        }
      } else {
        // Not in Warpcast, allow app to continue
        setSdkReady(true)
      }
    }

    callReady()
  }, [isInWarpcast, isReady])

  // Handle Connect button click - Manual login using Privy login()
  // CRITICAL: Only call login() after sdk.actions.ready() has completed
  const handleConnect = async () => {
    // Ensure sdk.actions.ready() has been called first
    if (!sdkReady) {
      console.warn("⏳ Waiting for sdk.actions.ready() to complete before login...")
      return
    }

    setIsConnecting(true)
    try {
      console.log("🔘 Connect Button: Clicked, calling Privy login() manually...")
      
      // Use Privy's login() function directly
      // This will open the login modal for Farcaster authentication
      login()
      
      // Note: login() is async but doesn't return a promise
      // The authentication state will be updated via usePrivy hook
      // Smart Wallet creation will happen automatically if createOnLogin: 'all-users' is set
    } catch (error) {
      console.error("❌ Connect Button: Login failed:", error)
      setIsConnecting(false)
    }
  }

  // Handle Smart Wallet activation - Create Smart Wallet manually if authenticated but no Smart Wallet
  const handleActivateSmartAccount = async () => {
    if (!authenticated || !privyReady) {
      console.warn("⚠️ Cannot activate Smart Account: User not authenticated or Privy not ready")
      return
    }

    setIsCreatingSmartWallet(true)
    try {
      console.log("🔘 Activate Smart Account: Creating Smart Wallet manually...")
      
      // Create Smart Wallet using Privy's createWallet function
      // This will create a Smart Wallet for the authenticated user
      const wallet = await createWallet()
      
      console.log("✅ Smart Wallet created:", wallet.address)
      console.log("  - Wallet Type:", (wallet as any).type)
      console.log("  - Wallet Client Type:", wallet.walletClientType)
      
      // The Smart Wallet detection useEffect will pick up the new wallet
      // No need to manually update state, it will be detected automatically
    } catch (error) {
      console.error("❌ Failed to create Smart Wallet:", error)
    } finally {
      setIsCreatingSmartWallet(false)
    }
  }

  // Handle login completion - Step 3: Verifikasi user data dan Smart Wallet setelah login
  // 
  // BERDASARKAN DOKUMENTASI PRIVY:
  // - Smart wallets dikontrol oleh embedded signers (EOA) yang dibuat oleh Privy
  // - Privy otomatis membuat embedded wallet sebagai signer untuk Smart Wallet
  // - Privy otomatis membuat Smart Wallet yang dikontrol oleh embedded signer tersebut
  // 
  // IMPORTANT: 
  // 1. Wait for privyReady before checking for Smart Wallets
  // 2. Use useSmartWallets hook (smartWalletClient) as primary source
  // 3. Fallback to wallets array if client is not available
  // 4. If user already has Smart Wallet in Dashboard, it should appear after privyReady
  
  // Handle login completion - Wait for Smart Wallet to be detected
  // The Smart Wallet detection is now handled in the main useEffect above
  // This effect just manages the connecting state
  useEffect(() => {
    if (isAuthenticated && username && userFid && privySmartWalletAddress) {
      console.log("✅ Privy Smart Wallet ready (Primary Address):", privySmartWalletAddress)
      setIsConnecting(false)
    } else if (isAuthenticated && username && userFid && !privySmartWalletAddress && privyReady) {
      // User is authenticated but Smart Wallet not found yet
      // The main useEffect will handle detection and logging
      // Keep connecting state active until Smart Wallet is found
      console.log("⏳ User authenticated, waiting for Smart Wallet detection...")
    }
  }, [isAuthenticated, username, userFid, privySmartWalletAddress, privyReady])
  
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
                // State 2: Initializing or Activate Smart Account
                // If authenticated but no Smart Wallet, show "Activate Smart Account" button
                authenticated && smartWallets.length === 0 ? (
                  <Button
                    size="sm"
                    onClick={handleActivateSmartAccount}
                    disabled={isCreatingSmartWallet || !privyReady}
                    className="bg-primary text-primary-foreground hover:bg-primary/90 font-medium"
                  >
                    {isCreatingSmartWallet ? (
                      <>
                        <User className="mr-1.5 h-4 w-4 animate-spin" />
                        ACTIVATING...
                      </>
                    ) : (
                      <>
                        <User className="mr-1.5 h-4 w-4" />
                        ACTIVATE SMART ACCOUNT
                      </>
                    )}
                  </Button>
                ) : (
                  // State 2a: Initializing (Privy Smart Wallet sedang dibuat)
                  <Button
                    size="sm"
                    disabled
                    className="bg-primary text-primary-foreground hover:bg-primary/90 font-medium animate-pulse"
                  >
                    <User className="mr-1.5 h-4 w-4" />
                    INITIALIZING...
                  </Button>
                )
              ) : (
                // State 1: Not Connected
                <Button
                  size="sm"
                  onClick={handleConnect}
                  disabled={isConnecting || !privyReady || !sdkReady}
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
            <WalletCard 
              fuelBalance={fuelBalance} 
              credits={credits} 
              walletAddress={privySmartWalletAddress}
              isSmartAccountActive={!!privySmartWalletAddress}
            />
            <TokenInput />
            <ConfigPanel 
              fuelBalance={fuelBalance} 
              credits={credits} 
              smartWalletAddress={privySmartWalletAddress}
            />
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
