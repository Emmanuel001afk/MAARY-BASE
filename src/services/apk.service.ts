import {
  createHash,
  createSign,
  generateKeyPairSync,
} from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { deflateRawSync } from "node:zlib";
import { NotFoundError, ValidationError } from "../lib/errors.js";
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
    { name: "exported", id: 0x01010010 },
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
      attrBool(NS_ANDROID, "allowBackup", false),
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
 *   - `protected onCreate(Landroid/os/Bundle;)V` configures the local mobile hub,
 *     WebSettings, WebView/Chrome clients, system colors, and remote Studio navigation.
 *   - `public onBackPressed()V` traverses WebView history before leaving the activity.
 *   - A private WebView field retains the active navigation state.
 */
export function buildClassesDex(packageName: string): Buffer {
  const pkgPath = packageName.replace(/\./g, "/");
  const activityDescriptor = `L${pkgPath}/MainActivity;`;
  const activityType = "Landroid/app/Activity;";
  const webViewType = "Landroid/webkit/WebView;";
  const settingsType = "Landroid/webkit/WebSettings;";
  const webViewClientType = "Landroid/webkit/WebViewClient;";
  const webChromeClientType = "Landroid/webkit/WebChromeClient;";
  const windowType = "Landroid/view/Window;";
  const sourceFile = "MainActivity.java";
  const startUrl = "file:///android_asset/www/index.html";

  interface DexProto {
    shorty: string;
    returnType: string;
    params: string[];
    protoIdx?: number;
    parametersOff?: number;
  }
  interface DexMethod {
    cls: string;
    name: string;
    proto: DexProto;
    protoIdx?: number;
  }

  const shortyFor = (type: string): string =>
    type.startsWith("L") || type.startsWith("[") ? "L" : type;
  const makeProto = (returnType: string, params: string[] = []): DexProto => ({
    shorty: [returnType, ...params].map(shortyFor).join(""),
    returnType,
    params,
  });

  const pVoid = makeProto("V");
  const pContext = makeProto("V", ["Landroid/content/Context;"]);
  const pBundle = makeProto("V", ["Landroid/os/Bundle;"]);
  const pView = makeProto("V", ["Landroid/view/View;"]);
  const pString = makeProto("V", ["Ljava/lang/String;"]);
  const pBoolean = makeProto("V", ["Z"]);
  const pInt = makeProto("V", ["I"]);
  const pWebViewClient = makeProto("V", [webViewClientType]);
  const pWebChromeClient = makeProto("V", [webChromeClientType]);
  const pSettings = makeProto(settingsType);
  const pWindow = makeProto(windowType);
  const pBooleanResult = makeProto("Z");
  const protos = [
    pVoid,
    pContext,
    pBundle,
    pView,
    pString,
    pBoolean,
    pInt,
    pWebViewClient,
    pWebChromeClient,
    pSettings,
    pWindow,
    pBooleanResult,
  ];

  const rawMethods: DexMethod[] = [
    { cls: activityType, name: "<init>", proto: pVoid },
    { cls: activityType, name: "onCreate", proto: pBundle },
    { cls: activityType, name: "onBackPressed", proto: pVoid },
    { cls: activityType, name: "setContentView", proto: pView },
    { cls: activityType, name: "getWindow", proto: pWindow },
    { cls: webViewType, name: "<init>", proto: pContext },
    { cls: webViewType, name: "loadUrl", proto: pString },
    { cls: webViewType, name: "getSettings", proto: pSettings },
    { cls: webViewType, name: "setWebViewClient", proto: pWebViewClient },
    { cls: webViewType, name: "setWebChromeClient", proto: pWebChromeClient },
    { cls: webViewType, name: "setBackgroundColor", proto: pInt },
    { cls: webViewType, name: "canGoBack", proto: pBooleanResult },
    { cls: webViewType, name: "goBack", proto: pVoid },
    { cls: settingsType, name: "setJavaScriptEnabled", proto: pBoolean },
    { cls: settingsType, name: "setDomStorageEnabled", proto: pBoolean },
    { cls: settingsType, name: "setAllowFileAccess", proto: pBoolean },
    { cls: settingsType, name: "setAllowContentAccess", proto: pBoolean },
    { cls: settingsType, name: "setAllowFileAccessFromFileURLs", proto: pBoolean },
    { cls: settingsType, name: "setAllowUniversalAccessFromFileURLs", proto: pBoolean },
    { cls: settingsType, name: "setLoadWithOverviewMode", proto: pBoolean },
    { cls: settingsType, name: "setUseWideViewPort", proto: pBoolean },
    { cls: settingsType, name: "setMediaPlaybackRequiresUserGesture", proto: pBoolean },
    { cls: settingsType, name: "setBuiltInZoomControls", proto: pBoolean },
    { cls: settingsType, name: "setDisplayZoomControls", proto: pBoolean },
    { cls: webViewClientType, name: "<init>", proto: pVoid },
    { cls: webChromeClientType, name: "<init>", proto: pVoid },
    { cls: windowType, name: "setStatusBarColor", proto: pInt },
    { cls: windowType, name: "setNavigationBarColor", proto: pInt },
    { cls: activityDescriptor, name: "<init>", proto: pVoid },
    { cls: activityDescriptor, name: "onCreate", proto: pBundle },
    { cls: activityDescriptor, name: "onBackPressed", proto: pVoid },
  ];

  const typeDescriptors = Array.from(new Set([
    activityDescriptor,
    activityType,
    webViewType,
    settingsType,
    webViewClientType,
    webChromeClientType,
    windowType,
    "Landroid/content/Context;",
    "Landroid/os/Bundle;",
    "Landroid/view/View;",
    "Ljava/lang/String;",
    "V",
    "Z",
    "I",
  ]));
  const rawStrings = Array.from(new Set([
    ...typeDescriptors,
    ...protos.map((proto) => proto.shorty),
    ...rawMethods.map((method) => method.name),
    "webView",
    sourceFile,
    startUrl,
  ])).sort();
  const strIdx = (value: string): number => {
    const index = rawStrings.indexOf(value);
    if (index === -1) throw new Error(`DEX string not found: ${value}`);
    return index;
  };

  // DEX type_ids are ordered by string_id; proto_ids by return type and parameters.
  typeDescriptors.sort((a, b) => strIdx(a) - strIdx(b));
  const typeIdx = (value: string): number => {
    const index = typeDescriptors.indexOf(value);
    if (index === -1) throw new Error(`DEX type not found: ${value}`);
    return index;
  };
  protos.sort((a, b) => {
    const returnDiff = typeIdx(a.returnType) - typeIdx(b.returnType);
    if (returnDiff !== 0) return returnDiff;
    const lengthDiff = a.params.length - b.params.length;
    if (lengthDiff !== 0) return lengthDiff;
    for (let index = 0; index < a.params.length; index += 1) {
      const diff = typeIdx(a.params[index]!) - typeIdx(b.params[index]!);
      if (diff !== 0) return diff;
    }
    return 0;
  });
  protos.forEach((proto, index) => { proto.protoIdx = index; });
  rawMethods.forEach((method) => { method.protoIdx = method.proto.protoIdx; });
  rawMethods.sort((a, b) => {
    const classDiff = typeIdx(a.cls) - typeIdx(b.cls);
    if (classDiff !== 0) return classDiff;
    const nameDiff = strIdx(a.name) - strIdx(b.name);
    if (nameDiff !== 0) return nameDiff;
    return a.protoIdx! - b.protoIdx!;
  });
  const methodIdx = (cls: string, name: string, proto: DexProto): number => {
    const index = rawMethods.findIndex((method) =>
      method.cls === cls && method.name === name && method.proto === proto
    );
    if (index === -1) throw new Error(`DEX method not found: ${cls}->${name}`);
    return index;
  };

  // One private WebView field retains navigation state for the Android back button.
  const fieldName = "webView";
  const fieldIdx = 0;
  const headerOff = 0;
  const stringIdsOff = 0x70;
  const typeIdsOff = stringIdsOff + rawStrings.length * 4;
  const protoIdsOff = typeIdsOff + typeDescriptors.length * 4;
  const fieldIdsOff = protoIdsOff + protos.length * 12;
  const methodIdsOff = fieldIdsOff + 8;
  const classDefsOff = methodIdsOff + rawMethods.length * 8;
  const dataOff = classDefsOff + 32;

  const invoke = (opcode: number, methodIndex: number, registers: number[]): number[] => [
    opcode | (registers.length << 12) | ((registers[4] ?? 0) << 8),
    methodIndex,
    (registers[0] ?? 0) | ((registers[1] ?? 0) << 4) |
      ((registers[2] ?? 0) << 8) | ((registers[3] ?? 0) << 12),
  ];
  const invokeVirtual = (cls: string, name: string, proto: DexProto, registers: number[]): number[] =>
    invoke(0x6e, methodIdx(cls, name, proto), registers);
  const newInstance = (register: number, type: string): number[] => [0x22 | (register << 8), typeIdx(type)];
  const constString = (register: number, value: string): number[] => [0x1a | (register << 8), strIdx(value)];
  const const4 = (register: number, literal: number): number[] => [0x12 | (register << 8) | ((literal & 0xf) << 12)];
  const const32 = (register: number, literal: number): number[] => [
    0x14 | (register << 8), literal & 0xffff, (literal >>> 16) & 0xffff,
  ];
  const moveResult = (register: number, object = false): number[] => [(object ? 0x0c : 0x0a) | (register << 8)];
  const fieldAccess = (opcode: number, a: number, b: number): number[] => [
    opcode | (a << 8) | (b << 12), fieldIdx,
  ];
  const ifEqz = (register: number, offset: number): number[] => [0x38 | (register << 8), offset & 0xffff];
  const returnVoid = 0x000e;

  // <init>()V — invoke the android.app.Activity constructor.
  const initUnits = [
    ...invoke(0x70, methodIdx(activityType, "<init>", pVoid), [0]),
    returnVoid,
  ];

  // onCreate(Bundle) — configure a real local/remote WebView client.
  // v0=WebView, v1=WebSettings, v2=temporary object/Window, v3=color,
  // v4=p0(Activity), v5=p1(Bundle).
  const createUnits: number[] = [
    ...invoke(0x6f, methodIdx(activityType, "onCreate", pBundle), [4, 5]),
    ...newInstance(0, webViewType),
    ...invoke(0x70, methodIdx(webViewType, "<init>", pContext), [0, 4]),
    ...fieldAccess(0x5b, 0, 4), // iput-object v0, v4, webView
    ...invokeVirtual(webViewType, "getSettings", pSettings, [0]),
    ...moveResult(1, true),
    ...const4(2, 1),
  ];
  for (const setting of [
    "setJavaScriptEnabled",
    "setDomStorageEnabled",
    "setAllowFileAccess",
    "setAllowContentAccess",
    "setAllowFileAccessFromFileURLs",
    "setAllowUniversalAccessFromFileURLs",
    "setLoadWithOverviewMode",
    "setUseWideViewPort",
    "setMediaPlaybackRequiresUserGesture",
  ]) {
    createUnits.push(...invokeVirtual(settingsType, setting, pBoolean, [1, 2]));
  }
  createUnits.push(...const4(2, 0));
  for (const setting of ["setBuiltInZoomControls", "setDisplayZoomControls"]) {
    createUnits.push(...invokeVirtual(settingsType, setting, pBoolean, [1, 2]));
  }
  createUnits.push(
    ...newInstance(2, webViewClientType),
    ...invoke(0x70, methodIdx(webViewClientType, "<init>", pVoid), [2]),
    ...invokeVirtual(webViewType, "setWebViewClient", pWebViewClient, [0, 2]),
    ...newInstance(2, webChromeClientType),
    ...invoke(0x70, methodIdx(webChromeClientType, "<init>", pVoid), [2]),
    ...invokeVirtual(webViewType, "setWebChromeClient", pWebChromeClient, [0, 2]),
    ...const32(3, 0xff0b141b),
    ...invokeVirtual(webViewType, "setBackgroundColor", pInt, [0, 3]),
    ...constString(2, startUrl),
    ...invokeVirtual(webViewType, "loadUrl", pString, [0, 2]),
    ...invokeVirtual(activityType, "setContentView", pView, [4, 0]),
    ...invokeVirtual(activityType, "getWindow", pWindow, [4]),
    ...moveResult(2, true),
    ...invokeVirtual(windowType, "setStatusBarColor", pInt, [2, 3]),
    ...invokeVirtual(activityType, "getWindow", pWindow, [4]),
    ...moveResult(2, true),
    ...invokeVirtual(windowType, "setNavigationBarColor", pInt, [2, 3]),
    returnVoid,
  );

  // onBackPressed()V — navigate WebView history before falling back to Activity.
  const backUnits: number[] = [
    ...fieldAccess(0x54, 0, 2), // 0: iget-object v0, v2(p0), webView
    ...ifEqz(0, 12),           // 2: branch to super at instruction 14
    ...invokeVirtual(webViewType, "canGoBack", pBooleanResult, [0]), // 4
    ...moveResult(1),          // 7
    ...ifEqz(1, 6),            // 8: branch to super at instruction 14
    ...invokeVirtual(webViewType, "goBack", pVoid, [0]), // 10
    returnVoid,                // 13
    ...invoke(0x6f, methodIdx(activityType, "onBackPressed", pVoid), [2]), // 14
    returnVoid,                // 17
  ];

  const buildCodeItem = (registers: number, inputs: number, outputs: number, units: number[]): Buffer => {
    const buffer = Buffer.alloc(16 + (units.length + (units.length % 2)) * 2);
    buffer.writeUInt16LE(registers, 0);
    buffer.writeUInt16LE(inputs, 2);
    buffer.writeUInt16LE(outputs, 4);
    buffer.writeUInt16LE(0, 6);
    buffer.writeUInt32LE(0, 8);
    buffer.writeUInt32LE(units.length, 12);
    units.forEach((unit, index) => buffer.writeUInt16LE(unit & 0xffff, 16 + index * 2));
    return buffer;
  };
  const codeItems = [
    buildCodeItem(1, 1, 1, initUnits),
    buildCodeItem(6, 2, 2, createUnits),
    buildCodeItem(3, 1, 1, backUnits),
  ];

  // Data section: parameter type_lists, code_items, strings, class_data, map_list.
  const typeListsOff = dataOff;
  const typeListChunks: Buffer[] = [];
  let cursor = typeListsOff;
  for (const proto of protos) {
    if (proto.params.length === 0) continue;
    const size = 4 + proto.params.length * 2;
    const paddedSize = size + ((4 - (size % 4)) % 4);
    const buffer = Buffer.alloc(paddedSize);
    buffer.writeUInt32LE(proto.params.length, 0);
    proto.params.forEach((param, index) => buffer.writeUInt16LE(typeIdx(param), 4 + index * 2));
    proto.parametersOff = cursor;
    typeListChunks.push(buffer);
    cursor += buffer.length;
  }
  const typeListsRaw = Buffer.concat(typeListChunks);
  const codeOffsets: number[] = [];
  for (const code of codeItems) {
    codeOffsets.push(cursor);
    cursor += code.length;
  }

  const stringDataStartOff = cursor;
  const stringDataOffsets: number[] = [];
  const stringDataChunks: Buffer[] = [];
  for (const value of rawStrings) {
    stringDataOffsets.push(cursor);
    const chunk = Buffer.concat([
      encodeUleb128(value.length),
      Buffer.from(value, "utf8"),
      Buffer.from([0]),
    ]);
    stringDataChunks.push(chunk);
    cursor += chunk.length;
  }
  const stringDataRaw = Buffer.concat(stringDataChunks);
  const classDataOff = cursor;
  const directMethods = [
    { index: methodIdx(activityDescriptor, "<init>", pVoid), access: 0x10001, codeOff: codeOffsets[0]! },
  ];
  const virtualMethods = [
    { index: methodIdx(activityDescriptor, "onCreate", pBundle), access: 0x0004, codeOff: codeOffsets[1]! },
    { index: methodIdx(activityDescriptor, "onBackPressed", pVoid), access: 0x0001, codeOff: codeOffsets[2]! },
  ].sort((a, b) => a.index - b.index);
  const encodedMethods = (methods: Array<{ index: number; access: number; codeOff: number }>): Buffer[] => {
    const chunks: Buffer[] = [];
    let previous = 0;
    for (const method of methods) {
      chunks.push(
        encodeUleb128(method.index - previous),
        encodeUleb128(method.access),
        encodeUleb128(method.codeOff),
      );
      previous = method.index;
    }
    return chunks;
  };
  const classDataRaw = Buffer.concat([
    encodeUleb128(0),
    encodeUleb128(1),
    encodeUleb128(directMethods.length),
    encodeUleb128(virtualMethods.length),
    encodeUleb128(fieldIdx),
    encodeUleb128(0x0002), // ACC_PRIVATE
    ...encodedMethods(directMethods),
    ...encodedMethods(virtualMethods),
  ]);
  cursor += classDataRaw.length;
  const mapOff = cursor + ((4 - (cursor % 4)) % 4);

  const mapItems = [
    { type: 0x0000, size: 1, offset: headerOff },
    { type: 0x0001, size: rawStrings.length, offset: stringIdsOff },
    { type: 0x0002, size: typeDescriptors.length, offset: typeIdsOff },
    { type: 0x0003, size: protos.length, offset: protoIdsOff },
    { type: 0x0004, size: 1, offset: fieldIdsOff },
    { type: 0x0005, size: rawMethods.length, offset: methodIdsOff },
    { type: 0x0006, size: 1, offset: classDefsOff },
    { type: 0x1001, size: typeListChunks.length, offset: typeListsOff },
    { type: 0x2001, size: codeItems.length, offset: codeOffsets[0]! },
    { type: 0x2002, size: rawStrings.length, offset: stringDataStartOff },
    { type: 0x2000, size: 1, offset: classDataOff },
    { type: 0x1000, size: 1, offset: mapOff },
  ];
  const mapBuf = Buffer.alloc(4 + mapItems.length * 12);
  mapBuf.writeUInt32LE(mapItems.length, 0);
  mapItems.forEach((item, index) => {
    const offset = 4 + index * 12;
    mapBuf.writeUInt16LE(item.type, offset);
    mapBuf.writeUInt32LE(item.size, offset + 4);
    mapBuf.writeUInt32LE(item.offset, offset + 8);
  });

  const fileSize = mapOff + mapBuf.length;
  const dex = Buffer.alloc(fileSize);
  stringDataOffsets.forEach((offset, index) => dex.writeUInt32LE(offset, stringIdsOff + index * 4));
  typeDescriptors.forEach((type, index) => dex.writeUInt32LE(strIdx(type), typeIdsOff + index * 4));
  protos.forEach((proto, index) => {
    const offset = protoIdsOff + index * 12;
    dex.writeUInt32LE(strIdx(proto.shorty), offset);
    dex.writeUInt32LE(typeIdx(proto.returnType), offset + 4);
    dex.writeUInt32LE(proto.parametersOff ?? 0, offset + 8);
  });
  // field_id_item: class_idx, type_idx, name_idx.
  dex.writeUInt16LE(typeIdx(activityDescriptor), fieldIdsOff);
  dex.writeUInt16LE(typeIdx(webViewType), fieldIdsOff + 2);
  dex.writeUInt32LE(strIdx(fieldName), fieldIdsOff + 4);
  rawMethods.forEach((method, index) => {
    const offset = methodIdsOff + index * 8;
    dex.writeUInt16LE(typeIdx(method.cls), offset);
    dex.writeUInt16LE(method.protoIdx!, offset + 2);
    dex.writeUInt32LE(strIdx(method.name), offset + 4);
  });
  dex.writeUInt32LE(typeIdx(activityDescriptor), classDefsOff);
  dex.writeUInt32LE(0x0001, classDefsOff + 4);
  dex.writeUInt32LE(typeIdx(activityType), classDefsOff + 8);
  dex.writeUInt32LE(0, classDefsOff + 12);
  dex.writeUInt32LE(strIdx(sourceFile), classDefsOff + 16);
  dex.writeUInt32LE(0, classDefsOff + 20);
  dex.writeUInt32LE(classDataOff, classDefsOff + 24);
  dex.writeUInt32LE(0, classDefsOff + 28);
  typeListsRaw.copy(dex, typeListsOff);
  codeItems.forEach((code, index) => code.copy(dex, codeOffsets[index]!));
  stringDataRaw.copy(dex, stringDataStartOff);
  classDataRaw.copy(dex, classDataOff);
  mapBuf.copy(dex, mapOff);

  Buffer.from("dex\n035\0", "ascii").copy(dex, 0);
  dex.writeUInt32LE(fileSize, 32);
  dex.writeUInt32LE(0x70, 36);
  dex.writeUInt32LE(0x12345678, 40);
  dex.writeUInt32LE(mapOff, 52);
  dex.writeUInt32LE(rawStrings.length, 56);
  dex.writeUInt32LE(stringIdsOff, 60);
  dex.writeUInt32LE(typeDescriptors.length, 64);
  dex.writeUInt32LE(typeIdsOff, 68);
  dex.writeUInt32LE(protos.length, 72);
  dex.writeUInt32LE(protoIdsOff, 76);
  dex.writeUInt32LE(1, 80);
  dex.writeUInt32LE(fieldIdsOff, 84);
  dex.writeUInt32LE(rawMethods.length, 88);
  dex.writeUInt32LE(methodIdsOff, 92);
  dex.writeUInt32LE(1, 96);
  dex.writeUInt32LE(classDefsOff, 100);
  dex.writeUInt32LE(fileSize - dataOff, 104);
  dex.writeUInt32LE(dataOff, 108);

  createHash("sha1").update(dex.subarray(32)).digest().copy(dex, 12);
  dex.writeUInt32LE(adler32(dex, 12), 8);
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

const DEFAULT_SERVER_URL = "http://10.0.2.2:4100";
const MOBILE_CLIENT_FILES = ["index.html", "styles.css", "app.js"] as const;

function normalizeProjectSlug(value: string): string {
  if (typeof value !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value)) {
    throw new ValidationError("projectSlug must be a valid lowercase project slug.");
  }
  return value;
}

function normalizeServerUrl(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) {
    throw new ValidationError("serverUrl must be a valid absolute URL of at most 2048 characters.");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ValidationError("serverUrl must be a valid absolute URL.");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new ValidationError("serverUrl must be an HTTP(S) origin or base path without credentials, query, or fragment.");
  }
  url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/dashboard$/, "");
  return url.toString().replace(/\/$/, "");
}

function buildMobileClientConfig(config: Record<string, unknown>): Buffer {
  // JSON is emitted as data, not executable interpolation; escaping also keeps the
  // generated script safe if future configuration contains markup-like text.
  const json = JSON.stringify(config)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  return Buffer.from(`window.__MARRY_BASE_CONFIG__ = Object.freeze(${json});\n`, "utf8");
}

export async function buildMarryBaseApk(options?: {
  projectSlug?: string;
  serverUrl?: string;
  versionName?: string;
  versionCode?: number;
  actorId?: string | null;
}): Promise<BuiltApkInfo> {
  const projectSlug = options?.projectSlug === undefined
    ? null
    : normalizeProjectSlug(options.projectSlug);
  const packageName = projectSlug
    ? `com.marrybase.app.${projectSlug.replace(/-/g, "")}`
    : "com.marrybase.platform";
  const versionName = options?.versionName ?? "1.0.0";
  if (typeof versionName !== "string" || !/^[0-9A-Za-z][0-9A-Za-z._-]{0,31}$/.test(versionName)) {
    throw new ValidationError("versionName must be 1–32 characters using letters, numbers, dots, underscores, or hyphens.");
  }
  const versionCode = options?.versionCode ?? 1;
  if (!Number.isInteger(versionCode) || versionCode < 1 || versionCode > 2_100_000_000) {
    throw new ValidationError("versionCode must be an integer between 1 and 2100000000.");
  }
  const serverUrl = normalizeServerUrl(options?.serverUrl ?? DEFAULT_SERVER_URL);

  const [logoPng, logoSvg, mobileIcon, ...mobileClientAssets] = await Promise.all([
    readFile(resolve(process.cwd(), "assets", "logo.png")),
    readFile(resolve(process.cwd(), "assets", "logo.svg")),
    readFile(resolve(process.cwd(), "public", "mobile", "app-icon.png")),
    ...MOBILE_CLIENT_FILES.map((fileName) =>
      readFile(resolve(process.cwd(), "public", "mobile", fileName))
    ),
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
        projectSlug,
        serverUrl,
        sdkVersion: "1.0.0",
        builtAt: new Date().toISOString(),
      },
      null,
      2
    ),
    "utf8"
  );

  const mobileClientConfig = buildMobileClientConfig({
    platform: "MARRY BASE",
    packageName,
    versionName,
    versionCode,
    projectSlug,
    serverUrl,
  });

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
    ...MOBILE_CLIENT_FILES.map((fileName, index) => ({
      name: `assets/www/${fileName}`,
      data: mobileClientAssets[index]!,
      store: false,
    })),
    { name: "assets/www/config.js", data: mobileClientConfig, store: false },
    { name: "assets/www/app-icon.png", data: mobileIcon, store: false },
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

  const fileName = projectSlug ? `marry-base-${projectSlug}.apk` : "marry-base.apk";
  const filePath = resolve(process.cwd(), "releases", fileName);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, apkBuffer);

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
    projectSlug,
    fileName,
    filePath,
    sizeBytes: apkBuffer.length,
    checksumSha256,
    entries: allEntries.map((e) => e.name),
    builtAt,
  };
}

export async function getBuiltProjectApk(projectSlug: string): Promise<{
  fileName: string;
  filePath: string;
  checksumSha256: string;
  buffer: Buffer;
}> {
  const slug = normalizeProjectSlug(projectSlug);
  const fileName = `marry-base-${slug}.apk`;
  const filePath = resolve(process.cwd(), "releases", fileName);
  let buffer: Buffer;
  try {
    buffer = await readFile(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new NotFoundError("This project APK has not been built yet. Build it from the project’s APK workspace first.");
    }
    throw error;
  }
  return {
    fileName,
    filePath,
    checksumSha256: createHash("sha256").update(buffer).digest("hex"),
    buffer,
  };
}

export async function getOrBuildDefaultApk(): Promise<{
  info: BuiltApkInfo;
  buffer: Buffer;
}> {
  const defaultApkPath = resolve(process.cwd(), "releases", "marry-base.apk");
  try {
    const fileStat = await stat(defaultApkPath);
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
          "assets/www/styles.css",
          "assets/www/app.js",
          "assets/www/config.js",
          "assets/www/app-icon.png",
          "META-INF/MANIFEST.MF",
          "META-INF/MARRYBAS.SF",
          "META-INF/MARRYBAS.RSA",
        ],
        builtAt: fileStat.mtime.toISOString(),
      },
      buffer,
    };
  } catch {
    const info = await buildMarryBaseApk();
    const buffer = await readFile(info.filePath);
    return { info, buffer };
  }
}
