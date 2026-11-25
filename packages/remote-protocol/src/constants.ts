/** Protocol constants shared by the core, the test client and the vectors. */
export const PROTOCOL_VERSION = 1;
export const MIN_PROTOCOL_VERSION = 1;

/** Prologue prefix: `agetor-remote/1` followed by the core id (SHA-256 of the core public key). */
export const PROLOGUE_PREFIX = "agetor-remote/1";

export const NOISE_NK = "Noise_NK_25519_ChaChaPoly_SHA256";
export const NOISE_NKPSK0 = "Noise_NKpsk0_25519_ChaChaPoly_SHA256";

/** HKDF `info` strings. */
export const INFO_MAILBOX = "agetor-mailbox/1";
export const INFO_PAIRING = "agetor-pairing/1";
export const INFO_SAS = "agetor-sas/1";
export const INFO_PUSH = "agetor-push/1";

/** A relay frame is at most 66 KB: one Noise message plus its header. */
export const MAX_RELAY_FRAME_BYTES = 66 * 1024;
/** A Noise message is at most 65,535 bytes, 16 of which are the AEAD tag. */
export const MAX_NOISE_MESSAGE_BYTES = 65535;
export const AEAD_TAG_BYTES = 16;
export const MAX_NOISE_PLAINTEXT_BYTES = MAX_NOISE_MESSAGE_BYTES - AEAD_TAG_BYTES;

/** App message padding buckets (inside the encryption). The last one is the largest plaintext a Noise message holds. */
export const PADDING_BUCKETS = [256, 1024, 4096, 16384, MAX_NOISE_PLAINTEXT_BYTES] as const;

export const SESSION_TAG_BYTES = 8;
export const MAILBOX_ID_BYTES = 16;
export const MAILBOX_KEY_BYTES = 32;

/** Envelope reassembly caps. */
export const MAX_CHUNKS_PER_MESSAGE = 1024;
export const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;
export const MAX_INFLIGHT_MESSAGES = 16;
/** Raw bytes per envelope chunk. Base64 grows it by 4/3, which stays inside one Noise plaintext. */
export const CHUNK_RAW_BYTES = 40 * 1024;

/** Session lifetime and rekey (spec "Lifetime"). */
export const REKEY_INTERVAL_MS = 10 * 60 * 1000;
export const REKEY_MESSAGES = 2 ** 20;
export const SESSION_IDLE_MS = 15 * 60 * 1000;
export const SESSION_MAX_MS = 12 * 60 * 60 * 1000;

/** Relay limits (relay contract §2). */
export const RELAY_QUEUE_BYTES = 256 * 1024;
export const RELAY_QUEUE_FRAMES = 64;
export const RELAY_RETENTION_MS = 10 * 60 * 1000;
export const RELAY_FRAMES_PER_SECOND = 50;
export const RELAY_BYTES_PER_10S = 2 * 1024 * 1024;
export const RELAY_IDLE_CLOSE_MS = 5 * 60 * 1000;
export const RELAY_PING_MS = 30 * 1000;

/** Signed decision limits. */
export const CHALLENGE_TTL_MS = 120 * 1000;
export const UNLOCK_MAX_MS = 10 * 60 * 1000;
export const PAIRING_TTL_MS = 120 * 1000;
export const DEVICE_NAME_MAX = 40;
export const PUSH_PAD_BYTES = 1024;
