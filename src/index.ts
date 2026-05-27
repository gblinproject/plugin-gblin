/**
 * plugin-gblin — ElizaOS plugin for GBLIN Protocol
 *
 * Exposes three Actions and one Provider that let any ElizaOS agent:
 *   • Park idle USDC into the GBLIN MEV-protected cbBTC/WETH basket (invest)
 *   • JIT-swap GBLIN back to USDC to pay x402 invoices in real-time (rescue)
 *   • Read treasury health to decide when to rebalance (health check)
 *
 * All on-chain calls go through the GBLIN x402 API on Base mainnet.
 * Payments to the API ($0.001–$0.005 USDC) use EIP-3009 transferWithAuthorization
 * signed by the agent's own wallet — no API keys, no centralised auth.
 *
 * Required env (via runtime.getSetting):
 *   EVM_PRIVATE_KEY       — 0x-prefixed 32-byte hex key (agent hot wallet)
 *
 * Optional env:
 *   GBLIN_BASE_URL        — override API host (default: https://gblin.digital)
 *   GBLIN_RPC_URL         — override Base mainnet RPC (default: publicnode)
 */

import {
  type Action,
  type ActionResult,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type Plugin,
  type Provider,
  type ProviderResult,
  type State,
  logger,
} from "@elizaos/core";
import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type Hex,
} from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment } from "@x402/fetch";

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_BASE_URL = "https://gblin.digital";
const DEFAULT_RPC_URL = "https://base-rpc.publicnode.com";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getConfig(runtime: IAgentRuntime) {
  const rawKey = String(runtime.getSetting("EVM_PRIVATE_KEY") ?? "");
  if (!rawKey || !rawKey.startsWith("0x") || rawKey.length !== 66) {
    throw new Error(
      "EVM_PRIVATE_KEY is missing or invalid. " +
        "Set it in your agent's environment (66-char 0x-prefixed hex)."
    );
  }
  const baseUrl = String(
    runtime.getSetting("GBLIN_BASE_URL") ?? DEFAULT_BASE_URL
  );
  const rpcUrl = String(
    runtime.getSetting("GBLIN_RPC_URL") ?? DEFAULT_RPC_URL
  );

  const account = privateKeyToAccount(rawKey as Hex);
  const publicClient = createPublicClient({
    chain: base,
    transport: http(rpcUrl),
  });
  const walletClient = createWalletClient({
    account,
    chain: base,
    transport: http(rpcUrl),
  });

  return { account, publicClient, walletClient, baseUrl };
}

/**
 * Build a fetch wrapper that automatically handles the x402 402 → sign → retry
 * flow using the official @x402/fetch + @x402/evm libraries. The signer is the
 * agent's viem account (privateKeyToAccount) which exposes `address` and
 * `signTypedData` — exactly what ExactEvmScheme needs to sign EIP-3009
 * authorizations for USDC.
 */
function makePaidFetch(runtime: IAgentRuntime) {
  const { account } = getConfig(runtime);
  const client = new x402Client();
  registerExactEvmScheme(client, { signer: account });
  return wrapFetchWithPayment(fetch, client);
}

/**
 * Perform a paid GET request to a GBLIN x402 endpoint.
 */
async function x402Get(
  runtime: IAgentRuntime,
  path: string
): Promise<unknown> {
  const { baseUrl } = getConfig(runtime);
  const url = `${baseUrl}${path}`;
  const paidFetch = makePaidFetch(runtime);

  const res = await paidFetch(url);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `x402 request failed (${res.status}): ${body.slice(0, 200)}`
    );
  }
  return res.json();
}

// ─── Action: CHECK_GBLIN_TREASURY_HEALTH ─────────────────────────────────────

const checkTreasuryHealthAction: Action = {
  name: "CHECK_GBLIN_TREASURY_HEALTH",
  similes: [
    "GBLIN_HEALTH",
    "CHECK_TREASURY",
    "ANALYZE_WALLET_TREASURY",
    "GET_GBLIN_BALANCES",
    "TREASURY_STATUS",
  ],
  description:
    "Query the GBLIN protocol for a wallet's treasury health: " +
    "GBLIN/USDC/ETH balances in USD, gas runway in days, and a rebalance " +
    "recommendation. Costs $0.002 USDC on Base mainnet via x402.",

  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    const key = String(runtime.getSetting("EVM_PRIVATE_KEY") ?? "");
    if (!key || !key.startsWith("0x") || key.length !== 66) {
      logger.warn(
        "[plugin-gblin] CHECK_GBLIN_TREASURY_HEALTH: EVM_PRIVATE_KEY missing or invalid"
      );
      return false;
    }
    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    try {
      const { account } = getConfig(runtime);

      // Extract wallet address from message or use agent's own wallet
      const text = message.content?.text ?? "";
      const walletMatch = text.match(/0x[0-9a-fA-F]{40}/);
      const wallet = walletMatch ? walletMatch[0] : account.address;

      logger.info(
        `[plugin-gblin] Checking treasury health for wallet ${wallet}`
      );

      const data = (await x402Get(
        runtime,
        `/api/x402/health?wallet=${wallet}`
      )) as Record<string, unknown>;

      const balances = data.balances as Record<string, unknown>;
      const runway = data.runway as Record<string, unknown>;
      const rebalance = data.rebalance_recommendation as string;

      const summary =
        `📊 **GBLIN Treasury Health** for \`${wallet}\`\n\n` +
        `**Balances:**\n` +
        `  • GBLIN: ${balances?.gblin} ($${balances?.gblin_value_usd})\n` +
        `  • USDC: $${balances?.usdc}\n` +
        `  • ETH: ${balances?.eth} ($${balances?.eth_value_usd})\n` +
        `  • Total: **$${balances?.total_usd}**\n\n` +
        `**Gas runway:** ${runway?.days_remaining ?? "unknown"} days\n\n` +
        `**Recommendation:** ${rebalance ?? "No action needed"}`;

      if (callback) {
        await callback({
          text: summary,
          actions: ["CHECK_GBLIN_TREASURY_HEALTH"],
          source: message.content?.source,
        });
      }

      return {
        success: true,
        text: summary,
        data,
      };
    } catch (error) {
      const msg = `Failed to check treasury health: ${(error as Error).message}`;
      logger.error(`[plugin-gblin] ${msg}`);
      if (callback) {
        await callback({ text: `❌ ${msg}`, source: message.content?.source });
      }
      return { success: false, text: msg };
    }
  },

  examples: [
    [
      {
        name: "{{user}}",
        content: { text: "Check my GBLIN treasury health" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Checking treasury health via GBLIN x402 API...",
          actions: ["CHECK_GBLIN_TREASURY_HEALTH"],
        },
      },
    ],
    [
      {
        name: "{{user}}",
        content: {
          text: "What is the treasury status for 0x0000000000000000000000000000000000000001?",
        },
      },
      {
        name: "{{agent}}",
        content: {
          text: "I'll analyze that wallet's treasury health right now.",
          actions: ["CHECK_GBLIN_TREASURY_HEALTH"],
        },
      },
    ],
  ],
};

// ─── Action: INVEST_IDLE_USDC_GBLIN ──────────────────────────────────────────

const investIdleUsdcAction: Action = {
  name: "INVEST_IDLE_USDC_GBLIN",
  similes: [
    "PARK_USDC_IN_GBLIN",
    "BUY_GBLIN",
    "CONVERT_USDC_TO_GBLIN",
    "SHIELD_TREASURY_MEV",
    "GBLIN_INVEST",
    "ACCUMULATE_GBLIN",
  ],
  description:
    "Convert idle USDC into the GBLIN MEV-protected index (cbBTC/WETH/USDC). " +
    "Fetches ready-to-broadcast calldata (4 sequential steps: approve USDC, swap to WETH, approve WETH, buy GBLIN) " +
    "from the GBLIN x402 API and executes all transactions sequentially on Base mainnet. " +
    "Bypasses the broken exactInput path in the GBLIN contract using SwapRouter02. " +
    "Costs $0.002 USDC for the API call plus gas on Base.",

  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    const key = String(runtime.getSetting("EVM_PRIVATE_KEY") ?? "");
    if (!key || !key.startsWith("0x") || key.length !== 66) {
      logger.warn(
        "[plugin-gblin] INVEST_IDLE_USDC_GBLIN: EVM_PRIVATE_KEY missing or invalid"
      );
      return false;
    }
    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    try {
      const { account, walletClient, publicClient } = getConfig(runtime);

      // Extract USDC amount from message
      const text = message.content?.text ?? "";
      const amountMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:usdc|USDC|\$)?/i);
      const usdcAmount = amountMatch ? amountMatch[1] : "10";

      logger.info(
        `[plugin-gblin] Investing ${usdcAmount} USDC into GBLIN for ${account.address}`
      );

      if (callback) {
        await callback({
          text: `⏳ Fetching GBLIN invest calldata for $${usdcAmount} USDC...`,
          source: message.content?.source,
        });
      }

      const data = (await x402Get(
        runtime,
        `/api/x402/invest?usdc=${usdcAmount}&wallet=${account.address}`
      )) as {
        steps: Array<{
          step: number;
          description: string;
          target: Address;
          calldata: Hex;
          value?: string;
        }>;
        expected_gblin_out?: string;
        safe_min_gblin_out?: string;
      };

      if (!data.steps || data.steps.length === 0) {
        throw new Error("API returned no transaction steps");
      }

      const txHashes: string[] = [];

      for (const step of data.steps) {
        logger.info(
          `[plugin-gblin] Executing step ${step.step}: ${step.description}`
        );

        const hash = await walletClient.sendTransaction({
          account,
          to: step.target,
          data: step.calldata,
          value: step.value ? BigInt(step.value) : 0n,
        });

        txHashes.push(hash);

        await publicClient.waitForTransactionReceipt({
          hash,
          confirmations: 1,
        });

        logger.info(`[plugin-gblin] Step ${step.step} confirmed: ${hash}`);
      }

      const summary =
        `✅ **GBLIN Investment Complete**\n\n` +
        `**Invested:** $${usdcAmount} USDC\n` +
        `**Expected GBLIN out:** ~${data.expected_gblin_out ?? "calculating..."}\n` +
        `**Safe min out:** ${data.safe_min_gblin_out ?? "N/A"}\n\n` +
        `**Transactions:**\n` +
        txHashes
          .map(
            (h, i) =>
              `  Step ${i + 1}: [${h.slice(0, 10)}...](https://basescan.org/tx/${h})`
          )
          .join("\n");

      if (callback) {
        await callback({
          text: summary,
          actions: ["INVEST_IDLE_USDC_GBLIN"],
          source: message.content?.source,
        });
      }

      return {
        success: true,
        text: summary,
        data: { txHashes, usdcAmount, ...data },
      };
    } catch (error) {
      const msg = `Failed to invest USDC into GBLIN: ${(error as Error).message}`;
      logger.error(`[plugin-gblin] ${msg}`);
      if (callback) {
        await callback({ text: `❌ ${msg}`, source: message.content?.source });
      }
      return { success: false, text: msg };
    }
  },

  examples: [
    [
      {
        name: "{{user}}",
        content: { text: "I have idle USDC. Park it in GBLIN." },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Converting your idle USDC into GBLIN for MEV-protected treasury management.",
          actions: ["INVEST_IDLE_USDC_GBLIN"],
        },
      },
    ],
    [
      {
        name: "{{user}}",
        content: { text: "Buy 25 USDC worth of GBLIN" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Executing a $25 USDC → GBLIN investment on Base mainnet.",
          actions: ["INVEST_IDLE_USDC_GBLIN"],
        },
      },
    ],
  ],
};

// ─── Action: RESCUE_USDC_FROM_GBLIN ──────────────────────────────────────────

const rescueUsdcAction: Action = {
  name: "RESCUE_USDC_FROM_GBLIN",
  similes: [
    "JIT_SWAP_GBLIN",
    "SELL_GBLIN_FOR_USDC",
    "CONVERT_GBLIN_TO_USDC",
    "LIQUIDATE_GBLIN",
    "GBLIN_TO_USDC",
    "PAY_X402_INVOICE",
  ],
  description:
    "Just-In-Time swap GBLIN → USDC in a single atomic transaction. " +
    "Use this when the agent needs USDC to pay an x402 invoice or cover " +
    "operational costs. Fetches atomic calldata from GBLIN x402 API and " +
    "broadcasts it on Base mainnet. Costs $0.005 USDC for the API call plus gas.",

  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    const key = String(runtime.getSetting("EVM_PRIVATE_KEY") ?? "");
    if (!key || !key.startsWith("0x") || key.length !== 66) {
      logger.warn(
        "[plugin-gblin] RESCUE_USDC_FROM_GBLIN: EVM_PRIVATE_KEY missing or invalid"
      );
      return false;
    }
    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    try {
      const { account, walletClient, publicClient } = getConfig(runtime);

      // Extract USDC amount needed from message
      const text = message.content?.text ?? "";
      const amountMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:usdc|USDC|\$)?/i);
      const usdcNeeded = amountMatch ? amountMatch[1] : "1";

      logger.info(
        `[plugin-gblin] JIT rescue: ${usdcNeeded} USDC for ${account.address}`
      );

      if (callback) {
        await callback({
          text: `⏳ Generating JIT GBLIN→USDC swap calldata for $${usdcNeeded}...`,
          source: message.content?.source,
        });
      }

      const data = (await x402Get(
        runtime,
        `/api/x402/jit?usdc=${usdcNeeded}&wallet=${account.address}`
      )) as {
        action: string;
        target_contract: Address;
        calldata: Hex;
        gblin_in?: string;
        usdc_out?: string;
        safe_min_usdc_out?: string;
      };

      if (!data.target_contract || !data.calldata) {
        throw new Error("API returned incomplete JIT swap data");
      }

      const hash = await walletClient.sendTransaction({
        account,
        to: data.target_contract,
        data: data.calldata,
        value: 0n,
      });

      await publicClient.waitForTransactionReceipt({
        hash,
        confirmations: 1,
      });

      const summary =
        `✅ **GBLIN → USDC JIT Swap Complete**\n\n` +
        `**USDC received:** ~$${usdcNeeded}\n` +
        `**GBLIN burned:** ~${data.gblin_in ?? "calculated on-chain"}\n` +
        `**Transaction:** [${hash.slice(0, 10)}...](https://basescan.org/tx/${hash})`;

      if (callback) {
        await callback({
          text: summary,
          actions: ["RESCUE_USDC_FROM_GBLIN"],
          source: message.content?.source,
        });
      }

      return {
        success: true,
        text: summary,
        data: { txHash: hash, usdcNeeded, ...data },
      };
    } catch (error) {
      const msg = `Failed to JIT swap GBLIN → USDC: ${(error as Error).message}`;
      logger.error(`[plugin-gblin] ${msg}`);
      if (callback) {
        await callback({ text: `❌ ${msg}`, source: message.content?.source });
      }
      return { success: false, text: msg };
    }
  },

  examples: [
    [
      {
        name: "{{user}}",
        content: { text: "I need 5 USDC to pay an x402 invoice" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "JIT-swapping GBLIN → $5 USDC to cover the invoice.",
          actions: ["RESCUE_USDC_FROM_GBLIN"],
        },
      },
    ],
    [
      {
        name: "{{user}}",
        content: { text: "Sell some GBLIN for 10 USDC" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Executing a JIT GBLIN→USDC atomic swap for $10.",
          actions: ["RESCUE_USDC_FROM_GBLIN"],
        },
      },
    ],
  ],
};

// ─── Provider: GBLIN_TREASURY_CONTEXT ────────────────────────────────────────

const gblinTreasuryProvider: Provider = {
  name: "GBLIN_TREASURY_CONTEXT",
  description:
    "Injects current GBLIN protocol state (NAV, basket weights, Crash Shield status) " +
    "into the agent context so the LLM can make informed treasury decisions. " +
    "This endpoint is paid ($0.001 USDC via x402) and called on every agent loop.",
  dynamic: true,
  position: 100,

  get: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State
  ): Promise<ProviderResult> => {
    const key = String(runtime.getSetting("EVM_PRIVATE_KEY") ?? "");
    if (!key || !key.startsWith("0x") || key.length !== 66) {
      return {
        text: "[GBLIN] EVM_PRIVATE_KEY not set — treasury context unavailable.",
        data: { available: false },
      };
    }

    try {
      const data = (await x402Get(runtime, "/api/x402/treasury-state")) as {
        nav_usd: number;
        eth_price_usd: number;
        crash_shield_active: boolean;
        slippage_buffer_pct: number;
        slippage_reason: string;
        basket: Array<{
          token: string;
          is_stable: boolean;
          base_weight_pct: number;
          dynamic_weight_pct: number;
          slashed: boolean;
        }>;
      };

      const basketSummary = data.basket
        .map(
          (b) =>
            `${b.is_stable ? "USDC" : b.token.slice(0, 6) + "..."}` +
            ` ${b.dynamic_weight_pct}%${b.slashed ? " [SLASHED]" : ""}`
        )
        .join(", ");

      const text =
        `[GBLIN Treasury State]\n` +
        `NAV: $${data.nav_usd.toFixed(4)} | ETH: $${data.eth_price_usd.toFixed(2)}\n` +
        `Crash Shield: ${data.crash_shield_active ? "🔴 ACTIVE" : "🟢 inactive"}\n` +
        `Slippage buffer: ${data.slippage_buffer_pct}% (${data.slippage_reason})\n` +
        `Basket: ${basketSummary}`;

      return {
        text,
        data,
        values: {
          gblin_nav_usd: data.nav_usd,
          gblin_crash_shield: data.crash_shield_active,
          gblin_slippage_pct: data.slippage_buffer_pct,
          gblin_slippage_reason: data.slippage_reason,
        },
      };
    } catch (error) {
      const msg = `[GBLIN] Failed to fetch treasury state: ${(error as Error).message}`;
      logger.warn(`[plugin-gblin] Provider error: ${msg}`);
      return {
        text: msg,
        data: { available: false, error: (error as Error).message },
      };
    }
  },
};

// ─── Plugin export ────────────────────────────────────────────────────────────

export const gblinPlugin: Plugin = {
  name: "plugin-gblin",
  description:
    "GBLIN Protocol treasury management for ElizaOS agents. " +
    "Park idle USDC in a MEV-protected cbBTC/WETH index, JIT-swap back to USDC " +
    "for x402 payments, and monitor treasury health — all on Base mainnet.",
  actions: [
    checkTreasuryHealthAction,
    investIdleUsdcAction,
    rescueUsdcAction,
  ],
  providers: [gblinTreasuryProvider],
};

export default gblinPlugin;

export {
  checkTreasuryHealthAction,
  investIdleUsdcAction,
  rescueUsdcAction,
  gblinTreasuryProvider,
};
