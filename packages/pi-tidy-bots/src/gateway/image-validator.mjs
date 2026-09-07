import { parentPort, workerData } from "node:worker_threads";
import { inflateSync } from "node:zlib";
import { PNG } from "pngjs";
import jpeg from "jpeg-js";

// This worker only decodes bounded in-memory bytes. It never reads supplied paths.
try {
  const bytes = Buffer.from(workerData.bytes);
  if (!bytes.length || bytes.length > 512 * 1024) throw new Error();
  let image;
  if (workerData.mediaType === "image/png") {
    if (
      bytes.length < 33 ||
      !bytes
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      bytes.readUInt32BE(8) !== 13 ||
      bytes.toString("ascii", 12, 16) !== "IHDR"
    )
      throw new Error();
    const width = bytes.readUInt32BE(16),
      height = bytes.readUInt32BE(20);
    if (
      !width ||
      !height ||
      width > 16384 ||
      height > 16384 ||
      width * height > 8_000_000
    )
      throw new Error();
    const compressed = [];
    let offset = 8,
      ended = false;
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset),
        type = bytes.toString("ascii", offset + 4, offset + 8);
      if (
        length > bytes.length - offset - 12 ||
        ["acTL", "fcTL", "fdAT"].includes(type)
      )
        throw new Error();
      if (type === "IDAT")
        compressed.push(bytes.subarray(offset + 8, offset + 8 + length));
      offset += length + 12;
      if (type === "IEND") {
        if (length || offset !== bytes.length) throw new Error();
        ended = true;
        break;
      }
    }
    if (!ended || !compressed.length) throw new Error();
    // pngjs's interlaced path lacks an output cap. Validate the same stream first.
    inflateSync(Buffer.concat(compressed), {
      maxOutputLength: Math.min(
        64 * 1024 * 1024,
        width * height * 8 + height * 8 + 1024
      ),
    });
    image = PNG.sync.read(bytes, { checkCRC: true });
    if (image.width !== width || image.height !== height) throw new Error();
  } else if (workerData.mediaType === "image/jpeg") {
    if (
      bytes[0] !== 255 ||
      bytes[1] !== 216 ||
      bytes.at(-2) !== 255 ||
      bytes.at(-1) !== 217
    )
      throw new Error();
    image = jpeg.decode(bytes, {
      useTArray: true,
      tolerantDecoding: false,
      maxResolutionInMP: 8,
      maxMemoryUsageInMB: 64,
    });
  } else throw new Error();
  if (
    !image.width ||
    !image.height ||
    image.width > 16384 ||
    image.height > 16384 ||
    image.width * image.height > 8_000_000 ||
    image.data.length !== image.width * image.height * 4
  )
    throw new Error();
  parentPort.postMessage({
    ok: true,
    width: image.width,
    height: image.height,
  });
} catch {
  parentPort.postMessage({ ok: false });
}
parentPort.close();
