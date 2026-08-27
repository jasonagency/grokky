import { describe, expect, test } from "vitest";
import { assertCompatibleProtocol, assertSecureRemoteEndpoint, MAX_REMOTE_FRAME_BYTES, REMOTE_PROTOCOL, signRemoteFrame, verifyRemoteFrame } from "../src/shared/remote-protocol";

describe("remote protocol", () => {
  test("authenticates bounded frames and rejects incompatible, invalid, or public plaintext peers", () => {
    const frame = signRemoteFrame({ protocolMajor: REMOTE_PROTOCOL.major, cursor: 1, jobId: "job", leaseEpoch: 1, type: "job.accepted", payload: {}, timestamp: 1 }, "credential");
    expect(() => verifyRemoteFrame(frame, "credential")).not.toThrow();
    expect(() => verifyRemoteFrame({ ...frame, payload: { changed: true } }, "credential")).toThrow("signature");
    expect(() => assertCompatibleProtocol({ major: 2, minor: 0 })).toThrow("incompatible");
    expect(() => assertSecureRemoteEndpoint("http://203.0.113.2:4747")).toThrow("HTTPS");
    expect(() => assertSecureRemoteEndpoint("http://10.attacker.example:4747")).toThrow("HTTPS");
    expect(assertSecureRemoteEndpoint("http://127.0.0.1:4747")).toBe("http://127.0.0.1:4747");
    expect(assertSecureRemoteEndpoint("http://[::1]:4747")).toBe("http://[::1]:4747");
    expect(assertSecureRemoteEndpoint("http://100.64.0.2:4747")).toBe("http://100.64.0.2:4747");
  });

  test("applies the frame limit after adding the signature envelope", () => {
    const base = { protocolMajor: REMOTE_PROTOCOL.major, cursor: 1, jobId: "job", leaseEpoch: 1, type: "job.output" as const, payload: "", timestamp: 1 };
    const payload = "x".repeat(MAX_REMOTE_FRAME_BYTES - Buffer.byteLength(JSON.stringify(base), "utf8") - 1);
    expect(Buffer.byteLength(JSON.stringify({ ...base, payload }), "utf8")).toBeLessThanOrEqual(MAX_REMOTE_FRAME_BYTES);
    expect(() => signRemoteFrame({ ...base, payload }, "credential")).toThrow("size limit");
  });
});
