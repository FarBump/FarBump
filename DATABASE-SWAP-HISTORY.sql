-- ============================================
-- FarBump - Swap History Table
-- ============================================
-- Tracks all swap transactions executed by bot wallets
-- Used for credit synchronization and audit trail
-- ============================================

-- Create swap_history table
CREATE TABLE IF NOT EXISTS swap_history (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_address TEXT NOT NULL,                    -- Main user's Smart Wallet address
  bot_wallet_address TEXT NOT NULL,               -- Bot Smart Account address that executed swap
  token_address TEXT NOT NULL,                   -- Target token address (buyToken)
  sell_amount_wei NUMERIC(78, 0) NOT NULL,        -- Amount of WETH sold in wei
  buy_amount_wei NUMERIC(78, 0),                  -- Amount of tokens bought (if available from 0x API)
  tx_hash TEXT NOT NULL,                          -- Transaction hash
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_swap_history_user_address ON swap_history(user_address);
CREATE INDEX IF NOT EXISTS idx_swap_history_bot_wallet ON swap_history(bot_wallet_address);
CREATE INDEX IF NOT EXISTS idx_swap_history_token ON swap_history(token_address);
CREATE INDEX IF NOT EXISTS idx_swap_history_tx_hash ON swap_history(tx_hash);
CREATE INDEX IF NOT EXISTS idx_swap_history_user_created ON swap_history(user_address, created_at DESC);

-- RLS Policies
ALTER TABLE swap_history ENABLE ROW LEVEL SECURITY;

-- Allow public read (filtering by user_address in application code)
DROP POLICY IF EXISTS "Users can view own swap history" ON swap_history;
CREATE POLICY "Users can view own swap history"
  ON swap_history
  FOR SELECT
  USING (true);

-- Comment
COMMENT ON TABLE swap_history IS 'Tracks all swap transactions executed by bot wallets. Used for credit synchronization and audit trail.';
COMMENT ON COLUMN swap_history.sell_amount_wei IS 'Amount of WETH sold in wei (deducted from bot wallet credit)';
COMMENT ON COLUMN swap_history.buy_amount_wei IS 'Amount of tokens bought (if available from 0x API response)';
COMMENT ON COLUMN swap_history.tx_hash IS 'Transaction hash from blockchain';

-- ============================================
-- Migration Complete!
-- ============================================

