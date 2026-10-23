import {
  createHash,
  createSign,
  generateKeyPairSync,
} from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { deflateRawSync } from "node:zlib";
import { recordAuditEvent } from "./audit.service.js";

export interface BuiltApkInfo {
  platformName: "MARRY BASE";
  packageName: string;
  versionName: string;
  versionCode: number;
  projectSlug: string | null;
  fileName: string;
  filePath: string;
  sizeBytes: number;
  checksumSha256: string;
  entries: string[];
  builtAt: string;
}

// Precomputed IEEE 802.3 CRC-32 lookup table
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC32_TABLE[(crc ^ buf[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function adler32(buf: Buffer, start = 0): number {
  const MOD_ADLER = 65521;
  let a = 1;
  let b = 0;
  for (let i = start; i < buf.length; i++) {
    a = (a + buf[i]!) % MOD_ADLER;
    b = (b + a) % MOD_ADLER;
  }
  return ((b << 16) | a) >>> 0;
}

/**
 * Builds an Android UTF-16LE ResStringPool chunk (RES_STRING_POOL_TYPE = 0x0001).
 */
function buildResStringPoolUtf16(strings: string[]): Buffer {
  const encodedStrings: Buffer[] = [];
  const offsets: number[] = [];
  let currentOffset = 0;

  for (const s of strings) {
    offsets.push(currentOffset);
    const strBuf = Buffer.from(s, "utf16le");
    const charLen = s.length;
    const entry = Buffer.alloc(2 + strBuf.length + 2);
    entry.writeUInt16LE(charLen, 0);
    strBuf.copy(entry, 2);
    entry.writeUInt16LE(0, 2 + strBuf.length);
    encodedStrings.push(entry);
    currentOffset += entry.length;
  }

  const stringsDataRaw = Buffer.concat(encodedStrings);
  const padLen = (4 - (stringsDataRaw.length % 4)) % 4;
  const stringsData =
    padLen > 0
      ? Buffer.concat([stringsDataRaw, Buffer.alloc(padLen, 0)])
      : stringsDataRaw;

  const headerSize = 28;
  const offsetsSize = strings.length * 4;
  const stringsStart = headerSize + offsetsSize;
  const totalSize = stringsStart + stringsData.length;

  const buf = Buffer.alloc(totalSize);
  buf.writeUInt16LE(0x0001, 0); // RES_STRING_POOL_TYPE
  buf.writeUInt16LE(headerSize, 2);
  buf.writeUInt32LE(totalSize, 4);
  buf.writeUInt32LE(strings.length, 8); // stringCount
  buf.writeUInt32LE(0, 12); // styleCount
  buf.writeUInt32LE(0, 16); // flags (UTF-16LE)
  buf.writeUInt32LE(stringsStart, 20); // stringsStart
  buf.writeUInt32LE(0, 24); // stylesStart

  for (let i = 0; i < offsets.length; i++) {
    buf.writeUInt32LE(offsets[i]!, headerSize + i * 4);
  }
  stringsData.copy(buf, stringsStart);
  return buf;
}

/**
 * Compiles a genuine Android Binary XML (AXML / ResXMLTree) AndroidManifest.xml
 * conforming to Android's frameworks/base/libs/androidfw/ResourceTypes.cpp.
 */
export function buildAndroidBinaryManifest(
  packageName: string,
  versionName: string,
  versionCode: number
): Buffer {
  // Attribute names with Android system resource IDs MUST come first in the string pool,
  // ordered by ascending android.R.attr resource ID.
  const attrResourceMap: Array<{ name: string; id: number }> = [
    { name: "label", id: 0x01010001 },
    { name: "icon", id: 0x01010002 },
    { name: "name", id: 0x01010003 },
    { name: "exported", id: 0x0101001e },
    { name: "minSdkVersion", id: 0x0101020c },
    { name: "versionCode", id: 0x0101021b },
    { name: "versionName", id: 0x0101021c },
    { name: "targetSdkVersion", id: 0x01010270 },
    { name: "allowBackup", id: 0x01010280 },
    { name: "usesCleartextTraffic", id: 0x010104ec },
  ];

  const otherStrings = [
    "android",
    "http://schemas.android.com/apk/res/android",
    "package",
    "manifest",
    "uses-sdk",
    "uses-permission",
    "application",
    "activity",
    "intent-filter",
    "action",
    "category",
    packageName,
    versionName,
    "android.permission.INTERNET",
    "MARRY BASE",
    `${packageName}.MainActivity`,
    "android.intent.action.MAIN",
    "android.intent.category.LAUNCHER",
  ];

  const allStrings = [
    ...attrResourceMap.map((a) => a.name),
    ...otherStrings,
  ];
  const idx = (s: string): number => {
    const i = allStrings.indexOf(s);
    if (i === -1) throw new Error(`Missing AXML string pool entry: ${s}`);
    return i;
  };

  const stringPoolChunk = buildResStringPoolUtf16(allStrings);

  // RES_XML_RESOURCE_MAP_TYPE = 0x0180
  const resMapSize = 8 + attrResourceMap.length * 4;
  const resMapChunk = Buffer.alloc(resMapSize);
  resMapChunk.writeUInt16LE(0x0180, 0);
  resMapChunk.writeUInt16LE(8, 2);
  resMapChunk.writeUInt32LE(resMapSize, 4);
  for (let i = 0; i < attrResourceMap.length; i++) {
    resMapChunk.writeUInt32LE(attrResourceMap[i]!.id, 8 + i * 4);
  }

  const NS_ANDROID = idx("http://schemas.android.com/apk/res/android");
  const NO_INDEX = 0xffffffff;

  function makeStartNamespace(line: number, prefix: number, uri: number): Buffer {
    const b = Buffer.alloc(24);
    b.writeUInt16LE(0x0100, 0); // RES_XML_START_NAMESPACE_TYPE
    b.writeUInt16LE(16, 2);
    b.writeUInt32LE(24, 4);
    b.writeUInt32LE(line, 8);
    b.writeUInt32LE(NO_INDEX, 12);
    b.writeUInt32LE(prefix, 16);
    b.writeUInt32LE(uri, 20);
    return b;
  }

  function makeEndNamespace(line: number, prefix: number, uri: number): Buffer {
    const b = Buffer.alloc(24);
    b.writeUInt16LE(0x0101, 0); // RES_XML_END_NAMESPACE_TYPE
    b.writeUInt16LE(16, 2);
    b.writeUInt32LE(24, 4);
    b.writeUInt32LE(line, 8);
    b.writeUInt32LE(NO_INDEX, 12);
    b.writeUInt32LE(prefix, 16);
    b.writeUInt32LE(uri, 20);
    return b;
  }

  interface AxmlAttr {
    ns: number;
    name: number;
    rawValue: number;
    dataType: number; // 0x01=REF, 0x03=STRING, 0x10=INT_DEC, 0x12=BOOL
    data: number;
  }

  function attrString(ns: number, nameStr: string, valStr: string): AxmlAttr {
    const valIdx = idx(valStr);
    return {
      ns,
      name: idx(nameStr),
      rawValue: valIdx,
      dataType: 0x03, // TYPE_STRING
      data: valIdx,
    };
  }

  function attrInt(ns: number, nameStr: string, val: number): AxmlAttr {
    return {
      ns,
      name: idx(nameStr),
      rawValue: NO_INDEX,
      dataType: 0x10, // TYPE_INT_DEC
      data: val >>> 0,
    };
  }

  function attrBool(ns: number, nameStr: string, val: boolean): AxmlAttr {
    return {
      ns,
      name: idx(nameStr),
      rawValue: NO_INDEX,
      dataType: 0x12, // TYPE_INT_BOOLEAN
      data: val ? 0xffffffff : 0x00000000,
    };
  }

  function attrRef(ns: number, nameStr: string, resId: number): AxmlAttr {
    return {
      ns,
      name: idx(nameStr),
      rawValue: NO_INDEX,
      dataType: 0x01, // TYPE_REFERENCE
      data: resId >>> 0,
    };
  }

  function makeStartElement(
    line: number,
    tagName: string,
    attrs: AxmlAttr[]
  ): Buffer {
    const totalSize = 36 + attrs.length * 20;
    const b = Buffer.alloc(totalSize);
    b.writeUInt16LE(0x0102, 0); // RES_XML_START_ELEMENT_TYPE
    b.writeUInt16LE(16, 2);
    b.writeUInt32LE(totalSize, 4);
    b.writeUInt32LE(line, 8);
    b.writeUInt32LE(NO_INDEX, 12);

    // ResXMLTree_attrExt (20 bytes)
    b.writeUInt32LE(NO_INDEX, 16); // ns
    b.writeUInt32LE(idx(tagName), 20); // name
    b.writeUInt16LE(20, 24); // attributeStart
    b.writeUInt16LE(20, 26); // attributeSize
    b.writeUInt16LE(attrs.length, 28); // attributeCount
    b.writeUInt16LE(0, 30); // idIndex
    b.writeUInt16LE(0, 32); // classIndex
    b.writeUInt16LE(0, 34); // styleIndex

    for (let i = 0; i < attrs.length; i++) {
      const a = attrs[i]!;
      const off = 36 + i * 20;
      b.writeUInt32LE(a.ns, off);
      b.writeUInt32LE(a.name, off + 4);
      b.writeUInt32LE(a.rawValue, off + 8);
      b.writeUInt16LE(8, off + 12); // Res_value.size = 8
      b.writeUInt8(0, off + 14); // Res_value.res0 = 0
      b.writeUInt8(a.dataType, off + 15); // Res_value.dataType
      b.writeUInt32LE(a.data >>> 0, off + 16); // Res_value.data
    }
    return b;
  }

  function makeEndElement(line: number, tagName: string): Buffer {
    const b = Buffer.alloc(24);
    b.writeUInt16LE(0x0103, 0); // RES_XML_END_ELEMENT_TYPE
    b.writeUInt16LE(16, 2);
    b.writeUInt32LE(24, 4);
    b.writeUInt32LE(line, 8);
    b.writeUInt32LE(NO_INDEX, 12);
    b.writeUInt32LE(NO_INDEX, 16);
    b.writeUInt32LE(idx(tagName), 20);
    return b;
  }

  const xmlNodes = [
    makeStartNamespace(2, idx("android"), NS_ANDROID),
    makeStartElement(2, "manifest", [
      attrInt(NS_ANDROID, "versionCode", versionCode),
      attrString(NS_ANDROID, "versionName", versionName),
      attrString(NO_INDEX, "package", packageName),
    ]),
    makeStartElement(6, "uses-sdk", [
      attrInt(NS_ANDROID, "minSdkVersion", 24),
      attrInt(NS_ANDROID, "targetSdkVersion", 34),
    ]),
    makeEndElement(6, "uses-sdk"),
    makeStartElement(9, "uses-permission", [
      attrString(NS_ANDROID, "name", "android.permission.INTERNET"),
    ]),
    makeEndElement(9, "uses-permission"),
    makeStartElement(11, "application", [
      attrString(NS_ANDROID, "label", "MARRY BASE"),
      attrRef(NS_ANDROID, "icon", 0x7f010000), // @mipmap/ic_launcher
      attrBool(NS_ANDROID, "allowBackup", true),
      attrBool(NS_ANDROID, "usesCleartextTraffic", true),
    ]),
    makeStartElement(16, "activity", [
      attrString(NS_ANDROID, "label", "MARRY BASE"),
      attrString(NS_ANDROID, "name", `${packageName}.MainActivity`),
      attrBool(NS_ANDROID, "exported", true),
    ]),
    makeStartElement(20, "intent-filter", []),
    makeStartElement(21, "action", [
      attrString(NS_ANDROID, "name", "android.intent.action.MAIN"),
    ]),
    makeEndElement(21, "action"),
    makeStartElement(22, "category", [
      attrString(NS_ANDROID, "name", "android.intent.category.LAUNCHER"),
    ]),
    makeEndElement(22, "category"),
    makeEndElement(23, "intent-filter"),
    makeEndElement(24, "activity"),
    makeEndElement(25, "application"),
    makeEndElement(26, "manifest"),
    makeEndNamespace(26, idx("android"), NS_ANDROID),
  ];

  const body = Buffer.concat([stringPoolChunk, resMapChunk, ...xmlNodes]);
  const header = Buffer.alloc(8);
  header.writeUInt16LE(0x0003, 0); // RES_XML_TYPE
  header.writeUInt16LE(8, 2);
  header.writeUInt32LE(8 + body.length, 4);

  return Buffer.concat([header, body]);
}

/**
 * Compiles a valid Android Resource Table (resources.arsc / RES_TABLE_TYPE = 0x0002)
 * mapping:
 *  - 0x7f010000 (@mipmap/ic_launcher) -> "res/mipmap-xhdpi/ic_launcher.png"
 *  - 0x7f020000 (@string/app_name)    -> "MARRY BASE"
 */
export function buildResourcesArsc(packageName: string): Buffer {
  const globalStrings = buildResStringPoolUtf16([
    "res/mipmap-mdpi/ic_launcher.png",
    "res/mipmap-hdpi/ic_launcher.png",
    "res/mipmap-xhdpi/ic_launcher.png",
    "res/mipmap-xxhdpi/ic_launcher.png",
    "res/mipmap-xxxhdpi/ic_launcher.png",
    "MARRY BASE",
  ]);

  const typeStrings = buildResStringPoolUtf16(["mipmap", "string"]);
  const keyStrings = buildResStringPoolUtf16(["ic_launcher", "app_name"]);

  function buildTypeSpecAndType(
    typeId: number,
    keyIndex: number,
    globalStringIdx: number
  ): Buffer {
    // ResTable_typeSpec (0x0202)
    const spec = Buffer.alloc(20);
    spec.writeUInt16LE(0x0202, 0);
    spec.writeUInt16LE(16, 2);
    spec.writeUInt32LE(20, 4);
    spec.writeUInt8(typeId, 8);
    spec.writeUInt32LE(1, 12); // entryCount = 1
    spec.writeUInt32LE(0, 16); // flags[0] = 0

    // ResTable_type (0x0201)
    // headerSize = 84 (20-byte base header + 64-byte ResTable_config)
    const typeHeaderSize = 84;
    const entriesStart = typeHeaderSize + 4; // 1 uint32 offset
    const entrySize = 16; // 8-byte ResTable_entry + 8-byte Res_value
    const typeTotalSize = entriesStart + entrySize;
    const typeChunk = Buffer.alloc(typeTotalSize);
    typeChunk.writeUInt16LE(0x0201, 0);
    typeChunk.writeUInt16LE(typeHeaderSize, 2);
    typeChunk.writeUInt32LE(typeTotalSize, 4);
    typeChunk.writeUInt8(typeId, 8);
    typeChunk.writeUInt32LE(1, 12); // entryCount = 1
    typeChunk.writeUInt32LE(entriesStart, 16);
    typeChunk.writeUInt32LE(64, 20); // ResTable_config.size = 64

    // Offset array (1 entry at offset 0)
    typeChunk.writeUInt32LE(0, typeHeaderSize);

    // ResTable_entry (8 bytes)
    typeChunk.writeUInt16LE(8, entriesStart); // size = 8
    typeChunk.writeUInt16LE(0, entriesStart + 2); // flags = 0
    typeChunk.writeUInt32LE(keyIndex, entriesStart + 4); // key index in keyStrings

    // Res_value (8 bytes)
    typeChunk.writeUInt16LE(8, entriesStart + 8); // size = 8
    typeChunk.writeUInt8(0, entriesStart + 10); // res0 = 0
    typeChunk.writeUInt8(0x03, entriesStart + 11); // TYPE_STRING
    typeChunk.writeUInt32LE(globalStringIdx, entriesStart + 12);

    return Buffer.concat([spec, typeChunk]);
  }

  const mipmapChunks = buildTypeSpecAndType(1, 0, 2); // @mipmap/ic_launcher -> res/mipmap-xhdpi/ic_launcher.png
  const stringChunks = buildTypeSpecAndType(2, 1, 5); // @string/app_name -> MARRY BASE

  // ResTable_package header = 288 bytes (0x0120)
  const pkgHeaderSize = 288;
  const pkgBody = Buffer.concat([
    typeStrings,
    keyStrings,
    mipmapChunks,
    stringChunks,
  ]);
  const pkgTotalSize = pkgHeaderSize + pkgBody.length;
  const pkgHeader = Buffer.alloc(pkgHeaderSize);
  pkgHeader.writeUInt16LE(0x0200, 0); // RES_TABLE_PACKAGE_TYPE
  pkgHeader.writeUInt16LE(pkgHeaderSize, 2);
  pkgHeader.writeUInt32LE(pkgTotalSize, 4);
  pkgHeader.writeUInt32LE(0x7f, 8); // user package ID 0x7f
  const pkgNameBuf = Buffer.from(packageName.slice(0, 127), "utf16le");
  pkgNameBuf.copy(pkgHeader, 12);
  pkgHeader.writeUInt32LE(pkgHeaderSize, 268); // typeStrings offset
  pkgHeader.writeUInt32LE(2, 272); // lastPublicType
  pkgHeader.writeUInt32LE(pkgHeaderSize + typeStrings.length, 276); // keyStrings offset
  pkgHeader.writeUInt32LE(2, 280); // lastPublicKey
  pkgHeader.writeUInt32LE(0, 284); // typeIdOffset

  const pkgChunk = Buffer.concat([pkgHeader, pkgBody]);
  const totalSize = 12 + globalStrings.length + pkgChunk.length;
  const tableHeader = Buffer.alloc(12);
  tableHeader.writeUInt16LE(0x0002, 0); // RES_TABLE_TYPE
  tableHeader.writeUInt16LE(12, 2);
  tableHeader.writeUInt32LE(totalSize, 4);
  tableHeader.writeUInt32LE(1, 8); // packageCount = 1

  return Buffer.concat([tableHeader, globalStrings, pkgChunk]);
}

function encodeUleb128(value: number): Buffer {
  const bytes: number[] = [];
  let v = value >>> 0;
  do {
    let byte = v & 0x7f;
    v >>>= 7;
    if (v !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (v !== 0);
  return Buffer.from(bytes);
}

/**
 * Compiles a complete, executable Dalvik Bytecode (classes.dex, format 035) file
 * defining `com.marrybase.platform.MainActivity extends android.app.Activity` with:
 *   - `public <init>()V` (calls `super.<init>()`)
 *   - `protected onCreate(Landroid/os/Bundle;)V` (calls `super.onCreate(Bundle)`,
 *     instantiates `android.webkit.WebView`, calls `loadUrl("file:///android_asset/www/index.html")`,
 *     and calls `setContentView(WebView)`).
 */
export function buildClassesDex(packageName: string): Buffer {
  const pkgPath = packageName.replace(/\./g, "/");
  const activityDescriptor = `L${pkgPath}/MainActivity;`;

  // DEX requires string_ids to be strictly sorted lexicographically!
  const rawStrings = [
    "<init>",
    "L",
    "Landroid/app/Activity;",
    "Landroid/content/Context;",
    "Landroid/os/Bundle;",
    "Landroid/view/View;",
    "Landroid/webkit/WebView;",
    activityDescriptor,
    "Ljava/lang/String;",
    "MainActivity.java",
    "V",
    "VL",
    "file:///android_asset/www/index.html",
    "loadUrl",
    "onCreate",
    "setContentView",
  ].sort();

  const strIdx = (s: string): number => {
    const i = rawStrings.indexOf(s);
    if (i === -1) throw new Error(`DEX string not found: ${s}`);
    return i;
  };

  // Type descriptors sorted by their string_id index
  const typeDescriptors = [
    "Landroid/app/Activity;",
    "Landroid/content/Context;",
    "Landroid/os/Bundle;",
    "Landroid/view/View;",
    "Landroid/webkit/WebView;",
    activityDescriptor,
    "Ljava/lang/String;",
    "V",
  ].sort((a, b) => strIdx(a) - strIdx(b));

  const typeIdx = (t: string): number => {
    const i = typeDescriptors.indexOf(t);
    if (i === -1) throw new Error(`DEX type not found: ${t}`);
    return i;
  };

  // Prototypes:
  // 0: ()V
  // 1: (Landroid/content/Context;)V
  // 2: (Landroid/os/Bundle;)V
  // 3: (Landroid/view/View;)V
  // 4: (Ljava/lang/String;)V
  const protos = [
    { shorty: "V", returnType: "V", params: [] as string[] },
    {
      shorty: "VL",
      returnType: "V",
      params: ["Landroid/content/Context;"],
    },
    { shorty: "VL", returnType: "V", params: ["Landroid/os/Bundle;"] },
    { shorty: "VL", returnType: "V", params: ["Landroid/view/View;"] },
    { shorty: "VL", returnType: "V", params: ["Ljava/lang/String;"] },
  ];

  // Methods sorted by (class_idx, name_idx, proto_idx)
  const rawMethods = [
    {
      cls: "Landroid/app/Activity;",
      name: "<init>",
      protoIdx: 0,
    },
    {
      cls: "Landroid/app/Activity;",
      name: "onCreate",
      protoIdx: 2,
    },
    {
      cls: "Landroid/app/Activity;",
      name: "setContentView",
      protoIdx: 3,
    },
    {
      cls: "Landroid/webkit/WebView;",
      name: "<init>",
      protoIdx: 1,
    },
    {
      cls: "Landroid/webkit/WebView;",
      name: "loadUrl",
      protoIdx: 4,
    },
    {
      cls: activityDescriptor,
      name: "<init>",
      protoIdx: 0,
    },
    {
      cls: activityDescriptor,
      name: "onCreate",
      protoIdx: 2,
    },
  ].sort((a, b) => {
    const cDiff = typeIdx(a.cls) - typeIdx(b.cls);
    if (cDiff !== 0) return cDiff;
    const nDiff = strIdx(a.name) - strIdx(b.name);
    if (nDiff !== 0) return nDiff;
    return a.protoIdx - b.protoIdx;
  });

  const methodIdx = (cls: string, name: string, protoIndex: number): number => {
    const i = rawMethods.findIndex(
      (m) => m.cls === cls && m.name === name && m.protoIdx === protoIndex
    );
    if (i === -1) throw new Error(`DEX method not found: ${cls}->${name}`);
    return i;
  };

  // Layout offsets (all 4-byte aligned):
  // 0x0000: header_item (112 bytes = 0x70)
  // 0x0070: string_id_item (16 * 4 = 64 bytes = 0x40)
  // 0x00b0: type_id_item (8 * 4 = 32 bytes = 0x20)
  // 0x00d0: proto_id_item (5 * 12 = 60 bytes = 0x3c)
  // 0x010c: method_id_item (7 * 8 = 56 bytes = 0x38)
  // 0x0144: class_def_item (1 * 32 = 32 bytes = 0x20)
  // 0x0164: type_list section (4 type_lists * 8 bytes = 32 bytes = 0x20)
  // 0x0184: code_item #1 (<init>) + code_item #2 (onCreate)
  const headerOff = 0;
  const stringIdsOff = 0x70;
  const typeIdsOff = stringIdsOff + rawStrings.length * 4; // 0xb0
  const protoIdsOff = typeIdsOff + typeDescriptors.length * 4; // 0xd0
  const methodIdsOff = protoIdsOff + protos.length * 12; // 0x10c
  const classDefsOff = methodIdsOff + rawMethods.length * 8; // 0x144
  const dataOff = classDefsOff + 32; // 0x164

  // Build type_list items for protos 1..4 (each has 1 parameter: 4-byte size=1 + 2-byte typeIdx + 2-byte pad = 8 bytes)
  const typeListsOff = dataOff;
  const typeListsBuf = Buffer.alloc(4 * 8);
  for (let i = 0; i < 4; i++) {
    const paramType = protos[i + 1]!.params[0]!;
    typeListsBuf.writeUInt32LE(1, i * 8);
    typeListsBuf.writeUInt16LE(typeIdx(paramType), i * 8 + 4);
    typeListsBuf.writeUInt16LE(0, i * 8 + 6);
  }

  // Build code_item #1: MainActivity.<init>()V
  // registers_size = 1 (p0 = v0), ins_size = 1, outs_size = 1, tries_size = 0
  // insns:
  //   70 10 <Activity.<init>> 00 00  (invoke-direct {v0}, Landroid/app/Activity;-><init>()V)
  //   0e 00                          (return-void)
  const code1Off = typeListsOff + typeListsBuf.length; // 0x184
  const actInitIdx = methodIdx("Landroid/app/Activity;", "<init>", 0);
  const code1Buf = Buffer.alloc(24);
  code1Buf.writeUInt16LE(1, 0); // registers_size
  code1Buf.writeUInt16LE(1, 2); // ins_size
  code1Buf.writeUInt16LE(1, 4); // outs_size
  code1Buf.writeUInt16LE(0, 6); // tries_size
  code1Buf.writeUInt32LE(0, 8); // debug_info_off
  code1Buf.writeUInt32LE(4, 12); // insns_size (4 16-bit code units = 8 bytes)
  code1Buf.writeUInt16LE(0x1070, 16); // invoke-direct {v0}
  code1Buf.writeUInt16LE(actInitIdx, 18);
  code1Buf.writeUInt16LE(0x0000, 20); // v0
  code1Buf.writeUInt16LE(0x000e, 22); // return-void

  // Build code_item #2: MainActivity.onCreate(Landroid/os/Bundle;)V
  // registers_size = 4 (v0, v1, p0=v2, p1=v3), ins_size = 2, outs_size = 2, tries_size = 0
  // insns (13 code units = 26 bytes, padded to 28 bytes):
  //   6f 20 <Activity.onCreate> 32 00      (invoke-super {v2, v3}, Landroid/app/Activity;->onCreate(Landroid/os/Bundle;)V)
  //   22 00 <WebView typeIdx>              (new-instance v0, Landroid/webkit/WebView;)
  //   70 20 <WebView.<init>> 20 00         (invoke-direct {v0, v2}, Landroid/webkit/WebView;-><init>(Landroid/content/Context;)V)
  //   1a 01 <url strIdx>                   (const-string v1, "file:///android_asset/www/index.html")
  //   6e 20 <WebView.loadUrl> 10 00        (invoke-virtual {v0, v1}, Landroid/webkit/WebView;->loadUrl(Ljava/lang/String;)V)
  //   6e 20 <Activity.setContentView> 02 00 (invoke-virtual {v2, v0}, Landroid/app/Activity;->setContentView(Landroid/view/View;)V)
  //   0e 00                                (return-void)
  const code2Off = code1Off + code1Buf.length; // 0x19c
  const actOnCreateIdx = methodIdx("Landroid/app/Activity;", "onCreate", 2);
  const actSetContentIdx = methodIdx(
    "Landroid/app/Activity;",
    "setContentView",
    3
  );
  const wvTypeIdx = typeIdx("Landroid/webkit/WebView;");
  const wvInitIdx = methodIdx("Landroid/webkit/WebView;", "<init>", 1);
  const wvLoadUrlIdx = methodIdx("Landroid/webkit/WebView;", "loadUrl", 4);
  const urlStrIdx = strIdx("file:///android_asset/www/index.html");

  // 16-byte code_item header + 17 16-bit code units (34 bytes) + 2-byte pad = 52 bytes
  const code2Fixed = Buffer.alloc(52);
  code2Fixed.writeUInt16LE(4, 0); // registers_size = 4
  code2Fixed.writeUInt16LE(2, 2); // ins_size = 2 (this=v2, bundle=v3)
  code2Fixed.writeUInt16LE(2, 4); // outs_size = 2
  code2Fixed.writeUInt16LE(0, 6); // tries_size = 0
  code2Fixed.writeUInt32LE(0, 8); // debug_info_off = 0
  code2Fixed.writeUInt32LE(17, 12); // 17 code units (34 bytes)
  code2Fixed.writeUInt16LE(0x206f, 16);
  code2Fixed.writeUInt16LE(actOnCreateIdx, 18);
  code2Fixed.writeUInt16LE(0x0032, 20);
  code2Fixed.writeUInt16LE(0x0022, 22);
  code2Fixed.writeUInt16LE(wvTypeIdx, 24);
  code2Fixed.writeUInt16LE(0x2070, 26);
  code2Fixed.writeUInt16LE(wvInitIdx, 28);
  code2Fixed.writeUInt16LE(0x0020, 30);
  code2Fixed.writeUInt16LE(0x011a, 32);
  code2Fixed.writeUInt16LE(urlStrIdx, 34);
  code2Fixed.writeUInt16LE(0x206e, 36);
  code2Fixed.writeUInt16LE(wvLoadUrlIdx, 38);
  code2Fixed.writeUInt16LE(0x0010, 40);
  code2Fixed.writeUInt16LE(0x206e, 42);
  code2Fixed.writeUInt16LE(actSetContentIdx, 44);
  code2Fixed.writeUInt16LE(0x0002, 46);
  code2Fixed.writeUInt16LE(0x000e, 48);

  // Build string_data_item section
  const stringDataStartOff = code2Off + code2Fixed.length;
  const stringDataOffsets: number[] = [];
  const stringDataChunks: Buffer[] = [];
  let curStrOff = stringDataStartOff;
  for (const s of rawStrings) {
    stringDataOffsets.push(curStrOff);
    const utf8 = Buffer.from(s, "utf8");
    const lenPrefix = encodeUleb128(s.length);
    const chunk = Buffer.concat([lenPrefix, utf8, Buffer.from([0x00])]);
    stringDataChunks.push(chunk);
    curStrOff += chunk.length;
  }
  const stringDataRaw = Buffer.concat(stringDataChunks);

  // Build class_data_item for MainActivity
  const classDataOff = stringDataStartOff + stringDataRaw.length;
  const mainInitIdx = methodIdx(activityDescriptor, "<init>", 0);
  const mainOnCreateIdx = methodIdx(activityDescriptor, "onCreate", 2);
  const classDataRaw = Buffer.concat([
    encodeUleb128(0), // static_fields_size = 0
    encodeUleb128(0), // instance_fields_size = 0
    encodeUleb128(1), // direct_methods_size = 1 (<init>)
    encodeUleb128(1), // virtual_methods_size = 1 (onCreate)
    // direct_method[0]: <init>
    encodeUleb128(mainInitIdx),
    encodeUleb128(0x10001), // ACC_PUBLIC | ACC_CONSTRUCTOR
    encodeUleb128(code1Off),
    // virtual_method[0]: onCreate
    encodeUleb128(mainOnCreateIdx),
    encodeUleb128(0x0004), // ACC_PROTECTED
    encodeUleb128(code2Off),
  ]);

  const preMapEnd = classDataOff + classDataRaw.length;
  const preMapPad = (4 - (preMapEnd % 4)) % 4;
  const mapOff = preMapEnd + preMapPad;

  // Build map_list (11 items: 4-byte size + 11 * 12 = 136 bytes)
  const mapItems = [
    { type: 0x0000, size: 1, offset: headerOff }, // TYPE_HEADER_ITEM
    { type: 0x0001, size: rawStrings.length, offset: stringIdsOff }, // TYPE_STRING_ID_ITEM
    { type: 0x0002, size: typeDescriptors.length, offset: typeIdsOff }, // TYPE_TYPE_ID_ITEM
    { type: 0x0003, size: protos.length, offset: protoIdsOff }, // TYPE_PROTO_ID_ITEM
    { type: 0x0005, size: rawMethods.length, offset: methodIdsOff }, // TYPE_METHOD_ID_ITEM
    { type: 0x0006, size: 1, offset: classDefsOff }, // TYPE_CLASS_DEF_ITEM
    { type: 0x1001, size: 4, offset: typeListsOff }, // TYPE_TYPE_LIST
    { type: 0x2001, size: 2, offset: code1Off }, // TYPE_CODE_ITEM
    { type: 0x2002, size: rawStrings.length, offset: stringDataStartOff }, // TYPE_STRING_DATA_ITEM
    { type: 0x2000, size: 1, offset: classDataOff }, // TYPE_CLASS_DATA_ITEM
    { type: 0x1000, size: 1, offset: mapOff }, // TYPE_MAP_LIST
  ];
  const mapBuf = Buffer.alloc(4 + mapItems.length * 12);
  mapBuf.writeUInt32LE(mapItems.length, 0);
  for (let i = 0; i < mapItems.length; i++) {
    const m = mapItems[i]!;
    const off = 4 + i * 12;
    mapBuf.writeUInt16LE(m.type, off);
    mapBuf.writeUInt16LE(0, off + 2);
    mapBuf.writeUInt32LE(m.size, off + 4);
    mapBuf.writeUInt32LE(m.offset, off + 8);
  }

  const fileSize = mapOff + mapBuf.length;
  const dex = Buffer.alloc(fileSize);

  // 1. Write string_id_items
  for (let i = 0; i < stringDataOffsets.length; i++) {
    dex.writeUInt32LE(stringDataOffsets[i]!, stringIdsOff + i * 4);
  }

  // 2. Write type_id_items
  for (let i = 0; i < typeDescriptors.length; i++) {
    dex.writeUInt32LE(strIdx(typeDescriptors[i]!), typeIdsOff + i * 4);
  }

  // 3. Write proto_id_items
  for (let i = 0; i < protos.length; i++) {
    const p = protos[i]!;
    const off = protoIdsOff + i * 12;
    dex.writeUInt32LE(strIdx(p.shorty), off);
    dex.writeUInt32LE(typeIdx(p.returnType), off + 4);
    dex.writeUInt32LE(
      p.params.length > 0 ? typeListsOff + (i - 1) * 8 : 0,
      off + 8
    );
  }

  // 4. Write method_id_items
  for (let i = 0; i < rawMethods.length; i++) {
    const m = rawMethods[i]!;
    const off = methodIdsOff + i * 8;
    dex.writeUInt16LE(typeIdx(m.cls), off);
    dex.writeUInt16LE(m.protoIdx, off + 2);
    dex.writeUInt32LE(strIdx(m.name), off + 4);
  }

  // 5. Write class_def_item
  dex.writeUInt32LE(typeIdx(activityDescriptor), classDefsOff); // class_idx
  dex.writeUInt32LE(0x0001, classDefsOff + 4); // ACC_PUBLIC
  dex.writeUInt32LE(typeIdx("Landroid/app/Activity;"), classDefsOff + 8); // superclass_idx
  dex.writeUInt32LE(0, classDefsOff + 12); // interfaces_off
  dex.writeUInt32LE(strIdx("MainActivity.java"), classDefsOff + 16); // source_file_idx
  dex.writeUInt32LE(0, classDefsOff + 20); // annotations_off
  dex.writeUInt32LE(classDataOff, classDefsOff + 24); // class_data_off
  dex.writeUInt32LE(0, classDefsOff + 28); // static_values_off

  // 6. Copy data section items
  typeListsBuf.copy(dex, typeListsOff);
  code1Buf.copy(dex, code1Off);
  code2Fixed.copy(dex, code2Off);
  stringDataRaw.copy(dex, stringDataStartOff);
  classDataRaw.copy(dex, classDataOff);
  mapBuf.copy(dex, mapOff);

  // 7. Write header_item
  Buffer.from("dex\n035\0", "ascii").copy(dex, 0);
  dex.writeUInt32LE(fileSize, 32);
  dex.writeUInt32LE(0x70, 36); // header_size
  dex.writeUInt32LE(0x12345678, 40); // endian_tag
  dex.writeUInt32LE(0, 44); // link_size
  dex.writeUInt32LE(0, 48); // link_off
  dex.writeUInt32LE(mapOff, 52); // map_off
  dex.writeUInt32LE(rawStrings.length, 56); // string_ids_size
  dex.writeUInt32LE(stringIdsOff, 60); // string_ids_off
  dex.writeUInt32LE(typeDescriptors.length, 64); // type_ids_size
  dex.writeUInt32LE(typeIdsOff, 68); // type_ids_off
  dex.writeUInt32LE(protos.length, 72); // proto_ids_size
  dex.writeUInt32LE(protoIdsOff, 76); // proto_ids_off
  dex.writeUInt32LE(0, 80); // field_ids_size
  dex.writeUInt32LE(0, 84); // field_ids_off
  dex.writeUInt32LE(rawMethods.length, 88); // method_ids_size
  dex.writeUInt32LE(methodIdsOff, 92); // method_ids_off
  dex.writeUInt32LE(1, 96); // class_defs_size
  dex.writeUInt32LE(classDefsOff, 100); // class_defs_off
  dex.writeUInt32LE(fileSize - dataOff, 104); // data_size
  dex.writeUInt32LE(dataOff, 108); // data_off

  // 8. Compute SHA-1 signature (bytes 32..end) and Adler-32 checksum (bytes 12..end)
  const sha1 = createHash("sha1").update(dex.subarray(32)).digest();
  sha1.copy(dex, 12);
  const checksum = adler32(dex, 12);
  dex.writeUInt32LE(checksum, 8);

  return dex;
}

// ASN.1 DER encoding helpers for X.509 & PKCS#7 CMS SignedData
function derLen(len: number): Buffer {
  if (len < 128) return Buffer.from([len]);
  const hex = len.toString(16).padStart(len > 255 ? 4 : 2, "0");
  const bytes = Buffer.from(hex, "hex");
  return Buffer.concat([Buffer.from([0x80 | bytes.length]), bytes]);
}

function derTag(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLen(content.length), content]);
}

function derSeq(...items: Buffer[]): Buffer {
  return derTag(0x30, Buffer.concat(items));
}

function derSet(...items: Buffer[]): Buffer {
  return derTag(0x31, Buffer.concat(items));
}

function derOid(oidHex: string): Buffer {
  return derTag(0x06, Buffer.from(oidHex, "hex"));
}

function derInt(numOrBuf: number | Buffer): Buffer {
  if (typeof numOrBuf === "number") {
    return derTag(0x02, Buffer.from([numOrBuf]));
  }
  const b =
    numOrBuf[0]! >= 0x80
      ? Buffer.concat([Buffer.from([0x00]), numOrBuf])
      : numOrBuf;
  return derTag(0x02, b);
}

function derUtf8(str: string): Buffer {
  return derTag(0x0c, Buffer.from(str, "utf8"));
}

function derUtcTime(yyMMddHHmmssZ: string): Buffer {
  return derTag(0x17, Buffer.from(yyMMddHHmmssZ, "ascii"));
}

/**
 * Generates an APK v1 JAR signature (MANIFEST.MF, MARRYBAS.SF, and ASN.1 DER PKCS#7 CMS MARRYBAS.RSA
 * containing a valid X.509v3 certificate and RSA-SHA256 SignerInfo).
 */
function buildApkSignatureFiles(
  entries: Array<{ name: string; data: Buffer }>
): {
  manifestMf: Buffer;
  signatureSf: Buffer;
  signatureRsa: Buffer;
} {
  const mfLines: string[] = [
    "Manifest-Version: 1.0",
    "Created-By: 1.0 (MARRY BASE Android Packager)",
    "",
  ];

  for (const entry of entries) {
    const digest = createHash("sha256").update(entry.data).digest("base64");
    mfLines.push(`Name: ${entry.name}`);
    mfLines.push(`SHA-256-Digest: ${digest}`);
    mfLines.push("");
  }

  const manifestMf = Buffer.from(mfLines.join("\r\n"), "utf8");
  const fullMfDigest = createHash("sha256").update(manifestMf).digest("base64");

  const sfLines: string[] = [
    "Signature-Version: 1.0",
    "Created-By: 1.0 (MARRY BASE Android Signer)",
    `SHA-256-Digest-Manifest: ${fullMfDigest}`,
    "",
  ];
  for (const entry of entries) {
    const sectionText = `Name: ${entry.name}\r\nSHA-256-Digest: ${createHash("sha256").update(entry.data).digest("base64")}\r\n\r\n`;
    const sectionDigest = createHash("sha256")
      .update(Buffer.from(sectionText, "utf8"))
      .digest("base64");
    sfLines.push(`Name: ${entry.name}`);
    sfLines.push(`SHA-256-Digest: ${sectionDigest}`);
    sfLines.push("");
  }
  const signatureSf = Buffer.from(sfLines.join("\r\n"), "utf8");

  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const spkiDer = publicKey.export({ type: "spki", format: "der" }) as Buffer;

  // Build X.509 TBSCertificate
  // OID sha256WithRSAEncryption = 1.2.840.113549.1.1.11 -> 2a864886f70d01010b
  const sigAlgId = derSeq(
    derOid("2a864886f70d01010b"),
    Buffer.from([0x05, 0x00])
  );
  // Issuer / Subject: CN=MARRY BASE Platform (OID 2.5.4.3 -> 550403)
  const rdnCn = derSet(derSeq(derOid("550403"), derUtf8("MARRY BASE Platform")));
  const nameSeq = derSeq(rdnCn);
  const validity = derSeq(
    derUtcTime("250101000000Z"),
    derUtcTime("491231235959Z")
  );
  const serialNum = derInt(Buffer.from("0102030405060708", "hex"));
  const versionV3 = derTag(0xa0, derInt(2));

  const tbsCert = derSeq(
    versionV3,
    serialNum,
    sigAlgId,
    nameSeq,
    validity,
    nameSeq,
    spkiDer
  );

  const certSign = createSign("RSA-SHA256");
  certSign.update(tbsCert);
  certSign.end();
  const certSigBytes = certSign.sign(privateKey);
  const certBitString = derTag(
    0x03,
    Buffer.concat([Buffer.from([0x00]), certSigBytes])
  );
  const x509CertDer = derSeq(tbsCert, sigAlgId, certBitString);

  // Sign signatureSf for PKCS#7 SignerInfo
  const sfSign = createSign("RSA-SHA256");
  sfSign.update(signatureSf);
  sfSign.end();
  const sfSignatureBytes = sfSign.sign(privateKey);

  // OID sha256 = 2.16.840.1.101.3.4.2.1 -> 608648016503040201
  const digestAlgSha256 = derSeq(
    derOid("608648016503040201"),
    Buffer.from([0x05, 0x00])
  );
  // OID rsaEncryption = 1.2.840.113549.1.1.1 -> 2a864886f70d010101
  const digestEncAlgRsa = derSeq(
    derOid("2a864886f70d010101"),
    Buffer.from([0x05, 0x00])
  );

  // SignerInfo ::= SEQUENCE { version 1, IssuerAndSerialNumber, digestAlgorithm, digestEncryptionAlgorithm, encryptedDigest }
  const signerInfo = derSeq(
    derInt(1),
    derSeq(nameSeq, serialNum),
    digestAlgSha256,
    digestEncAlgRsa,
    derTag(0x04, sfSignatureBytes)
  );

  // PKCS#7 SignedData (OID 1.2.840.113549.1.7.2 -> 2a864886f70d010702)
  // ContentInfo pkcs7-data (OID 1.2.840.113549.1.7.1 -> 2a864886f70d010701)
  const signedData = derSeq(
    derInt(1),
    derSet(digestAlgSha256),
    derSeq(derOid("2a864886f70d010701")),
    derTag(0xa0, x509CertDer),
    derSet(signerInfo)
  );

  const signatureRsa = derSeq(
    derOid("2a864886f70d010702"),
    derTag(0xa0, signedData)
  );

  return { manifestMf, signatureSf, signatureRsa };
}

/**
 * Builds a 4-byte zipaligned ZIP/APK archive:
 * - Uncompressed entries (`store: true`, e.g. `resources.arsc` and `res/mipmap-<density>/ic_launcher.png`)
 *   have their Local File Header extra field padded so their file data begins on a 4-byte aligned offset (`offset % 4 === 0`).
 * - Compressed entries (`store: false`) use DEFLATE (`method = 8`).
 */
function buildZipAlignedArchive(
  entries: Array<{ name: string; data: Buffer; store?: boolean }>
): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const uncompressedSize = entry.data.length;
    const crc = crc32(entry.data);
    const useStore = Boolean(entry.store);
    const compressedData = useStore
      ? entry.data
      : deflateRawSync(entry.data, { level: 6 });
    const compressionMethod = useStore ? 0 : 8;

    // Compute 4-byte alignment padding for uncompressed entries (zipalign 4)
    let extraLen = 0;
    if (useStore) {
      const dataStartWithoutExtra = offset + 30 + nameBuf.length;
      extraLen = (4 - (dataStartWithoutExtra % 4)) % 4;
    }
    const extraBuf = Buffer.alloc(extraLen, 0);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0); // PK\x03\x04
    localHeader.writeUInt16LE(20, 4); // version needed = 2.0
    localHeader.writeUInt16LE(0, 6); // general purpose bit flag
    localHeader.writeUInt16LE(compressionMethod, 8);
    localHeader.writeUInt16LE(0x0000, 10); // mod time
    localHeader.writeUInt16LE(0x554b, 12); // mod date
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressedData.length, 18);
    localHeader.writeUInt32LE(uncompressedSize, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(extraBuf.length, 28);

    const localRecord = Buffer.concat([
      localHeader,
      nameBuf,
      extraBuf,
      compressedData,
    ]);
    localParts.push(localRecord);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0); // PK\x01\x02
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(compressionMethod, 10);
    centralHeader.writeUInt16LE(0x0000, 12);
    centralHeader.writeUInt16LE(0x554b, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressedData.length, 20);
    centralHeader.writeUInt32LE(uncompressedSize, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra field length in central dir
    centralHeader.writeUInt16LE(0, 32); // file comment length
    centralHeader.writeUInt16LE(0, 34); // disk number
    centralHeader.writeUInt16LE(0, 36); // internal attrs
    centralHeader.writeUInt32LE(0, 38); // external attrs
    centralHeader.writeUInt32LE(offset, 42); // relative offset of local header

    centralParts.push(Buffer.concat([centralHeader, nameBuf]));
    offset += localRecord.length;
  }

  const centralDir = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // PK\x05\x06
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDir, eocd]);
}

export async function buildMarryBaseApk(options?: {
  projectSlug?: string;
  serverUrl?: string;
  versionName?: string;
  versionCode?: number;
  actorId?: string | null;
}): Promise<BuiltApkInfo> {
  const packageName = options?.projectSlug
    ? `com.marrybase.app.${options.projectSlug.replace(/[^a-z0-9]/gi, "").toLowerCase()}`
    : "com.marrybase.platform";
  const versionName = options?.versionName || "1.0.0";
  const versionCode = options?.versionCode || 1;
  const serverUrl = options?.serverUrl || "http://10.0.2.2:4100";

  const logoPngPath = resolve(process.cwd(), "assets", "logo.png");
  const logoSvgPath = resolve(process.cwd(), "assets", "logo.svg");

  const [logoPng, logoSvg] = await Promise.all([
    readFile(logoPngPath),
    readFile(logoSvgPath),
  ]);

  // Read multi-density Android launcher icons (fallback to logoPng if a density file is missing)
  const readDensityIcon = async (density: string): Promise<Buffer> => {
    try {
      return await readFile(
        resolve(
          process.cwd(),
          "android",
          "app",
          "src",
          "main",
          "res",
          density,
          "ic_launcher.png"
        )
      );
    } catch {
      return logoPng;
    }
  };

  const [iconMdpi, iconHdpi, iconXhdpi, iconXxhdpi, iconXxxdpi] =
    await Promise.all([
      readDensityIcon("mipmap-mdpi"),
      readDensityIcon("mipmap-hdpi"),
      readDensityIcon("mipmap-xhdpi"),
      readDensityIcon("mipmap-xxhdpi"),
      readDensityIcon("mipmap-xxxhdpi"),
    ]);

  const manifestBin = buildAndroidBinaryManifest(
    packageName,
    versionName,
    versionCode
  );
  const classesDex = buildClassesDex(packageName);
  const resourcesArsc = buildResourcesArsc(packageName);

  const mobileConfigJson = Buffer.from(
    JSON.stringify(
      {
        platform: "MARRY BASE",
        packageName,
        versionName,
        versionCode,
        projectSlug: options?.projectSlug ?? null,
        serverUrl,
        sdkVersion: "1.0.0",
        builtAt: new Date().toISOString(),
      },
      null,
      2
    ),
    "utf8"
  );

  const mobileIndexHtml = Buffer.from(
    `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>MARRY BASE Mobile Studio</title>
</head>
<body style="background:#0b0f17;color:#f8fafc;font-family:sans-serif;text-align:center;padding:2rem;">
  <img src="../../res/drawable/logo.png" alt="MARRY BASE App Icon" style="width:96px;height:96px;border-radius:20px;" />
  <h1>MARRY BASE</h1>
  <p>Connected Mobile Client (${packageName} v${versionName})</p>
  <p>Endpoint: ${serverUrl}</p>
</body>
</html>`,
    "utf8"
  );

  const coreEntries: Array<{ name: string; data: Buffer; store?: boolean }> = [
    { name: "AndroidManifest.xml", data: manifestBin, store: false },
    { name: "classes.dex", data: classesDex, store: false },
    { name: "resources.arsc", data: resourcesArsc, store: true }, // Uncompressed & 4-byte aligned per Android R+ requirement
    { name: "res/mipmap-mdpi/ic_launcher.png", data: iconMdpi, store: true },
    { name: "res/mipmap-hdpi/ic_launcher.png", data: iconHdpi, store: true },
    { name: "res/mipmap-xhdpi/ic_launcher.png", data: iconXhdpi, store: true },
    { name: "res/mipmap-xxhdpi/ic_launcher.png", data: iconXxhdpi, store: true },
    {
      name: "res/mipmap-xxxhdpi/ic_launcher.png",
      data: iconXxxdpi,
      store: true,
    },
    { name: "res/drawable/logo.png", data: logoPng, store: true },
    { name: "res/drawable/logo.svg", data: logoSvg, store: false },
    {
      name: "assets/marry-base-config.json",
      data: mobileConfigJson,
      store: false,
    },
    { name: "assets/www/index.html", data: mobileIndexHtml, store: false },
  ];

  const { manifestMf, signatureSf, signatureRsa } =
    buildApkSignatureFiles(coreEntries);

  const allEntries: Array<{ name: string; data: Buffer; store?: boolean }> = [
    ...coreEntries,
    { name: "META-INF/MANIFEST.MF", data: manifestMf, store: false },
    { name: "META-INF/MARRYBAS.SF", data: signatureSf, store: false },
    { name: "META-INF/MARRYBAS.RSA", data: signatureRsa, store: false },
  ];

  const apkBuffer = buildZipAlignedArchive(allEntries);
  const checksumSha256 = createHash("sha256").update(apkBuffer).digest("hex");

  const fileName = options?.projectSlug
    ? `marry-base-${options.projectSlug}.apk`
    : "marry-base.apk";
  const filePath = resolve(process.cwd(), "releases", fileName);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, apkBuffer);

  // Also write default releases/marry-base.apk so it is always up-to-date
  const defaultApkPath = resolve(process.cwd(), "releases", "marry-base.apk");
  if (filePath !== defaultApkPath) {
    await writeFile(defaultApkPath, apkBuffer);
  }

  const builtAt = new Date().toISOString();

  try {
    await recordAuditEvent({
      projectId: null,
      actorType: options?.actorId ? "user" : "system",
      actorId: options?.actorId ?? null,
      action: "platform.apk.built",
      resourceType: "apk",
      resourceId: fileName,
      metadata: {
        platformName: "MARRY BASE",
        packageName,
        versionName,
        versionCode,
        sizeBytes: apkBuffer.length,
        checksumSha256,
      },
    });
  } catch {
    // Allow CLI APK builds even when DB is not active
  }

  return {
    platformName: "MARRY BASE",
    packageName,
    versionName,
    versionCode,
    projectSlug: options?.projectSlug ?? null,
    fileName,
    filePath,
    sizeBytes: apkBuffer.length,
    checksumSha256,
    entries: allEntries.map((e) => e.name),
    builtAt,
  };
}

export async function getOrBuildDefaultApk(): Promise<{
  info: BuiltApkInfo;
  buffer: Buffer;
}> {
  const defaultApkPath = resolve(process.cwd(), "releases", "marry-base.apk");
  try {
    await stat(defaultApkPath);
    const buffer = await readFile(defaultApkPath);
    const checksumSha256 = createHash("sha256").update(buffer).digest("hex");
    return {
      info: {
        platformName: "MARRY BASE",
        packageName: "com.marrybase.platform",
        versionName: "1.0.0",
        versionCode: 1,
        projectSlug: null,
        fileName: "marry-base.apk",
        filePath: defaultApkPath,
        sizeBytes: buffer.length,
        checksumSha256,
        entries: [
          "AndroidManifest.xml",
          "classes.dex",
          "resources.arsc",
          "res/mipmap-mdpi/ic_launcher.png",
          "res/mipmap-hdpi/ic_launcher.png",
          "res/mipmap-xhdpi/ic_launcher.png",
          "res/mipmap-xxhdpi/ic_launcher.png",
          "res/mipmap-xxxhdpi/ic_launcher.png",
          "res/drawable/logo.png",
          "res/drawable/logo.svg",
          "assets/marry-base-config.json",
          "assets/www/index.html",
          "META-INF/MANIFEST.MF",
          "META-INF/MARRYBAS.SF",
          "META-INF/MARRYBAS.RSA",
        ],
        builtAt: new Date().toISOString(),
      },
      buffer,
    };
  } catch {
    const info = await buildMarryBaseApk();
    const buffer = await readFile(info.filePath);
    return { info, buffer };
  }
}
