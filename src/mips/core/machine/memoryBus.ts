// @index mips-core — 小端 memory bus：region 分类、对齐/越界检查、字节车道与设备事务路由
import { ProgramImage } from '../api';
import {
  DeviceAccess,
  DeviceBusPort,
  DeviceFaultReason,
  isDeviceAccessFault,
  PreparedDeviceAccess
} from '../devices/deviceBus';
import {
  AccessWidth,
  CourseExecutionProfile,
  DeviceRegion,
  isDeviceRegion,
  MemoryRegion,
  RegionId,
  regionForAddress,
  regionWordCount
} from '../profiles/profile';
import { hex8Address, u32 } from '../values';

/**
 * 小端字节车道显式实现，不依赖宿主 TypedArray 的 endian（计划第 5.3 节）。
 *
 * 本模块只回答"这次访问是否合法、落在哪里、写了哪些字节"，不决定它是架构异常
 * 还是 out-of-domain：P7 由 `transition` 映射为 AdEL/AdES，P3–P6 没有架构异常，
 * 同一个 fault 会被分类为可比较域之外的输入（COURSE-P56-DOMAIN-001）。
 */

export type MemoryFaultReason =
  | 'misaligned'
  | 'unmapped'
  | 'address-overflow'
  | 'unsupported-width'
  | 'count-write'
  | 'device-schedule-missing'
  | 'unloaded-instruction';

export type AccessDirection = 'fetch' | 'load' | 'store';

export interface MemoryFault {
  readonly reason: MemoryFaultReason;
  readonly direction: AccessDirection;
  readonly address: number;
  readonly message: string;
}

export interface MemoryAccessRequest {
  readonly kind: 'load' | 'store';
  readonly address: number;
  readonly width: AccessWidth;
  /** Explicit byte enables for partial-word transfers (`swl/swr`). */
  readonly byteMask?: number;
  /** Alignment requirement in bytes; defaults to `width`. */
  readonly alignment?: 1 | 2 | 4;
  /** Set when the effective-address addition overflowed signed 32-bit. */
  readonly addressOverflow?: boolean;
  /** Raw store payload before byte-lane selection. */
  readonly value?: number;
}

export interface PreparedMemoryAccess {
  readonly kind: 'load' | 'store';
  readonly address: number;
  readonly width: AccessWidth;
  readonly wordAddress: number;
  readonly byteMask: number;
  readonly region: RegionId;
  readonly device?: PreparedDeviceAccess;
}

export interface FetchResult {
  readonly word?: number;
  readonly fault?: MemoryFault;
}

export type UnloadedInstructionPolicy = 'fail-closed' | 'synthetic-zero';

export interface MemoryBusOptions {
  /**
   * COURSE-P7-UNLOADED-IM-001: strict lanes fail closed on a legal-but-unloaded
   * instruction word. `synthetic-zero` exists only for explicit exploratory runs
   * and must never produce a strict golden.
   */
  readonly unloadedInstruction?: UnloadedInstructionPolicy;
  readonly devices?: DeviceBusPort;
}

interface RegionStorage {
  readonly region: MemoryRegion;
  readonly words: Uint32Array;
  readonly loaded: Uint8Array | undefined;
}

export class MemoryBus {
  private readonly storage = new Map<RegionId, RegionStorage>();
  private readonly devices: DeviceBusPort | undefined;
  private readonly unloadedPolicy: UnloadedInstructionPolicy;

  constructor(
    private readonly profile: CourseExecutionProfile,
    options: MemoryBusOptions = {}
  ) {
    this.devices = options.devices;
    this.unloadedPolicy = options.unloadedInstruction ?? 'fail-closed';
    for (const region of profile.memoryRegions) {
      const count = regionWordCount(region);
      this.storage.set(region.id, {
        region,
        words: new Uint32Array(count),
        loaded: region.instructionOnly ? new Uint8Array(count) : undefined
      });
    }
  }

  /** Load every image segment; a word outside the profile address space is an input error. */
  loadImage(image: ProgramImage): void {
    for (const segment of image.segments) {
      for (let index = 0; index < segment.words.length; index++) {
        const address = u32(segment.baseAddress + index * 4);
        const region = regionForAddress(this.profile, address);
        if (!region || isDeviceRegion(region)) {
          throw new Error(
            `ProgramImage segment "${segment.name}" 的字 ${hex8Address(address)} 不在 profile `
            + `${this.profile.id} 的可加载存储区内`
          );
        }
        if ((address & 3) !== 0) {
          throw new Error(`ProgramImage segment "${segment.name}" 的基地址未字对齐: ${hex8Address(address)}`);
        }
        const storage = this.storage.get(region.id);
        if (!storage) {
          throw new Error(`profile ${this.profile.id} 没有为 region ${region.id} 分配存储`);
        }
        const slot = (address - region.range.start) / 4;
        storage.words[slot] = u32(segment.words[index]);
        if (storage.loaded) {
          storage.loaded[slot] = 1;
        }
      }
    }
  }

  /** Instruction fetch with PC alignment and IM range checks (P7-2-3 取指异常). */
  fetch(pc: number): FetchResult {
    const address = u32(pc);
    if ((address & 3) !== 0) {
      return {
        fault: {
          reason: 'misaligned', direction: 'fetch', address,
          message: `取指地址 ${hex8Address(address)} 未字对齐`
        }
      };
    }
    const region = regionForAddress(this.profile, address);
    if (!region || isDeviceRegion(region) || !region.instructionOnly) {
      return {
        fault: {
          reason: 'unmapped', direction: 'fetch', address,
          message: `取指地址 ${hex8Address(address)} 超出指令存储器范围`
        }
      };
    }
    const storage = this.storage.get(region.id);
    if (!storage) {
      throw new Error(`profile ${this.profile.id} 没有为 region ${region.id} 分配存储`);
    }
    const slot = (address - region.range.start) / 4;
    if (storage.loaded && storage.loaded[slot] === 0) {
      if (this.unloadedPolicy === 'synthetic-zero') {
        return { word: 0 };
      }
      return {
        fault: {
          reason: 'unloaded-instruction', direction: 'fetch', address,
          message: `合法 IM 范围内的 ${hex8Address(address)} 未由 ProgramImage 提供指令字`
        }
      };
    }
    return { word: u32(storage.words[slot]) };
  }

  /** True when the address holds a loaded instruction word. */
  isLoadedInstruction(address: number): boolean {
    const region = regionForAddress(this.profile, u32(address));
    if (!region || isDeviceRegion(region) || !region.instructionOnly) {
      return false;
    }
    const storage = this.storage.get(region.id);
    if (!storage?.loaded) {
      return false;
    }
    return storage.loaded[(u32(address) - region.range.start) / 4] === 1;
  }

  /** Validate one data access without producing any side effect. */
  prepare(request: MemoryAccessRequest): PreparedMemoryAccess | MemoryFault {
    const address = u32(request.address);
    const direction: AccessDirection = request.kind;
    if (request.addressOverflow) {
      return {
        reason: 'address-overflow', direction, address,
        message: `计算有效地址时发生 32 位有符号加法溢出（${hex8Address(address)}）`
      };
    }
    const alignment = request.alignment ?? request.width;
    if (alignment > 1 && (address & (alignment - 1)) !== 0) {
      return {
        reason: 'misaligned', direction, address,
        message: `访存地址 ${hex8Address(address)} 未按 ${alignment} 字节对齐`
      };
    }
    const region = regionForAddress(this.profile, address);
    if (!region || (!isDeviceRegion(region) && region.instructionOnly)) {
      return {
        reason: 'unmapped', direction, address,
        message: `访存地址 ${hex8Address(address)} 超出 DM 与已声明外设的范围`
      };
    }
    if (!region.acceptedWidths.includes(request.width)) {
      return {
        reason: 'unsupported-width', direction, address,
        message: `region ${region.id} 不接受 ${request.width} 字节宽度的访问`
      };
    }
    const wordAddress = u32(address & ~3);
    const byteMask = request.byteMask ?? defaultByteMask(address, request.width);
    if (isDeviceRegion(region)) {
      return this.prepareDevice(region, request, address, wordAddress, byteMask, direction);
    }
    return {
      kind: request.kind,
      address,
      width: request.width,
      wordAddress,
      byteMask,
      region: region.id
    };
  }

  private prepareDevice(
    region: DeviceRegion,
    request: MemoryAccessRequest,
    address: number,
    wordAddress: number,
    byteMask: number,
    direction: AccessDirection
  ): PreparedMemoryAccess | MemoryFault {
    if (!this.devices) {
      return {
        reason: 'unmapped', direction, address,
        message: `profile ${this.profile.id} 没有连接 ${region.id} 设备端口`
      };
    }
    if (region.id !== 'interrupt-generator' && byteMask !== 0b1111) {
      return {
        reason: 'unsupported-width', direction, address,
        message: `region ${region.id} 只接受整字事务，拒绝部分字节使能 0b${byteMask.toString(2)}`
      };
    }
    const access: DeviceAccess = {
      kind: request.kind,
      device: region.id,
      address,
      width: request.width,
      ...(request.value === undefined ? {} : { value: u32(request.value) })
    };
    const prepared = this.devices.prepare(access);
    if (isDeviceAccessFault(prepared)) {
      return {
        reason: deviceFaultToMemoryFault(prepared.fault),
        direction, address, message: prepared.message
      };
    }
    return {
      kind: request.kind,
      address,
      width: request.width,
      wordAddress,
      byteMask,
      region: region.id,
      device: prepared
    };
  }

  /** Read the value a prepared load would produce, with sign/zero extension applied. */
  read(prepared: PreparedMemoryAccess, signExtend: boolean): number {
    const word = this.readWord(prepared);
    if (prepared.width === 4) {
      return word;
    }
    const shift = (prepared.address & 3) * 8;
    if (prepared.width === 1) {
      const byte = (word >>> shift) & 0xff;
      return signExtend ? u32((byte << 24) >> 24) : byte;
    }
    const half = (word >>> ((prepared.address & 2) * 8)) & 0xffff;
    return signExtend ? u32((half << 16) >> 16) : half;
  }

  /** Raw aligned word behind a prepared access (used by `lwl/lwr` and store merges). */
  readWord(prepared: PreparedMemoryAccess): number {
    if (prepared.device) {
      if (!this.devices) {
        throw new Error('device access prepared without a device port');
      }
      return u32(this.devices.read(prepared.device));
    }
    return this.readMemoryWord(prepared.region, prepared.wordAddress);
  }

  /** Merge the store payload into the aligned word and return before/after values. */
  storePreview(prepared: PreparedMemoryAccess, rawValue: number): {
    readonly valueBefore: number;
    readonly valueAfter: number;
  } {
    const valueBefore = this.readWord(prepared);
    const laneMask = byteMaskToBits(prepared.byteMask);
    const aligned = alignStoreValue(prepared, rawValue);
    return {
      valueBefore,
      valueAfter: u32((valueBefore & ~laneMask) | (aligned & laneMask))
    };
  }

  /** Apply the store. Device transactions are delegated to the port's `commit`. */
  commit(prepared: PreparedMemoryAccess, rawValue: number): void {
    if (prepared.device) {
      return;
    }
    const { valueAfter } = this.storePreview(prepared, rawValue);
    this.writeMemoryWord(prepared.region, prepared.wordAddress, valueAfter);
  }

  /** Direct DM word read for probes/snapshots; returns zero outside a memory region. */
  readDataWord(address: number): number {
    const region = regionForAddress(this.profile, u32(address));
    if (!region || isDeviceRegion(region)) {
      return 0;
    }
    return this.readMemoryWord(region.id, u32(address & ~3));
  }

  /** Sparse non-zero words of one memory region, ordered by address. */
  nonZeroWords(regionId: RegionId): readonly { readonly address: number; readonly value: number }[] {
    const storage = this.storage.get(regionId);
    if (!storage) {
      return [];
    }
    const entries: { address: number; value: number }[] = [];
    for (let slot = 0; slot < storage.words.length; slot++) {
      const value = u32(storage.words[slot]);
      if (value !== 0) {
        entries.push({ address: u32(storage.region.range.start + slot * 4), value });
      }
    }
    return entries;
  }

  private readMemoryWord(regionId: RegionId, wordAddress: number): number {
    const storage = this.storage.get(regionId);
    if (!storage) {
      return 0;
    }
    const slot = (u32(wordAddress) - storage.region.range.start) / 4;
    if (!Number.isInteger(slot) || slot < 0 || slot >= storage.words.length) {
      return 0;
    }
    return u32(storage.words[slot]);
  }

  private writeMemoryWord(regionId: RegionId, wordAddress: number, value: number): void {
    const storage = this.storage.get(regionId);
    if (!storage) {
      throw new Error(`region ${regionId} 没有可写存储`);
    }
    const slot = (u32(wordAddress) - storage.region.range.start) / 4;
    if (!Number.isInteger(slot) || slot < 0 || slot >= storage.words.length) {
      throw new Error(`地址 ${hex8Address(wordAddress)} 超出 region ${regionId}`);
    }
    storage.words[slot] = u32(value);
    if (storage.loaded) {
      storage.loaded[slot] = 1;
    }
  }
}

/** Byte enables implied by an access width at a byte address (little endian). */
export function defaultByteMask(address: number, width: AccessWidth): number {
  const offset = u32(address) & 3;
  if (width === 4) {
    return 0b1111;
  }
  if (width === 2) {
    return offset < 2 ? 0b0011 : 0b1100;
  }
  return 1 << offset;
}

/** Map a device-port rejection onto the bus fault vocabulary. */
function deviceFaultToMemoryFault(fault: DeviceFaultReason): MemoryFaultReason {
  switch (fault) {
    case 'count-write':
      return 'count-write';
    case 'schedule-missing':
      return 'device-schedule-missing';
    case 'unsupported-width':
      return 'unsupported-width';
    default:
      return 'unmapped';
  }
}

/** Expand a 4-bit byte-enable mask into a 32-bit bit mask. */
export function byteMaskToBits(byteMask: number): number {
  let bits = 0;
  for (let lane = 0; lane < 4; lane++) {
    if ((byteMask >>> lane) & 1) {
      bits |= 0xff << (lane * 8);
    }
  }
  return u32(bits);
}

/** Shift a raw store payload into its byte lanes for a width-derived access. */
function alignStoreValue(prepared: PreparedMemoryAccess, rawValue: number): number {
  const value = u32(rawValue);
  if (prepared.width === 4) {
    return value;
  }
  if (prepared.width === 1) {
    return u32((value & 0xff) << ((prepared.address & 3) * 8));
  }
  return u32((value & 0xffff) << ((prepared.address & 2) * 8));
}
