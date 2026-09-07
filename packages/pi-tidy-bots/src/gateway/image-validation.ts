import { Worker } from "node:worker_threads";
import { ProtocolError } from "./protocol.ts";

let active = 0;
/** Bound CPU concurrency, decode lifetime and heap independently of HTTP admission. */
export async function validateImage(
  bytes: Uint8Array,
  mediaType: string
): Promise<void> {
  if (active >= 2)
    throw new ProtocolError(
      "media_busy",
      "Image validation is busy; retry the same operation"
    );
  if (
    !bytes.byteLength ||
    bytes.byteLength > 512 * 1024 ||
    !["image/png", "image/jpeg"].includes(mediaType)
  )
    throw new ProtocolError("invalid_payload", "Invalid image input");
  active++;
  let worker: Worker | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    worker = new Worker(new URL("./image-validator.mjs", import.meta.url), {
      workerData: { bytes, mediaType },
      execArgv: [],
      env: {},
      resourceLimits: {
        maxOldGenerationSizeMb: 96,
        maxYoungGenerationSizeMb: 16,
      },
    });
    await new Promise<void>((resolve, reject) => {
      const fail = () =>
        reject(
          new ProtocolError(
            "invalid_payload",
            "Image bytes failed bounded decoding"
          )
        );
      timer = setTimeout(fail, 5000);
      worker!.once("error", fail);
      worker!.once("exit", fail);
      worker!.once("message", (result) =>
        result?.ok === true ? resolve() : fail()
      );
    });
  } finally {
    if (timer) clearTimeout(timer);
    try {
      await worker?.terminate();
    } finally {
      active--;
    }
  }
}
