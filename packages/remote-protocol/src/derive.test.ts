import { describe, expect, test } from "bun:test";
import { hkdfSync, createHmac, createHash } from "node:crypto";
import { fromHex, toHex, utf8 } from "./bytes.ts";
import { collapseId, coreId, mailboxId, mailboxKey, pairingMailboxKey, pushRequestMac, sasCode, utcDate } from "./derive.ts";
import vectors from "../vectors/agetor-derive.json";

const link = fromHex(vectors.linkSecret);

function nodeHkdf(ikm: Uint8Array, info: string, len: number): string {
  return Buffer.from(hkdfSync("sha256", ikm, Buffer.alloc(0), Buffer.from(info), len)).toString("hex");
}

describe("derive", () => {
  test("mailbox keys match node:crypto HKDF and the vectors", () => {
    for (const m of vectors.mailbox) {
      expect(toHex(mailboxKey(link, m.date))).toBe(nodeHkdf(link, "agetor-mailbox/1" + m.date, 32));
      expect(toHex(mailboxKey(link, m.date))).toBe(m.key);
      expect(toHex(mailboxId(mailboxKey(link, m.date)))).toBe(m.id);
      expect(m.id).toBe(createHash("sha256").update(fromHex(m.key)).digest("hex").slice(0, 32));
    }
  });
  test("the two dates either side of midnight UTC give different mailbox ids", () => {
    const before = utcDate(Date.UTC(2026, 10, 24, 23, 59, 59));
    const after = utcDate(Date.UTC(2026, 10, 25, 0, 0, 0));
    expect(before).toBe("2026-11-24");
    expect(after).toBe("2026-11-25");
    expect(toHex(mailboxId(mailboxKey(link, before)))).not.toBe(toHex(mailboxId(mailboxKey(link, after))));
  });
  test("the pairing mailbox uses its own info and no date", () => {
    const pairing = fromHex(vectors.pairingSecret);
    expect(toHex(pairingMailboxKey(pairing))).toBe(nodeHkdf(pairing, "agetor-pairing/1", 32));
    expect(toHex(pairingMailboxKey(pairing))).toBe(vectors.pairingMailbox.key);
  });
  test("SAS is six digits and matches an independent computation", () => {
    const hh = fromHex(vectors.handshakeHash);
    const okm = Buffer.from(nodeHkdf(hh, "agetor-sas/1", 32), "hex");
    expect(sasCode(hh)).toBe(String(okm.readUInt32BE(0) % 1_000_000).padStart(6, "0"));
    expect(sasCode(hh)).toBe(vectors.sas);
    for (const c of vectors.sasCases) {
      expect(sasCode(fromHex(c.handshakeHash))).toBe(c.code);
      expect(c.code).toMatch(/^\d{6}$/);
    }
  });
  test("core id, collapse id and push MAC", () => {
    expect(toHex(coreId(fromHex(vectors.corePub)))).toBe(vectors.coreId);
    expect(toHex(collapseId(link, vectors.collapse.taskId))).toBe(createHmac("sha256", link).update(vectors.collapse.taskId).digest("hex"));
    expect(toHex(collapseId(link, vectors.collapse.taskId))).toBe(vectors.collapse.id);
    expect(toHex(pushRequestMac(fromHex(vectors.pushMac.sendKey), fromHex(vectors.pushMac.request)))).toBe(vectors.pushMac.mac);
    expect(toHex(collapseId(link, "other"))).not.toBe(vectors.collapse.id);
  });
  test("a malformed date is refused", () => {
    expect(() => mailboxKey(link, "2026-1-1")).toThrow();
    expect(utf8("x").length).toBe(1);
  });
});
