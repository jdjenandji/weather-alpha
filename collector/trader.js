// trader.js — Polymarket CLOB trading module
// Places limit BUY orders on strong weather signals

const CLOB_HOST = 'https://clob.polymarket.com';
const GAMMA_HOST = 'https://gamma-api.polymarket.com';
const CHAIN_ID = 137; // Polygon mainnet

export class Trader {
  constructor({ privateKey, walletAddress, maxBet = 20, enabled = false }) {
    this.privateKey = privateKey;
    this.walletAddress = walletAddress;
    this.maxBet = parseFloat(maxBet);
    this.enabled = enabled;
    this.client = null;
    this.initialized = false;
  }

  async init() {
    if (!this.enabled || !this.privateKey) {
      console.log('[trader] Trading disabled or no key configured');
      return false;
    }

    try {
      // Dynamic import — these are heavy deps
      let ClobClient, Wallet;
      try {
        ClobClient = (await import('@polymarket/clob-client')).ClobClient;
        Wallet = (await import('ethers')).Wallet;
      } catch (e) {
        console.error('[trader] SDK import failed:', e.message);
        console.error('[trader] Make sure @polymarket/clob-client and ethers@5 are installed');
        return false;
      }

      const signer = new Wallet(this.privateKey);
      
      // Derive API credentials
      const tempClient = new ClobClient(CLOB_HOST, CHAIN_ID, signer);
      const apiCreds = await tempClient.createOrDeriveApiKey();
      
      // Initialize full client
      this.client = new ClobClient(
        CLOB_HOST,
        CHAIN_ID,
        signer,
        apiCreds,
        0, // EOA signature type
        this.walletAddress || signer.address,
      );

      this.initialized = true;
      console.log(`[trader] Initialized. Wallet: ${(this.walletAddress || signer.address).slice(0, 10)}... Max bet: $${this.maxBet}`);
      return true;
    } catch (err) {
      console.error('[trader] Init failed:', err.message);
      return false;
    }
  }

  async getMarketDetails(citySlug, dateStr) {
    // Get the event and its markets from Gamma API
    const months = ['january','february','march','april','may','june','july','august','september','october','november','december'];
    const d = new Date(dateStr + 'T00:00:00Z');
    const slug = `highest-temperature-in-${citySlug}-on-${months[d.getUTCMonth()]}-${d.getUTCDate()}-${d.getUTCFullYear()}`;
    
    const res = await fetch(`${GAMMA_HOST}/events?slug=${slug}`);
    const data = await res.json();
    if (!data[0]) return null;

    const event = data[0];
    return {
      negRisk: event.negRisk ?? true, // weather markets are neg risk
      markets: event.markets.map(m => ({
        title: m.groupItemTitle,
        conditionId: m.conditionId,
        tokenIds: JSON.parse(m.clobTokenIds), // [yesTokenId, noTokenId]
        price: parseFloat(JSON.parse(m.outcomePrices)[0]),
        tickSize: m.minimumTickSize || '0.01',
      })),
    };
  }

  async placeBuy({ citySlug, dateStr, bucket, maxPrice, size }) {
    if (!this.initialized || !this.client) {
      console.log('[trader] Not initialized, skipping trade');
      return null;
    }

    try {
      // Get market details
      const details = await this.getMarketDetails(citySlug, dateStr);
      if (!details) {
        console.log(`[trader] No market found for ${citySlug} ${dateStr}`);
        return null;
      }

      // Find the target bucket's market
      const target = details.markets.find(m => m.title === bucket);
      if (!target) {
        console.log(`[trader] Bucket "${bucket}" not found in market`);
        return null;
      }

      // Use YES token (first in array)
      const tokenId = target.tokenIds[0];
      const tickSize = target.tickSize;
      const negRisk = details.negRisk;

      // Snap price to tick size
      const tick = parseFloat(tickSize);
      const price = Math.floor(maxPrice / tick) * tick;
      
      if (price <= 0) {
        console.log(`[trader] Price ${maxPrice} rounds to 0 with tick ${tickSize}, skipping`);
        return null;
      }

      // Calculate size (number of shares) from dollar amount
      const dollarAmount = Math.min(size || this.maxBet, this.maxBet);
      const shares = Math.floor(dollarAmount / price);

      if (shares < 1) {
        console.log(`[trader] Would buy <1 share at ${price}, skipping`);
        return null;
      }

      console.log(`[trader] Placing order: BUY ${shares} shares of "${bucket}" YES @ ${price} ($${(shares * price).toFixed(2)} cost)`);
      console.log(`[trader]   Market: ${citySlug} ${dateStr} | Token: ${tokenId.slice(0, 12)}... | negRisk: ${negRisk}`);

      const { Side, OrderType } = await import('@polymarket/clob-client');

      const response = await this.client.createAndPostOrder(
        {
          tokenID: tokenId,
          price: price,
          size: shares,
          side: Side.BUY,
        },
        {
          tickSize: tickSize,
          negRisk: negRisk,
        },
        OrderType.GTC,
      );

      console.log(`[trader] ✅ Order placed! ID: ${response.orderID} Status: ${response.status}`);
      return {
        orderId: response.orderID,
        status: response.status,
        bucket,
        price,
        shares,
        cost: shares * price,
        city: citySlug,
        date: dateStr,
      };
    } catch (err) {
      console.error(`[trader] ❌ Order failed:`, err.message);
      return null;
    }
  }

  async getOpenOrders() {
    if (!this.initialized) return [];
    try {
      return await this.client.getOpenOrders();
    } catch { return []; }
  }

  async getBalance() {
    // Check USDC.e balance on Polygon
    // This is a simple RPC call
    try {
      const res = await fetch('https://polygon-rpc.com', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'eth_call',
          params: [{
            to: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', // USDC.e on Polygon
            data: '0x70a08231000000000000000000000000' + this.walletAddress.slice(2).toLowerCase(),
          }, 'latest'],
          id: 1,
        }),
      });
      const data = await res.json();
      return parseInt(data.result, 16) / 1e6; // USDC has 6 decimals
    } catch { return null; }
  }
}
