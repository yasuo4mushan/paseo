/**
 * wx 文件系统 / 文档预览操作（t17）：promisified 封装，供文件浏览器与附件卡复用。
 * 下载目录固定为 `${wx.env.USER_DATA_PATH}/paseo-files/`。
 */

import Taro from "@tarojs/taro";
import { safeFileName, fileExtension } from "./files";

export const DOWNLOAD_DIR = `${Taro.env.USER_DATA_PATH}/paseo-files`;

type FailErr = { errMsg?: string };

function fsm(): Taro.FileSystemManager {
  return Taro.getFileSystemManager();
}

function mkdirRecursive(dir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    fsm().mkdir({
      dirPath: dir,
      recursive: true,
      success: () => resolve(),
      fail: (e: FailErr) => {
        // 已存在视为成功（wx mkdir 无 EEXIST 宽容）
        if (String(e?.errMsg ?? "").includes("exist")) resolve();
        else reject(new Error(e?.errMsg ?? "mkdir failed"));
      },
    });
  });
}

export async function ensureDownloadDir(): Promise<string> {
  await mkdirRecursive(DOWNLOAD_DIR);
  return DOWNLOAD_DIR;
}

/** 把字节写到下载目录，返回完整路径（同名覆盖）。 */
export async function saveBytesToDownload(fileName: string, bytes: Uint8Array): Promise<string> {
  const dir = await ensureDownloadDir();
  const name = safeFileName(fileName);
  const filePath = `${dir}/${name}`;
  // copy 出独立 ArrayBuffer（subarray 共享 buffer，wx 需要完整视图）
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  await new Promise<void>((resolve, reject) => {
    fsm().writeFile({
      filePath,
      data: copy.buffer,
      success: () => resolve(),
      fail: (e: FailErr) => reject(new Error(e?.errMsg ?? "writeFile failed")),
    });
  });
  return filePath;
}

/** wx.openDocument 支持的文件类型。 */
export type WxDocumentType = "doc" | "docx" | "xls" | "xlsx" | "ppt" | "pptx" | "pdf";

const DOCUMENT_TYPES = new Set(["doc", "docx", "xls", "xlsx", "ppt", "pptx", "pdf"]);

/** 扩展名是 openDocument 支持的类型时返回 fileType，否则 undefined。 */
export function documentFileType(name: string): WxDocumentType | undefined {
  const ext = fileExtension(name);
  return DOCUMENT_TYPES.has(ext) ? (ext as WxDocumentType) : undefined;
}

/** wx.openDocument：pdf/doc(x)/xls(x)/ppt(x) 系统预览。 */
export function openDocument(filePath: string, fileType?: WxDocumentType): Promise<void> {
  return new Promise((resolve, reject) => {
    Taro.openDocument({
      filePath,
      ...(fileType ? { fileType } : {}),
      showMenu: true,
      success: () => resolve(),
      fail: (e: FailErr) => reject(new Error(e?.errMsg ?? "openDocument failed")),
    });
  });
}

/** wx.previewImage：全屏图片预览。 */
export function previewImage(url: string): void {
  Taro.previewImage({ current: url, urls: [url] });
}

/** wx.shareFileMessage：转发到聊天（用户可长按另存）。 */
export function shareFile(filePath: string, fileName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    Taro.shareFileMessage({
      filePath,
      fileName,
      success: () => resolve(),
      fail: (e: FailErr) => reject(new Error(e?.errMsg ?? "shareFileMessage failed")),
    });
  });
}

/** 读取本地文件为字节（选图 / chooseMessageFile 后上传用）。 */
export function readLocalFileBytes(filePath: string): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    fsm().readFile({
      filePath,
      encoding: "base64",
      success: (res: { data: string | ArrayBuffer }) => {
        try {
          resolve(new Uint8Array(Taro.base64ToArrayBuffer(res.data as string)));
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      },
      fail: (e: FailErr) => reject(new Error(e?.errMsg ?? "readFile failed")),
    });
  });
}
