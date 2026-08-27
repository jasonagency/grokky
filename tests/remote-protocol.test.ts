import { describe, expect, test } from "vitest";
import { assertCompatibleProtocol, assertSecureRemoteEndpoint, MAX_REMOTE_FRAME_BYTES, REMOTE_PROTOCOL, signRemoteFrame, verifyRemoteFrame } from "../src/shared/remote-protocol";
import { HostClient, type HostTransport } from "../src/main/remote/host-client";

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

  test("orders signed host events and rejects cursor gaps", async () => {
    const frames = [2, 1].map((cursor) => signRemoteFrame({ protocolMajor: REMOTE_PROTOCOL.major, cursor, jobId: "job", leaseEpoch: 1, type: "job.output", payload: { cursor }, timestamp: cursor }, "credential"));
    const transport: HostTransport = {
      capabilities: async () => ({ protocol: REMOTE_PROTOCOL, hostId: "host", harnesses: [], controls: [], filesCompatibility: true, maxFrameBytes: MAX_REMOTE_FRAME_BYTES }),
      submit: async () => { throw new Error("unused"); },
      events: async () => frames,
      control: async () => ({ accepted: false }),
    };
    const client = new HostClient("http://127.0.0.1:4747", "credential", transport);
    expect((await client.events(0)).map((frame) => frame.cursor)).toEqual([1, 2]);
    frames.splice(1, 1);
    await expect(client.events(0)).rejects.toThrow("gap after cursor 0");
  });
});
