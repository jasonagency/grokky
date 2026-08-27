import { posix, win32 } from "node:path";
import { describe, expect, test } from "vitest";
import { isPathWithin } from "../src/main/path-boundary";

describe("path boundaries", () => {
  test.each([
    [posix, "/work/repository", "/work/repository/task", "/work/repository-copy/task"],
    [win32, "C:\\work\\repository", "C:\\work\\repository\\task", "C:\\work\\repository-copy\\task"],
  ])("accepts descendants and rejects sibling prefixes", (pathApi, root, descendant, sibling) => {
    expect(isPathWithin(root, root, pathApi)).toBe(true);
    expect(isPathWithin(root, descendant, pathApi)).toBe(true);
    expect(isPathWithin(root, sibling, pathApi)).toBe(false);
  });

  test("rejects a Windows path on another drive", () => {
    expect(isPathWithin("C:\\work\\repository", "D:\\work\\repository\\task", win32)).toBe(false);
  });
});
