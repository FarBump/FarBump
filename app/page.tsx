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
import { BotLiveActivity } from "@/components/bot-live-activity"
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
import { useAccount, usePublicClient } from "wagmi"
import { base } from "wagmi/chains"
import { isAddress } from "viem"
import { useCreditBalance } from "@/hooks/use-credit-balance"
import { useBotSession } from "@/hooks/use-bot-session"
import { parseUnits } from "viem"
import { toast } from "sonner"

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
  const publicClient = usePublicClient()
  
  // Use useSmartWallets hook to detect Smart Account
  // This is the recommended way to access Smart Wallets in Privy
  const { client: smartWalletClient } = useSmartWallets()
  
  // Function to verify if an address is a smart wallet contract (not EOA)
  // Smart wallet contracts have code size > 0, EOA has code size = 0
  const verifySmartWalletContract = async (address: string): Promise<boolean> => {
    if (!publicClient || !isAddress(address)) {
      return false
    }
    
    try {
      const code = await publicClient.getBytecode({ address: address as `0x${string}` })
      // Smart wallet contract has code, EOA has no code (null or "0x")
      const isContract = !!(code && code !== "0x" && code.length > 2)
      return isContract
    } catch (error) {
      console.error("  ❌ Error verifying smart wallet contract:", error)
      return false
    }
  }
  
  // State to store Smart Wallet address (detected via useEffect when ready)
  const [privySmartWalletAddress, setPrivySmartWalletAddress] = useState<string | null>(null)
  const [smartWallet, setSmartWallet] = useState<any>(null)
  const [sdkReady, setSdkReady] = useState(false)
  const [isCreatingSmartWallet, setIsCreatingSmartWallet] = useState(false)
  
  // State for target token address (from TokenInput)
  const [targetTokenAddress, setTargetTokenAddress] = useState<string | null>(null)
  const [isTokenVerified, setIsTokenVerified] = useState(false)
  const [tokenMetadata, setTokenMetadata] = useState<{ name: string; symbol: string; decimals: number } | null>(null)
  
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
    // CRITICAL: smartWalletClient.account.address is the Smart Wallet contract address
    // This is different from Embedded Wallet address (which is EOA)
    // Priority: 1. smartWalletClient.account.address (Smart Wallet contract), 2. smartWallets[0].address, 3. null
    const detectedSmartWallet = smartWallets[0] || null
    
    // CRITICAL: Use smartWalletClient.account.address as primary source
    // This is the Smart Wallet contract address, not the Embedded Wallet (EOA)
    const detectedAddress = clientAddress || detectedSmartWallet?.address || null
    
    // CRITICAL: Verify that the detected address is actually a smart wallet contract, not EOA
    if (detectedAddress) {
      console.log("🔍 Verifying Smart Wallet contract...")
      console.log("  - Detected Address:", detectedAddress)
      console.log("  - Source:", clientAddress ? "useSmartWallets hook (client) - Smart Wallet contract" : "wallets array")
      console.log("  - Wallet Type:", detectedSmartWallet ? (detectedSmartWallet as any).type : "unknown")
      console.log("  - Wallet Client Type:", detectedSmartWallet?.walletClientType || "unknown")
      console.log("  - Embedded Wallet (signer) Address:", embeddedWallet?.address || "Not found")
      
      // Verify if it's a contract (smart wallet) or EOA
      verifySmartWalletContract(detectedAddress).then((isContract) => {
        if (isContract) {
          console.log("  ✅ Verified: Address is a Smart Wallet CONTRACT (code size > 0)")
          console.log("  - This is a real Smart Wallet contract address")
          console.log("  - Smart Wallet Contract Address:", detectedAddress)
          setSmartWallet(detectedSmartWallet)
          setPrivySmartWalletAddress(detectedAddress)
        } else {
          console.warn("  ⚠️ WARNING: Address is EOA (code size = 0), NOT a Smart Wallet contract!")
          console.warn("  - This means the detected address is an Embedded Wallet (EOA), not a Smart Wallet contract")
          console.warn("  - Embedded Wallet Address (EOA):", detectedAddress)
          console.warn("  - Smart Wallet contract address should be different and have code")
          console.warn("  - Current wallet type:", (detectedSmartWallet as any)?.type || "unknown")
          console.warn("  - Current wallet client type:", detectedSmartWallet?.walletClientType || "unknown")
          
          // If this is from smartWalletClient, it should be the contract address
          // If it's from wallets array and it's EOA, it's probably the Embedded Wallet
          if (clientAddress) {
            console.warn("  ⚠️ smartWalletClient returned EOA address - this might be a configuration issue")
            console.warn("  - Smart Wallet contract might not be deployed yet (lazy deployment)")
            console.warn("  - Contract will be deployed on first transaction")
            // Still set it as it's from smartWalletClient (should be correct)
            setSmartWallet(detectedSmartWallet)
            setPrivySmartWalletAddress(detectedAddress)
          } else {
            // This is from wallets array and it's EOA - it's probably Embedded Wallet
            console.warn("  - This is likely the Embedded Wallet (signer), not Smart Wallet contract")
            setSmartWallet(null)
            setPrivySmartWalletAddress(null)
          }
        }
      }).catch((error) => {
        console.error("  ❌ Error during verification:", error)
        // On error, log warning but still set it (might be network issue)
        console.warn("  ⚠️ Could not verify contract status, assuming it's valid")
        // If from smartWalletClient, trust it (should be Smart Wallet contract)
        if (clientAddress) {
          setSmartWallet(detectedSmartWallet)
          setPrivySmartWalletAddress(detectedAddress)
        } else {
          // From wallets array, be more cautious
          setSmartWallet(null)
          setPrivySmartWalletAddress(null)
        }
      })
    } else {
      console.warn("❌ Smart Wallet NOT detected")
      console.warn("  - smartWalletClient.account.address:", clientAddress || "Not available")
      console.warn("  - smartWallets array length:", smartWallets.length)
      setSmartWallet(null)
      setPrivySmartWalletAddress(null)
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
  const [buyAmountUsd, setBuyAmountUsd] = useState("0.0001")
  const [intervalSeconds, setIntervalSeconds] = useState(60) // Default: 60 seconds (1 minute)
  
  // Fetch credit balance from database
  const { data: creditData, isLoading: isLoadingCredit } = useCreditBalance(privySmartWalletAddress)
  const credits = creditData?.balanceUsd || 0
  
  // Bot session management
  const { session, startSession, stopSession, isStarting, isStopping } = useBotSession(privySmartWalletAddress)

  // Extract user data from Privy user object (prioritize Privy user data)
  // Use user.farcaster.pfp and user.farcaster.username from Privy user object
  const username = user?.farcaster?.username 
    ? `@${user.farcaster.username}` 
    : privyUser?.farcaster?.username 
    ? `@${privyUser.farcaster.username}` 
    : farcasterUser?.username 
    ? `@${farcasterUser.username}` 
    : null

  const userFid = user?.farcaster?.fid?.toString() || 
    privyUser?.farcaster?.fid?.toString() || 
    farcasterUser?.fid?.toString() || 
    null

  // Use user.farcaster.pfp from Privy user object with fallback
  // pfp can be a string URL or an object with url property
  const userAvatar = (typeof user?.farcaster?.pfp === 'string' 
    ? user.farcaster.pfp 
    : (user?.farcaster?.pfp as any)?.url) ||
    (user?.farcaster as any)?.profilePicture ||
    (typeof privyUser?.farcaster?.pfp === 'string'
      ? privyUser.farcaster.pfp
      : (privyUser?.farcaster?.pfp as any)?.url) ||
    (privyUser?.farcaster as any)?.profilePicture ||
    (typeof farcasterUser?.pfp === 'string'
      ? farcasterUser.pfp
      : farcasterUser?.pfp?.url) ||
    null

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

  // Handle Connect button click - Simplified approach using Privy's regular login
  // Privy's login() should work with Farcaster context that's already available
  // This avoids the blank screen issue caused by sdk.actions.signIn()
  const handleConnect = async () => {
    // Ensure sdk.actions.ready() has been called first
    if (!sdkReady) {
      console.warn("⏳ Waiting for sdk.actions.ready() to complete before login...")
      return
    }

    setIsConnecting(true)
    try {
      console.log("🔘 Connect Button: Starting login flow...")
      
      // Use Privy's regular login() which should work with Farcaster context
      // The Farcaster context is already available from miniapp-provider
      // Privy will detect the Farcaster context and authenticate accordingly
      console.log("  Using Privy's regular login() with Farcaster context...")
      console.log("  - Farcaster context available:", !!context)
      console.log("  - User FID:", context?.user?.fid)
      console.log("  - Is in Warpcast:", isInWarpcast)
      
      // Privy's login() will open a modal for Farcaster authentication
      // Since we're in Warpcast and have context, Privy should handle it automatically
      login()
      
      console.log("  ✅ Login initiated with Privy!")
      
      // Note: Smart Wallet creation will be handled in useEffect after authentication
      // Privy does NOT automatically create Smart Wallets for Farcaster Mini App logins
      // We need to create it manually after login succeeds
      
      // Don't set isConnecting to false here - let the authentication state handle it
      // The connecting state will be reset when authentication succeeds or fails
    } catch (error: any) {
      console.error("❌ Connect Button: Login failed:", error)
      console.error("  - Error name:", error?.name)
      console.error("  - Error message:", error?.message)
      console.error("  - Error stack:", error?.stack)
      
      // Always reset connecting state to prevent blank screen
      setIsConnecting(false)
    }
  }

  // Handle Smart Wallet activation - Deploy Smart Wallet contract
  // CRITICAL: Don't use createWallet() - it creates Embedded Wallet, not Smart Wallet
  // Smart Wallet contract is deployed via smartWalletClient on first transaction
  const handleActivateSmartAccount = async () => {
    if (!authenticated || !privyReady) {
      console.warn("⚠️ Cannot activate Smart Account: User not authenticated or Privy not ready")
      return
    }

    if (!smartWalletClient) {
      console.warn("⚠️ Cannot activate Smart Account: Smart Wallet client not available")
      console.warn("  - Make sure Smart Wallets are enabled in Privy Dashboard")
      return
    }

    if (!embeddedWallet) {
      console.warn("⚠️ Cannot activate Smart Account: Embedded Wallet (signer) not found")
      console.warn("  - Embedded Wallet is required as signer for Smart Wallet")
      return
    }

    setIsCreatingSmartWallet(true)
    try {
      console.log("🔘 Activate Smart Account: Checking Smart Wallet status...")
      
      // Get Smart Wallet address from smartWalletClient
      const smartWalletAddress = smartWalletClient.account.address
      console.log("  - Smart Wallet Contract Address:", smartWalletAddress)
      console.log("  - Embedded Wallet (signer) Address:", embeddedWallet.address)
      
      // Verify if Smart Wallet contract is deployed
      console.log("  🔍 Verifying Smart Wallet contract deployment...")
      const isContract = await verifySmartWalletContract(smartWalletAddress)
      
      if (isContract) {
        console.log("  ✅ Smart Wallet contract is already deployed (code size > 0)")
        console.log("  ✅ Smart Wallet is ready to use!")
      } else {
        console.log("  ⚠️ Smart Wallet contract not deployed yet (lazy deployment)")
        console.log("  - Contract will be deployed automatically on first transaction")
        console.log("  - Smart Wallet address is:", smartWalletAddress)
        console.log("  - You can use this address - contract will deploy when needed")
      }
      
      // The Smart Wallet detection useEffect will pick up the address
      // No need to manually update state, it will be detected automatically
    } catch (error) {
      console.error("❌ Failed to activate Smart Account:", error)
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
  
  // Handle login completion - Auto-create Smart Wallet after Farcaster login
  // CRITICAL: Privy does NOT automatically create Smart Wallets for Farcaster Mini App logins
  // We need to ensure Smart Wallet contract is deployed after authentication succeeds
  useEffect(() => {
    if (isAuthenticated && username && userFid && privySmartWalletAddress) {
      // Smart Wallet already exists and verified
      console.log("✅ Privy Smart Wallet ready (Primary Address):", privySmartWalletAddress)
      setIsConnecting(false)
    } else if (isAuthenticated && username && userFid && !privySmartWalletAddress && privyReady && !isCreatingSmartWallet) {
      // User is authenticated but Smart Wallet not found
      // CRITICAL: Check if embedded wallet exists first
      // If embedded wallet exists, Smart Wallet contract should be deployable via smartWalletClient
      console.log("⏳ User authenticated via Farcaster, checking wallet status...")
      console.log("  - Embedded Wallet exists:", !!embeddedWallet)
      console.log("  - Embedded Wallet address:", embeddedWallet?.address || "Not found")
      console.log("  - Smart Wallet Client available:", !!smartWalletClient)
      console.log("  - Smart Wallet Client address:", smartWalletClient?.account?.address || "Not available")
      
      // CRITICAL: Don't call createWallet() - it creates Embedded Wallet, not Smart Wallet
      // Smart Wallet contract address is available via smartWalletClient.account.address
      // Smart Wallet contracts use lazy deployment - deployed on first transaction
      
      if (embeddedWallet && smartWalletClient) {
        // Both embedded wallet and smart wallet client are available
        const smartWalletAddress = smartWalletClient.account.address
        console.log("  ✅ Embedded Wallet exists:", embeddedWallet.address)
        console.log("  ✅ Smart Wallet Client available, contract address:", smartWalletAddress)
        console.log("  - Smart Wallet contract will be deployed on first transaction (lazy deployment)")
        console.log("  - No need to call createWallet() - it would create duplicate embedded wallet")
        setIsConnecting(false)
      } else if (embeddedWallet && !smartWalletClient) {
        // Embedded wallet exists but smart wallet client not available
        console.log("  ✅ Embedded Wallet exists:", embeddedWallet.address)
        console.log("  ⚠️ Smart Wallet Client not available yet")
        console.log("  - This might be normal - Smart Wallet client initializes after embedded wallet")
        console.log("  - Smart Wallet contract address will be available once client is ready")
        // Wait a bit for smart wallet client to initialize
        const timeoutId = setTimeout(() => {
          if (smartWalletClient) {
            console.log("  ✅ Smart Wallet Client is now available")
          } else {
            console.log("  ⚠️ Smart Wallet Client still not available - may need manual activation")
          }
        }, 1000)
        return () => clearTimeout(timeoutId)
      } else {
        // No embedded wallet - this shouldn't happen with createOnLogin: "all-users"
        console.log("  ⚠️ No Embedded Wallet found yet")
        console.log("  - This might be normal if Privy is still initializing")
        console.log("  - Don't create wallet manually - let Privy handle it via createOnLogin config")
        // Wait a bit for embedded wallet to be created
        const timeoutId = setTimeout(() => {
          if (embeddedWallet) {
            console.log("  ✅ Embedded Wallet is now available")
          } else {
            console.log("  ⚠️ Embedded Wallet still not found - check Privy Dashboard configuration")
          }
        }, 1000)
        return () => clearTimeout(timeoutId)
      }
    }
  }, [isAuthenticated, username, userFid, privySmartWalletAddress, privyReady, isCreatingSmartWallet, embeddedWallet, smartWalletClient])
  
  const handleToggle = async () => {
    if (!isActive) {
      // Starting bot session
      if (!isTokenVerified || !targetTokenAddress) {
        toast.error("Please verify target token address first")
        return
      }
      
      if (!buyAmountUsd || parseFloat(buyAmountUsd) <= 0) {
        toast.error("Please enter a valid buy amount")
        return
      }
      
      if (!privySmartWalletAddress || !isAddress(privySmartWalletAddress)) {
        toast.error("Smart wallet not ready")
        return
      }
      
      try {
        // Validate intervalSeconds
        if (intervalSeconds < 2 || intervalSeconds > 600) {
          toast.error("Interval must be between 2 seconds and 10 minutes")
          return
        }
        
        // Validate buyAmountUsd
        const amountUsdValue = parseFloat(buyAmountUsd)
        if (isNaN(amountUsdValue) || amountUsdValue <= 0) {
          toast.error("Please enter a valid buy amount (USD)")
          return
        }
        
        // Check if credit balance is sufficient (at least enough for one bump)
        // Note: We'll validate this on backend too, but check here for better UX
        if (credits < amountUsdValue) {
          toast.error(`Insufficient credit. Required: $${amountUsdValue.toFixed(2)}, Available: $${credits.toFixed(2)}`)
          return
        }
        
        // Note: buyAmountPerBumpWei will be calculated on backend from USD amount using real-time ETH price
        // Bot will run continuously until user stops it manually
        await startSession({
          userAddress: privySmartWalletAddress,
          tokenAddress: targetTokenAddress as `0x${string}`,
          amountUsd: amountUsdValue.toString(), // Send USD amount
          intervalSeconds: intervalSeconds, // Send interval in seconds
        })
        
        setIsActive(true)
        toast.success("Bot session started successfully")
      } catch (error: any) {
        console.error("Failed to start bot session:", error)
        toast.error(error.message || "Failed to start bot session")
      }
    } else {
      // Stopping bot session
      try {
        await stopSession()
        setIsActive(false)
        toast.success("Bot session stopped")
      } catch (error: any) {
        console.error("Failed to stop bot session:", error)
        toast.error(error.message || "Failed to stop bot session")
      }
    }
  }
  
  // Sync isActive with session status
  useEffect(() => {
    if (session) {
      setIsActive(session.status === "running")
    }
  }, [session])

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
                <span className="hidden text-xs font-medium text-foreground sm:inline">
                  {isActive ? "LIVE" : "IDLE"}
                </span>
              </div>
              <div className="flex items-center gap-2">
                {/* Connection Status Indicator - Green dot when connected, pulsing when initializing */}
                {/* Only show dot when connected or initializing, hide when not connected */}
                {(isConnected || isInitializing || isCreatingSmartWallet) && (
                  <div className={`h-2 w-2 rounded-full shrink-0 ${
                    isConnected 
                      ? "bg-green-500" 
                      : "bg-primary animate-pulse"
                  }`} />
                )}
                {isConnected ? (
                  // State 3: Connected (Privy Smart Wallet ready) - Show PFP and Username
                  <div className="flex items-center gap-1.5 rounded-lg border border-border bg-card/50 backdrop-blur-sm px-2 py-1.5 h-8 max-w-[200px]">
                    <div className="relative h-5 w-5 overflow-hidden rounded-full border border-primary/20 shrink-0 bg-secondary flex items-center justify-center">
                      {userAvatar ? (
                        <Image 
                          src={userAvatar} 
                          alt="User Avatar" 
                          fill 
                          className="object-cover rounded-full"
                          unoptimized
                          onError={() => {
                            // Image will fallback to User icon via CSS or state
                          }}
                        />
                      ) : null}
                      {/* Fallback User icon - shown when no avatar or image fails */}
                      {!userAvatar && (
                        <User className="h-3 w-3 text-muted-foreground" />
                      )}
                    </div>
                    <span className="font-mono text-xs font-medium text-foreground truncate">{username}</span>
                  </div>
                ) : isInitializing ? (
                  // State 2: Initializing or Activate Smart Account
                  authenticated && smartWallets.length === 0 ? (
                    // State 2a: Activate Smart Account button
                    <Button
                      size="sm"
                      onClick={handleActivateSmartAccount}
                      disabled={isCreatingSmartWallet || !privyReady}
                      className="h-8 px-2.5 py-1.5 bg-card/50 backdrop-blur-sm border border-border text-foreground hover:bg-card/70 font-medium text-xs"
                    >
                      <div className="flex items-center gap-1.5">
                        {isCreatingSmartWallet ? (
                          <span className="text-xs whitespace-nowrap">Loading...</span>
                        ) : (
                          <>
                            <User className="h-3.5 w-3.5 shrink-0" />
                            <span className="text-xs whitespace-nowrap">Activate</span>
                          </>
                        )}
                      </div>
                    </Button>
                  ) : (
                    // State 2b: Initializing (Privy Smart Wallet sedang dibuat)
                    <Button
                      size="sm"
                      disabled
                      className="h-8 px-2.5 py-1.5 bg-card/50 backdrop-blur-sm border border-border text-foreground font-medium text-xs"
                    >
                      <span className="text-xs whitespace-nowrap">Loading...</span>
                    </Button>
                  )
                ) : (
                  // State 1: Not Connected
                  <Button
                    size="sm"
                    onClick={handleConnect}
                    disabled={isConnecting || !privyReady || !sdkReady}
                    className="h-8 px-2.5 py-1.5 bg-primary text-primary-foreground hover:bg-primary/90 font-medium text-xs shadow-lg shadow-primary/50"
                  >
                    <div className="flex items-center gap-1.5">
                      <User className="h-3.5 w-3.5 shrink-0" />
                      <span className="whitespace-nowrap">Connect</span>
                    </div>
                  </Button>
                )}
              </div>
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
            <PriceChart tokenAddress={targetTokenAddress} />
            <WalletCard 
              fuelBalance={fuelBalance} 
              credits={credits} 
              walletAddress={privySmartWalletAddress}
              isSmartAccountActive={!!privySmartWalletAddress}
            />
            <TokenInput 
              onAddressChange={(address) => {
                setTargetTokenAddress(address)
                // Reset verification if address changes
                if (!address) {
                  setIsTokenVerified(false)
                  setTokenMetadata(null)
                }
              }}
              onVerifiedChange={(isVerified, metadata) => {
                setIsTokenVerified(isVerified)
                setTokenMetadata(metadata || null)
              }}
            />
            <ConfigPanel 
              fuelBalance={fuelBalance} 
              credits={credits} 
              smartWalletAddress={privySmartWalletAddress}
              buyAmountUsd={buyAmountUsd}
              onBuyAmountChange={setBuyAmountUsd}
              intervalSeconds={intervalSeconds}
              onIntervalChange={setIntervalSeconds}
            />
            <ActionButton 
              isActive={isActive} 
              onToggle={handleToggle} 
              credits={credits}
              balanceWei={creditData?.balanceWei}
              isVerified={isTokenVerified}
              buyAmountUsd={buyAmountUsd}
            />
            {/* Bot Live Activity - Realtime feed from bot_logs table */}
            <BotLiveActivity userAddress={privySmartWalletAddress} enabled={isActive} />
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
