// @index system-function-constants — Shared legality classification without requiring numeric evaluation.
import { systemTasks } from './model';
export type VerilogSystemFunctionConstantKind = 'constant' | 'nonConstant' | 'unknown';

const constantSystemFunctions = new Set([
  '$signed', '$unsigned', '$clog2',
  '$itor', '$rtoi', '$realtobits', '$bitstoreal',
  '$ln', '$log10', '$exp', '$sqrt', '$pow', '$floor', '$ceil',
  '$sin', '$cos', '$tan', '$asin', '$acos', '$atan', '$atan2', '$hypot',
  '$sinh', '$cosh', '$tanh', '$asinh', '$acosh', '$atanh'
]);

const runtimeSystemFunctions = new Set([
  '$time', '$stime', '$realtime', '$random', '$urandom', '$urandom_range',
  '$fopen', '$fclose', '$fgetc', '$ungetc', '$fgets', '$fscanf', '$sscanf',
  '$fread', '$ftell', '$fseek', '$rewind', '$feof', '$ferror',
  '$test$plusargs', '$value$plusargs', '$system', '$countdrivers', '$getpattern',
  '$dist_uniform', '$dist_normal', '$dist_exponential', '$dist_poisson',
  '$dist_chi_square', '$dist_t', '$dist_erlang'
]);

/** Unknown implementations may be constant; absence from a whitelist proves nothing. */
export function classifySystemFunctionConstant(name: string): VerilogSystemFunctionConstantKind {
  if (constantSystemFunctions.has(name)) return 'constant';
  if (runtimeSystemFunctions.has(name) || systemTasks.has(name.replace(/^\$/, ''))) return 'nonConstant';
  return 'unknown';
}
