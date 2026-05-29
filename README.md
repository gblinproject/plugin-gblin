# plugin-gblin

**ElizaOS plugin** — gasless treasury management for AI agents on Base mainnet.

Park idle USDC into the [GBLIN](https://gblin.digital) MEV-protected index (cbBTC / WETH / USDC),
JIT-swap back to USDC to pay x402 invoices, and monitor treasury health —
all from inside your ElizaOS agent.

[![npm](https://img.shields.io/npm/v/plugin-gblin)](https://www.npmjs.com/package/plugin-gblin)
[![ElizaOS](https://img.shields.io/badge/elizaos-v1-blue)](https://elizaos.ai)
[![Base](https://img.shields.io/badge/chain-Base%20mainnet-0052ff)](https://base.org)
[![Base MCP Plugin](https://img.shields.io/badge/Base%20MCP-PR%20%2356-blue)](https://github.com/base/skills/pull/56)
[![x402 Manifest](https://img.shields.io/badge/x402-manifest-green)](https://gblin.digital/.well-known/x402)
[![Base Mainnet](https://img.shields.io/badge/Base-Mainnet%20Live-0052FF)](https://basescan.org/address/0x38DcDB3A381677239BBc652aed9811F2f8496345)

---

## What it does

| Action | Trigger phrases | Cost |
|---|---|---|
| `CHECK_GBLIN_TREASURY_HEALTH` | "check my treasury", "wallet status" | $0.002 USDC |
| `INVEST_IDLE_USDC_GBLIN` | "park USDC in GBLIN", "buy GBLIN", "invest 10 USDC" | $0.002 USDC |
| `RESCUE_USDC_FROM_GBLIN` | "need USDC", "sell GBLIN", "JIT swap", "pay invoice" | $0.005 USDC |

The **Provider** (`GBLIN_TREASURY_CONTEXT`) injects live NAV, basket weights, and
Crash Shield status into every agent loop ($0.001 USDC per call).

All payments are gasless for the agent: the Coinbase CDP facilitator pays on-chain
gas; the agent only signs an EIP-3009 `transferWithAuthorization`.

---

## Install

```bash
# with npm
npm install plugin-gblin

# with bun (elizaos default)
bun add plugin-gblin
```

Or via the ElizaOS CLI:

```bash
elizaos plugins add gblin
```

---

## Configuration

Add to your agent's `.env`:

```env
# Required
EVM_PRIVATE_KEY=0x_your_agent_hot_wallet_private_key

# Optional — override defaults
GBLIN_BASE_URL=https://gblin.digital
GBLIN_RPC_URL=https://base-rpc.publicnode.com
```

> **Security**: use a **dedicated hot wallet** for the agent with only the
> USDC/GBLIN it needs. Never use a founder or treasury wallet here.
> The maximum a malicious endpoint could drain in one run is $0.005 USDC.

---

## Add to your character

```typescript
// character.ts
import { type Character } from "@elizaos/core";

export const character: Character = {
  name: "TreasuryAgent",
  plugins: [
    "@elizaos/plugin-sql",
    "@elizaos/plugin-bootstrap",
    // Add GBLIN only if private key is set
    ...(process.env.EVM_PRIVATE_KEY?.trim() ? ["plugin-gblin"] : []),
  ],
  // ...
};
```

Or in `character.json`:

```json
{
  "name": "TreasuryAgent",
  "plugins": ["plugin-gblin"],
  "settings": {
    "secrets": {
      "EVM_PRIVATE_KEY": "0x..."
    }
  }
}
```

---

## How it works

```
Agent LLM decides "I have idle USDC"
  ↓
triggers INVEST_IDLE_USDC_GBLIN action
  ↓
plugin sends GET /api/x402/invest?usdc=10 (preflight → 402)
  ↓
plugin signs EIP-3009 transferWithAuthorization ($0.002 USDC)
  ↓
plugin retries with PAYMENT-SIGNATURE header
  ↓
GBLIN API returns {steps: [{target, calldata}, {target, calldata}]}
  ↓
plugin broadcasts step 1 (USDC approve) → waits confirmation
  ↓
plugin broadcasts step 2 (buyGBLINWithToken) → waits confirmation
  ↓
callback: "✅ Invested $10 USDC → GBLIN. tx: 0xab12..."
```

---

## Endpoints consumed

All calls go to `https://gblin.digital/api/x402/*`. Each is a paid x402 v2
endpoint on Base mainnet (chain id 8453, USDC `0x8335...`).

| Path | Price | Returns |
|---|---|---|
| `GET /api/x402/treasury-state` | $0.001 | NAV, basket, Crash Shield |
| `GET /api/x402/health?wallet=` | $0.002 | balances, gas runway, recommendation |
| `GET /api/x402/invest?usdc=` | $0.002 | sequential tx calldata |
| `GET /api/x402/jit?usdc=&wallet=` | $0.005 | atomic swap calldata |

Discovery manifest: [gblin.digital/api/x402/llms.txt](https://gblin.digital/api/x402/llms.txt)

---

## Protocol

- **Contract**: [`0x38DcDB3A381677239BBc652aed9811F2f8496345`](https://basescan.org/address/0x38DcDB3A381677239BBc652aed9811F2f8496345) (Base mainnet)
- **Owner**: [48h Timelock](https://basescan.org/address/0x6aBeC8716fFeEcf7C3D6e68255b4797113E8e5Dd) — every parameter change takes 48 hours on-chain
- **Basket**: 45% cbBTC + 45% WETH + 10% USDC (rebalances with on-chain Crash Shield)
- **MCP Server**: [`@gblin-protocol/mcp-server`](https://www.npmjs.com/package/@gblin-protocol/mcp-server) — free alternative for Claude Desktop / Cursor

---

## Discovery & Ecosystem Integration

GBLIN is integrated across the AI agent ecosystem:

- **Base MCP Plugin:** [PR #56 on base/skills](https://github.com/base/skills/pull/56) — official Base MCP integration (in review)
- **x402 Manifest:** https://gblin.digital/.well-known/x402 — paid endpoints discovery
- **LLM Discovery:** https://gblin.digital/api/x402/llms.txt — free protocol summary
- **MCP Server:** https://github.com/gblinproject/GBLIN-MCP — same operations via Model Context Protocol

This ElizaOS plugin uses GBLIN's x402 endpoints under the hood. The 4-step atomic batch (approve USDC → swap WETH → approve WETH → buy GBLIN) is fully tested on Base mainnet.

## Live Test Proof

Action `INVEST_IDLE_USDC_GBLIN` tested with real $2 USDC on Base mainnet — 4/4 transactions confirmed.

**Wallet tested:** `0xd15Ca75fF73AA5173c28bd82FFf302204CF6c6D9`

| Step | Description | Transaction |
|------|-------------|-------------|
| 1 | Approve USDC → SwapRouter02 | [0x83d1e08b...](https://basescan.org/tx/0x83d1e08bbb41687c000c6d5e940c77f0a6a44841aa04178a22fc44425e099296) |
| 2 | Swap USDC → WETH via exactInputSingle | [0x5bf37e22...](https://basescan.org/tx/0x5bf37e22e9ad0745119db7e1d8666024af9c90afe1f12772ba00f14c3d4f60d4) |
| 3 | Approve WETH → GBLIN contract | [0x4e26cc49...](https://basescan.org/tx/0x4e26cc492259434bc3bffa7a338d6ef2758ef7bfbbaff15e4e24faf1b686ae62) |
| 4 | Buy GBLIN with WETH | [0x3d1084f6...](https://basescan.org/tx/0x3d1084f6374dff2125ba337208c4b547d9821523a0a51f797f9fb422c9b24e2c) |

Treasury health post-invest:
- GBLIN: 0.001074 ($2.14)
- USDC: $0.085
- ETH: 0.001476 ($3.04)
- Total wallet: $5.26

See `tests/test-plugin.ts` and `tests/test-mcp-real.ts` for the full test suite.

---

## License

MIT © GBLIN Protocol
