import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { nox } from "@iexec-nox/nox-hardhat-plugin";

describe("Nox toolchain probe", () => {
  it("round-trips an encrypted value through the local stack", { timeout: 120_000 }, async () => {
    const { viem } = await nox.connect();
    const probe = await viem.deployContract("Probe", [42n]);
    const handle = (await probe.read.value()) as `0x${string}`;
    const { value } = await nox.publicDecrypt(handle);
    assert.equal(value, 42n);
  });
});
