import type React from "react"
import type { Metadata } from "next"
import { JetBrains_Mono } from "next/font/google"
import { Analytics } from "@vercel/analytics/next"
import { PrivyProvider } from "@/components/privy-provider"
import { MiniAppProvider } from "@/components/miniapp-provider"
import { SDKReady } from "@/components/sdk-ready"
import "./globals.css"

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
})

export const metadata: Metadata = {
  title: "FarBump - Token Bump Bot",
  description: "Professional HFT Token Bump Bot on Base Network",
  generator: "v0.app",
  icons: {
    icon: "/farbump-logo.png",
    apple: "/farbump-logo.png",
  },
  viewport: {
    width: "device-width",
    initialScale: 1,
    maximumScale: 1,
    userScalable: false,
    viewportFit: "cover",
  },
  themeColor: "#000000",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "FarBump",
  },
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  // Get app URL from environment variable or use default from manifest
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://farbump.vercel.app"
  
  // FrameEmbed JSON for sharing
  const frameEmbed = {
    version: "next",
    imageUrl: `${appUrl}/farbump-logo.png`,
    button: {
      title: "Bump!",
      action: {
        type: "launch_frame",
        url: appUrl,
        name: "FarBump",
        splashImageUrl: `${appUrl}/farbump-logo.png`,
        splashBackgroundColor: "#000000"
      }
    }
  }

  return (
    <html lang="en">
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover" />
        <meta name="theme-color" content="#000000" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="apple-mobile-web-app-title" content="FarBump" />
        <meta 
          name="fc:frame" 
          content={JSON.stringify(frameEmbed)} 
        />
      </head>
      <body className={`${jetbrainsMono.variable} font-mono antialiased`}>
        <MiniAppProvider>
          <PrivyProvider>
            <SDKReady />
            {children}
            <Analytics />
          </PrivyProvider>
        </MiniAppProvider>
      </body>
    </html>
  )
}
