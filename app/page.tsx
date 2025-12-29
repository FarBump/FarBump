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
  
  const { ready: privyReady } = usePrivy()
  const { wallets } = useWallets()
  const { address: wagmiAddress, isConnected: wagmiConnected } = useAccount()
  
  // Farcaster Embed Wallet address (hanya untuk informasi, TIDAK digunakan untuk verifikasi atau transaksi)
  // Kita tidak perlu fetch atau verifikasi Farcaster Embed Wallet untuk auth flow
  // Hanya Privy Smart Wallet yang digunakan untuk transaksi
  const farcasterEmbedWallet = context?.user?.custodyAddress || null
  
  // Get Privy Smart Wallet address (Smart Wallet untuk transaksi di app)
  // CRITICAL: Hanya gunakan wallet dengan walletClientType === 'smart_wallet'
  // JANGAN gunakan Farcaster Embed Wallet (custodyAddress)
  const smartWallet = wallets.find(w => {
    // Hanya ambil wallet dengan type 'smart_wallet'
    if (w.walletClientType !== 'smart_wallet') return false
    
    // Pastikan address tidak sama dengan Farcaster Embed Wallet (jika ada)
    if (farcasterEmbedWallet && w.address?.toLowerCase() === farcasterEmbedWallet.toLowerCase()) {
      console.warn("⚠️ WARNING: Found wallet with same address as Farcaster Embed Wallet, skipping...")
      return false
    }
    
    return true
  })
  
  // Privy Smart Wallet address (HANYA dari smartWallet, BUKAN dari wagmiAddress atau Farcaster Embed Wallet)
  // wagmiAddress mungkin masih mengarah ke Farcaster Embed Wallet, jadi kita tidak menggunakannya
  const privySmartWalletAddress = smartWallet?.address || null
  
  // Debug: Log wallet information untuk memastikan kita menggunakan Smart Wallet yang benar
  useEffect(() => {
    if (wallets.length > 0 || isAuthenticated) {
      console.log("🔍 Wallet Debug Info:")
      console.log("  - Farcaster Embed Wallet (custodyAddress):", farcasterEmbedWallet)
      console.log("  - Total Wallets:", wallets.length)
      console.log("  - All Privy Wallets (DETAILED):", wallets.map(w => ({
        address: w.address,
        walletClientType: w.walletClientType,
        chainId: w.chainId,
        isSmartWallet: w.walletClientType === 'smart_wallet',
        isFarcasterEmbed: farcasterEmbedWallet && w.address?.toLowerCase() === farcasterEmbedWallet.toLowerCase()
      })))
      console.log("  - Smart Wallets Found:", wallets.filter(w => w.walletClientType === 'smart_wallet').length)
      console.log("  - Selected Smart Wallet:", smartWallet ? {
        address: smartWallet.address,
        walletClientType: smartWallet.walletClientType
      } : "❌ NOT FOUND - Smart Wallet belum dibuat oleh Privy")
      console.log("  - Wagmi Address:", wagmiAddress)
      console.log("  - Wagmi Connected:", wagmiConnected)
      console.log("  - Final Privy Smart Wallet Address:", privySmartWalletAddress || "❌ NOT READY")
      console.log("  - Is Authenticated:", isAuthenticated)
      console.log("  - Privy User:", privyUser ? {
        id: privyUser.id,
        wallet: privyUser.wallet?.address,
        walletType: privyUser.wallet?.walletClientType
      } : "No user")
      
      // Warning jika Smart Wallet belum dibuat
      if (isAuthenticated && !privySmartWalletAddress) {
        console.warn("⚠️ WARNING: User is authenticated but Privy Smart Wallet is not ready yet.")
        console.warn("  - This might be because:")
        console.warn("    1. Smart Wallet creation is still in progress (wait a few seconds)")
        console.warn("    2. Smart Wallets not enabled in Privy Dashboard")
        console.warn("    3. Base Network not configured in Smart Wallets")
        console.warn("    4. createOnLogin: 'all-users' not working as expected")
      }
    }
  }, [wallets, smartWallet, wagmiAddress, wagmiConnected, privySmartWalletAddress, farcasterEmbedWallet, isAuthenticated, privyUser])
  
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

  // Handle login completion - Step 3: Verifikasi user data dan Smart Wallet setelah login
  // CRITICAL: Karena kita menggunakan whitelabel login (useLoginToMiniApp), automatic wallet
  // creation (createOnLogin) TIDAK bekerja. Kita HARUS manually create Smart Wallet setelah login.
  // Referensi: https://docs.privy.io/basics/react/advanced/automatic-wallet-creation
  // 
  // NOTE: createWallet() tanpa parameter mencoba membuat embedded wallet, bukan Smart Wallet.
  // Jika user sudah punya embedded wallet, akan error "User already has an embedded wallet".
  // Smart Wallet seharusnya dibuat otomatis oleh Privy jika smartWallets.enabled = true,
  // tapi karena whitelabel login, mungkin perlu waktu lebih lama atau perlu konfigurasi di Privy Dashboard.
  useEffect(() => {
    if (isAuthenticated && username && userFid && privyReady && !privySmartWalletAddress) {
      console.log("✅ User authenticated, checking Smart Wallet...", {
        username,
        fid: userFid,
        hasPrivySmartWallet: !!privySmartWalletAddress,
        privyReady,
        totalWallets: wallets.length,
        walletTypes: wallets.map(w => w.walletClientType)
      })
      
      // Wait and check if Smart Wallet is created automatically
      // Privy might create Smart Wallet automatically even with whitelabel login
      // if smartWallets.enabled = true and configured correctly in Privy Dashboard
      const timer = setTimeout(() => {
        const currentSmartWallet = wallets.find(w => w.walletClientType === 'smart_wallet')
        if (currentSmartWallet) {
          console.log("✅ Smart Wallet found after delay:", currentSmartWallet.address)
          setIsConnecting(false)
        } else {
          console.warn("⚠️ Smart Wallet still not found after delay.")
          console.warn("  - Please check Privy Dashboard configuration:")
          console.warn("    1. Settings → Wallets → Smart Wallets → Enabled")
          console.warn("    2. Settings → Wallets → Smart Wallets → Base Network (Chain ID: 8453) enabled")
          console.warn("    3. Smart Wallets might need to be created manually via Privy Dashboard or API")
          console.warn("  - Current wallets:", wallets.map(w => ({
            address: w.address,
            type: w.walletClientType,
            chainId: w.chainId
          })))
          // Don't try to create wallet manually - it will try to create embedded wallet
          // Smart Wallet creation should be handled by Privy automatically or via Dashboard/API
        }
      }, 5000) // Wait 5 seconds for automatic Smart Wallet creation
      
      return () => clearTimeout(timer)
    } else if (isAuthenticated && privySmartWalletAddress) {
      console.log("✅ Privy Smart Wallet ready:", privySmartWalletAddress)
      setIsConnecting(false)
    }
  }, [isAuthenticated, username, userFid, privySmartWalletAddress, privyReady, wallets])
  
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
