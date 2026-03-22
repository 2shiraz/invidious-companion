import { Platform, Types } from "youtubei.js";

// https://ytjs.dev/guide/getting-started.html#providing-a-custom-javascript-interpreter
// deno-lint-ignore require-await
const cache = new Map();
export const jsInterpreter = Platform.shim.eval = async (
  data: Types.BuildScriptResult,
  env: Record<string, Types.VMPrimative>,
) => {

  let fn = cache.get(data.output);

  if (!fn) {
    fn = new Function(data.output);
    cache.set(data.output, fn);
  }

  return fn();
};
