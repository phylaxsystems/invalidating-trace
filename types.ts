// types.ts - TypeScript types and interfaces for the queue-based Tracer API

/**
 * Access list entry for EIP-2930 and later transaction types.
 * Contains an address and the storage keys that will be accessed.
 */
export interface AccessListEntry {
  addr: string;
  storageKeys: string[];
}

/**
 * Authorization tuple for EIP-7702 (Type 4) transactions.
 * Contains the signature components for account authorization.
 */
export interface AuthorizationTuple {
  chainId: number;
  addr: string;
  nonce: string;
  v: number;
  r: string;
  s: string;
}

/**
 * Full EVM transaction representation supporting all 5 transaction types (0-4).
 * - Type 0: Legacy transactions
 * - Type 1: EIP-2930 (access list) transactions
 * - Type 2: EIP-1559 (dynamic fee) transactions
 * - Type 3: EIP-4844 (blob) transactions
 * - Type 4: EIP-7702 (account abstraction) transactions
 */
export interface EVMTransaction {
  /** Transaction type discriminator (0=Legacy, 1=EIP-2930, 2=EIP-1559, 3=EIP-4844, 4=EIP-7702) */
  type: 0 | 1 | 2 | 3 | 4;
  /** Transaction hash (0x prefixed, 64 hex characters) */
  transaction_hash: string;
  /** Chain ID */
  chain_id: number;
  /** Transaction nonce */
  nonce: string;
  /** Gas limit for the transaction */
  gas_limit: string;
  /** Target address (empty for contract creation) */
  to_address: string;
  /** Sender address */
  from_address: string;
  /** Value in wei */
  value: string;
  /** Optional calldata (hex encoded) */
  data?: string;
  /** Gas price for Type 0 and 1 transactions */
  gas_price?: string;
  /** Max fee per gas for Type 2, 3, and 4 transactions */
  max_fee_per_gas?: string;
  /** Max priority fee per gas for Type 2, 3, and 4 transactions */
  max_priority_fee_per_gas?: string;
  /** Max fee per blob gas for Type 3 transactions */
  max_fee_per_blob_gas?: string;
  /** Blob versioned hashes for Type 3 transactions */
  blob_versioned_hashes?: string[];
  /** Authorization list for Type 4 transactions */
  authorization_list?: AuthorizationTuple[];
  /** Access list for Type 1, 2, 3, and 4 transactions */
  access_list?: AccessListEntry[];
}

/**
 * Block environment context from Revm, critical for accurate simulation.
 * When provided, all fields are required to ensure accurate simulation.
 */
export interface BlockEnv {
  /** Block number */
  number: string;
  /** Unix timestamp */
  timestamp: string;
  /** Coinbase/miner/validator address */
  beneficiary: string;
  /** Block gas limit */
  gas_limit: string;
  /** EIP-1559 base fee */
  basefee: string;
  /** Pre-merge difficulty */
  difficulty: string;
  /** Post-merge randomness (null for pre-merge chains) */
  prevrandao: string | null;
  /** EIP-4844 blob gas pricing (null for non-blob chains) */
  blob_excess_gas_and_price: {
    excess_blob_gas: string;
    blob_gasprice: string;
  } | null;
}

/**
 * Transaction data for replay in the tracer.
 * Simplified transaction representation for the main transaction being traced.
 */
export interface TransactionData {
  /** Sender address */
  from: string;
  /** Target address (empty for contract creation) */
  to: string;
  /** Value in wei */
  value: string;
  /** Calldata (hex encoded) */
  data: string;
  /** Optional nonce */
  nonce?: string;
  /** Optional gas limit */
  gas_limit?: string;
  /** Optional transaction type (0-4) */
  type?: number;
}

/**
 * Trace request payload submitted to POST /api/queue.
 * The dapp sends everything the tracer needs - the tracer fetches nothing.
 */
export interface TraceRequest {
  /** RPC URL for the target chain (e.g., "https://rpc.sepolia.linea.build") */
  rpc_url: string;
  /** Callback URL to POST results to (may include query params like debug_trace_id) */
  callback_url: string;
  /** Chain ID for logging/context */
  chain_id: number;
  /** Transaction hash of the transaction being traced (0x prefixed, 64 hex characters) */
  transaction_hash: string;
  /** Block number to fork at (block N-1, state at END of that block) */
  fork_block_number: number;
  /** Transaction data for replay */
  transaction: TransactionData;
  /** Previous transactions in the block for multi-block simulation (Linea) */
  previous_transactions?: EVMTransaction[];
  /** Block environment context for accurate simulation (REQUIRED) */
  block_env: BlockEnv;
}

/**
 * Callback payload sent to the dapp after trace completion.
 * Posted to the callback_url provided in the TraceRequest.
 */
export interface TraceCallbackPayload {
  /** Whether the trace completed successfully */
  success: boolean;
  /** Trace output content (present if success=true) */
  trace_content?: string;
  /** Format of the trace content */
  trace_format?: "ansi" | "plain" | "json";
  /** Error message (present if success=false) */
  error?: string;
  /** Error code for categorization (present if success=false) */
  error_code?: string;
  /** Duration of the trace operation in milliseconds */
  duration_ms?: number;
  /** Additional metadata from the tracer */
  tracer_metadata?: Record<string, unknown>;
}

/**
 * Response returned immediately when a trace request is queued.
 */
export interface QueueResponse {
  /** Status of the queue operation */
  status: "queued";
  /** Human-readable message */
  message: string;
}

/**
 * Error response for failed requests.
 */
export interface ErrorResponse {
  /** Error message */
  error: string;
}
