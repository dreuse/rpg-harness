import { type GmSegment, isRecord, MAX_SEGMENTS, segmentsOf } from './gm-segments.ts';

const MESSAGE_START = 'message_start';
const BLOCK_START = 'content_block_start';
const BLOCK_DELTA = 'content_block_delta';
const TOOL_USE = 'tool_use';
const INPUT_DELTA = 'input_json_delta';
const SEGMENTS_KEY = 'segments';
const ROOT_DEPTH = 1;
const LIST_DEPTH = 2;
const ELEMENT_DEPTH = 3;
const NOT_IN_OBJECT = -1;
const NONE: readonly GmSegment[] = [];
const QUOTE = '"';
const BACKSLASH = '\\';
const OPEN_LIST = '[';
const OPEN_OBJECT = '{';
const CLOSE_LIST = ']';
const CLOSE_OBJECT = '}';

const segmentScanner = () => {
  let text = '';
  let scanned = 0;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let stringStart = 0;
  let key = '';
  let listKey = '';
  let objectStart = NOT_IN_OBJECT;
  let emitted = 0;

  const closed = (end: number): readonly GmSegment[] => {
    try {
      return emitted >= MAX_SEGMENTS
        ? NONE
        : (segmentsOf({ segments: [JSON.parse(text.slice(objectStart, end))] }) ?? NONE);
    } catch {
      return NONE;
    }
  };

  const step = (char: string, at: number): readonly GmSegment[] => {
    if (inString) {
      if (escaped) escaped = false;
      else if (char === BACKSLASH) escaped = true;
      else if (char === QUOTE) {
        inString = false;
        if (depth === ROOT_DEPTH) key = text.slice(stringStart + 1, at);
      }
      return NONE;
    }
    if (char === QUOTE) {
      inString = true;
      stringStart = at;
    } else if (char === OPEN_LIST || char === OPEN_OBJECT) {
      depth += 1;
      if (char === OPEN_LIST && depth === LIST_DEPTH) listKey = key;
      if (char === OPEN_OBJECT && depth === ELEMENT_DEPTH && listKey === SEGMENTS_KEY) objectStart = at;
    } else if (char === CLOSE_LIST || char === CLOSE_OBJECT) {
      depth -= 1;
      if (char === CLOSE_OBJECT && depth === LIST_DEPTH && objectStart !== NOT_IN_OBJECT) {
        const segments = closed(at + 1);
        emitted += segments.length;
        objectStart = NOT_IN_OBJECT;
        return segments;
      }
    }
    return NONE;
  };

  return {
    push(chunk: string): GmSegment[] {
      text += chunk;
      const out: GmSegment[] = [];
      for (; scanned < text.length; scanned += 1) out.push(...step(text.charAt(scanned), scanned));
      return out;
    },
    text: () => text,
  };
};

export const toolInputStream = (toolName: string) => {
  let active: unknown;
  let scanner = segmentScanner();
  return {
    push(event: unknown): GmSegment[] {
      if (!isRecord(event)) return [];
      if (event.type === MESSAGE_START) active = undefined;
      if (event.type === BLOCK_START) {
        const block = event.content_block;
        const mine = isRecord(block) && block.type === TOOL_USE && block.name === toolName;
        if (mine) scanner = segmentScanner();
        active = mine ? event.index : event.index === active ? undefined : active;
      }
      if (event.type !== BLOCK_DELTA) return [];
      if (active === undefined || event.index !== active) return [];
      const { delta } = event;
      if (!isRecord(delta) || delta.type !== INPUT_DELTA || typeof delta.partial_json !== 'string') return [];
      return scanner.push(delta.partial_json);
    },
    input(): unknown {
      try {
        return JSON.parse(scanner.text());
      } catch {
        return undefined;
      }
    },
  };
};
