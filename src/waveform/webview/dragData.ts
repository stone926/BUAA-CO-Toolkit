// @index waveform-webview-drag — 从信号树拖入波形列表的数据格式：MIME 类型与载荷编解码

export const signalDragType = 'application/x-co-wave-vars';

export interface SignalDragPayload {
  readonly vars: readonly number[];
  /** When present, the dropped signals become a group with this name. */
  readonly group?: string;
}

export function encodeSignalDrag(payload: SignalDragPayload): string {
  return JSON.stringify(payload);
}

export function decodeSignalDrag(text: string): SignalDragPayload | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null || !Array.isArray((value as { vars?: unknown }).vars)) {
    return undefined;
  }
  const record = value as { vars: unknown[]; group?: unknown };
  return {
    vars: record.vars.filter((index): index is number => Number.isInteger(index) && (index as number) >= 0),
    ...(typeof record.group === 'string' ? { group: record.group.slice(0, 256) } : {})
  };
}
