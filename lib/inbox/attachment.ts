/**
 * Preparo do anexo no BROWSER, antes de mandar pro WhatsApp.
 *
 * O arquivo não passa por storage nosso (decisão Darlei 26/07): ele viaja em
 * base64 dentro do POST /api/v1/messages. Isso põe um teto real — o corpo da
 * função serverless (~4,5 MB), e base64 engorda o arquivo em 1/3. Por isso:
 *  - imagem é recomprimida aqui (o WhatsApp faria isso de qualquer jeito),
 *  - o resto é barrado acima de 2,8 MB com mensagem clara em vez de erro 413.
 */

/** Teto do arquivo cru (não-imagem). 2,8 MB → ~3,7 MB em base64. */
export const MAX_ATTACHMENT_BYTES = 2_800_000;

/** Lado maior da imagem depois da recompressão. */
const IMAGE_MAX_EDGE = 1600;
const IMAGE_QUALITY = 0.82;

export interface PreparedAttachment {
  filename: string;
  mime: string;
  /** base64 puro, sem o prefixo data:. */
  base64: string;
  bytes: number;
  /** objectURL só para a prévia; quem chama revoga. */
  previewUrl: string | null;
}

export type PrepareResult =
  | { ok: true; attachment: PreparedAttachment }
  | { ok: false; error: string };

function base64Of(dataUrl: string): string {
  const comma = dataUrl.indexOf(",");
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

/** Recomprime a imagem no canvas; devolve null se o navegador não der conta. */
async function shrinkImage(file: File): Promise<{ blob: Blob; mime: string } | null> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, IMAGE_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const w = Math.round(bitmap.width * scale);
    const h = Math.round(bitmap.height * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", IMAGE_QUALITY),
    );
    return blob ? { blob, mime: "image/jpeg" } : null;
  } catch {
    return null;
  }
}

export async function prepareAttachment(file: File): Promise<PrepareResult> {
  const isImage = file.type.startsWith("image/");
  let payload: Blob = file;
  let mime = file.type || "application/octet-stream";
  let filename = file.name || "arquivo";

  if (isImage && file.type !== "image/gif") {
    const shrunk = await shrinkImage(file);
    // Só troca se realmente ficou menor (PNG de tela pode inchar em JPEG).
    if (shrunk && shrunk.blob.size < file.size) {
      payload = shrunk.blob;
      mime = shrunk.mime;
      filename = filename.replace(/\.[^.]+$/, "") + ".jpg";
    }
  }

  if (payload.size > MAX_ATTACHMENT_BYTES) {
    const mb = (payload.size / 1_000_000).toFixed(1);
    return {
      ok: false,
      error: `Arquivo de ${mb} MB. O limite de envio aqui é 2,8 MB — comprima ou mande por e-mail.`,
    };
  }

  const dataUrl = await readAsDataUrl(payload);
  return {
    ok: true,
    attachment: {
      filename,
      mime,
      base64: base64Of(dataUrl),
      bytes: payload.size,
      previewUrl: mime.startsWith("image/") ? URL.createObjectURL(payload) : null,
    },
  };
}

/** Tipo da mensagem no CRM a partir do mime (bate com messages_type_check). */
export function messageTypeForMime(mime: string): string {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  return "document";
}
