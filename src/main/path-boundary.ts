import { isAbsolute, relative, sep } from "node:path";

interface PathApi {
  relative(from: string, to: string): string;
  isAbsolute(pathname: string): boolean;
  sep: string;
}

const nativePath: PathApi = { relative, isAbsolute, sep };

export function isPathWithin(root: string, pathname: string, pathApi: PathApi = nativePath): boolean {
  const candidate = pathApi.relative(root, pathname);
  return candidate === "" || (candidate !== ".." && !candidate.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(candidate));
}
