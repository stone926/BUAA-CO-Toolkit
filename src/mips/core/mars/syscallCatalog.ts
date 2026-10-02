// @index mips-core — Canonical ordinary MARS syscall reference and executable service availability

export type MarsSyscallCategory = 'console' | 'memory' | 'process' | 'file' | 'time' | 'random' | 'midi' | 'dialog';

export interface MarsSyscallInfo {
  readonly code: number;
  readonly name: string;
  readonly parameters: string;
  readonly returns: string;
  readonly description: string;
  readonly category: MarsSyscallCategory;
  readonly supported: boolean;
}

type Service = readonly [number, string, MarsSyscallCategory, string, string, string];

const implemented: readonly Service[] = [
  [1, 'print integer', 'console', '$a0 = signed integer', '无', '打印有符号 32 位整数。'],
  [2, 'print float', 'console', '$f12 = float', '无', '打印单精度浮点数。'],
  [3, 'print double', 'console', '$f12/$f13 = double', '无', '打印双精度浮点数，使用偶数寄存器对。'],
  [4, 'print string', 'console', '$a0 = UTF-8 字符串地址', '无', '打印以 NUL 结尾的 UTF-8 字符串。'],
  [5, 'read integer', 'console', '无', '$v0 = signed integer', '读取十进制有符号 32 位整数。'],
  [6, 'read float', 'console', '无', '$f0 = float', '读取单精度浮点数。'],
  [7, 'read double', 'console', '无', '$f0/$f1 = double', '读取双精度浮点数。'],
  [8, 'read string', 'console', '$a0 = buffer 地址；$a1 = buffer 字节容量', '结果写入 buffer', '最多写入容量减一的 UTF-8 字节并追加 NUL；有剩余容量时保留或追加换行。容量为 1 时仅写 NUL，容量小于等于 0 时不写入。'],
  [9, 'sbrk', 'memory', '$a0 = 非负字节数', '$v0 = 分配到的地址', '分配堆内存，后续堆地址按 4 字节对齐。'],
  [10, 'exit', 'process', '无', '程序结束', '结束程序，退出码为 0。'],
  [11, 'print character', 'console', '$a0 = 字符', '无', '打印 $a0 最低 8 位对应的字符。'],
  [12, 'read character', 'console', '无', '$v0 = 字符码', '读取一个字符。'],
  [13, 'open file', 'file', '$a0 = UTF-8 路径地址；$a1 = flags；$a2 = mode（忽略）', '$v0 = fd，失败为负数', '打开文件；flags 0 只读，1 写入并创建/截断，9 写入并创建/追加。相对路径由宿主工作目录解析。'],
  [14, 'read file', 'file', '$a0 = fd；$a1 = buffer 地址；$a2 = 最大字节数', '$v0 = 读取字节数，EOF 为 0，失败为负数', '从文件或标准输入读取字节。'],
  [15, 'write file', 'file', '$a0 = fd；$a1 = buffer 地址；$a2 = 字节数', '$v0 = 写入字节数，失败为负数', '写入文件或标准输出/错误；fd 0、1、2 分别为标准输入、输出、错误。'],
  [16, 'close file', 'file', '$a0 = fd', '无', '关闭文件描述符。'],
  [17, 'exit2', 'process', '$a0 = exit code', '程序结束', '结束程序并保留有符号退出码。'],
  [30, 'system time', 'time', '无', '$a0 = 低 32 位；$a1 = 高 32 位', '返回 Unix epoch 起的毫秒数，时间由宿主提供。'],
  [32, 'sleep', 'time', '$a0 = 毫秒数', '无', '请求宿主等待；负值按 0 处理。'],
  [34, 'print hexadecimal', 'console', '$a0 = integer', '无', '打印 8 位十六进制数，含前导零且无 0x 前缀。'],
  [35, 'print binary', 'console', '$a0 = integer', '无', '打印 32 位二进制数，含前导零。'],
  [36, 'print unsigned integer', 'console', '$a0 = integer', '无', '打印无符号 32 位十进制整数。'],
  [40, 'set random seed', 'random', '$a0 = stream id；$a1 = seed', '无', '设置独立随机流的种子，与 Java Random 序列兼容。'],
  [41, 'random integer', 'random', '$a0 = stream id', '$a0 = random integer', '生成有符号 32 位随机整数；结果写入 $a0。'],
  [42, 'random integer range', 'random', '$a0 = stream id；$a1 = 正整数上界', '$a0 = random integer', '返回 [0, 上界) 中的整数，上界必须大于 0。'],
  [43, 'random float', 'random', '$a0 = stream id', '$f0 = random float', '返回 [0, 1) 中的单精度随机数。'],
  [44, 'random double', 'random', '$a0 = stream id', '$f0/$f1 = random double', '返回 [0, 1) 中的双精度随机数。']
];

const unavailable: readonly Service[] = [
  [31, 'MIDI output', 'midi', '$a0 = pitch；$a1 = duration；$a2 = instrument；$a3 = volume', '无', '内置 MARS 不提供 MIDI 音频输出。'],
  [33, 'MIDI output synchronous', 'midi', '$a0 = pitch；$a1 = duration；$a2 = instrument；$a3 = volume', '无', '内置 MARS 不提供同步 MIDI 音频输出。'],
  ...Array.from({ length: 10 }, (_, index): Service => [50 + index,
    ['ConfirmDialog', 'InputDialogInt', 'InputDialogFloat', 'InputDialogDouble', 'InputDialogString', 'MessageDialog', 'MessageDialogInt', 'MessageDialogFloat', 'MessageDialogDouble', 'MessageDialogString'][index],
    'dialog', '桌面 MARS 对话框参数', '桌面 MARS 对话框结果', '内置 MARS 不提供 Java 桌面对话框服务。'])
];

function entry(service: Service, supported: boolean): MarsSyscallInfo {
  const [code, name, category, parameters, returns, description] = service;
  return Object.freeze({ code, name, category, parameters, returns, description, supported });
}

/** Ordinary mode only. P7 syscall always traps with ExcCode=8 to 0x4180. */
export const marsSyscallCatalog: readonly MarsSyscallInfo[] = Object.freeze([
  ...implemented.map(service => entry(service, true)), ...unavailable.map(service => entry(service, false))
].sort((a, b) => a.code - b.code));

export const supportedMarsSyscalls: readonly MarsSyscallInfo[] = Object.freeze(marsSyscallCatalog.filter(service => service.supported));
const services = new Map(marsSyscallCatalog.map(service => [service.code, service]));

export function marsSyscallByCode(code: number): MarsSyscallInfo | undefined {
  return services.get(code);
}

export function getSupportedMarsSyscall(code: number): MarsSyscallInfo | undefined {
  const service = services.get(code);
  return service?.supported ? service : undefined;
}
